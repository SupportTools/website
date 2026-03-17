---
title: "Linux NUMA Architecture: Memory Policies, numactl, and NUMA-Aware Database Tuning"
date: 2030-05-06T00:00:00-05:00
draft: false
tags: ["Linux", "NUMA", "Performance", "PostgreSQL", "Memory Management", "numactl", "Database Tuning"]
categories: ["Linux", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to NUMA architecture on Linux servers: topology discovery, numactl process and memory binding, NUMA-aware PostgreSQL configuration, and implementing NUMA awareness in C and Go applications."
more_link: "yes"
url: "/linux-numa-architecture-memory-policies-numactl-database-tuning-guide/"
---

Non-Uniform Memory Access (NUMA) architecture is the dominant memory topology for multi-socket servers. On a dual-socket system with 512 GB RAM, half the memory is physically attached to each CPU socket. A core on socket 0 can access memory attached to socket 1, but the latency is 2-4x higher than accessing local memory. Ignoring NUMA on memory-intensive workloads — databases, in-memory caches, analytics engines — routinely causes 20-40% throughput degradation compared to NUMA-optimized configurations.

This guide provides a production-depth treatment of NUMA: how to discover topology, how to use numactl for process and memory binding, how to tune PostgreSQL for NUMA awareness, and how to write NUMA-conscious C and Go code.

<!--more-->

## NUMA Fundamentals

### Architecture Overview

```
Dual-Socket NUMA System (2 nodes):

  Socket 0 (NUMA Node 0)              Socket 1 (NUMA Node 1)
  ┌──────────────────────────┐        ┌──────────────────────────┐
  │  Cores 0-23              │        │  Cores 24-47             │
  │  L1/L2 cache per core    │        │  L1/L2 cache per core    │
  │  L3 cache (shared)       │        │  L3 cache (shared)       │
  │                          │        │                          │
  │  Memory Controller       │◄──QPI──►  Memory Controller       │
  │  DDR4 DIMM slots         │  Link  │  DDR4 DIMM slots         │
  │  (256 GB local)          │        │  (256 GB local)          │
  └──────────────────────────┘        └──────────────────────────┘
         │                                      │
    Local access                           Local access
    ~80ns latency                          ~80ns latency
         │                                      │
    Remote access (cross-QPI): ~160ns latency
```

### Key Performance Metrics

```bash
# Measure NUMA distance between nodes
# Values: 10 = local access, 20+ = remote access
numactl --hardware

# Example output on a 4-socket system:
# node 0 1 2 3
#   0: 10 20 30 30
#   1: 20 10 30 30
#   2: 30 30 10 20
#   3: 30 30 20 10
#
# Nodes 0 and 1 share a QPI link (distance 20 = ~2x slower)
# Nodes 0 and 2 are on different QPI hops (distance 30 = ~3x slower)
```

## Topology Discovery Tools

### numactl Hardware Information

```bash
# Full NUMA topology
numactl --hardware

# Example output:
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7 8 9 10 11 24 25 26 27 28 29 30 31 32 33 34 35
# node 0 size: 262144 MB
# node 0 free: 198432 MB
# node 1 cpus: 12 13 14 15 16 17 18 19 20 21 22 23 36 37 38 39 40 41 42 43 44 45 46 47
# node 1 size: 262144 MB
# node 1 free: 201847 MB
# node distances:
# node   0   1
#   0:  10  20
#   1:  20  10

# CPU topology with NUMA information
lscpu | grep -E "NUMA|Socket|Core|Thread"

# NUMA node to CPU mapping
for node in /sys/devices/system/node/node*/; do
    nodeid=$(basename "$node" | sed 's/node//')
    cpulist=$(cat "$node/cpulist")
    memsize=$(awk '/MemTotal/{print $2/1024/1024 " GB"}' "$node/meminfo")
    printf "NUMA Node %s: CPUs [%s], Memory: %s\n" "$nodeid" "$cpulist" "$memsize"
done
```

### Hardware Topology with lstopo

```bash
# Install hwloc for visual topology
apt-get install hwloc

# Text representation of hardware topology
lstopo --of txt

# Generate a visual topology diagram
lstopo --of svg > topology.svg

# Detailed NUMA topology with cache information
lstopo-no-graphics --no-useless-caches -p

# Check memory bandwidth characteristics
apt-get install stream
numactl --membind=0 --cpunodebind=0 stream  # Local memory bandwidth
numactl --membind=1 --cpunodebind=0 stream  # Remote memory bandwidth
```

### Programmatic Topology Discovery

```c
// numa_topology.c - Discover NUMA topology programmatically
#include <numa.h>
#include <numaif.h>
#include <stdio.h>
#include <stdlib.h>

void print_numa_topology(void) {
    if (numa_available() < 0) {
        fprintf(stderr, "NUMA not available on this system\n");
        return;
    }

    int num_nodes = numa_max_node() + 1;
    int num_cpus = numa_num_configured_cpus();

    printf("NUMA Configuration:\n");
    printf("  Nodes: %d\n", num_nodes);
    printf("  CPUs: %d\n", num_cpus);

    for (int node = 0; node < num_nodes; node++) {
        long long free_size;
        long long total_size = numa_node_size64(node, &free_size);

        printf("\nNode %d:\n", node);
        printf("  Memory: %lld MB total, %lld MB free\n",
               total_size / (1024*1024), free_size / (1024*1024));

        // Print CPU list for this node
        struct bitmask *cpus = numa_allocate_cpumask();
        numa_node_to_cpus(node, cpus);
        printf("  CPUs: ");
        int first = 1;
        for (int cpu = 0; cpu < num_cpus; cpu++) {
            if (numa_bitmask_isbitset(cpus, cpu)) {
                if (!first) printf(", ");
                printf("%d", cpu);
                first = 0;
            }
        }
        printf("\n");
        numa_free_cpumask(cpus);

        // Print distance to other nodes
        printf("  Distances: ");
        for (int other = 0; other < num_nodes; other++) {
            printf("node%d=%d ", other, numa_distance(node, other));
        }
        printf("\n");
    }
}

int main(void) {
    print_numa_topology();
    return 0;
}
// Compile: gcc -o numa_topology numa_topology.c -lnuma
```

## numactl Process and Memory Binding

### Core numactl Options

```bash
# Bind process and its memory to NUMA node 0
# Both CPU execution and memory allocation happen on node 0
numactl --cpunodebind=0 --membind=0 <command>

# Bind only memory to node 0, allow CPU to run anywhere
# Useful when node 0 has faster memory but fewer available CPUs
numactl --membind=0 <command>

# Preferred node: try node 0 first, fall back to other nodes if insufficient
numactl --preferred=0 <command>

# Interleave memory across nodes (useful for benchmark comparisons)
# Reduces local memory benefit but prevents remote access hot spots
numactl --interleave=all <command>

# Bind to specific CPUs within a NUMA node
numactl --physcpubind=0-11 --membind=0 <command>

# Bind to multiple NUMA nodes (useful for large workloads spanning nodes)
numactl --cpunodebind=0,1 --membind=0,1 <command>

# Check current NUMA policy of a running process
cat /proc/<pid>/numa_maps | head -20

# Check per-node memory usage
numastat -p <process_name>
numastat         # System-wide NUMA statistics
```

### NUMA Policy for System Services

```bash
# /etc/systemd/system/postgresql.service.d/numa.conf
[Service]
# Bind PostgreSQL to NUMA node 0
ExecStart=
ExecStart=/usr/bin/numactl --cpunodebind=0 --membind=0 /usr/lib/postgresql/16/bin/postgres -D /var/lib/postgresql/16/main

# Alternative: use systemd's NumaCPUs/NumaMemory (systemd >= 243)
# NumaCPUs=0
# NumaMemory=0
# NumaPolicy=bind
```

### Memory Policy System Calls

```c
// mem_policy.c - Set memory policy programmatically
#include <numa.h>
#include <numaif.h>
#include <sys/mman.h>
#include <stdlib.h>
#include <stdio.h>

// Allocate memory on a specific NUMA node
void* alloc_on_node(size_t size, int node) {
    struct bitmask *nodemask = numa_allocate_nodemask();
    numa_bitmask_setbit(nodemask, node);

    // Set memory policy for this thread: allocate on specified node
    if (set_mempolicy(MPOL_BIND, nodemask->maskp, nodemask->size + 1) != 0) {
        perror("set_mempolicy");
        numa_free_nodemask(nodemask);
        return NULL;
    }

    void *ptr = malloc(size);

    // Reset to default policy
    set_mempolicy(MPOL_DEFAULT, NULL, 0);

    numa_free_nodemask(nodemask);
    return ptr;
}

// Allocate and touch memory to force physical page placement
void* alloc_and_fault_on_node(size_t size, int node) {
    void *ptr = numa_alloc_onnode(size, node);
    if (!ptr) return NULL;

    // Touch every page to trigger page fault and physical allocation
    volatile char *p = (volatile char*)ptr;
    for (size_t i = 0; i < size; i += 4096) {
        p[i] = 0;
    }

    return ptr;
}

// Migrate existing memory pages to a new NUMA node
int migrate_pages_to_node(void *addr, size_t size, int target_node) {
    struct bitmask *from = numa_allocate_nodemask();
    struct bitmask *to = numa_allocate_nodemask();

    // Move from all nodes to target node
    numa_bitmask_setall(from);
    numa_bitmask_setbit(to, target_node);

    int ret = numa_migrate_pages(0, from, to);

    numa_free_nodemask(from);
    numa_free_nodemask(to);
    return ret;
}

// Check which NUMA node a virtual address is allocated on
int get_page_node(void *addr) {
    int node;
    if (get_mempolicy(&node, NULL, 0, addr, MPOL_F_NODE | MPOL_F_ADDR) != 0) {
        perror("get_mempolicy");
        return -1;
    }
    return node;
}

int main(void) {
    size_t alloc_size = 256 * 1024 * 1024; // 256 MB

    printf("Allocating 256 MB on NUMA node 0\n");
    void *buf = alloc_and_fault_on_node(alloc_size, 0);
    if (!buf) {
        fprintf(stderr, "Allocation failed\n");
        return 1;
    }

    printf("Verifying allocation node: %d\n", get_page_node(buf));

    numa_free(buf, alloc_size);
    return 0;
}
```

## NUMA Balancing

### Automatic NUMA Balancing

Linux kernel automatic NUMA balancing (`numabalancing`) migrates pages based on access patterns, but its overhead can hurt latency-sensitive workloads:

```bash
# Check current NUMA balancing status
cat /proc/sys/kernel/numa_balancing
# 0 = disabled, 1 = enabled

# Disable for latency-sensitive workloads (databases, real-time services)
echo 0 > /proc/sys/kernel/numa_balancing

# Make permanent
echo "kernel.numa_balancing=0" > /etc/sysctl.d/99-numa.conf
sysctl -p /etc/sysctl.d/99-numa.conf

# Monitor NUMA balancing activity (when enabled)
cat /proc/vmstat | grep -E "numa_"
# numa_hit: pages allocated locally
# numa_miss: pages allocated remotely due to policy
# numa_foreign: pages intended for this node allocated on another
# numa_interleave: pages allocated by interleave policy
# numa_local: pages allocated on the node accessed by
# numa_other: pages allocated on a node other than where accessed

# Watch NUMA statistics in real time
watch -n 1 'grep numa /proc/vmstat'
```

### NUMA Balancing Tuning Parameters

```bash
# How often the kernel scans for NUMA misplaced pages (milliseconds)
cat /proc/sys/kernel/numa_balancing_scan_delay_ms
echo 1000 > /proc/sys/kernel/numa_balancing_scan_delay_ms

# Scan period (max time to complete one full scan)
cat /proc/sys/kernel/numa_balancing_scan_period_max_ms
echo 60000 > /proc/sys/kernel/numa_balancing_scan_period_max_ms

# Scan size per iteration (pages)
cat /proc/sys/kernel/numa_balancing_scan_size_mb
echo 256 > /proc/sys/kernel/numa_balancing_scan_size_mb
```

## PostgreSQL NUMA Configuration

### Understanding PostgreSQL's Memory Access Patterns

PostgreSQL shared_buffers, WAL buffers, and work_mem all benefit from NUMA optimization. On a dual-socket system, if PostgreSQL allocates its shared buffer pool across both NUMA nodes but worker processes run primarily on node 0, queries will frequently access remote memory.

```bash
# Check which NUMA node PostgreSQL memory is on
pid=$(pgrep -x postgres | head -1)
cat /proc/$pid/numa_maps | awk '
/huge|heap|stack|shm/ {
    split($2, a, "=")
    node[a[2]]++
    total++
}
END {
    for (n in node)
        printf "Node %s: %d pages (%.1f%%)\n", n, node[n], node[n]*100/total
}'
```

### PostgreSQL NUMA-Aware Startup

```bash
# /etc/systemd/system/postgresql@.service.d/numa-binding.conf
[Service]
ExecStart=
ExecStart=/usr/bin/numactl \
    --cpunodebind=0 \
    --membind=0 \
    /usr/lib/postgresql/%i/bin/postgres \
    -D /var/lib/postgresql/%i/main \
    -c config_file=/etc/postgresql/%i/main/postgresql.conf
```

### postgresql.conf NUMA Optimizations

```ini
# /etc/postgresql/16/main/postgresql.conf
# NUMA-optimized PostgreSQL configuration for a 2-socket server
# Assuming binding to NUMA node 0 with 256 GB RAM

# Shared buffer pool: set to ~25% of node's local memory
# With NUMA binding to node 0 (256 GB), use ~64 GB
shared_buffers = 64GB

# Effective cache size: total RAM available to PostgreSQL (including OS page cache)
# For single-node binding, use ~75% of node memory
effective_cache_size = 192GB

# Work memory: per-sort/hash operation memory
# Tune carefully - too high causes remote memory allocation on large queries
work_mem = 256MB

# Maintenance operations memory
maintenance_work_mem = 4GB

# WAL buffers: keep in local memory
wal_buffers = 64MB

# Disable huge pages if your NUMA node doesn't support them uniformly
# or enable and verify huge pages are allocated on the correct node
huge_pages = try

# Parallel query workers: limit to cores on local NUMA node
# For a 24-core node 0: use max 8-12 workers to leave headroom
max_parallel_workers_per_gather = 8
max_parallel_workers = 16
max_worker_processes = 24

# Connection pooling: use PgBouncer pinned to same NUMA node
# Direct connections have overhead from cross-socket memory if spawning
# backend processes land on different nodes
max_connections = 200
```

### NUMA-Aware pgbouncer Deployment

```ini
# /etc/pgbouncer/pgbouncer.ini
[databases]
production = host=localhost port=5432 dbname=production

[pgbouncer]
pool_mode = transaction
max_client_conn = 2000
default_pool_size = 20
server_lifetime = 3600
server_idle_timeout = 60

# Server-side connection affinity
# Ensure pgbouncer runs on the same NUMA node as PostgreSQL
# Start with: numactl --cpunodebind=0 --membind=0 pgbouncer /etc/pgbouncer/pgbouncer.ini
```

```bash
# NUMA-aware PostgreSQL + pgbouncer startup script
#!/bin/bash
# /usr/local/bin/start-postgres-numa.sh

NUMA_NODE=0
PG_VERSION=16
PG_USER=postgres

# Verify node has sufficient free memory
NODE_FREE=$(numactl --hardware | grep "node $NUMA_NODE free:" | awk '{print $4}')
echo "NUMA node $NUMA_NODE free memory: ${NODE_FREE} MB"

if [ "$NODE_FREE" -lt 131072 ]; then  # 128 GB minimum
    echo "WARNING: Insufficient local memory on node $NUMA_NODE"
    echo "Consider using interleave mode or adjusting shared_buffers"
fi

# Start PostgreSQL pinned to NUMA node
echo "Starting PostgreSQL on NUMA node $NUMA_NODE"
numactl \
    --cpunodebind=$NUMA_NODE \
    --membind=$NUMA_NODE \
    su -c "/usr/lib/postgresql/$PG_VERSION/bin/pg_ctl start \
           -D /var/lib/postgresql/$PG_VERSION/main \
           -l /var/log/postgresql/startup.log" \
    $PG_USER

# Start pgbouncer on same node
echo "Starting pgbouncer on NUMA node $NUMA_NODE"
numactl \
    --cpunodebind=$NUMA_NODE \
    --membind=$NUMA_NODE \
    pgbouncer -d /etc/pgbouncer/pgbouncer.ini
```

### PostgreSQL NUMA Monitoring Queries

```sql
-- Check backend process distribution across NUMA nodes
-- Requires pg_numa extension or external monitoring
SELECT
    pid,
    application_name,
    state,
    query_start,
    wait_event_type,
    wait_event
FROM pg_stat_activity
WHERE state != 'idle'
ORDER BY query_start;

-- Monitor shared_buffers hit ratio (high hit rate reduces cross-NUMA traffic)
SELECT
    schemaname,
    tablename,
    heap_blks_read,
    heap_blks_hit,
    ROUND(100.0 * heap_blks_hit / NULLIF(heap_blks_hit + heap_blks_read, 0), 2) AS hit_pct
FROM pg_statio_user_tables
WHERE heap_blks_hit + heap_blks_read > 1000
ORDER BY heap_blks_read DESC
LIMIT 20;

-- Check for large sequential scans (these stress memory bandwidth significantly)
SELECT
    schemaname,
    tablename,
    seq_scan,
    seq_tup_read,
    pg_size_pretty(pg_relation_size(schemaname||'.'||tablename)) AS table_size
FROM pg_stat_user_tables
WHERE seq_scan > 100
ORDER BY seq_tup_read DESC
LIMIT 10;
```

## Application-Level NUMA Awareness in C

### NUMA-Aware Thread Pool

```c
// numa_threadpool.c
#include <numa.h>
#include <pthread.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

#define MAX_THREADS_PER_NODE 32
#define MAX_NODES 8

typedef struct {
    int node_id;
    int thread_id;
    void *(*work_fn)(void*);
    void *work_data;
} thread_args_t;

typedef struct {
    pthread_t threads[MAX_THREADS_PER_NODE];
    int num_threads;
    int node_id;
} numa_node_pool_t;

typedef struct {
    numa_node_pool_t nodes[MAX_NODES];
    int num_nodes;
} numa_thread_pool_t;

static void* thread_main(void *arg) {
    thread_args_t *args = (thread_args_t*)arg;

    // Bind this thread to its assigned NUMA node
    struct bitmask *nodemask = numa_allocate_nodemask();
    numa_bitmask_setbit(nodemask, args->node_id);

    if (numa_run_on_node(args->node_id) != 0) {
        perror("numa_run_on_node");
    }

    // Set memory policy to prefer local node
    if (set_mempolicy(MPOL_PREFERRED, nodemask->maskp, nodemask->size + 1) != 0) {
        perror("set_mempolicy");
    }

    numa_free_nodemask(nodemask);

    printf("Thread %d starting on NUMA node %d\n", args->thread_id, args->node_id);

    void *result = args->work_fn(args->work_data);
    free(args);
    return result;
}

numa_thread_pool_t* create_numa_pool(int threads_per_node) {
    if (numa_available() < 0) {
        fprintf(stderr, "NUMA not available\n");
        return NULL;
    }

    numa_thread_pool_t *pool = malloc(sizeof(numa_thread_pool_t));
    memset(pool, 0, sizeof(*pool));

    pool->num_nodes = numa_max_node() + 1;

    for (int node = 0; node < pool->num_nodes; node++) {
        pool->nodes[node].node_id = node;
        pool->nodes[node].num_threads = threads_per_node;
    }

    return pool;
}

void submit_work_to_node(numa_thread_pool_t *pool, int node_id,
                          void *(*work_fn)(void*), void *data) {
    if (node_id >= pool->num_nodes) {
        fprintf(stderr, "Invalid node_id %d\n", node_id);
        return;
    }

    thread_args_t *args = malloc(sizeof(thread_args_t));
    args->node_id = node_id;
    args->work_fn = work_fn;
    args->work_data = data;

    // In a real pool, submit to a work queue per node
    // This simplified version creates a new thread per task
    pthread_t tid;
    pthread_create(&tid, NULL, thread_main, args);
    pthread_detach(tid);
}
```

## NUMA Awareness in Go

### Go Runtime NUMA Configuration

Go's runtime does not natively bind to NUMA nodes, but you can influence NUMA behavior through environment variables and OS-level binding:

```bash
# Start a Go service pinned to NUMA node 0
numactl --cpunodebind=0 --membind=0 ./my-go-service

# For services managed by systemd
# /etc/systemd/system/my-go-service.service
[Service]
ExecStart=/usr/bin/numactl --cpunodebind=0 --membind=0 /usr/local/bin/my-go-service
Environment=GOMAXPROCS=24  # Limit to cores on node 0
```

### Go NUMA-Aware Memory Allocation via cgo

```go
// numa_alloc.go
package numa

// #cgo LDFLAGS: -lnuma
// #include <numa.h>
// #include <stdlib.h>
//
// void* numa_alloc_on_node(size_t size, int node) {
//     return numa_alloc_onnode(size, node);
// }
//
// void numa_dealloc(void* ptr, size_t size) {
//     numa_free(ptr, size);
// }
//
// int get_current_node(void) {
//     return numa_node_of_cpu(sched_getcpu());
// }
//
// int numa_node_count(void) {
//     return numa_max_node() + 1;
// }
import "C"
import (
    "fmt"
    "unsafe"
)

// Buffer is a byte slice allocated on a specific NUMA node.
type Buffer struct {
    ptr  unsafe.Pointer
    size int
    node int
}

// NewBuffer allocates a buffer on the specified NUMA node.
// The caller must call Free() to release the memory.
func NewBuffer(size int, node int) (*Buffer, error) {
    if C.numa_available() < 0 {
        return nil, fmt.Errorf("NUMA not available on this system")
    }

    ptr := C.numa_alloc_on_node(C.size_t(size), C.int(node))
    if ptr == nil {
        return nil, fmt.Errorf("NUMA allocation of %d bytes on node %d failed", size, node)
    }

    return &Buffer{
        ptr:  ptr,
        size: size,
        node: node,
    }, nil
}

// Bytes returns the buffer as a Go byte slice.
// WARNING: Do not let this slice escape after calling Free().
func (b *Buffer) Bytes() []byte {
    return (*[1 << 30]byte)(b.ptr)[:b.size:b.size]
}

// Free releases the NUMA-allocated memory.
func (b *Buffer) Free() {
    if b.ptr != nil {
        C.numa_dealloc(b.ptr, C.size_t(b.size))
        b.ptr = nil
    }
}

// CurrentNode returns the NUMA node of the current CPU.
func CurrentNode() int {
    return int(C.get_current_node())
}

// NodeCount returns the number of NUMA nodes.
func NodeCount() int {
    return int(C.numa_node_count())
}
```

### NUMA-Aware Buffer Pool in Go

```go
// numa_pool.go
package numa

import (
    "runtime"
    "sync"
)

// NodeLocalPool maintains a separate sync.Pool per NUMA node,
// reducing cross-node memory allocation in pool operations.
type NodeLocalPool[T any] struct {
    pools []*sync.Pool
    newFn func() T
}

// NewNodeLocalPool creates a pool with one sync.Pool per NUMA node.
func NewNodeLocalPool[T any](newFn func() T) *NodeLocalPool[T] {
    nodeCount := NodeCount()
    if nodeCount <= 0 {
        nodeCount = 1
    }

    pools := make([]*sync.Pool, nodeCount)
    for i := range pools {
        pools[i] = &sync.Pool{New: func() interface{} {
            return newFn()
        }}
    }

    return &NodeLocalPool[T]{
        pools: pools,
        newFn: newFn,
    }
}

// Get retrieves an item from the pool local to the current NUMA node.
func (p *NodeLocalPool[T]) Get() T {
    node := p.currentNode()
    return p.pools[node].Get().(T)
}

// Put returns an item to the pool local to the current NUMA node.
func (p *NodeLocalPool[T]) Put(val T) {
    node := p.currentNode()
    p.pools[node].Put(val)
}

func (p *NodeLocalPool[T]) currentNode() int {
    // Lock OS thread to prevent goroutine migration between calls
    // This is important for correctness when querying current CPU/node
    runtime.LockOSThread()
    defer runtime.UnlockOSThread()

    node := CurrentNode()
    if node < 0 || node >= len(p.pools) {
        return 0
    }
    return node
}
```

## Monitoring NUMA Performance

### Key Metrics and Commands

```bash
#!/usr/bin/env bash
# numa-monitor.sh - Comprehensive NUMA monitoring script

echo "=== NUMA Statistics ==="
numastat

echo ""
echo "=== Per-Node Memory Usage ==="
for node in /sys/devices/system/node/node*/; do
    nodeid=$(basename "$node" | sed 's/node//')
    meminfo="$node/meminfo"
    total=$(awk '/MemTotal/{print $4}' "$meminfo")
    free=$(awk '/MemFree/{print $4}' "$meminfo")
    used=$((total - free))
    pct=$((used * 100 / total))
    printf "Node %s: %d MB used / %d MB total (%d%%)\n" \
        "$nodeid" "$((used/1024))" "$((total/1024))" "$pct"
done

echo ""
echo "=== NUMA Hit/Miss Rates ==="
awk '
/numa_hit/{hit=$2}
/numa_miss/{miss=$2}
END{
    total=hit+miss
    if(total>0)
        printf "Hit rate: %.2f%% (%d hits, %d misses)\n", hit*100/total, hit, miss
}' /proc/vmstat

echo ""
echo "=== Top Processes by NUMA Remote Access ==="
# Requires numastat -p or perf stat
for pid in $(ls /proc | grep '^[0-9]' | head -20); do
    if [ -f "/proc/$pid/numa_maps" ]; then
        remote=$(awk '/^[^ ]*/ {
            for(i=1;i<=NF;i++) {
                if($i~/^N[0-9]+=/) {
                    split($i,a,"=")
                    n=substr(a[1],2)
                    c=a[2]
                    if(n!=local) remote+=c
                    else local_count+=c
                }
            }
        } END{print remote+0}' /proc/$pid/numa_maps 2>/dev/null)
        if [ "$remote" -gt 10000 ] 2>/dev/null; then
            name=$(cat /proc/$pid/comm 2>/dev/null)
            printf "PID %s (%s): %s remote pages\n" "$pid" "$name" "$remote"
        fi
    fi
done

echo ""
echo "=== Cache Line Migrations (CPU-specific) ==="
perf stat -e cache-misses,cache-references \
    -a --no-aggr sleep 5 2>&1 | grep -E "cache|CPU"
```

### Prometheus NUMA Metrics

```yaml
# node-exporter additional collectors for NUMA
# /etc/prometheus/node_exporter_collectors.txt
--collector.textfile.directory=/var/lib/node_exporter/textfile_collector

# /usr/local/bin/collect-numa-metrics.sh (run via cron every minute)
#!/bin/bash
OUTPUT=/var/lib/node_exporter/textfile_collector/numa_metrics.prom

{
    echo "# HELP node_numa_hit_total Pages successfully allocated on intended NUMA node"
    echo "# TYPE node_numa_hit_total counter"
    awk '/numa_hit/{printf "node_numa_hit_total %s\n", $2}' /proc/vmstat

    echo "# HELP node_numa_miss_total Pages that had to be allocated on a different NUMA node"
    echo "# TYPE node_numa_miss_total counter"
    awk '/numa_miss/{printf "node_numa_miss_total %s\n", $2}' /proc/vmstat

    echo "# HELP node_numa_foreign_total Pages that were intended for local node but allocated elsewhere"
    echo "# TYPE node_numa_foreign_total counter"
    awk '/numa_foreign/{printf "node_numa_foreign_total %s\n", $2}' /proc/vmstat

    # Per-node free memory
    for node in /sys/devices/system/node/node*/; do
        nodeid=$(basename "$node" | sed 's/node//')
        free=$(awk '/MemFree/{print $4*1024}' "${node}/meminfo")
        echo "node_numa_free_bytes{node=\"$nodeid\"} $free"
    done
} > "$OUTPUT"
```

## Key Takeaways

NUMA optimization is one of the highest-leverage performance improvements available for multi-socket server workloads, but it requires understanding the specific memory access patterns of your application.

**Topology-first design**: Before optimizing, use `numactl --hardware` and `lstopo` to map your hardware topology. Understand which CPU cores are on which nodes, the inter-node distances, and available memory per node. This informs all subsequent decisions.

**Pin memory-intensive workloads to single nodes**: Database processes, in-memory caches, and analytics engines that fit within a single NUMA node's memory should be bound using `numactl --cpunodebind=N --membind=N`. This eliminates remote memory access entirely for the common case.

**Disable NUMA balancing for latency-sensitive workloads**: Automatic NUMA balancing causes periodic page migrations that introduce latency spikes. For databases and real-time services, disable it with `kernel.numa_balancing=0` and manage placement explicitly.

**PostgreSQL shared_buffers must fit in local node memory**: The single most impactful PostgreSQL NUMA optimization is ensuring that shared_buffers is sized to fit entirely in the local NUMA node's memory. Cross-node buffer cache access creates constant memory bus traffic that limits query throughput.

**Monitor NUMA miss rates in production**: High `numa_miss` rates in `/proc/vmstat` indicate processes are frequently allocating on non-preferred nodes. The target for well-optimized workloads is greater than 95% NUMA hit rate.

**Go applications benefit from OS-level binding**: Since the Go runtime does not natively support NUMA, use `numactl` to bind Go services at the process level and set `GOMAXPROCS` to the number of cores on the target node to prevent goroutine scheduling across NUMA boundaries.
