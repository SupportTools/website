---
title: "Linux Memory Management Deep Dive: Virtual Memory, Page Tables, and Performance"
date: 2025-07-02T22:10:00-05:00
draft: false
tags: ["Linux", "Memory Management", "Virtual Memory", "Performance", "Kernel", "Systems Programming"]
categories:
- Linux
- Systems Programming
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive exploration of Linux memory management including virtual memory, page tables, memory allocation strategies, NUMA, and performance optimization techniques"
more_link: "yes"
url: "/linux-memory-management-deep-dive/"
---

Memory management is one of the most critical and complex subsystems in the Linux kernel. Understanding how Linux manages memory—from virtual address translation to page replacement algorithms—is essential for writing high-performance applications and diagnosing memory-related issues. This guide explores Linux memory management from userspace APIs to kernel internals.

<!--more-->

# [Linux Memory Management Deep Dive](#linux-memory-management)

## Virtual Memory Architecture

### Address Space Layout

```c
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/mman.h>

// Explore process address space
void print_memory_layout() {
    extern char etext, edata, end;  // Provided by linker
    
    printf("Process Memory Layout (PID: %d)\n", getpid());
    printf("==================================\n");
    
    // Text segment
    printf("Text segment:\n");
    printf("  Start: %p\n", (void*)0x400000);  // Typical start
    printf("  End:   %p (etext)\n", &etext);
    
    // Data segment
    printf("Data segment:\n");
    printf("  Start: %p\n", &etext);
    printf("  End:   %p (edata)\n", &edata);
    
    // BSS segment
    printf("BSS segment:\n");
    printf("  Start: %p\n", &edata);
    printf("  End:   %p (end)\n", &end);
    
    // Heap
    void* heap_start = sbrk(0);
    void* heap_alloc = malloc(1);
    void* heap_end = sbrk(0);
    printf("Heap:\n");
    printf("  Start: %p\n", heap_start);
    printf("  End:   %p\n", heap_end);
    free(heap_alloc);
    
    // Stack (approximate)
    int stack_var;
    printf("Stack:\n");
    printf("  Variable: %p\n", &stack_var);
    printf("  Top (approx): %p\n", 
           (void*)((uintptr_t)&stack_var & ~0xFFF));
    
    // Memory mappings
    FILE* maps = fopen("/proc/self/maps", "r");
    if (maps) {
        printf("\nMemory Mappings:\n");
        char line[256];
        while (fgets(line, sizeof(line), maps)) {
            printf("  %s", line);
        }
        fclose(maps);
    }
}

// Analyze virtual memory regions
typedef struct {
    void* start;
    void* end;
    char perms[5];
    char name[256];
} memory_region_t;

void analyze_memory_regions() {
    FILE* maps = fopen("/proc/self/maps", "r");
    if (!maps) return;
    
    memory_region_t regions[1000];
    int count = 0;
    
    char line[512];
    while (fgets(line, sizeof(line), maps) && count < 1000) {
        unsigned long start, end;
        char perms[5];
        char name[256] = "";
        
        sscanf(line, "%lx-%lx %4s %*s %*s %*s %255[^\n]",
               &start, &end, perms, name);
        
        regions[count].start = (void*)start;
        regions[count].end = (void*)end;
        strncpy(regions[count].perms, perms, 4);
        strncpy(regions[count].name, name, 255);
        count++;
    }
    fclose(maps);
    
    // Analyze regions
    size_t total_size = 0;
    size_t readable = 0, writable = 0, executable = 0;
    
    for (int i = 0; i < count; i++) {
        size_t size = (char*)regions[i].end - (char*)regions[i].start;
        total_size += size;
        
        if (regions[i].perms[0] == 'r') readable += size;
        if (regions[i].perms[1] == 'w') writable += size;
        if (regions[i].perms[2] == 'x') executable += size;
    }
    
    printf("Virtual Memory Summary:\n");
    printf("  Total mapped: %zu MB\n", total_size / (1024*1024));
    printf("  Readable:     %zu MB\n", readable / (1024*1024));
    printf("  Writable:     %zu MB\n", writable / (1024*1024));
    printf("  Executable:   %zu MB\n", executable / (1024*1024));
}
```

### Page Table Walking

```c
#include <sys/types.h>
#include <fcntl.h>

// Page table entry information
typedef struct {
    uint64_t pfn : 55;        // Page frame number
    unsigned int soft_dirty : 1;
    unsigned int exclusive : 1;
    unsigned int reserved : 4;
    unsigned int present : 1;
    unsigned int swapped : 1;
    unsigned int file_shared : 1;
} page_info_t;

// Read page information from /proc/self/pagemap
int get_page_info(void* vaddr, page_info_t* info) {
    int pagemap_fd = open("/proc/self/pagemap", O_RDONLY);
    if (pagemap_fd < 0) return -1;
    
    size_t page_size = sysconf(_SC_PAGE_SIZE);
    off_t offset = ((uintptr_t)vaddr / page_size) * sizeof(uint64_t);
    
    uint64_t entry;
    if (pread(pagemap_fd, &entry, sizeof(entry), offset) != sizeof(entry)) {
        close(pagemap_fd);
        return -1;
    }
    
    close(pagemap_fd);
    
    // Parse page table entry
    info->present = (entry >> 63) & 1;
    info->swapped = (entry >> 62) & 1;
    info->file_shared = (entry >> 61) & 1;
    info->exclusive = (entry >> 56) & 1;
    info->soft_dirty = (entry >> 55) & 1;
    info->pfn = entry & ((1ULL << 55) - 1);
    
    return 0;
}

// Virtual to physical address translation
uintptr_t virt_to_phys(void* vaddr) {
    page_info_t info;
    if (get_page_info(vaddr, &info) < 0) {
        return 0;
    }
    
    if (!info.present) {
        return 0;  // Page not in memory
    }
    
    size_t page_size = sysconf(_SC_PAGE_SIZE);
    uintptr_t page_offset = (uintptr_t)vaddr & (page_size - 1);
    uintptr_t phys_addr = (info.pfn * page_size) + page_offset;
    
    return phys_addr;
}

// Analyze memory access patterns
void analyze_page_faults() {
    size_t page_size = sysconf(_SC_PAGE_SIZE);
    size_t num_pages = 1000;
    
    // Allocate memory but don't touch it
    char* buffer = mmap(NULL, num_pages * page_size,
                       PROT_READ | PROT_WRITE,
                       MAP_PRIVATE | MAP_ANONYMOUS,
                       -1, 0);
    
    // Check which pages are resident
    unsigned char vec[num_pages];
    mincore(buffer, num_pages * page_size, vec);
    
    int resident_before = 0;
    for (size_t i = 0; i < num_pages; i++) {
        if (vec[i] & 1) resident_before++;
    }
    
    printf("Pages resident before access: %d/%zu\n", 
           resident_before, num_pages);
    
    // Access every Nth page
    for (size_t i = 0; i < num_pages; i += 10) {
        buffer[i * page_size] = 1;  // Trigger page fault
    }
    
    // Check again
    mincore(buffer, num_pages * page_size, vec);
    int resident_after = 0;
    for (size_t i = 0; i < num_pages; i++) {
        if (vec[i] & 1) resident_after++;
    }
    
    printf("Pages resident after access: %d/%zu\n", 
           resident_after, num_pages);
    printf("Page faults triggered: %d\n", 
           resident_after - resident_before);
    
    munmap(buffer, num_pages * page_size);
}
```

## Memory Allocation Strategies

### Understanding Allocators

```c
#include <malloc.h>
#include <string.h>

// Custom memory allocator using mmap
typedef struct block {
    size_t size;
    struct block* next;
    int free;
    char data[];
} block_t;

typedef struct {
    block_t* head;
    size_t total_allocated;
    size_t total_freed;
    pthread_mutex_t lock;
} allocator_t;

static allocator_t g_allocator = {
    .head = NULL,
    .total_allocated = 0,
    .total_freed = 0,
    .lock = PTHREAD_MUTEX_INITIALIZER
};

void* custom_malloc(size_t size) {
    pthread_mutex_lock(&g_allocator.lock);
    
    // Align size
    size = (size + 7) & ~7;
    
    // Find free block
    block_t* current = g_allocator.head;
    block_t* prev = NULL;
    
    while (current) {
        if (current->free && current->size >= size) {
            // Found suitable block
            current->free = 0;
            g_allocator.total_allocated += size;
            pthread_mutex_unlock(&g_allocator.lock);
            return current->data;
        }
        prev = current;
        current = current->next;
    }
    
    // Allocate new block
    size_t block_size = sizeof(block_t) + size;
    block_t* new_block = mmap(NULL, block_size,
                             PROT_READ | PROT_WRITE,
                             MAP_PRIVATE | MAP_ANONYMOUS,
                             -1, 0);
    
    new_block->size = size;
    new_block->next = NULL;
    new_block->free = 0;
    
    // Add to list
    if (prev) {
        prev->next = new_block;
    } else {
        g_allocator.head = new_block;
    }
    
    g_allocator.total_allocated += size;
    pthread_mutex_unlock(&g_allocator.lock);
    
    return new_block->data;
}

void custom_free(void* ptr) {
    if (!ptr) return;
    
    pthread_mutex_lock(&g_allocator.lock);
    
    block_t* block = (block_t*)((char*)ptr - offsetof(block_t, data));
    block->free = 1;
    g_allocator.total_freed += block->size;
    
    pthread_mutex_unlock(&g_allocator.lock);
}

// Memory pool allocator
typedef struct {
    void* pool;
    size_t pool_size;
    size_t object_size;
    void* free_list;
    _Atomic(size_t) allocated;
    _Atomic(size_t) freed;
} memory_pool_t;

memory_pool_t* pool_create(size_t object_size, size_t num_objects) {
    memory_pool_t* pool = malloc(sizeof(memory_pool_t));
    
    pool->object_size = object_size;
    pool->pool_size = object_size * num_objects;
    pool->pool = mmap(NULL, pool->pool_size,
                     PROT_READ | PROT_WRITE,
                     MAP_PRIVATE | MAP_ANONYMOUS,
                     -1, 0);
    
    // Initialize free list
    pool->free_list = pool->pool;
    char* current = pool->pool;
    
    for (size_t i = 0; i < num_objects - 1; i++) {
        *(void**)current = current + object_size;
        current += object_size;
    }
    *(void**)current = NULL;
    
    atomic_store(&pool->allocated, 0);
    atomic_store(&pool->freed, 0);
    
    return pool;
}

void* pool_alloc(memory_pool_t* pool) {
    void* obj;
    void* next;
    
    do {
        obj = pool->free_list;
        if (!obj) return NULL;  // Pool exhausted
        
        next = *(void**)obj;
    } while (!__atomic_compare_exchange_n(&pool->free_list, &obj, next,
                                         0, __ATOMIC_RELEASE, 
                                         __ATOMIC_ACQUIRE));
    
    atomic_fetch_add(&pool->allocated, 1);
    return obj;
}

void pool_free(memory_pool_t* pool, void* obj) {
    void* head;
    
    do {
        head = pool->free_list;
        *(void**)obj = head;
    } while (!__atomic_compare_exchange_n(&pool->free_list, &head, obj,
                                         0, __ATOMIC_RELEASE,
                                         __ATOMIC_ACQUIRE));
    
    atomic_fetch_add(&pool->freed, 1);
}
```

### Heap Analysis and Debugging

```c
// Memory usage statistics
void print_malloc_stats() {
    struct mallinfo2 info = mallinfo2();
    
    printf("Heap Statistics:\n");
    printf("  Total allocated space:  %zu bytes\n", info.uordblks);
    printf("  Total free space:       %zu bytes\n", info.fordblks);
    printf("  Top-most free block:    %zu bytes\n", info.keepcost);
    printf("  Memory mapped regions:  %zu\n", info.hblks);
    printf("  Memory in mapped regions: %zu bytes\n", info.hblkhd);
    printf("  Max allocated space:    %zu bytes\n", info.usmblks);
    
    // Additional glibc statistics
    malloc_stats();
}

// Memory leak detection
typedef struct allocation {
    void* ptr;
    size_t size;
    char file[256];
    int line;
    struct allocation* next;
} allocation_t;

static allocation_t* g_allocations = NULL;
static pthread_mutex_t g_alloc_lock = PTHREAD_MUTEX_INITIALIZER;

void* debug_malloc(size_t size, const char* file, int line) {
    void* ptr = malloc(size);
    if (!ptr) return NULL;
    
    allocation_t* alloc = malloc(sizeof(allocation_t));
    alloc->ptr = ptr;
    alloc->size = size;
    strncpy(alloc->file, file, 255);
    alloc->line = line;
    
    pthread_mutex_lock(&g_alloc_lock);
    alloc->next = g_allocations;
    g_allocations = alloc;
    pthread_mutex_unlock(&g_alloc_lock);
    
    return ptr;
}

void debug_free(void* ptr) {
    if (!ptr) return;
    
    pthread_mutex_lock(&g_alloc_lock);
    
    allocation_t** current = &g_allocations;
    while (*current) {
        if ((*current)->ptr == ptr) {
            allocation_t* to_free = *current;
            *current = (*current)->next;
            free(ptr);
            free(to_free);
            pthread_mutex_unlock(&g_alloc_lock);
            return;
        }
        current = &(*current)->next;
    }
    
    pthread_mutex_unlock(&g_alloc_lock);
    
    fprintf(stderr, "ERROR: Freeing untracked pointer %p\n", ptr);
    abort();
}

void report_leaks() {
    pthread_mutex_lock(&g_alloc_lock);
    
    size_t total_leaked = 0;
    allocation_t* current = g_allocations;
    
    if (current) {
        printf("\nMemory Leaks Detected:\n");
        printf("======================\n");
    }
    
    while (current) {
        printf("  %zu bytes leaked at %s:%d\n",
               current->size, current->file, current->line);
        total_leaked += current->size;
        current = current->next;
    }
    
    if (total_leaked > 0) {
        printf("Total leaked: %zu bytes\n", total_leaked);
    }
    
    pthread_mutex_unlock(&g_alloc_lock);
}

#define MALLOC(size) debug_malloc(size, __FILE__, __LINE__)
#define FREE(ptr) debug_free(ptr)
```

## Advanced Memory Mapping

### Huge Pages and THP

```c
// Using huge pages explicitly
void* allocate_huge_pages(size_t size) {
    // Align size to huge page boundary
    size_t huge_page_size = 2 * 1024 * 1024;  // 2MB
    size = (size + huge_page_size - 1) & ~(huge_page_size - 1);
    
    void* ptr = mmap(NULL, size,
                    PROT_READ | PROT_WRITE,
                    MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB,
                    -1, 0);
    
    if (ptr == MAP_FAILED) {
        // Fallback to regular pages
        ptr = mmap(NULL, size,
                  PROT_READ | PROT_WRITE,
                  MAP_PRIVATE | MAP_ANONYMOUS,
                  -1, 0);
        
        // Advise kernel to use huge pages
        madvise(ptr, size, MADV_HUGEPAGE);
    }
    
    return ptr;
}

// Monitor Transparent Huge Pages
void monitor_thp() {
    FILE* fp = fopen("/proc/meminfo", "r");
    if (!fp) return;
    
    char line[256];
    while (fgets(line, sizeof(line), fp)) {
        if (strstr(line, "AnonHugePages:") ||
            strstr(line, "ShmemHugePages:") ||
            strstr(line, "FileHugePages:")) {
            printf("%s", line);
        }
    }
    fclose(fp);
    
    // Check THP status for current process
    fp = fopen("/proc/self/smaps", "r");
    if (!fp) return;
    
    size_t thp_size = 0;
    while (fgets(line, sizeof(line), fp)) {
        if (strstr(line, "AnonHugePages:")) {
            size_t size;
            sscanf(line, "AnonHugePages: %zu kB", &size);
            thp_size += size;
        }
    }
    fclose(fp);
    
    printf("Process using %zu MB of transparent huge pages\n",
           thp_size / 1024);
}

// Control memory defragmentation
void configure_memory_compaction() {
    // Trigger memory compaction
    FILE* fp = fopen("/proc/sys/vm/compact_memory", "w");
    if (fp) {
        fprintf(fp, "1\n");
        fclose(fp);
    }
    
    // Check fragmentation
    fp = fopen("/proc/buddyinfo", "r");
    if (fp) {
        printf("Memory fragmentation (buddyinfo):\n");
        char line[256];
        while (fgets(line, sizeof(line), fp)) {
            printf("  %s", line);
        }
        fclose(fp);
    }
}
```

### NUMA-Aware Memory Management

```c
#include <numa.h>
#include <numaif.h>

// NUMA memory allocation
void* numa_alloc_on_node(size_t size, int node) {
    if (!numa_available()) {
        return malloc(size);
    }
    
    void* ptr = numa_alloc_onnode(size, node);
    if (!ptr) {
        // Fallback to any node
        ptr = numa_alloc(size);
    }
    
    return ptr;
}

// NUMA statistics
void print_numa_stats() {
    if (!numa_available()) {
        printf("NUMA not available\n");
        return;
    }
    
    int num_nodes = numa_num_configured_nodes();
    printf("NUMA Nodes: %d\n", num_nodes);
    
    for (int node = 0; node < num_nodes; node++) {
        long size = numa_node_size(node, NULL);
        printf("  Node %d: %ld MB\n", node, size / (1024 * 1024));
        
        // CPU affinity
        struct bitmask* cpus = numa_allocate_cpumask();
        numa_node_to_cpus(node, cpus);
        
        printf("    CPUs: ");
        for (int cpu = 0; cpu < numa_num_configured_cpus(); cpu++) {
            if (numa_bitmask_isbitset(cpus, cpu)) {
                printf("%d ", cpu);
            }
        }
        printf("\n");
        
        numa_free_cpumask(cpus);
    }
}

// NUMA-aware memory migration
void migrate_pages_to_node(void* addr, size_t size, int target_node) {
    if (!numa_available()) return;
    
    // Get current page locations
    size_t page_size = sysconf(_SC_PAGE_SIZE);
    size_t num_pages = (size + page_size - 1) / page_size;
    
    void** pages = malloc(num_pages * sizeof(void*));
    int* status = malloc(num_pages * sizeof(int));
    int* nodes = malloc(num_pages * sizeof(int));
    
    // Prepare page addresses
    for (size_t i = 0; i < num_pages; i++) {
        pages[i] = (char*)addr + (i * page_size);
        nodes[i] = target_node;
    }
    
    // Move pages
    long result = move_pages(0, num_pages, pages, nodes, status, MPOL_MF_MOVE);
    
    if (result == 0) {
        int moved = 0;
        for (size_t i = 0; i < num_pages; i++) {
            if (status[i] >= 0) moved++;
        }
        printf("Migrated %d/%zu pages to node %d\n", 
               moved, num_pages, target_node);
    }
    
    free(pages);
    free(status);
    free(nodes);
}
```

## Memory Performance Optimization

### Cache-Conscious Programming

```c
#include <emmintrin.h>  // For prefetch

// Cache line size (typically 64 bytes)
#define CACHE_LINE_SIZE 64

// Aligned allocation for cache efficiency
void* cache_aligned_alloc(size_t size) {
    void* ptr;
    int ret = posix_memalign(&ptr, CACHE_LINE_SIZE, size);
    return (ret == 0) ? ptr : NULL;
}

// Structure padding to avoid false sharing
typedef struct {
    _Atomic(int64_t) counter;
    char padding[CACHE_LINE_SIZE - sizeof(_Atomic(int64_t))];
} __attribute__((aligned(CACHE_LINE_SIZE))) padded_counter_t;

// Prefetching for performance
void process_large_array(int* array, size_t size) {
    const size_t prefetch_distance = 8;  // Prefetch 8 elements ahead
    
    for (size_t i = 0; i < size; i++) {
        // Prefetch future data
        if (i + prefetch_distance < size) {
            __builtin_prefetch(&array[i + prefetch_distance], 0, 3);
        }
        
        // Process current element
        array[i] = array[i] * 2 + 1;
    }
}

// Cache-oblivious algorithm example
void cache_oblivious_transpose(double* A, double* B, 
                              int n, int m,
                              int r0, int r1, 
                              int c0, int c1) {
    if (r1 - r0 <= 16 && c1 - c0 <= 16) {
        // Base case: small enough to fit in cache
        for (int i = r0; i < r1; i++) {
            for (int j = c0; j < c1; j++) {
                B[j * n + i] = A[i * m + j];
            }
        }
    } else if (r1 - r0 >= c1 - c0) {
        // Split rows
        int rm = (r0 + r1) / 2;
        cache_oblivious_transpose(A, B, n, m, r0, rm, c0, c1);
        cache_oblivious_transpose(A, B, n, m, rm, r1, c0, c1);
    } else {
        // Split columns
        int cm = (c0 + c1) / 2;
        cache_oblivious_transpose(A, B, n, m, r0, r1, c0, cm);
        cache_oblivious_transpose(A, B, n, m, r0, r1, cm, c1);
    }
}

// Memory bandwidth measurement
double measure_memory_bandwidth() {
    size_t size = 1024 * 1024 * 1024;  // 1GB
    char* buffer = malloc(size);
    
    // Warm up
    memset(buffer, 0, size);
    
    struct timespec start, end;
    clock_gettime(CLOCK_MONOTONIC, &start);
    
    // Write test
    for (int i = 0; i < 10; i++) {
        memset(buffer, i, size);
    }
    
    clock_gettime(CLOCK_MONOTONIC, &end);
    
    double elapsed = (end.tv_sec - start.tv_sec) + 
                    (end.tv_nsec - start.tv_nsec) / 1e9;
    double bandwidth = (size * 10.0) / elapsed / (1024 * 1024 * 1024);
    
    free(buffer);
    
    return bandwidth;
}
```

### Memory Access Patterns

```c
// Row-major vs column-major access
void benchmark_access_patterns() {
    const int N = 4096;
    double (*matrix)[N] = malloc(sizeof(double[N][N]));
    
    struct timespec start, end;
    
    // Row-major access (cache-friendly)
    clock_gettime(CLOCK_MONOTONIC, &start);
    for (int i = 0; i < N; i++) {
        for (int j = 0; j < N; j++) {
            matrix[i][j] = i * j;
        }
    }
    clock_gettime(CLOCK_MONOTONIC, &end);
    
    double row_major_time = (end.tv_sec - start.tv_sec) + 
                           (end.tv_nsec - start.tv_nsec) / 1e9;
    
    // Column-major access (cache-unfriendly)
    clock_gettime(CLOCK_MONOTONIC, &start);
    for (int j = 0; j < N; j++) {
        for (int i = 0; i < N; i++) {
            matrix[i][j] = i * j;
        }
    }
    clock_gettime(CLOCK_MONOTONIC, &end);
    
    double col_major_time = (end.tv_sec - start.tv_sec) + 
                           (end.tv_nsec - start.tv_nsec) / 1e9;
    
    printf("Access Pattern Performance:\n");
    printf("  Row-major:    %.3f seconds\n", row_major_time);
    printf("  Column-major: %.3f seconds\n", col_major_time);
    printf("  Speedup:      %.2fx\n", col_major_time / row_major_time);
    
    free(matrix);
}

// TLB optimization
void optimize_tlb_usage() {
    size_t page_size = sysconf(_SC_PAGE_SIZE);
    size_t huge_page_size = 2 * 1024 * 1024;
    
    // Many small allocations (TLB pressure)
    const int num_small = 10000;
    void** small_allocs = malloc(num_small * sizeof(void*));
    
    struct timespec start, end;
    clock_gettime(CLOCK_MONOTONIC, &start);
    
    for (int i = 0; i < num_small; i++) {
        small_allocs[i] = mmap(NULL, page_size,
                              PROT_READ | PROT_WRITE,
                              MAP_PRIVATE | MAP_ANONYMOUS,
                              -1, 0);
        *(int*)small_allocs[i] = i;  // Touch the page
    }
    
    clock_gettime(CLOCK_MONOTONIC, &end);
    double small_time = (end.tv_sec - start.tv_sec) + 
                       (end.tv_nsec - start.tv_nsec) / 1e9;
    
    // One large allocation (TLB-friendly)
    clock_gettime(CLOCK_MONOTONIC, &start);
    
    int* large_alloc = mmap(NULL, num_small * page_size,
                           PROT_READ | PROT_WRITE,
                           MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB,
                           -1, 0);
    
    if (large_alloc == MAP_FAILED) {
        large_alloc = mmap(NULL, num_small * page_size,
                          PROT_READ | PROT_WRITE,
                          MAP_PRIVATE | MAP_ANONYMOUS,
                          -1, 0);
    }
    
    for (int i = 0; i < num_small; i++) {
        large_alloc[i * (page_size / sizeof(int))] = i;
    }
    
    clock_gettime(CLOCK_MONOTONIC, &end);
    double large_time = (end.tv_sec - start.tv_sec) + 
                       (end.tv_nsec - start.tv_nsec) / 1e9;
    
    printf("TLB Optimization:\n");
    printf("  Many small pages: %.3f seconds\n", small_time);
    printf("  One large region: %.3f seconds\n", large_time);
    printf("  Speedup:          %.2fx\n", small_time / large_time);
    
    // Cleanup
    for (int i = 0; i < num_small; i++) {
        munmap(small_allocs[i], page_size);
    }
    free(small_allocs);
    munmap(large_alloc, num_small * page_size);
}
```

## Memory Debugging and Profiling

### Custom Memory Profiler

```c
// Memory profiling infrastructure
typedef struct mem_profile {
    size_t current_usage;
    size_t peak_usage;
    size_t total_allocated;
    size_t total_freed;
    size_t allocation_count;
    size_t free_count;
    GHashTable* allocations;  // ptr -> size
    GHashTable* callstacks;   // callstack -> count
} mem_profile_t;

static mem_profile_t g_profile = {0};
static pthread_mutex_t g_profile_lock = PTHREAD_MUTEX_INITIALIZER;

// Hook malloc/free
void* __real_malloc(size_t size);
void __real_free(void* ptr);

void* __wrap_malloc(size_t size) {
    void* ptr = __real_malloc(size);
    if (!ptr) return NULL;
    
    pthread_mutex_lock(&g_profile_lock);
    
    g_profile.current_usage += size;
    g_profile.total_allocated += size;
    g_profile.allocation_count++;
    
    if (g_profile.current_usage > g_profile.peak_usage) {
        g_profile.peak_usage = g_profile.current_usage;
    }
    
    if (g_profile.allocations) {
        g_hash_table_insert(g_profile.allocations, ptr, 
                           GSIZE_TO_POINTER(size));
    }
    
    pthread_mutex_unlock(&g_profile_lock);
    
    return ptr;
}

void __wrap_free(void* ptr) {
    if (!ptr) return;
    
    pthread_mutex_lock(&g_profile_lock);
    
    gpointer size_ptr = g_hash_table_lookup(g_profile.allocations, ptr);
    if (size_ptr) {
        size_t size = GPOINTER_TO_SIZE(size_ptr);
        g_profile.current_usage -= size;
        g_profile.total_freed += size;
        g_profile.free_count++;
        g_hash_table_remove(g_profile.allocations, ptr);
    }
    
    pthread_mutex_unlock(&g_profile_lock);
    
    __real_free(ptr);
}

void print_memory_profile() {
    pthread_mutex_lock(&g_profile_lock);
    
    printf("Memory Profile:\n");
    printf("  Current usage:     %zu MB\n", 
           g_profile.current_usage / (1024 * 1024));
    printf("  Peak usage:        %zu MB\n", 
           g_profile.peak_usage / (1024 * 1024));
    printf("  Total allocated:   %zu MB\n", 
           g_profile.total_allocated / (1024 * 1024));
    printf("  Total freed:       %zu MB\n", 
           g_profile.total_freed / (1024 * 1024));
    printf("  Allocation count:  %zu\n", g_profile.allocation_count);
    printf("  Free count:        %zu\n", g_profile.free_count);
    printf("  Outstanding allocs: %zu\n", 
           g_profile.allocation_count - g_profile.free_count);
    
    pthread_mutex_unlock(&g_profile_lock);
}
```

### Page Fault Analysis

```c
// Monitor page faults
void monitor_page_faults() {
    struct rusage usage_before, usage_after;
    getrusage(RUSAGE_SELF, &usage_before);
    
    // Allocate and access memory
    size_t size = 100 * 1024 * 1024;  // 100MB
    char* buffer = mmap(NULL, size,
                       PROT_READ | PROT_WRITE,
                       MAP_PRIVATE | MAP_ANONYMOUS,
                       -1, 0);
    
    // Access memory to trigger page faults
    for (size_t i = 0; i < size; i += 4096) {
        buffer[i] = 1;
    }
    
    getrusage(RUSAGE_SELF, &usage_after);
    
    printf("Page Fault Statistics:\n");
    printf("  Minor faults: %ld\n", 
           usage_after.ru_minflt - usage_before.ru_minflt);
    printf("  Major faults: %ld\n", 
           usage_after.ru_majflt - usage_before.ru_majflt);
    
    munmap(buffer, size);
}

// Real-time page fault monitoring
void* page_fault_monitor(void* arg) {
    FILE* stat_file = fopen("/proc/self/stat", "r");
    if (!stat_file) return NULL;
    
    while (1) {
        rewind(stat_file);
        
        char line[1024];
        if (fgets(line, sizeof(line), stat_file)) {
            // Parse /proc/self/stat for page fault counts
            unsigned long minflt, majflt;
            int fields = sscanf(line, 
                "%*d %*s %*c %*d %*d %*d %*d %*d %*u "
                "%lu %*lu %lu %*lu", &minflt, &majflt);
            
            if (fields == 2) {
                printf("\rMinor faults: %lu, Major faults: %lu", 
                       minflt, majflt);
                fflush(stdout);
            }
        }
        
        sleep(1);
    }
    
    fclose(stat_file);
    return NULL;
}
```

## Kernel Memory Management Interface

### Controlling Memory Behavior

```c
// Memory locking and pinning
void demonstrate_memory_locking() {
    size_t size = 10 * 1024 * 1024;  // 10MB
    void* buffer = malloc(size);
    
    // Lock memory to prevent swapping
    if (mlock(buffer, size) == 0) {
        printf("Locked %zu MB in RAM\n", size / (1024 * 1024));
        
        // Check locked memory limits
        struct rlimit rlim;
        getrlimit(RLIMIT_MEMLOCK, &rlim);
        printf("Memory lock limit: %zu MB\n", 
               rlim.rlim_cur / (1024 * 1024));
        
        // Unlock when done
        munlock(buffer, size);
    }
    
    // Lock all current and future memory
    if (mlockall(MCL_CURRENT | MCL_FUTURE) == 0) {
        printf("All process memory locked\n");
        munlockall();
    }
    
    free(buffer);
}

// Memory advice with madvise
void optimize_memory_access() {
    size_t size = 100 * 1024 * 1024;
    void* buffer = mmap(NULL, size,
                       PROT_READ | PROT_WRITE,
                       MAP_PRIVATE | MAP_ANONYMOUS,
                       -1, 0);
    
    // Sequential access pattern
    madvise(buffer, size, MADV_SEQUENTIAL);
    
    // Process sequentially
    char* data = buffer;
    for (size_t i = 0; i < size; i++) {
        data[i] = i & 0xFF;
    }
    
    // Random access pattern
    madvise(buffer, size, MADV_RANDOM);
    
    // Will need again soon
    madvise(buffer, size / 2, MADV_WILLNEED);
    
    // Done with this region
    madvise((char*)buffer + size / 2, size / 2, MADV_DONTNEED);
    
    // Free and punch hole
    madvise(buffer, size, MADV_REMOVE);
    
    munmap(buffer, size);
}

// Process memory map control
void control_memory_mapping() {
    // Disable address space randomization for debugging
    personality(ADDR_NO_RANDOMIZE);
    
    // Set memory overcommit
    FILE* fp = fopen("/proc/sys/vm/overcommit_memory", "w");
    if (fp) {
        fprintf(fp, "1\n");  // Always overcommit
        fclose(fp);
    }
    
    // Tune OOM killer
    fp = fopen("/proc/self/oom_score_adj", "w");
    if (fp) {
        fprintf(fp, "-1000\n");  // Disable OOM killer for this process
        fclose(fp);
    }
}
```

## Best Practices

1. **Understand Virtual Memory**: Know the difference between virtual and physical memory
2. **Monitor Memory Usage**: Use tools like /proc/meminfo and vmstat
3. **Optimize Access Patterns**: Consider cache hierarchy and TLB
4. **Use Appropriate Allocators**: Choose between malloc, mmap, and custom allocators
5. **Handle NUMA Systems**: Be aware of memory locality on multi-socket systems
6. **Profile and Measure**: Don't guess, measure actual memory behavior
7. **Lock Critical Memory**: Use mlock for real-time or security-critical data

## Conclusion

Linux memory management is a sophisticated system that provides powerful tools for application developers. From virtual memory abstractions to NUMA optimizations, from huge pages to custom allocators, understanding these mechanisms enables you to build applications that efficiently utilize system memory.

The techniques covered here—virtual memory analysis, custom allocators, NUMA awareness, and performance optimization—form the foundation for building high-performance Linux applications. By mastering these concepts, you can diagnose memory issues, optimize memory usage, and build systems that scale efficiently across diverse hardware configurations.