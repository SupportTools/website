---
title: "Linux NUMA-Aware Memory Allocation: numactl, libnuma, and Kernel Policies"
date: 2029-07-30T00:00:00-05:00
draft: false
tags: ["Linux", "NUMA", "Memory", "Performance", "Kernel", "numactl", "libnuma"]
categories: ["Linux", "Performance", "Systems Programming"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to NUMA-aware memory allocation on Linux: distance matrices, binding modes, first-touch policy, kernel NUMA balancing, transparent NUMA migration, and application tuning for database and HPC workloads."
more_link: "yes"
url: "/linux-numa-aware-memory-allocation-numactl-libnuma-kernel-policies/"
---

Non-Uniform Memory Access (NUMA) is the memory architecture of every modern multi-socket server. When a process running on CPU socket 0 accesses memory attached to socket 1, that access traverses an inter-socket interconnect and can be 1.5x to 3x slower than a local access. On a busy 64-core, 4-socket machine, the difference between NUMA-aware and NUMA-oblivious memory allocation can mean the difference between a database sustaining 500K queries per second and 200K queries per second. This guide covers every layer of NUMA memory management, from the hardware topology to kernel policies to application-level allocation strategies.

<!--more-->

# Linux NUMA-Aware Memory Allocation: numactl, libnuma, and Kernel Policies

## Understanding NUMA Topology

### The NUMA Distance Matrix

Every NUMA node has a distance to every other NUMA node. Distance 10 means local access. Distances above 10 represent the cost of accessing remote memory:

```bash
# Display NUMA topology
numactl --hardware

# Example output on a 4-socket system:
# available: 4 nodes (0-3)
# node 0 cpus: 0 1 2 3 4 5 6 7 32 33 34 35 36 37 38 39
# node 0 size: 65536 MB
# node 0 free: 62145 MB
# node 1 cpus: 8 9 10 11 12 13 14 15 40 41 42 43 44 45 46 47
# node 1 size: 65536 MB
# node 1 free: 61890 MB
# ...
# node distances:
# node   0   1   2   3
#   0:  10  21  31  31
#   1:  21  10  31  21
#   2:  31  31  10  21
#   3:  31  21  21  10

# More detailed topology
lstopo --of txt
# or graphical
lstopo

# Show NUMA statistics
numastat

# Per-process NUMA stats
numastat -p <pid>

# Show memory per NUMA node
cat /sys/devices/system/node/node*/meminfo
```

### Inspecting NUMA Topology Programmatically

```bash
# Node count
cat /sys/devices/system/node/online

# CPUs per node
for node in /sys/devices/system/node/node*; do
    echo "$(basename $node): $(cat $node/cpulist)"
done

# Memory per node (in kB)
for node in /sys/devices/system/node/node*; do
    echo "$(basename $node): $(grep MemTotal $node/meminfo | awk '{print $4}') kB"
done

# NUMA distance matrix
for src in /sys/devices/system/node/node*/distance; do
    echo "$(dirname $src | xargs basename): $(cat $src)"
done
```

### Reading NUMA Statistics

```bash
# numastat output explanation
numastat
#                            node0           node1
# numa_hit                   5123456          203456  <- Allocations satisfied from local node
# numa_miss                    45678          189012  <- Allocations that had to go remote
# numa_foreign                189012           45678  <- Allocations made here for a remote node
# interleave_hit               12345            9876  <- Interleaved allocations
# local_node                 5023456          193456  <- Allocations from tasks running on this node
# other_node                  100000           10000  <- Allocations from tasks on other nodes

# Miss rate = numa_miss / (numa_hit + numa_miss)
# A miss rate above 5% on a latency-sensitive workload needs investigation
```

## numactl: Controlling NUMA Policy from the Command Line

### Binding Processes to NUMA Nodes

```bash
# Run a process bound to node 0 CPUs and memory
numactl --cpunodebind=0 --membind=0 -- my-database --config /etc/mydb.conf

# Bind to a specific CPU range with memory on the same node
numactl --physcpubind=0-7 --membind=0 -- my-app

# Interleave memory across all nodes (good for shared memory)
numactl --interleave=all -- my-shared-memory-app

# Bind to nearest available NUMA node (locality first)
numactl --localalloc -- my-app

# Preferred node but fall back to others if unavailable
numactl --preferred=0 -- my-app

# Verify NUMA policy of a running process
numastat -p $(pgrep my-app)
cat /proc/$(pgrep my-app)/numa_maps
```

### numactl for Database Workloads

```bash
#!/bin/bash
# start-postgres-numa.sh

POSTGRES_BINARY="/usr/lib/postgresql/16/bin/postgres"
POSTGRES_DATA="/var/lib/postgresql/16/main"
POSTGRES_CONFIG="/etc/postgresql/16/main/postgresql.conf"

# Detect available NUMA nodes
NUMA_NODES=$(numactl --hardware | grep "available:" | awk '{print $2}')

if [[ "$NUMA_NODES" -eq 1 ]]; then
    echo "Single NUMA node system, no binding needed"
    exec "$POSTGRES_BINARY" -D "$POSTGRES_DATA" -c config_file="$POSTGRES_CONFIG"
fi

# Bind PostgreSQL to node 0 for consistent latency
# Use node 0 because it typically has lowest average distance to other nodes
echo "Binding PostgreSQL to NUMA node 0 ($NUMA_NODES nodes available)"
exec numactl \
    --cpunodebind=0 \
    --membind=0 \
    -- "$POSTGRES_BINARY" -D "$POSTGRES_DATA" -c config_file="$POSTGRES_CONFIG"
```

```bash
# start-redis-numa.sh - Redis benefits from memory interleaving
#!/bin/bash

exec numactl \
    --interleave=all \
    -- redis-server /etc/redis/redis.conf
```

### numactl in Kubernetes via CPU Manager

```yaml
# kubernetes-numa-pod.yaml
apiVersion: v1
kind: Pod
metadata:
  name: numa-aware-db
spec:
  containers:
    - name: postgres
      image: postgres:16
      resources:
        requests:
          cpu: "8"       # Request whole CPUs
          memory: "32Gi"
        limits:
          cpu: "8"       # Guaranteed QoS requires equal limits
          memory: "32Gi"
      # CPU Manager with static policy will pin this pod to specific CPUs
      # NUMA Topology Manager ensures CPU and memory are co-located
---
# Node configuration for NUMA-aware Kubernetes
# /var/lib/kubelet/config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cpuManagerPolicy: static
topologyManagerPolicy: single-numa-node  # or: best-effort, restricted
topologyManagerScope: pod
```

## libnuma: Programmatic NUMA Control

### Basic libnuma Usage in C

```c
#include <numa.h>
#include <numaif.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void print_numa_info(void) {
    if (numa_available() < 0) {
        fprintf(stderr, "NUMA not available\n");
        return;
    }

    printf("NUMA nodes: %d\n", numa_num_configured_nodes());
    printf("Max node: %d\n", numa_max_node());
    printf("Configured CPUs: %d\n", numa_num_configured_cpus());

    for (int node = 0; node <= numa_max_node(); node++) {
        long size_free, size_total;
        numa_node_size64(node, &size_free);
        printf("Node %d: %ld MB free\n", node, size_free / (1024 * 1024));
    }
}

void demonstrate_numa_allocation(void) {
    const size_t ALLOC_SIZE = 1024 * 1024 * 256; // 256 MB

    // Allocate on node 0
    void *mem_node0 = numa_alloc_onnode(ALLOC_SIZE, 0);
    if (!mem_node0) {
        fprintf(stderr, "Failed to allocate on node 0\n");
        return;
    }

    // Allocate interleaved across all nodes
    void *mem_interleaved = numa_alloc_interleaved(ALLOC_SIZE);
    if (!mem_interleaved) {
        fprintf(stderr, "Failed to allocate interleaved\n");
        numa_free(mem_node0, ALLOC_SIZE);
        return;
    }

    // Touch pages to trigger physical allocation
    memset(mem_node0, 0, ALLOC_SIZE);
    memset(mem_interleaved, 0, ALLOC_SIZE);

    printf("Allocated 256MB on node 0 at %p\n", mem_node0);
    printf("Allocated 256MB interleaved at %p\n", mem_interleaved);

    numa_free(mem_node0, ALLOC_SIZE);
    numa_free(mem_interleaved, ALLOC_SIZE);
}

// NUMA-aware memory pool
struct numa_pool {
    void **regions;
    size_t *sizes;
    int *nodes;
    int count;
};

struct numa_pool *create_distributed_pool(size_t size_per_node) {
    int num_nodes = numa_num_configured_nodes();
    struct numa_pool *pool = malloc(sizeof(struct numa_pool));

    pool->regions = malloc(num_nodes * sizeof(void *));
    pool->sizes = malloc(num_nodes * sizeof(size_t));
    pool->nodes = malloc(num_nodes * sizeof(int));
    pool->count = num_nodes;

    for (int i = 0; i < num_nodes; i++) {
        pool->regions[i] = numa_alloc_onnode(size_per_node, i);
        pool->sizes[i] = size_per_node;
        pool->nodes[i] = i;

        if (!pool->regions[i]) {
            // Cleanup on partial failure
            for (int j = 0; j < i; j++) {
                numa_free(pool->regions[j], pool->sizes[j]);
            }
            free(pool->regions);
            free(pool->sizes);
            free(pool->nodes);
            free(pool);
            return NULL;
        }

        // Touch memory to force physical allocation
        memset(pool->regions[i], 0, size_per_node);
    }

    return pool;
}

// Get memory region local to current CPU
void *get_local_region(struct numa_pool *pool) {
    int current_node = numa_node_of_cpu(sched_getcpu());
    return pool->regions[current_node];
}
```

### Go with NUMA-Aware Memory Using CGo

```go
package numa

/*
#cgo LDFLAGS: -lnuma
#include <numa.h>
#include <numaif.h>
#include <stdlib.h>

int numa_is_available() {
    return numa_available() >= 0;
}

void* alloc_on_node(size_t size, int node) {
    return numa_alloc_onnode(size, node);
}

void free_numa(void *ptr, size_t size) {
    numa_free(ptr, size);
}

int get_current_node() {
    return numa_node_of_cpu(sched_getcpu());
}

int get_node_count() {
    return numa_num_configured_nodes();
}
*/
import "C"
import (
    "fmt"
    "unsafe"
)

// NUMAAllocator allocates memory on specific NUMA nodes
type NUMAAllocator struct {
    nodeCount int
}

func NewNUMAAllocator() (*NUMAAllocator, error) {
    if C.numa_is_available() == 0 {
        return nil, fmt.Errorf("NUMA not available on this system")
    }
    return &NUMAAllocator{nodeCount: int(C.get_node_count())}, nil
}

// AllocOnNode allocates size bytes on the specified NUMA node
func (a *NUMAAllocator) AllocOnNode(size int, node int) (unsafe.Pointer, error) {
    if node >= a.nodeCount {
        return nil, fmt.Errorf("node %d does not exist (max: %d)", node, a.nodeCount-1)
    }

    ptr := C.alloc_on_node(C.size_t(size), C.int(node))
    if ptr == nil {
        return nil, fmt.Errorf("NUMA allocation of %d bytes on node %d failed", size, node)
    }

    return ptr, nil
}

// CurrentNode returns the NUMA node of the currently executing CPU
func (a *NUMAAllocator) CurrentNode() int {
    return int(C.get_current_node())
}

// Free releases NUMA-allocated memory
func (a *NUMAAllocator) Free(ptr unsafe.Pointer, size int) {
    C.free_numa(ptr, C.size_t(size))
}
```

## First-Touch Memory Policy

The Linux kernel's default memory allocation policy is "first-touch": physical pages are allocated on the NUMA node of the thread that first writes to them. This means the layout of your initialization code determines the memory affinity of your data.

### First-Touch Performance Implications

```c
#include <pthread.h>
#include <numa.h>
#include <stdio.h>

#define ARRAY_SIZE (256 * 1024 * 1024 / sizeof(double)) // 256 MB

// BAD: Main thread (possibly on node 0) initializes all memory
// Workers on other nodes will experience remote access
double *bad_init_array(void) {
    double *arr = malloc(ARRAY_SIZE * sizeof(double));

    // Main thread touches ALL pages - they all land on node 0
    for (size_t i = 0; i < ARRAY_SIZE; i++) {
        arr[i] = 0.0;
    }

    return arr;
}

// GOOD: Each worker thread initializes its own partition
struct init_args {
    double *arr;
    size_t start;
    size_t count;
    int node;
};

void *thread_init(void *arg) {
    struct init_args *a = (struct init_args *)arg;

    // Pin this thread to the target NUMA node
    struct bitmask *mask = numa_allocate_cpumask();
    numa_node_to_cpus(a->node, mask);
    numa_sched_setaffinity(0, mask);
    numa_free_cpumask(mask);

    // Now initialize memory - will be first-touched by this thread
    // Physical pages will be allocated on this thread's NUMA node
    for (size_t i = a->start; i < a->start + a->count; i++) {
        a->arr[i] = 0.0;
    }

    return NULL;
}

double *good_init_array(int num_nodes) {
    double *arr = malloc(ARRAY_SIZE * sizeof(double));
    size_t per_node = ARRAY_SIZE / num_nodes;

    pthread_t *threads = malloc(num_nodes * sizeof(pthread_t));
    struct init_args *args = malloc(num_nodes * sizeof(struct init_args));

    for (int i = 0; i < num_nodes; i++) {
        args[i].arr = arr;
        args[i].start = i * per_node;
        args[i].count = per_node;
        args[i].node = i;
        pthread_create(&threads[i], NULL, thread_init, &args[i]);
    }

    for (int i = 0; i < num_nodes; i++) {
        pthread_join(threads[i], NULL);
    }

    free(threads);
    free(args);
    return arr;
}
```

### Verifying First-Touch Placement

```bash
# Check where pages are physically located after allocation
# /proc/PID/numa_maps shows virtual address ranges and their NUMA policy + actual placement

# Example output:
# 7f8b4c000000 default anon=16384 dirty=16384 N0=12288 N1=4096 kernelpagesize_kB=4
# Address: 7f8b4c000000
# Policy: default (first-touch)
# anon=16384: 16384 anonymous pages
# dirty=16384: pages modified
# N0=12288: 12288 pages on node 0 (75%)
# N1=4096: 4096 pages on node 1 (25%)

cat /proc/$(pgrep myapp)/numa_maps | head -20

# Check a specific address range
cat /proc/$(pgrep myapp)/smaps | grep -A 20 "7f8b4c000000"
```

## Kernel NUMA Balancing

The Linux kernel has a NUMA balancing subsystem (CONFIG_NUMA_BALANCING) that automatically migrates memory pages toward the NUMA node where they are most frequently accessed.

### Configuring NUMA Balancing

```bash
# Check if NUMA balancing is enabled
cat /proc/sys/kernel/numa_balancing

# Enable (default on modern kernels)
echo 1 > /proc/sys/kernel/numa_balancing

# Disable for latency-sensitive applications with static NUMA placement
echo 0 > /proc/sys/kernel/numa_balancing

# NUMA balancing tuning parameters
# How frequently to scan memory for NUMA migrations (milliseconds)
cat /proc/sys/kernel/numa_balancing_scan_delay_ms       # default: 1000
cat /proc/sys/kernel/numa_balancing_scan_period_min_ms  # default: 1000
cat /proc/sys/kernel/numa_balancing_scan_period_max_ms  # default: 60000
cat /proc/sys/kernel/numa_balancing_scan_size_mb        # default: 256

# Reduce scan overhead for databases with stable memory access patterns
sysctl -w kernel.numa_balancing_scan_period_max_ms=600000
sysctl -w kernel.numa_balancing_scan_size_mb=64
```

### Monitoring NUMA Migration Activity

```bash
# Check NUMA migration statistics
grep -i "numa" /proc/vmstat

# Key metrics:
# numa_page_alloc: Pages allocated on the wrong node
# numa_pte_updates: PTE scans for NUMA balancing
# numa_hint_faults: Page faults triggered by NUMA balancing hints
# numa_hint_faults_local: Hint faults that were already local
# numa_pages_migrated: Pages migrated by NUMA balancing
# numa_migrate_throttled: Migrations blocked due to rate limiting

# If numa_pages_migrated is very high, NUMA balancing is doing a lot of work
# This indicates either a workload with changing locality or over-active scanning

# Watch NUMA migration rate
watch -n 1 "grep numa_pages_migrated /proc/vmstat"

# Per-process NUMA stats (Linux 5.x+)
cat /proc/$(pgrep myapp)/status | grep Numa
```

## Transparent Huge Pages and NUMA

Transparent Huge Pages (THP) interact with NUMA in important ways: a 2MB huge page must reside entirely on one NUMA node, which affects the granularity of NUMA migration.

```bash
# THP settings
cat /sys/kernel/mm/transparent_hugepage/enabled  # [always] madvise never

# For NUMA-sensitive workloads, use madvise mode
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled

# Then selectively enable THP for specific allocations
# madvise(ptr, size, MADV_HUGEPAGE);

# Check THP usage per NUMA node
grep AnonHugePages /sys/devices/system/node/node*/meminfo
```

## Application Tuning: Database Workloads

### PostgreSQL NUMA Tuning

```bash
# postgresql.conf NUMA-related settings

# For a 4-socket system, split work_mem per node
# If you have 4 nodes and 256GB total, allocate ~64GB per node's worth of work
# Keep shared_buffers within one NUMA node if possible

# Systemd unit with NUMA binding
cat > /etc/systemd/system/postgresql.service.d/numa.conf <<EOF
[Service]
# Bind to specific NUMA nodes
ExecStart=
ExecStart=/usr/bin/numactl --cpunodebind=0,1 --membind=0,1 /usr/lib/postgresql/16/bin/postgres -D /var/lib/postgresql/16/main -c config_file=/etc/postgresql/16/main/postgresql.conf
EOF

systemctl daemon-reload
systemctl restart postgresql
```

```sql
-- Verify PostgreSQL NUMA usage
SELECT * FROM pg_stat_activity LIMIT 1;

-- Check backend process NUMA placement
SELECT pid, query, now() - query_start AS duration
FROM pg_stat_activity
WHERE state = 'active';

-- Then check each backend's NUMA stats:
-- numastat -p <pid>
```

### Redis NUMA Tuning

```bash
# Redis benefits from memory interleaving because its data structures
# are accessed by clients running on any CPU

# /etc/systemd/system/redis.service.d/numa.conf
[Service]
ExecStart=
ExecStart=/usr/bin/numactl --interleave=all /usr/bin/redis-server /etc/redis/redis.conf
```

### JVM NUMA Configuration

```bash
# JVM NUMA awareness (works with G1GC and ZGC)
java \
  -XX:+UseNUMA \
  -XX:+UseG1GC \
  -Xms32g -Xmx32g \
  -XX:+AlwaysPreTouch \
  -jar myapp.jar

# UseNUMA causes the JVM to allocate Eden spaces on each NUMA node
# AlwaysPreTouch ensures pages are physically allocated at startup,
# triggering first-touch allocation on the startup threads

# For JVM applications, use numactl to ensure the startup thread
# (which triggers AlwaysPreTouch) is on the target node
numactl --cpunodebind=0 --membind=0 java \
  -XX:+UseNUMA \
  -XX:+UseG1GC \
  -Xms32g -Xmx32g \
  -XX:+AlwaysPreTouch \
  -jar myapp.jar
```

## NUMA Benchmarking and Measurement

### stream Benchmark for NUMA Validation

```bash
# Install stream benchmark
apt-get install stream

# Run on a single NUMA node
numactl --cpunodebind=0 --membind=0 stream

# Run across all nodes (interleaved)
numactl --interleave=all stream

# Compare results
# Local memory: ~300 GB/s on modern systems
# Remote memory: ~150-200 GB/s (depends on interconnect)
# If you're getting remote bandwidth on a process that should be local,
# your first-touch policy is wrong
```

### Writing a Custom NUMA Benchmark

```c
// numa-bench.c
#include <numa.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <string.h>

#define SIZE (256 * 1024 * 1024)  // 256 MB

double measure_bandwidth(void *src, void *dst, size_t size) {
    struct timespec start, end;

    // Warm up
    memcpy(dst, src, size);

    clock_gettime(CLOCK_MONOTONIC, &start);

    // 10 iterations
    for (int i = 0; i < 10; i++) {
        memcpy(dst, src, size);
    }

    clock_gettime(CLOCK_MONOTONIC, &end);

    double elapsed = (end.tv_sec - start.tv_sec) +
                     (end.tv_nsec - start.tv_nsec) / 1e9;

    // bytes / second, converted to GB/s
    return (10.0 * size) / (elapsed * 1e9);
}

int main(void) {
    if (numa_available() < 0) {
        fprintf(stderr, "NUMA not available\n");
        return 1;
    }

    int num_nodes = numa_num_configured_nodes();
    printf("Testing NUMA bandwidth between %d nodes\n\n", num_nodes);
    printf("%-8s %-8s %12s\n", "Src", "Dst", "BW (GB/s)");
    printf("%-8s %-8s %12s\n", "---", "---", "---------");

    for (int src_node = 0; src_node < num_nodes; src_node++) {
        for (int dst_node = 0; dst_node < num_nodes; dst_node++) {
            void *src = numa_alloc_onnode(SIZE, src_node);
            void *dst = numa_alloc_onnode(SIZE, dst_node);

            if (!src || !dst) {
                fprintf(stderr, "Allocation failed\n");
                continue;
            }

            // Touch pages on their respective nodes
            memset(src, 1, SIZE);
            memset(dst, 0, SIZE);

            double bw = measure_bandwidth(src, dst, SIZE);
            printf("%-8d %-8d %12.2f\n", src_node, dst_node, bw);

            numa_free(src, SIZE);
            numa_free(dst, SIZE);
        }
    }

    return 0;
}
```

```bash
gcc -O3 -o numa-bench numa-bench.c -lnuma
./numa-bench

# Expected output on a 2-socket system:
# Src      Dst         BW (GB/s)
# ---      ---         ---------
# 0        0              285.43    <- local
# 0        1              142.18    <- remote
# 1        0              141.92    <- remote
# 1        1              288.11    <- local
```

## Production Monitoring and Alerting

### Prometheus Metrics for NUMA

```bash
# node_exporter NUMA metrics
# node_memory_numa_hit_total
# node_memory_numa_miss_total
# node_memory_numa_foreign_total
# node_memory_numa_interleave_hit_total
# node_memory_numa_local_total
# node_memory_numa_other_total

# Calculate NUMA miss rate
# (sum(rate(node_memory_numa_miss_total[5m])) by (instance, node))
# /
# (sum(rate(node_memory_numa_miss_total[5m])) by (instance, node) + sum(rate(node_memory_numa_hit_total[5m])) by (instance, node))
```

```yaml
# prometheus-rules/numa-alerts.yaml
groups:
  - name: numa
    rules:
      - alert: HighNUMAMissRate
        expr: |
          (
            sum(rate(node_memory_numa_miss_total[5m])) by (instance, node)
            /
            (
              sum(rate(node_memory_numa_miss_total[5m])) by (instance, node)
              + sum(rate(node_memory_numa_hit_total[5m])) by (instance, node)
            )
          ) > 0.10
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High NUMA miss rate on {{ $labels.instance }}"
          description: "NUMA node {{ $labels.node }} on {{ $labels.instance }} has a {{ $value | humanizePercentage }} miss rate. Check process NUMA affinity."

      - alert: NUMAMigrationStorm
        expr: rate(node_memory_numa_pages_migrated_total[1m]) > 10000
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "NUMA migration storm on {{ $labels.instance }}"
          description: "{{ $value }} pages/second being migrated. Consider disabling numa_balancing or fixing workload placement."
```

## Summary

NUMA-aware memory management is essential for achieving full performance on modern multi-socket servers:

1. **Measure first**: Use `numastat`, `numactl --hardware`, and `/proc/PID/numa_maps` to understand current NUMA behavior before optimizing.
2. **Use numactl for process binding**: Bind latency-sensitive workloads to a single NUMA node. Use `--interleave=all` for shared memory workloads like Redis.
3. **Fix first-touch initialization**: Ensure worker threads initialize their own data partitions to control physical page placement.
4. **Tune kernel NUMA balancing**: Disable it for stable workloads with explicit placement; tune scan parameters for dynamic workloads.
5. **Configure the JVM with UseNUMA**: JVM workloads see significant gains from NUMA-aware garbage collection.
6. **Use Kubernetes Topology Manager**: For containerized workloads, the topology manager ensures CPU and memory are co-located.
7. **Monitor with Prometheus**: Alert on NUMA miss rates above 10% and migration storms.
