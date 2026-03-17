---
title: "Linux NUMA Architecture Deep Dive: Memory Policies, numactl, libnuma, Process Binding, and Memory Bandwidth Optimization"
date: 2031-12-20T00:00:00-05:00
draft: false
tags: ["Linux", "NUMA", "Performance", "Memory", "CPU", "numactl", "libnuma", "HPC", "Kernel"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to NUMA (Non-Uniform Memory Access) architecture on Linux covering memory policies, numactl configuration, libnuma programming, CPU and memory binding, bandwidth optimization, and NUMA-aware application design for high-performance workloads."
more_link: "yes"
url: "/linux-numa-architecture-memory-policies-numactl-libnuma-bandwidth-optimization/"
---

Non-Uniform Memory Access (NUMA) is the dominant memory architecture in multi-socket and many-core systems. When a process running on socket 0 allocates memory on socket 1, the access traverses the inter-processor interconnect (AMD Infinity Fabric, Intel UPI) rather than the local memory controller, adding 30-100ns of latency and consuming shared bandwidth. For latency-sensitive and high-throughput workloads, NUMA topology ignorance is a silent performance cliff.

This guide covers the Linux NUMA subsystem from hardware topology through kernel policy interfaces, numactl command-line control, libnuma programming, and production optimization patterns for databases, high-performance Go applications, and Kubernetes node-level tuning.

<!--more-->

# Linux NUMA Architecture Deep Dive: Memory Policies, numactl, libnuma, and Bandwidth Optimization

## Section 1: NUMA Hardware Architecture

### 1.1 NUMA Topology

In a dual-socket server, each processor has direct access to its local DRAM banks. Accessing the other socket's memory requires traversing the inter-socket interconnect:

```
Socket 0                    Socket 1
┌─────────────────┐         ┌─────────────────┐
│ Core 0-23       │◄──UPI──►│ Core 24-47      │
│ LLC 32MB        │         │ LLC 32MB        │
│ IMC ─── DRAM   │         │ IMC ─── DRAM   │
│ (128GB DDR5)   │         │ (128GB DDR5)   │
└─────────────────┘         └─────────────────┘
  NUMA Node 0                 NUMA Node 1

Local access:   ~80ns
Remote access: ~130ns  (1.6x penalty)
```

On systems with more than two sockets, or with AMD EPYC's CCX topology, multiple NUMA nodes may appear within a single physical socket.

### 1.2 Discovering NUMA Topology

```bash
# List NUMA nodes and their CPUs
numactl --hardware

# Example output:
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7 8 9 10 11 24 25 26 27 28 29 30 31 32 33 34 35
# node 0 size: 128927 MB
# node 0 free: 64321 MB
# node 1 cpus: 12 13 14 15 16 17 18 19 20 21 22 23 36 37 38 39 40 41 42 43 44 45 46 47
# node 1 size: 128927 MB
# node 1 free: 65432 MB
# node distances:
# node   0   1
#   0:  10  21
#   1:  21  10

# Show NUMA topology in detail
lstopo --of ascii

# NUMA distances (lower is better, 10 = local)
cat /sys/devices/system/node/node0/distance

# CPU-to-NUMA node mapping
cat /sys/devices/system/node/node0/cpulist
cat /sys/devices/system/node/node1/cpulist

# Memory per node
cat /sys/devices/system/node/node0/meminfo

# HW topology with hwloc
hwloc-info --topology
hwloc-calc --number-of core NUMANode:0
```

### 1.3 NUMA Statistics

```bash
# NUMA hit/miss statistics
numastat

# Example output:
#                           node0           node1
# numa_hit              12345678        23456789
# numa_miss               123456          234567
# numa_foreign            234567          123456
# interleave_hit           45678           56789
# local_node            12000000        22000000
# other_node              345678          456789

# Per-process NUMA statistics
numastat -p <pid>

# Per-node memory usage
numastat -m

# NUMA balancing statistics
cat /proc/vmstat | grep numa
```

## Section 2: Linux NUMA Memory Policies

### 2.1 System-Wide NUMA Policy

```bash
# Check current NUMA balancing status
cat /proc/sys/kernel/numa_balancing

# Enable automatic NUMA balancing (kernel migrates pages to accessing node)
echo 1 > /proc/sys/kernel/numa_balancing

# NUMA balancing scan delay (ms between scans)
cat /proc/sys/kernel/numa_balancing_scan_delay_ms

# Tune scan period
echo 1000 > /proc/sys/kernel/numa_balancing_scan_period_min_ms
echo 60000 > /proc/sys/kernel/numa_balancing_scan_period_max_ms
```

### 2.2 Process Memory Policies

The `set_mempolicy(2)` system call sets the memory allocation policy for a process:

```
MPOL_DEFAULT     - fall back to process or system default
MPOL_BIND        - allocate ONLY from specified nodes (strict)
MPOL_PREFERRED   - prefer specified node, fall back if full
MPOL_INTERLEAVE  - round-robin across nodes (for bandwidth)
MPOL_LOCAL       - allocate on the node of the current CPU
```

### 2.3 VMA-Level Policies

Memory policies can be applied to specific virtual memory areas using `mbind(2)`:

```c
#include <sys/mman.h>
#include <numaif.h>

void set_memory_binding_for_region(void *addr, size_t len, int node)
{
    unsigned long nodemask = 1UL << node;

    // Bind future allocations in this range to node
    if (mbind(addr, len, MPOL_BIND, &nodemask, 64, MPOL_MF_MOVE | MPOL_MF_STRICT) != 0) {
        perror("mbind");
    }
}
```

## Section 3: numactl Command-Line Interface

### 3.1 Running a Process with NUMA Binding

```bash
# Run a command on NUMA node 0's CPUs with memory on node 0
numactl --cpunodebind=0 --membind=0 ./my-application

# Bind to specific CPUs (not entire node)
numactl --physcpubind=0,1,2,3 --membind=0 ./my-application

# Interleave memory across all nodes (good for global shared data)
numactl --interleave=all ./database-server

# Prefer node 0 but allow allocation on node 1 if needed
numactl --preferred=0 ./application

# Bind to node 1 only for memory, any CPU
numactl --membind=1 ./memory-intensive-job

# Set NUMA policy for an already-running process
numactl --run-with-cpunodebind=0 --membind=0 -p <pid>

# Show current policy for a process
numactl --show
cat /proc/<pid>/numa_maps
```

### 3.2 numastat for Performance Diagnostics

```bash
# Memory allocation efficiency per process
numastat -p $(pgrep postgres)

# Show memory per node with human-readable sizes
numastat -m -n

# Show per-node allocation for top processes
numastat --largest 20

# Watch NUMA statistics live
watch -n 1 numastat
```

### 3.3 Persistent NUMA Configuration via Systemd

```ini
# /etc/systemd/system/postgres.service.d/numa.conf
[Service]
# Bind to NUMA node 0
ExecStart=
ExecStart=numactl --cpunodebind=0 --membind=0 /usr/bin/postgres -D /var/lib/postgresql/data

# Alternative using systemd NUMAPolicy
NUMAPolicy=bind
NUMAMask=0
```

```bash
# Verify systemd NUMA config
systemctl cat postgres | grep -i numa
systemctl show postgres | grep -i numa
```

## Section 4: libnuma Programming Interface

### 4.1 Basic libnuma Usage

```c
#include <numa.h>
#include <numaif.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void demonstrate_libnuma(void)
{
    // Check NUMA availability
    if (numa_available() < 0) {
        fprintf(stderr, "NUMA not available on this system\n");
        return;
    }

    int num_nodes = numa_num_configured_nodes();
    int max_node = numa_max_node();
    printf("NUMA nodes: %d (max node: %d)\n", num_nodes, max_node);

    // Get CPU count per node
    for (int node = 0; node <= max_node; node++) {
        struct bitmask *cpus = numa_allocate_cpumask();
        numa_node_to_cpus(node, cpus);

        int cpu_count = 0;
        for (int cpu = 0; cpu < numa_num_configured_cpus(); cpu++) {
            if (numa_bitmask_isbitset(cpus, cpu))
                cpu_count++;
        }

        long long free_mem;
        long long total_mem = numa_node_size64(node, &free_mem);

        printf("Node %d: %d CPUs, total=%lldGB, free=%lldGB\n",
               node, cpu_count,
               total_mem / (1024*1024*1024),
               free_mem / (1024*1024*1024));

        numa_free_cpumask(cpus);
    }

    // Allocate on specific node
    size_t size = 256 * 1024 * 1024; // 256MB
    void *local_mem = numa_alloc_onnode(size, 0);
    if (!local_mem) {
        fprintf(stderr, "numa_alloc_onnode failed\n");
        return;
    }

    // Touch all pages to force allocation
    memset(local_mem, 0, size);

    // Verify allocation location
    int node;
    if (get_mempolicy(&node, NULL, 0, local_mem, MPOL_F_ADDR | MPOL_F_NODE) == 0) {
        printf("256MB buffer allocated on node: %d\n", node);
    }

    numa_free(local_mem, size);
}
```

### 4.2 NUMA-Aware Memory Allocator

```c
// numa_allocator.h - A NUMA-aware memory pool
#ifndef NUMA_ALLOCATOR_H
#define NUMA_ALLOCATOR_H

#include <stddef.h>

typedef struct numa_pool numa_pool_t;

// Create a memory pool bound to a specific NUMA node.
// All allocations from this pool are guaranteed to be on node_id.
numa_pool_t *numa_pool_create(int node_id, size_t initial_size);

// Allocate aligned memory from the pool.
void *numa_pool_alloc(numa_pool_t *pool, size_t size, size_t alignment);

// Return memory to the pool.
void numa_pool_free(numa_pool_t *pool, void *ptr, size_t size);

// Destroy the pool and release all memory.
void numa_pool_destroy(numa_pool_t *pool);

// Move an allocation from its current node to node_id.
// Returns a new pointer on the target node.
void *numa_migrate_to_node(void *ptr, size_t size, int node_id);

#endif
```

```c
// numa_allocator.c
#include "numa_allocator.h"
#include <numa.h>
#include <numaif.h>
#include <pthread.h>
#include <string.h>
#include <errno.h>

struct numa_pool {
    int           node_id;
    pthread_mutex_t lock;
    void          **slabs;
    size_t         slab_count;
    size_t         slab_size;
};

numa_pool_t *numa_pool_create(int node_id, size_t initial_size)
{
    if (numa_available() < 0)
        return NULL;
    if (node_id > numa_max_node())
        return NULL;

    numa_pool_t *pool = numa_alloc_onnode(sizeof(*pool), node_id);
    if (!pool)
        return NULL;

    memset(pool, 0, sizeof(*pool));
    pool->node_id = node_id;
    pool->slab_size = initial_size;
    pthread_mutex_init(&pool->lock, NULL);

    return pool;
}

void *numa_pool_alloc(numa_pool_t *pool, size_t size, size_t alignment)
{
    // For simplicity, fall back to numa_alloc_onnode.
    // A production implementation would manage slab lists.
    void *ptr = numa_alloc_onnode(size, pool->node_id);
    if (!ptr)
        return NULL;

    // Align the pointer if needed
    uintptr_t addr = (uintptr_t)ptr;
    if (alignment > 0 && (addr % alignment) != 0) {
        numa_free(ptr, size);
        // Allocate with extra space for alignment
        ptr = numa_alloc_onnode(size + alignment, pool->node_id);
        if (!ptr)
            return NULL;
        addr = ((uintptr_t)ptr + alignment - 1) & ~(alignment - 1);
        return (void *)addr;
    }

    return ptr;
}

void *numa_migrate_to_node(void *ptr, size_t size, int target_node)
{
    void *new_ptr = numa_alloc_onnode(size, target_node);
    if (!new_ptr)
        return NULL;

    memcpy(new_ptr, ptr, size);
    return new_ptr;
}

void numa_pool_destroy(numa_pool_t *pool)
{
    if (!pool)
        return;
    int node_id = pool->node_id;
    pthread_mutex_destroy(&pool->lock);
    numa_free(pool, sizeof(*pool));
    (void)node_id;
}
```

### 4.3 NUMA-Aware Thread Pinning in C

```c
#include <pthread.h>
#include <numa.h>
#include <sched.h>

struct thread_config {
    int numa_node;
    int cpu_id;  // -1 for any CPU in the node
    void *(*work)(void *);
    void *arg;
};

void *numa_thread_wrapper(void *arg)
{
    struct thread_config *cfg = arg;

    // Pin to NUMA node
    struct bitmask *node_mask = numa_allocate_nodemask();
    numa_bitmask_setbit(node_mask, cfg->numa_node);
    numa_set_membind(node_mask);  // memory binds to this node
    numa_free_nodemask(node_mask);

    // Pin to specific CPU if requested
    if (cfg->cpu_id >= 0) {
        cpu_set_t cpuset;
        CPU_ZERO(&cpuset);
        CPU_SET(cfg->cpu_id, &cpuset);
        pthread_setaffinity_np(pthread_self(), sizeof(cpuset), &cpuset);
    } else {
        // Pin to any CPU in the node
        struct bitmask *cpu_mask = numa_allocate_cpumask();
        numa_node_to_cpus(cfg->numa_node, cpu_mask);

        cpu_set_t cpuset;
        CPU_ZERO(&cpuset);
        for (int i = 0; i < numa_num_configured_cpus(); i++) {
            if (numa_bitmask_isbitset(cpu_mask, i))
                CPU_SET(i, &cpuset);
        }
        pthread_setaffinity_np(pthread_self(), sizeof(cpuset), &cpuset);
        numa_free_cpumask(cpu_mask);
    }

    return cfg->work(cfg->arg);
}

// Launch a thread on a specific NUMA node
pthread_t launch_numa_thread(int node, void *(*fn)(void *), void *arg)
{
    struct thread_config *cfg = malloc(sizeof(*cfg));
    cfg->numa_node = node;
    cfg->cpu_id = -1;
    cfg->work = fn;
    cfg->arg = arg;

    pthread_attr_t attr;
    pthread_attr_init(&attr);
    // Set stack memory on the target NUMA node
    pthread_attr_setstacksize(&attr, 8 * 1024 * 1024);

    pthread_t tid;
    pthread_create(&tid, &attr, numa_thread_wrapper, cfg);
    pthread_attr_destroy(&attr);
    return tid;
}
```

## Section 5: Go NUMA-Aware Programming

### 5.1 CPU Affinity in Go via cgo

```go
package numago

// #cgo LDFLAGS: -lnuma
// #include <numa.h>
// #include <sched.h>
// #include <stdlib.h>
//
// int set_thread_affinity_to_node(int node) {
//     struct bitmask *cpumask = numa_allocate_cpumask();
//     if (!cpumask) return -1;
//     numa_node_to_cpus(node, cpumask);
//
//     cpu_set_t cpuset;
//     CPU_ZERO(&cpuset);
//     for (int i = 0; i < numa_num_configured_cpus(); i++) {
//         if (numa_bitmask_isbitset(cpumask, i))
//             CPU_SET(i, &cpuset);
//     }
//     numa_free_cpumask(cpumask);
//
//     return sched_setaffinity(0, sizeof(cpuset), &cpuset);
// }
//
// int get_current_numa_node(void) {
//     return numa_node_of_cpu(sched_getcpu());
// }
//
// int get_numa_node_count(void) {
//     return numa_num_configured_nodes();
// }
import "C"

import (
    "fmt"
    "runtime"
)

// GetNUMANodeCount returns the number of NUMA nodes on this system.
func GetNUMANodeCount() int {
    return int(C.get_numa_node_count())
}

// GetCurrentNUMANode returns the NUMA node of the current goroutine's OS thread.
func GetCurrentNUMANode() int {
    return int(C.get_current_numa_node())
}

// SetThreadNUMANode pins the current OS thread to the CPUs of the specified NUMA node.
// Must be called with runtime.LockOSThread() held.
func SetThreadNUMANode(node int) error {
    ret := C.set_thread_affinity_to_node(C.int(node))
    if ret != 0 {
        return fmt.Errorf("set_thread_affinity_to_node(%d) failed: %d", node, ret)
    }
    return nil
}

// NUMAWorkerPool creates a pool of goroutines pinned to specific NUMA nodes.
type NUMAWorkerPool struct {
    nodes    int
    workers  []chan func()
    stop     chan struct{}
}

func NewNUMAWorkerPool(workersPerNode int) *NUMAWorkerPool {
    nodes := GetNUMANodeCount()
    pool := &NUMAWorkerPool{
        nodes:   nodes,
        workers: make([]chan func(), nodes),
        stop:    make(chan struct{}),
    }

    for node := 0; node < nodes; node++ {
        pool.workers[node] = make(chan func(), 1000)
        for w := 0; w < workersPerNode; w++ {
            go pool.runWorker(node, pool.workers[node])
        }
    }

    return pool
}

func (p *NUMAWorkerPool) runWorker(node int, ch chan func()) {
    // Lock this goroutine to its OS thread so CPU affinity applies
    runtime.LockOSThread()
    defer runtime.UnlockOSThread()

    if err := SetThreadNUMANode(node); err != nil {
        // Log and continue on non-NUMA systems
        _ = err
    }

    for {
        select {
        case fn := <-ch:
            fn()
        case <-p.stop:
            return
        }
    }
}

// Submit submits work to run on a specific NUMA node.
func (p *NUMAWorkerPool) Submit(node int, fn func()) {
    if node < 0 || node >= p.nodes {
        node = GetCurrentNUMANode() % p.nodes
    }
    p.workers[node] <- fn
}

// SubmitLocal submits work to the NUMA node of the current goroutine.
func (p *NUMAWorkerPool) SubmitLocal(fn func()) {
    node := GetCurrentNUMANode()
    p.Submit(node % p.nodes, fn)
}

func (p *NUMAWorkerPool) Close() {
    close(p.stop)
}
```

### 5.2 NUMA-Aware Object Pools

```go
package numapool

import (
    "runtime"
    "sync"
)

// NUMAObjectPool maintains separate sync.Pool instances per NUMA node,
// reducing cross-node memory access in object reuse.
type NUMAObjectPool[T any] struct {
    pools []*sync.Pool
    nodes int
}

func NewNUMAObjectPool[T any](newFn func() T) *NUMAObjectPool[T] {
    nodes := runtime.NumCPU() / 4 // approximate NUMA node count
    if nodes < 1 {
        nodes = 1
    }

    p := &NUMAObjectPool[T]{
        pools: make([]*sync.Pool, nodes),
        nodes: nodes,
    }

    for i := range p.pools {
        p.pools[i] = &sync.Pool{
            New: func() interface{} {
                return newFn()
            },
        }
    }

    return p
}

func (p *NUMAObjectPool[T]) Get() T {
    // Use CPU ID to select the local pool
    // This is an approximation; true NUMA affinity requires cgo
    node := runtime.NumGoroutine() % p.nodes
    return p.pools[node].Get().(T)
}

func (p *NUMAObjectPool[T]) Put(v T) {
    node := runtime.NumGoroutine() % p.nodes
    p.pools[node].Put(v)
}
```

## Section 6: Kubernetes NUMA-Aware Workloads

### 6.1 CPU Manager and Topology Manager

```yaml
# kubelet config with topology-aware scheduling
# /var/lib/kubelet/config.yaml
cpuManagerPolicy: static
topologyManagerPolicy: single-numa-node
topologyManagerScope: pod

# Kubernetes 1.26+ supports fine-grained policies:
# topologyManagerPolicy options: none, best-effort, restricted, single-numa-node
```

### 6.2 Requesting Guaranteed QoS with CPU Pinning

```yaml
# guaranteed-qos-pod.yaml
apiVersion: v1
kind: Pod
metadata:
  name: numa-bound-app
  namespace: production
spec:
  containers:
    - name: app
      image: registry.example.com/numa-app:latest
      resources:
        # Equal requests and limits = Guaranteed QoS = eligible for CPU pinning
        requests:
          cpu: "8"          # Must be integer for static CPU manager
          memory: "16Gi"
        limits:
          cpu: "8"
          memory: "16Gi"
      env:
        - name: GOMAXPROCS
          value: "8"
```

The `static` CPU manager policy with `single-numa-node` topology manager will place all 8 CPUs on a single NUMA node and bind the container's memory to that same node.

### 6.3 NUMA-Aware Helm Chart Values

```yaml
# values.yaml for NUMA-sensitive databases
replicaCount: 2

resources:
  requests:
    cpu: "16"       # Integer for static CPU manager
    memory: "64Gi"
  limits:
    cpu: "16"
    memory: "64Gi"

# Node selector targeting high-memory NUMA nodes
nodeSelector:
  numa-nodes: "2"
  cpu-model: "intel-xeon-platinum"

topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: DoNotSchedule
    labelSelector:
      matchLabels:
        app: postgres

affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchLabels:
            app: postgres
        topologyKey: kubernetes.io/hostname
```

## Section 7: Memory Bandwidth Optimization

### 7.1 Measuring Memory Bandwidth

```bash
# Install and run stream benchmark
git clone https://github.com/jeffhammond/STREAM
cd STREAM
gcc -O3 -fopenmp -DSTREAM_ARRAY_SIZE=800000000 stream.c -o stream
./stream

# NUMA-aware stream benchmark (per node)
numactl --cpunodebind=0 --membind=0 ./stream
numactl --cpunodebind=0 --membind=1 ./stream  # cross-node = lower bandwidth

# Use perf to measure memory bandwidth
perf stat -e LLC-load-misses,LLC-store-misses \
    numactl --membind=0 ./your-application

# Intel Memory Latency Checker
./mlc --bandwidth_matrix
```

### 7.2 Optimizing Memory Access Patterns

```bash
# Check page size and huge page availability
cat /proc/meminfo | grep -i huge

# Enable transparent huge pages
echo always > /sys/kernel/mm/transparent_hugepage/enabled

# Or explicit huge pages on a specific NUMA node
echo 512 > /sys/devices/system/node/node0/hugepages/hugepages-2048kB/nr_hugepages
echo 512 > /sys/devices/system/node/node1/hugepages/hugepages-2048kB/nr_hugepages

# Check huge page allocation per node
grep -r HugePages /sys/devices/system/node/*/meminfo
```

### 7.3 NUMA Balancing Tuning

```bash
# Kernel NUMA balancing parameters
sysctl -a | grep numa_balancing

# Disable automatic balancing for latency-critical workloads
# that have explicit binding (prevents page migrations)
echo 0 > /proc/sys/kernel/numa_balancing

# For workloads without explicit binding, tune scan aggressiveness
sysctl -w kernel.numa_balancing_scan_delay_ms=1000
sysctl -w kernel.numa_balancing_scan_period_min_ms=1000
sysctl -w kernel.numa_balancing_scan_period_max_ms=60000
sysctl -w kernel.numa_balancing_scan_size_mb=256

# Persist via sysctl.d
cat > /etc/sysctl.d/90-numa.conf << 'EOF'
# Disable NUMA auto-balancing for explicitly bound workloads
kernel.numa_balancing = 0

# Tuning for workloads relying on automatic balancing
# kernel.numa_balancing_scan_delay_ms = 1000
# kernel.numa_balancing_scan_period_min_ms = 1000
# kernel.numa_balancing_scan_period_max_ms = 60000
EOF

sysctl --system
```

## Section 8: Workload-Specific NUMA Strategies

### 8.1 PostgreSQL NUMA Configuration

```bash
# PostgreSQL: bind to NUMA node 0, interleave shared buffers
cat > /etc/systemd/system/postgresql.service.d/numa.conf << 'EOF'
[Service]
# Bind the postgres process to NUMA node 0
# Interleave memory helps the shared buffer pool which is
# accessed by all worker processes on both nodes
ExecStart=
ExecStart=numactl --cpunodebind=0 --membind=0 /usr/pgsql-16/bin/postgres -D /var/lib/pgsql/16/data

# For large shared_buffers, interleave may be better:
# ExecStart=numactl --interleave=all /usr/pgsql-16/bin/postgres -D /var/lib/pgsql/16/data
EOF

systemctl daemon-reload
systemctl restart postgresql-16
```

### 8.2 Redis NUMA Configuration

```bash
# Redis: bind to a single node for low-latency single-threaded access
cat > /etc/systemd/system/redis.service.d/numa.conf << 'EOF'
[Service]
ExecStart=
ExecStart=numactl --cpunodebind=0 --membind=0 /usr/bin/redis-server /etc/redis/redis.conf
EOF
```

### 8.3 Java JVM NUMA Configuration

```bash
# JVM with NUMA-aware allocator
java -XX:+UseNUMA \
     -XX:+UseParallelGC \
     -Xms32g -Xmx32g \
     -XX:ParallelGCThreads=16 \
     -XX:ConcGCThreads=4 \
     com.example.MyApplication
```

## Section 9: Monitoring NUMA Performance

### 9.1 NUMA-Aware perf Monitoring

```bash
# Monitor NUMA-related hardware counters
perf stat -e \
    'cpu/event=0xd1,umask=0x01,name=MEM_LOAD_RETIRED.L3_HIT/' \
    'cpu/event=0xd1,umask=0x20,name=MEM_LOAD_RETIRED.L3_MISS/' \
    'offcore_requests_outstanding.demand_data_rd' \
    -- ./your_workload

# NUMA topology event sampling
perf mem record -a sleep 10
perf mem report --sort=local_weight,mem,sym,dso

# Memory access latency distribution
perf mem record -t load -a sleep 10
perf mem report -D --sort=mem,sym,local_weight
```

### 9.2 Prometheus Node Exporter NUMA Metrics

```bash
# Node exporter exposes NUMA stats
curl http://localhost:9100/metrics | grep numa

# Key metrics:
# node_memory_numa_hit_total{node="0"}
# node_memory_numa_miss_total{node="0"}
# node_memory_numa_foreign_total{node="0"}
# node_memory_numa_local_total{node="0"}
# node_memory_numa_other_total{node="0"}
```

### 9.3 NUMA Health Alert

```yaml
# prometheus-rules.yaml
groups:
  - name: numa-performance
    rules:
      - alert: HighNUMARemoteMemoryAccess
        expr: |
          rate(node_memory_numa_foreign_total[5m]) /
          (rate(node_memory_numa_hit_total[5m]) + rate(node_memory_numa_miss_total[5m])) > 0.20
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "High NUMA remote memory access on {{ $labels.instance }}"
          description: >
            {{ $value | humanizePercentage }} of memory allocations on node
            {{ $labels.node }} are being served from remote NUMA nodes.
            Consider CPU/memory binding for latency-sensitive workloads.
```

## Summary

NUMA architecture fundamentally affects performance on any multi-socket or many-core system. Key optimization principles:

- Use `numastat` and `numactl --hardware` to baseline your topology and identify remote access patterns
- Apply `numactl --cpunodebind --membind` to latency-sensitive processes as a first step
- Use `MPOL_INTERLEAVE` for globally shared data structures accessed by threads on multiple nodes
- Enable `MPOL_BIND` with `mbind()` for per-thread memory pools in HPC workloads
- Configure Kubernetes `topologyManagerPolicy: single-numa-node` with integer CPU requests to get hardware-guaranteed NUMA locality
- Disable automatic NUMA balancing for processes with explicit binding; enable it for processes without
- Monitor `node_memory_numa_foreign_total` to identify workloads that would benefit from binding

The latency penalty for remote NUMA access (20-50ns per access, multiplied by millions of accesses per second) makes NUMA optimization one of the highest-ROI performance tuning activities for database and high-throughput Go service workloads.
