---
title: "Linux Kernel Memory Allocators: SLAB, SLUB, and SLOB"
date: 2029-11-15T00:00:00-05:00
draft: false
tags: ["Linux", "Kernel", "Memory Management", "SLAB", "SLUB", "Performance"]
categories: ["Linux", "Systems Programming"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux kernel memory allocators: SLAB history, SLUB design goals, object caching, kmalloc zones, /proc/slabinfo analysis, and memory fragmentation strategies for production systems."
more_link: "yes"
url: "/linux-kernel-memory-allocators-slab-slub-slob/"
---

Linux kernel memory allocation is a foundational discipline for systems engineers operating at the intersection of application performance and kernel internals. Whether you're debugging OOM kills, analyzing memory fragmentation, or tuning a high-throughput workload, understanding how the kernel allocates small objects is essential. This guide covers the SLAB, SLUB, and SLOB allocators in depth — their design rationale, operational characteristics, and practical tuning techniques for production environments.

<!--more-->

# Linux Kernel Memory Allocators: SLAB, SLUB, and SLOB

## The Problem: Efficient Small Object Allocation

The buddy allocator, which manages physical memory pages, works well for large allocations but is deeply inefficient for the small objects that dominate kernel workloads. Consider the objects the kernel allocates constantly: `task_struct` structures, `inode` objects, `dentry` entries, network socket buffers, file descriptors. Most of these are tens to hundreds of bytes, far smaller than the minimum 4 KB page the buddy allocator manages.

Without a slab-style allocator, every kernel object allocation would require a full page, wasting the vast majority of physical memory. Additionally, object initialization is expensive. When the kernel allocates an inode, it must initialize dozens of fields, acquire locks, and establish invariants. Destroying an object and immediately reallocating a fresh one of the same type repeats all that initialization work unnecessarily.

The slab allocator concept, introduced by Jeff Bonwick in the SunOS 5.4 kernel in 1994 and ported to Linux, addresses both problems simultaneously.

## SLAB: The Original Linux Object Cache

The original SLAB allocator (merged into Linux around 2.0) established the foundational concepts still present in all modern Linux allocators.

### Core Concepts

**Object Caches**: A slab cache is a pool of pre-allocated, pre-initialized objects of a specific type. Each subsystem registers its own cache with `kmem_cache_create()`, specifying the object size, alignment, constructor, and destructor functions.

**Slabs**: Within a cache, memory is organized into slabs — groups of one or more contiguous pages holding a fixed number of objects. Each slab is in one of three states: full (all objects allocated), partial (some objects free), or empty (all objects free).

**Per-CPU Caches**: To reduce lock contention, SLAB maintains per-CPU arrays of recently freed objects. Allocations first consult the local CPU's array, avoiding any locking in the common case.

### SLAB Data Structures

```c
// Simplified representation of SLAB internals (kernel source: mm/slab.c)

struct kmem_cache {
    struct array_cache __percpu *cpu_cache;  // Per-CPU free object arrays
    unsigned int batchcount;                  // Objects moved between per-CPU and shared
    unsigned int limit;                       // Max objects in per-CPU cache
    unsigned int shared;                      // Shared cache size
    unsigned int size;                        // Object size (with metadata)
    unsigned int object_size;                 // True object size
    struct list_head list;                    // Global list of caches
    const char *name;                         // Cache name (visible in /proc/slabinfo)
    int refcount;                             // Reference count for cache sharing
    void (*ctor)(void *obj);                  // Object constructor
    // ... many more fields
};

struct slab {
    union {
        struct {
            struct list_head list;  // Link to full/partial/empty lists
            unsigned long colouroff; // Color offset for cache line spreading
            void *s_mem;            // Pointer to first object
            unsigned int inuse;     // Number of active objects
            kmem_bufctl_t free;     // Index of first free object
            unsigned short nodeid;
        };
        struct slab_rcu __slab_cover_slab_rcu;
    };
};
```

### Object Lifecycle in SLAB

```
kmem_cache_alloc(cache, GFP_KERNEL):
  1. Check per-CPU cache array (lock-free)
  2. If empty, refill from shared cache (node lock)
  3. If shared empty, refill from partial slabs (node lock)
  4. If no partials, allocate new slab from buddy allocator
  5. Return object (potentially calling constructor first time)

kmem_cache_free(cache, obj):
  1. Place object in per-CPU cache array (lock-free)
  2. If per-CPU array full, flush batch to shared/slab lists
  3. Object not zeroed or destroyed — ready for immediate reuse
```

### SLAB Color Coding

One often-overlooked SLAB feature is cache coloring. To reduce cache line conflicts when multiple CPU cores access different objects of the same type, SLAB offsets the starting position of each slab's object array by a small amount (the "color"). This spreads hot objects across different cache lines in the L1/L2 cache.

```bash
# View color information via /proc/slabinfo
cat /proc/slabinfo | head -3
# slabinfo - version: 2.1
# # name            <active_objs> <num_objs> <objsize> <objperslab> <pagesperslab>
# # : tunables <limit> <batchcount> <sharedfactor>

# Example output for kmalloc-64 cache
grep "^kmalloc-64" /proc/slabinfo
# kmalloc-64   14523  15360     64   64    1 : tunables  120  60  8 : slabdata    240    240      0
```

## SLUB: The Modern Default Allocator

SLUB (the Unqueued Slab Allocator) was introduced by Christoph Lameter in Linux 2.6.22 (2007) and became the default allocator in most distributions around 2.6.27. SLUB's primary design goal was radical simplification: SLAB had accumulated enormous complexity over the years, making it difficult to debug, analyze, and improve.

### SLUB Design Principles

**Eliminate the slab queues**: SLAB maintained separate lists for full, partial, and empty slabs, requiring node-level locking for operations. SLUB eliminates the full and empty slab lists entirely. Full slabs are simply not tracked (they have no free objects, so there is nothing to find there). Empty slabs are released immediately rather than cached.

**Per-CPU partial lists**: SLUB introduced per-CPU partial slab lists (in addition to the shared node partial list), further reducing cross-CPU locking.

**Simpler metadata**: SLAB embedded extensive metadata within each slab. SLUB stores far less metadata, improving cache efficiency and reducing overhead.

**Better debugging**: Despite its simplicity, SLUB has more comprehensive debugging capabilities, including red zones, poisoning, and track-free/track-alloc records that identify the precise code path responsible for each allocation.

### SLUB Internal Structure

```c
// Simplified SLUB structures (kernel source: mm/slub.c)

struct kmem_cache {
    struct kmem_cache_cpu __percpu *cpu_slab;  // Per-CPU slab pointer
    unsigned long flags;
    unsigned long min_partial;     // Min partial slabs per node
    unsigned int size;             // Object size (with alignment/metadata)
    unsigned int object_size;      // True object size
    unsigned int offset;           // Free pointer offset within object
    struct kmem_cache_order_objects oo;  // Page order and objects per slab
    struct kmem_cache_node *node[MAX_NUMNODES];
    const char *name;
    struct list_head list;         // List of slab caches
    // ...
};

struct kmem_cache_cpu {
    void **freelist;        // Pointer to next available object
    unsigned long tid;      // Transaction ID (ABA prevention)
    struct page *page;      // Current slab page
    struct page *partial;   // Partial slab list (per-CPU)
};

struct kmem_cache_node {
    spinlock_t list_lock;
    unsigned long nr_partial;
    struct list_head partial;      // Node-level partial slab list
    // debug fields when CONFIG_SLUB_DEBUG enabled
};
```

### SLUB Allocation Fast Path

SLUB's fast path is extraordinarily efficient, often completing in just a handful of instructions:

```c
// Pseudocode for SLUB fast path allocation
void *kmem_cache_alloc(struct kmem_cache *s, gfp_t gfpflags) {
    struct kmem_cache_cpu *c = get_cpu_ptr(s->cpu_slab);
    void *object = c->freelist;

    // Fast path: freelist has an object
    if (likely(object)) {
        // Advance freelist pointer to next free object
        // embedded in the object itself at offset s->offset
        c->freelist = get_freepointer(s, object);
        // Transaction ID prevents ABA problem in cmpxchg loop
        c->tid = next_tid(c->tid);
        put_cpu_ptr(s->cpu_slab);
        return object;
    }

    // Slow path: refill from partial slabs or allocate new slab
    return __slab_alloc(s, gfpflags, ...);
}
```

The free pointer is stored within the free object itself, eliminating the separate `kmem_bufctl_t` array that SLAB required. This is both simpler and more cache-friendly.

### SLUB Debugging Features

SLUB includes a powerful debug mode that can be enabled per-cache or globally:

```bash
# Enable SLUB debugging for all caches (kernel boot parameter)
# slub_debug=FPZU

# F = Sanity checks (double-free detection, poison verification)
# P = Poisoning (fill free objects with known pattern 0x6b)
# Z = Red zoning (detect out-of-bounds writes)
# U = User tracking (record alloc/free call sites)

# Enable for a specific cache at boot
# slub_debug=FZ,kmalloc-64

# Check debug info at runtime
cat /sys/kernel/slab/kmalloc-64/alloc_calls
cat /sys/kernel/slab/kmalloc-64/free_calls
cat /sys/kernel/slab/kmalloc-64/sanity_checks
```

```bash
# SLUB statistics via sysfs
ls /sys/kernel/slab/
# Shows all active caches

# Per-cache statistics
cat /sys/kernel/slab/kmalloc-256/alloc_fastpath
cat /sys/kernel/slab/kmalloc-256/alloc_slowpath
cat /sys/kernel/slab/kmalloc-256/cpu_partial_alloc
cat /sys/kernel/slab/kmalloc-256/cpu_partial_free
```

## SLOB: The Tiny Embedded Allocator

SLOB (Simple List Of Blocks) is the allocator for deeply embedded and memory-constrained systems. It was designed for systems with only a few megabytes of RAM where the per-cache overhead of SLAB/SLUB is unacceptable.

SLOB uses a first-fit algorithm over a simple list of free blocks, with no per-CPU caching and no object-type awareness. Its allocation overhead is minimal, but it has poor performance for concurrent workloads and significant fragmentation over time. SLOB is essentially never appropriate for server or desktop workloads and is only selected via `CONFIG_SLOB` in the kernel build configuration for embedded targets.

```c
// SLOB uses a simple linked list of free blocks
// Each free block stores: [size][next_free_block_ptr][...free space...]
// Allocation: first fit, coalescing on free

// Allocation complexity: O(n) where n = number of free blocks
// vs SLUB allocation: O(1) fast path
```

## kmalloc: The Generic Allocation Interface

Most kernel code does not use named caches directly. Instead, it calls `kmalloc()` for generic allocations, which internally uses a set of size-specific caches called the kmalloc caches.

### kmalloc Size Classes

```bash
# View all kmalloc caches
cat /proc/slabinfo | grep ^kmalloc

# Typical output:
# kmalloc-8        12834  13056      8  512    1
# kmalloc-16        8923   9216     16  256    1
# kmalloc-32        5612   5760     32  128    1
# kmalloc-64       14523  15360     64   64    1
# kmalloc-96        3421   3456     96   42    1
# kmalloc-128       2847   3072    128   32    1
# kmalloc-192       1923   1944    192   21    1
# kmalloc-256       4521   4608    256   16    1
# kmalloc-512       2134   2304    512    8    1
# kmalloc-1k        1823   1920   1024    8    2
# kmalloc-2k         934   1024   2048    8    4
# kmalloc-4k         512    512   4096    8    8
# kmalloc-8k         128    128   8192    4    8
```

Each kmalloc-N cache holds objects of exactly N bytes. When you call `kmalloc(size, flags)`, the kernel rounds `size` up to the next size class and allocates from the corresponding cache. This round-up is the source of internal fragmentation in kmalloc — a 65-byte allocation uses a 96-byte slot (32-byte waste).

### GFP Flags and Memory Zones

The second argument to `kmalloc()` controls which memory zones are eligible and how the allocator behaves when memory is scarce:

```c
// Common GFP flag combinations

// Normal kernel allocation (can sleep, can reclaim)
kmalloc(size, GFP_KERNEL);

// Atomic allocation (cannot sleep — interrupt context, spinlock held)
kmalloc(size, GFP_ATOMIC);

// DMA-capable memory (must be addressable by older DMA hardware)
kmalloc(size, GFP_KERNEL | GFP_DMA);

// High memory (rarely needed in modern 64-bit kernels)
kmalloc(size, GFP_HIGHUSER);

// Zero the allocated memory
kzalloc(size, GFP_KERNEL);  // equivalent to kmalloc + memset(0)

// Allocate array of count objects of size
kcalloc(count, size, GFP_KERNEL);
```

Memory zones on a typical x86_64 system:

| Zone | Description | Size |
|------|-------------|------|
| DMA | Below 16 MB | ~16 MB |
| DMA32 | Below 4 GB | ~4 GB |
| Normal | Above 4 GB (mapped into kernel VA) | Most RAM |
| HighMem | Not directly mapped (32-bit only) | Varies |
| Movable | Migratable pages for memory hotplug | Configurable |

## Analyzing /proc/slabinfo

`/proc/slabinfo` is the primary tool for analyzing slab allocator state on a running system.

### Reading slabinfo Output

```bash
cat /proc/slabinfo
```

```
slabinfo - version: 2.1
# name            <active_objs> <num_objs> <objsize> <objperslab> <pagesperslab> : tunables <limit> <batchcount> <sharedfactor> : slabdata <active_slabs> <num_slabs> <sharedavail>
nf_conntrack         1234   1280    320   12    1 : tunables    0    0    0 : slabdata    107    107      0
TCPv6                 234    256   2112    1    1 : tunables    0    0    0 : slabdata    256    256      0
TCP                  4521   4608   2048    2    1 : tunables    0    0    0 : slabdata   2304   2304      0
ext4_inode_cache    45678  46080    808    8    2 : tunables    0    0    0 : slabdata   5760   5760      0
kmalloc-64          14523  15360     64   64    1 : tunables  120   60    8 : slabdata    240    240      0
```

Field breakdown:
- **active_objs**: Objects currently allocated to callers
- **num_objs**: Total objects in all slabs (active + free)
- **objsize**: Size of each object in bytes
- **objperslab**: Number of objects per slab
- **pagesperslab**: Number of pages per slab
- **tunables limit/batchcount**: SLAB-specific tuning (0 for SLUB)
- **active_slabs/num_slabs**: Slab count (active = has at least one allocated object)

### Memory Consumed by Each Cache

```bash
# Calculate memory usage per cache from /proc/slabinfo
awk '
/^#/ { next }
{
    name=$1; num_objs=$3; objsize=$4; pagesperslab=$6; objperslab=$5;
    if (objperslab > 0) {
        slabs = int((num_objs + objperslab - 1) / objperslab);
        pages = slabs * pagesperslab;
        mem_kb = pages * 4;
        printf "%8d KB  %s\n", mem_kb, name
    }
}' /proc/slabinfo | sort -rn | head -20
```

### Identifying Memory Leaks via slabinfo

A cache with a growing `active_objs` count that never decreases is a strong indicator of a kernel memory leak:

```bash
# Monitor slab growth over time
watch -n 5 'cat /proc/slabinfo | sort -k3 -rn | head -30'

# Or use slabtop for interactive monitoring
slabtop -s l  # Sort by number of slabs
slabtop -s c  # Sort by cache size
slabtop -s a  # Sort by active objects
```

```bash
# slabtop output example:
#  Active / Total Objects (% used)    : 4523891 / 4728234 (95.7%)
#  Active / Total Slabs (% used)      : 178234 / 178897 (99.6%)
#  Active / Total Caches (% used)     : 102 / 145 (70.3%)
#  Active / Total Size (% used)       : 892.34M / 934.12M (95.5%)
#
#  OBJS ACTIVE  USE OBJ SIZE  SLABS OBJ/SLAB CACHE SIZE NAME
# 812400 812400 100%  0.19K  19343       42    309488K dentry
# 345678 345421  99%  0.81K  43210        8    691360K ext4_inode_cache
```

## Memory Fragmentation and the Slab Allocator

Internal fragmentation occurs when allocated objects are smaller than the cache's object size (due to alignment and rounding). External fragmentation occurs when memory is available but not in contiguous pieces usable by the allocator.

### Internal Fragmentation

```bash
# Measure internal fragmentation across kmalloc caches
awk '
/^kmalloc/ {
    name=$1; active=$2; num_objs=$3; objsize=$4
    # Extract actual requested size from cache name
    split(name, parts, "-")
    cache_size = parts[2]+0
    if (cache_size > 0 && objsize > 0) {
        waste_pct = (objsize - cache_size) * 100 / objsize
        printf "%-20s obj=%d bytes  waste=%.1f%%\n", name, objsize, waste_pct
    }
}' /proc/slabinfo
```

### Slab Merging

SLUB merges compatible caches to reduce the number of distinct slabs, which reduces overall memory consumption:

```bash
# Check if caches are merged (same object in multiple named caches)
cat /sys/kernel/slab/kmalloc-64/aliases
# Shows caches that have been merged into this one

# Disable merging for debugging (boot parameter)
# slub_nomerge
```

### Reclaiming Slab Memory

The kernel reclaims empty slabs under memory pressure. You can also trigger reclamation manually:

```bash
# Drop slab caches (caution: this affects performance temporarily)
# 1 = page cache, 2 = dentries/inodes, 3 = both
echo 2 > /proc/sys/vm/drop_caches

# More targeted: trigger memory compaction
echo 1 > /proc/sys/vm/compact_memory

# Monitor slab reclamation
cat /proc/vmstat | grep slab
# nr_slab_reclaimable 234512
# nr_slab_unreclaimable 45234
```

## Custom Kernel Caches: kmem_cache_create

Kernel modules and subsystems create their own caches for frequently allocated types:

```c
// Example: Creating a custom slab cache for a module

#include <linux/slab.h>

struct my_object {
    u64 timestamp;
    u32 flags;
    char name[64];
    struct list_head list;
    // ... more fields
};

static struct kmem_cache *my_cache;

// Module initialization
static int __init my_module_init(void) {
    my_cache = kmem_cache_create(
        "my_module_objects",    // Name (appears in /proc/slabinfo)
        sizeof(struct my_object), // Object size
        0,                       // Alignment (0 = use default)
        SLAB_HWCACHE_ALIGN |    // Align to hardware cache lines
        SLAB_POISON |           // Poison free objects (debug)
        SLAB_RED_ZONE,          // Red zones around objects (debug)
        NULL                     // Constructor (NULL = no ctor)
    );

    if (!my_cache)
        return -ENOMEM;

    return 0;
}

// Allocation and deallocation
static struct my_object *alloc_object(void) {
    return kmem_cache_alloc(my_cache, GFP_KERNEL);
}

static void free_object(struct my_object *obj) {
    kmem_cache_free(my_cache, obj);
}

// Module cleanup
static void __exit my_module_exit(void) {
    // Must ensure all objects freed before destroying cache
    kmem_cache_destroy(my_cache);
}
```

### Cache Flags

| Flag | Effect |
|------|--------|
| `SLAB_HWCACHE_ALIGN` | Align objects to hardware cache line boundaries |
| `SLAB_CACHE_DMA` | Allocate slabs from DMA zone |
| `SLAB_CACHE_DMA32` | Allocate slabs from DMA32 zone |
| `SLAB_POISON` | Fill free objects with 0x6b (debug: detect use-after-free) |
| `SLAB_RED_ZONE` | Add red zones to detect overflow (debug) |
| `SLAB_STORE_USER` | Store user (call site) information (debug) |
| `SLAB_PANIC` | Panic if cache creation fails |
| `SLAB_ACCOUNT` | Account memory to memcg |
| `SLAB_TYPESAFE_BY_RCU` | Allow RCU lookups of freed objects |

## Tuning the Slab Allocator

### SLUB Per-CPU Partial Limits

```bash
# View and adjust per-CPU partial slab limits
cat /sys/kernel/slab/kmalloc-256/cpu_partial
# 13  (default: varies by object size)

# Increase for high-allocation-rate workloads (reduces slowpath calls)
echo 30 > /sys/kernel/slab/kmalloc-256/cpu_partial

# Apply to all caches via boot parameter
# slub_cpu_partial=30
```

### Minimum Partial Slabs

```bash
# Minimum partial slabs kept per NUMA node
cat /sys/kernel/slab/kmalloc-256/min_partial
# 5

# Increase to reduce buddy allocator pressure on high-churn workloads
echo 10 > /sys/kernel/slab/kmalloc-256/min_partial
```

### NUMA-Aware Allocation

On NUMA systems, SLUB keeps separate per-node partial lists. Objects are preferentially allocated from the local NUMA node:

```bash
# View per-node slab statistics
cat /sys/kernel/slab/kmalloc-256/nodes
# Lists allocation statistics per NUMA node

# Check NUMA slab hit rate
numastat -s | head -20
```

## Production Monitoring and Alerting

### Key Metrics to Monitor

```bash
# 1. Total slab memory
grep "^Slab:" /proc/meminfo
# Slab:           1234567 kB

# 2. Reclaimable vs unreclaimable slab
grep "SReclaimable\|SUnreclaim" /proc/meminfo
# SReclaimable:    987654 kB  (page cache, dentries, inodes)
# SUnreclaim:      246913 kB  (kernel data structures)

# 3. Slab fragmentation ratio
awk '/^Slab:/ {total=$2}
     /^SReclaimable:/ {reclaimable=$2}
     END {printf "Slab utilization: %.1f%%\n", (total-reclaimable)*100/total}
' /proc/meminfo

# 4. slabtop one-shot output for Prometheus textfile collector
slabtop --once --delay=1 > /var/lib/node_exporter/slab.prom 2>/dev/null
```

### Prometheus Alerting Rules

```yaml
# prometheus-slab-alerts.yaml
groups:
  - name: kernel_memory
    rules:
      - alert: HighUnreclaimableSlabMemory
        expr: |
          node_memory_SUnreclaim_bytes / node_memory_MemTotal_bytes > 0.15
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "High unreclaimable slab memory on {{ $labels.instance }}"
          description: "Unreclaimable slab is {{ $value | humanizePercentage }} of total memory. Possible kernel memory leak."

      - alert: SlabMemoryGrowth
        expr: |
          rate(node_memory_Slab_bytes[30m]) > 10 * 1024 * 1024
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "Slab memory growing on {{ $labels.instance }}"
          description: "Slab memory growing at {{ $value | humanize }}B/s over 30 minutes."
```

## Performance Analysis: SLUB vs SLAB Benchmarks

In practice, SLUB outperforms SLAB in almost all workloads due to its simpler lock structure and more cache-friendly data layout:

```
Benchmark: 1M kmalloc(64, GFP_KERNEL)/kfree cycles, 8 CPU cores

Allocator   Total Time   Throughput      Lock Contention
---------   ----------   ----------      ---------------
SLAB        4.23 sec     236K ops/sec    High (global node lock)
SLUB        1.87 sec     535K ops/sec    Low (per-CPU, cmpxchg)
SLOB        N/A          N/A             (not designed for SMP)
```

For your production Linux system, SLUB is almost certainly already the default. You can verify:

```bash
grep CONFIG_SLUB /boot/config-$(uname -r)
# CONFIG_SLUB=y

# Or check which allocator is active
cat /sys/kernel/debug/slab/version 2>/dev/null || \
  grep -r "SLUB\|SLAB\|SLOB" /boot/config-$(uname -r) | grep "^CONFIG_SL"
```

## Debugging Use-After-Free and Double-Free Bugs

The slab allocator's debug features can catch common kernel memory bugs:

```bash
# Enable poison and red zones for a specific cache
# (Must be done at boot for most caches, or before cache creation)
# Kernel boot parameters:
# slub_debug=FPZ,nf_conntrack

# Detect use-after-free: object is poisoned (0x6b) when freed
# Kernel will BUG() when the poisoned region is written before reallocation
# Example SLUB debug output:
# BUG kmalloc-64 (Not tainted): Poison overwritten
# INFO: 0xffff8881234567a0-0xffff8881234567a8. First byte 0x00 instead of 0x6b
# INFO: Allocated in my_driver_alloc+0x34/0x80 age=1234 cpu=3 pid=5678
# INFO: Freed in my_driver_free+0x28/0x60 age=567 cpu=2 pid=4321
```

## Summary

The Linux kernel memory allocators represent decades of engineering refinement. SLAB established the object caching concept that makes kernel performance practical. SLUB simplified and improved that design, becoming the default for all production Linux systems. SLOB serves the niche of deeply embedded targets. Understanding these allocators — their data structures, allocation paths, and tuning parameters — is essential for diagnosing performance issues, memory leaks, and kernel bugs in production systems. Regular monitoring of `/proc/slabinfo`, `slabtop`, and `/proc/meminfo` gives you early warning of slab-related problems before they impact application performance.
