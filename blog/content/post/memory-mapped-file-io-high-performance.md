---
title: "Memory-Mapped File I/O for High-Performance Applications"
date: 2026-09-21T00:00:00-05:00
author: "Systems Engineering Team"
description: "Master memory-mapped file I/O techniques for building high-performance applications. Learn advanced mmap strategies, NUMA optimization, huge pages, async I/O integration, and enterprise-grade file management patterns."
categories: ["Systems Programming", "Performance Optimization", "File Systems"]
tags: ["memory mapping", "mmap", "file I/O", "performance optimization", "huge pages", "NUMA", "async I/O", "zero-copy", "file systems", "enterprise applications"]
keywords: ["memory mapped files", "mmap programming", "high performance I/O", "zero-copy I/O", "huge pages", "NUMA optimization", "async file I/O", "memory mapping techniques", "file system optimization"]
draft: false
toc: true
---

Memory-mapped file I/O represents one of the most powerful techniques for achieving high-performance file access in modern applications. By mapping files directly into virtual memory, applications can eliminate the overhead of traditional read/write system calls and leverage the operating system's virtual memory subsystem for optimal performance. This comprehensive guide explores advanced memory-mapping techniques and their implementation in enterprise-scale systems.

## Memory Mapping Fundamentals

Memory mapping creates a direct correspondence between a file's contents and a region of virtual memory, allowing applications to access file data using simple memory operations rather than explicit I/O calls.

### Basic Memory Mapping Operations

```c
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdint.h>

typedef struct {
    void *base_address;
    size_t file_size;
    size_t mapped_size;
    int file_descriptor;
    int protection_flags;
    int mapping_flags;
    char *filename;
    
    // Statistics
    size_t access_count;
    size_t page_faults;
    struct timespec last_access;
} memory_mapped_file_t;

// Create a memory-mapped file with comprehensive error handling
memory_mapped_file_t* create_memory_mapped_file(const char *filename, 
                                               size_t size, 
                                               int access_mode,
                                               bool create_if_missing) {
    memory_mapped_file_t *mmf = calloc(1, sizeof(memory_mapped_file_t));
    if (!mmf) return NULL;
    
    // Store filename for later reference
    mmf->filename = strdup(filename);
    
    // Open or create file
    int flags = O_RDWR;
    if (create_if_missing) {
        flags |= O_CREAT;
    }
    
    mmf->file_descriptor = open(filename, flags, 0644);
    if (mmf->file_descriptor < 0) {
        perror("Failed to open file");
        free(mmf->filename);
        free(mmf);
        return NULL;
    }
    
    // Get current file size
    struct stat file_stat;
    if (fstat(mmf->file_descriptor, &file_stat) < 0) {
        perror("Failed to get file stats");
        close(mmf->file_descriptor);
        free(mmf->filename);
        free(mmf);
        return NULL;
    }
    
    mmf->file_size = file_stat.st_size;
    
    // Extend file if necessary
    if (size > mmf->file_size) {
        if (ftruncate(mmf->file_descriptor, size) < 0) {
            perror("Failed to extend file");
            close(mmf->file_descriptor);
            free(mmf->filename);
            free(mmf);
            return NULL;
        }
        mmf->file_size = size;
    }
    
    // Determine protection and mapping flags
    mmf->protection_flags = PROT_READ;
    if (access_mode & O_WRONLY || access_mode & O_RDWR) {
        mmf->protection_flags |= PROT_WRITE;
    }
    
    mmf->mapping_flags = MAP_SHARED; // Changes are written back to file
    
    // Calculate aligned mapping size
    size_t page_size = getpagesize();
    mmf->mapped_size = ((mmf->file_size + page_size - 1) / page_size) * page_size;
    
    // Create memory mapping
    mmf->base_address = mmap(NULL, mmf->mapped_size, 
                            mmf->protection_flags, 
                            mmf->mapping_flags,
                            mmf->file_descriptor, 0);
    
    if (mmf->base_address == MAP_FAILED) {
        perror("Memory mapping failed");
        close(mmf->file_descriptor);
        free(mmf->filename);
        free(mmf);
        return NULL;
    }
    
    return mmf;
}

// Advanced memory mapping with huge pages support
memory_mapped_file_t* create_hugepage_mapped_file(const char *filename, 
                                                 size_t size,
                                                 bool use_transparent_hugepages) {
    memory_mapped_file_t *mmf = create_memory_mapped_file(filename, size, O_RDWR, true);
    if (!mmf) return NULL;
    
    if (use_transparent_hugepages) {
        // Advise kernel to use huge pages for this mapping
        if (madvise(mmf->base_address, mmf->mapped_size, MADV_HUGEPAGE) < 0) {
            fprintf(stderr, "Warning: Failed to enable huge pages: %s\n", 
                    strerror(errno));
        }
    } else {
        // Use explicit huge page allocation
        size_t hugepage_size = 2 * 1024 * 1024; // 2MB huge pages
        size_t aligned_size = ((size + hugepage_size - 1) / hugepage_size) * hugepage_size;
        
        // Remap with huge page alignment
        munmap(mmf->base_address, mmf->mapped_size);
        
        mmf->base_address = mmap(NULL, aligned_size,
                               mmf->protection_flags,
                               mmf->mapping_flags | MAP_HUGETLB,
                               mmf->file_descriptor, 0);
        
        if (mmf->base_address == MAP_FAILED) {
            // Fallback to regular pages
            fprintf(stderr, "Huge page allocation failed, using regular pages\n");
            mmf->base_address = mmap(NULL, mmf->mapped_size,
                                   mmf->protection_flags,
                                   mmf->mapping_flags,
                                   mmf->file_descriptor, 0);
            
            if (mmf->base_address == MAP_FAILED) {
                close(mmf->file_descriptor);
                free(mmf->filename);
                free(mmf);
                return NULL;
            }
        } else {
            mmf->mapped_size = aligned_size;
        }
    }
    
    return mmf;
}

// Cleanup memory-mapped file
void destroy_memory_mapped_file(memory_mapped_file_t *mmf) {
    if (!mmf) return;
    
    // Synchronize changes to storage
    if (msync(mmf->base_address, mmf->mapped_size, MS_SYNC) < 0) {
        perror("Failed to sync memory-mapped file");
    }
    
    // Unmap memory
    if (munmap(mmf->base_address, mmf->mapped_size) < 0) {
        perror("Failed to unmap memory");
    }
    
    // Close file descriptor
    close(mmf->file_descriptor);
    
    // Free resources
    free(mmf->filename);
    free(mmf);
}
```

## Advanced Memory Access Patterns

Different access patterns require specific optimization strategies to achieve maximum performance.

### Sequential and Random Access Optimization

```c
#include <sys/mman.h>

// Memory access pattern analyzer
typedef struct {
    size_t sequential_reads;
    size_t random_reads;
    size_t sequential_writes;
    size_t random_writes;
    size_t last_offset;
    size_t sequential_threshold;
    bool is_sequential_pattern;
} access_pattern_analyzer_t;

// Optimized sequential reader with prefetching
typedef struct {
    memory_mapped_file_t *mmf;
    size_t current_position;
    size_t prefetch_size;
    size_t read_ahead_distance;
    access_pattern_analyzer_t *analyzer;
} sequential_reader_t;

sequential_reader_t* create_sequential_reader(memory_mapped_file_t *mmf, 
                                            size_t prefetch_size) {
    sequential_reader_t *reader = malloc(sizeof(sequential_reader_t));
    if (!reader) return NULL;
    
    reader->mmf = mmf;
    reader->current_position = 0;
    reader->prefetch_size = prefetch_size;
    reader->read_ahead_distance = prefetch_size * 2;
    
    reader->analyzer = calloc(1, sizeof(access_pattern_analyzer_t));
    reader->analyzer->sequential_threshold = 4096; // 4KB threshold
    
    // Set initial access pattern advice
    madvise(mmf->base_address, mmf->mapped_size, MADV_SEQUENTIAL);
    
    return reader;
}

// Read data with intelligent prefetching
size_t sequential_read(sequential_reader_t *reader, void *buffer, size_t size) {
    if (!reader || !buffer) return 0;
    
    memory_mapped_file_t *mmf = reader->mmf;
    
    // Check bounds
    if (reader->current_position >= mmf->file_size) {
        return 0; // EOF
    }
    
    size_t bytes_to_read = size;
    if (reader->current_position + size > mmf->file_size) {
        bytes_to_read = mmf->file_size - reader->current_position;
    }
    
    // Analyze access pattern
    access_pattern_analyzer_t *analyzer = reader->analyzer;
    size_t offset_diff = (reader->current_position > analyzer->last_offset) ?
                        reader->current_position - analyzer->last_offset :
                        analyzer->last_offset - reader->current_position;
    
    if (offset_diff <= analyzer->sequential_threshold) {
        analyzer->sequential_reads++;
        analyzer->is_sequential_pattern = true;
    } else {
        analyzer->random_reads++;
        analyzer->is_sequential_pattern = false;
    }
    
    analyzer->last_offset = reader->current_position;
    
    // Adaptive prefetching based on pattern
    if (analyzer->is_sequential_pattern) {
        size_t prefetch_start = reader->current_position + bytes_to_read;
        size_t prefetch_end = prefetch_start + reader->read_ahead_distance;
        
        if (prefetch_end <= mmf->file_size) {
            // Asynchronous prefetch
            madvise((char*)mmf->base_address + prefetch_start,
                   reader->read_ahead_distance, MADV_WILLNEED);
        }
    } else {
        // Random access pattern detected
        madvise(mmf->base_address, mmf->mapped_size, MADV_RANDOM);
    }
    
    // Copy data from mapped memory
    memcpy(buffer, (char*)mmf->base_address + reader->current_position, bytes_to_read);
    reader->current_position += bytes_to_read;
    
    return bytes_to_read;
}

// High-performance random access structure
typedef struct {
    memory_mapped_file_t *mmf;
    size_t *hot_regions;
    size_t hot_region_count;
    size_t hot_region_capacity;
    
    // Cache for frequently accessed pages
    struct {
        size_t page_offset;
        void *cached_data;
        size_t access_count;
        struct timespec last_access;
    } *page_cache;
    size_t cache_size;
    
    // Statistics
    size_t cache_hits;
    size_t cache_misses;
} random_access_manager_t;

random_access_manager_t* create_random_access_manager(memory_mapped_file_t *mmf,
                                                    size_t cache_size) {
    random_access_manager_t *manager = malloc(sizeof(random_access_manager_t));
    if (!manager) return NULL;
    
    manager->mmf = mmf;
    manager->hot_region_capacity = 1024;
    manager->hot_regions = malloc(manager->hot_region_capacity * sizeof(size_t));
    manager->hot_region_count = 0;
    
    manager->cache_size = cache_size;
    manager->page_cache = calloc(cache_size, sizeof(*manager->page_cache));
    
    manager->cache_hits = 0;
    manager->cache_misses = 0;
    
    // Configure for random access
    madvise(mmf->base_address, mmf->mapped_size, MADV_RANDOM);
    
    return manager;
}

// Optimized random read with caching
size_t random_read(random_access_manager_t *manager, size_t offset, 
                  void *buffer, size_t size) {
    if (!manager || !buffer || offset >= manager->mmf->file_size) {
        return 0;
    }
    
    size_t bytes_to_read = size;
    if (offset + size > manager->mmf->file_size) {
        bytes_to_read = manager->mmf->file_size - offset;
    }
    
    size_t page_size = getpagesize();
    size_t page_offset = (offset / page_size) * page_size;
    
    // Check page cache first
    for (size_t i = 0; i < manager->cache_size; i++) {
        if (manager->page_cache[i].page_offset == page_offset &&
            manager->page_cache[i].cached_data != NULL) {
            
            // Cache hit
            manager->cache_hits++;
            manager->page_cache[i].access_count++;
            clock_gettime(CLOCK_MONOTONIC, &manager->page_cache[i].last_access);
            
            size_t offset_in_page = offset - page_offset;
            memcpy(buffer, (char*)manager->page_cache[i].cached_data + offset_in_page,
                   bytes_to_read);
            
            return bytes_to_read;
        }
    }
    
    // Cache miss - read from mapped memory
    manager->cache_misses++;
    
    // Track hot regions
    if (manager->hot_region_count < manager->hot_region_capacity) {
        manager->hot_regions[manager->hot_region_count++] = page_offset;
    }
    
    // Prefetch page
    madvise((char*)manager->mmf->base_address + page_offset, page_size, MADV_WILLNEED);
    
    // Copy data
    memcpy(buffer, (char*)manager->mmf->base_address + offset, bytes_to_read);
    
    // Update cache (simple LRU replacement)
    update_page_cache(manager, page_offset, 
                     (char*)manager->mmf->base_address + page_offset, page_size);
    
    return bytes_to_read;
}

void update_page_cache(random_access_manager_t *manager, size_t page_offset,
                      void *page_data, size_t page_size) {
    // Find LRU entry
    size_t lru_index = 0;
    struct timespec oldest_time = manager->page_cache[0].last_access;
    
    for (size_t i = 1; i < manager->cache_size; i++) {
        if (manager->page_cache[i].cached_data == NULL) {
            lru_index = i;
            break;
        }
        
        if (manager->page_cache[i].last_access.tv_sec < oldest_time.tv_sec ||
            (manager->page_cache[i].last_access.tv_sec == oldest_time.tv_sec &&
             manager->page_cache[i].last_access.tv_nsec < oldest_time.tv_nsec)) {
            oldest_time = manager->page_cache[i].last_access;
            lru_index = i;
        }
    }
    
    // Replace entry
    if (manager->page_cache[lru_index].cached_data) {
        free(manager->page_cache[lru_index].cached_data);
    }
    
    manager->page_cache[lru_index].page_offset = page_offset;
    manager->page_cache[lru_index].cached_data = malloc(page_size);
    memcpy(manager->page_cache[lru_index].cached_data, page_data, page_size);
    manager->page_cache[lru_index].access_count = 1;
    clock_gettime(CLOCK_MONOTONIC, &manager->page_cache[lru_index].last_access);
}
```

## NUMA-Aware Memory Mapping

Non-Uniform Memory Access (NUMA) considerations are crucial for optimal performance on multi-socket systems.

### NUMA Topology Detection and Optimization

```c
#include <numa.h>
#include <numaif.h>

typedef struct {
    int num_nodes;
    int *node_cpus;
    size_t *node_memory;
    int current_node;
    bool numa_available;
} numa_topology_t;

// Detect NUMA topology
numa_topology_t* detect_numa_topology() {
    numa_topology_t *topology = malloc(sizeof(numa_topology_t));
    if (!topology) return NULL;
    
    topology->numa_available = (numa_available() >= 0);
    
    if (!topology->numa_available) {
        topology->num_nodes = 1;
        topology->current_node = 0;
        topology->node_cpus = malloc(sizeof(int));
        topology->node_cpus[0] = numa_num_configured_cpus();
        topology->node_memory = malloc(sizeof(size_t));
        topology->node_memory[0] = numa_max_possible_node(); // Simplified
        return topology;
    }
    
    topology->num_nodes = numa_max_node() + 1;
    topology->node_cpus = malloc(topology->num_nodes * sizeof(int));
    topology->node_memory = malloc(topology->num_nodes * sizeof(size_t));
    
    for (int node = 0; node < topology->num_nodes; node++) {
        struct bitmask *cpu_mask = numa_allocate_cpumask();
        numa_node_to_cpus(node, cpu_mask);
        topology->node_cpus[node] = numa_bitmask_weight(cpu_mask);
        numa_free_cpumask(cpu_mask);
        
        long long free_memory;
        topology->node_memory[node] = numa_node_size64(node, &free_memory);
    }
    
    topology->current_node = numa_node_of_cpu(sched_getcpu());
    
    return topology;
}

// NUMA-aware memory-mapped file
typedef struct {
    memory_mapped_file_t **node_mappings;
    numa_topology_t *topology;
    size_t file_size;
    size_t chunk_size;
    int num_chunks;
    
    // Node affinity tracking
    int *chunk_to_node;
    pthread_mutex_t affinity_lock;
} numa_mapped_file_t;

numa_mapped_file_t* create_numa_mapped_file(const char *filename, 
                                           size_t file_size,
                                           numa_topology_t *topology) {
    numa_mapped_file_t *nmf = malloc(sizeof(numa_mapped_file_t));
    if (!nmf) return NULL;
    
    nmf->topology = topology;
    nmf->file_size = file_size;
    
    // Calculate chunk size based on file size and NUMA nodes
    nmf->chunk_size = (file_size + topology->num_nodes - 1) / topology->num_nodes;
    nmf->num_chunks = (file_size + nmf->chunk_size - 1) / nmf->chunk_size;
    
    // Align chunk size to page boundaries
    size_t page_size = getpagesize();
    nmf->chunk_size = ((nmf->chunk_size + page_size - 1) / page_size) * page_size;
    
    // Create mappings for each NUMA node
    nmf->node_mappings = malloc(topology->num_nodes * sizeof(memory_mapped_file_t*));
    nmf->chunk_to_node = malloc(nmf->num_chunks * sizeof(int));
    
    for (int node = 0; node < topology->num_nodes; node++) {
        // Create file mapping on specific NUMA node
        nmf->node_mappings[node] = create_memory_mapped_file(filename, file_size, O_RDWR, true);
        
        if (nmf->node_mappings[node] && topology->numa_available) {
            // Bind memory to specific NUMA node
            unsigned long node_mask = 1UL << node;
            mbind(nmf->node_mappings[node]->base_address,
                  nmf->node_mappings[node]->mapped_size,
                  MPOL_BIND, &node_mask, topology->num_nodes + 1, 0);
        }
    }
    
    // Initialize chunk-to-node mapping
    for (int chunk = 0; chunk < nmf->num_chunks; chunk++) {
        nmf->chunk_to_node[chunk] = chunk % topology->num_nodes;
    }
    
    pthread_mutex_init(&nmf->affinity_lock, NULL);
    
    return nmf;
}

// NUMA-aware read operation
size_t numa_aware_read(numa_mapped_file_t *nmf, size_t offset, 
                      void *buffer, size_t size) {
    if (offset >= nmf->file_size) return 0;
    
    size_t bytes_to_read = size;
    if (offset + size > nmf->file_size) {
        bytes_to_read = nmf->file_size - offset;
    }
    
    // Determine which chunk and NUMA node
    int chunk_index = offset / nmf->chunk_size;
    int target_node = nmf->chunk_to_node[chunk_index];
    
    // Get current CPU's NUMA node
    int current_node = numa_node_of_cpu(sched_getcpu());
    
    // Use local node mapping if available, otherwise use target node
    int access_node = (current_node < nmf->topology->num_nodes) ? 
                     current_node : target_node;
    
    memory_mapped_file_t *mapping = nmf->node_mappings[access_node];
    if (!mapping) {
        // Fallback to first available mapping
        for (int i = 0; i < nmf->topology->num_nodes; i++) {
            if (nmf->node_mappings[i]) {
                mapping = nmf->node_mappings[i];
                break;
            }
        }
    }
    
    if (!mapping) return 0;
    
    // Perform the read
    memcpy(buffer, (char*)mapping->base_address + offset, bytes_to_read);
    
    return bytes_to_read;
}

// Dynamic NUMA affinity optimization
void optimize_numa_affinity(numa_mapped_file_t *nmf, size_t *access_pattern, 
                           size_t pattern_length) {
    pthread_mutex_lock(&nmf->affinity_lock);
    
    // Analyze access pattern to determine optimal chunk placement
    int *node_access_count = calloc(nmf->topology->num_nodes, sizeof(int));
    int *chunk_access_count = calloc(nmf->num_chunks, sizeof(int));
    
    for (size_t i = 0; i < pattern_length; i++) {
        int chunk = access_pattern[i] / nmf->chunk_size;
        if (chunk < nmf->num_chunks) {
            chunk_access_count[chunk]++;
        }
    }
    
    // Reassign chunks to nodes based on access frequency
    for (int chunk = 0; chunk < nmf->num_chunks; chunk++) {
        if (chunk_access_count[chunk] > 10) { // Threshold for hot chunks
            // Find NUMA node with least load
            int best_node = 0;
            for (int node = 1; node < nmf->topology->num_nodes; node++) {
                if (node_access_count[node] < node_access_count[best_node]) {
                    best_node = node;
                }
            }
            
            nmf->chunk_to_node[chunk] = best_node;
            node_access_count[best_node] += chunk_access_count[chunk];
        }
    }
    
    free(node_access_count);
    free(chunk_access_count);
    
    pthread_mutex_unlock(&nmf->affinity_lock);
}
```

## Asynchronous I/O Integration

Combining memory mapping with asynchronous I/O provides optimal performance for complex access patterns.

### AIO and Memory Mapping Coordination

```c
#include <aio.h>
#include <signal.h>

typedef struct {
    memory_mapped_file_t *mmf;
    struct aiocb *pending_operations;
    size_t max_operations;
    size_t active_operations;
    
    // Completion handling
    void (*completion_callback)(struct aiocb *cb, void *user_data);
    void *user_data;
    
    // Event notification
    int event_fd;
    pthread_t completion_thread;
    volatile bool running;
    
    // Statistics
    size_t total_operations;
    size_t completed_operations;
    size_t failed_operations;
} async_mmapped_file_t;

// AIO completion handler
void aio_completion_handler(int sig, siginfo_t *info, void *context) {
    struct aiocb *cb = (struct aiocb*)info->si_value.sival_ptr;
    async_mmapped_file_t *amf = (async_mmapped_file_t*)cb->aio_sigevent.sigev_value.sival_ptr;
    
    int error = aio_error(cb);
    ssize_t bytes = aio_return(cb);
    
    if (error == 0) {
        amf->completed_operations++;
        
        // Synchronize with memory mapping
        if (cb->aio_lio_opcode == LIO_WRITE) {
            msync((char*)amf->mmf->base_address + cb->aio_offset, 
                  cb->aio_nbytes, MS_ASYNC);
        }
    } else {
        amf->failed_operations++;
    }
    
    // Call user completion callback
    if (amf->completion_callback) {
        amf->completion_callback(cb, amf->user_data);
    }
    
    amf->active_operations--;
}

async_mmapped_file_t* create_async_mmapped_file(const char *filename,
                                               size_t file_size,
                                               size_t max_operations) {
    async_mmapped_file_t *amf = malloc(sizeof(async_mmapped_file_t));
    if (!amf) return NULL;
    
    // Create memory-mapped file
    amf->mmf = create_memory_mapped_file(filename, file_size, O_RDWR, true);
    if (!amf->mmf) {
        free(amf);
        return NULL;
    }
    
    amf->max_operations = max_operations;
    amf->pending_operations = calloc(max_operations, sizeof(struct aiocb));
    amf->active_operations = 0;
    amf->running = true;
    
    // Set up signal handler for AIO completion
    struct sigaction sa;
    sa.sa_sigaction = aio_completion_handler;
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = SA_SIGINFO | SA_RESTART;
    sigaction(SIGRTMIN, &sa, NULL);
    
    return amf;
}

// Asynchronous read with memory mapping coordination
int async_mmapped_read(async_mmapped_file_t *amf, size_t offset, 
                      void *buffer, size_t size,
                      void (*callback)(struct aiocb*, void*),
                      void *user_data) {
    if (amf->active_operations >= amf->max_operations) {
        return -1; // Too many pending operations
    }
    
    // Find available operation slot
    struct aiocb *cb = NULL;
    for (size_t i = 0; i < amf->max_operations; i++) {
        if (amf->pending_operations[i].aio_fildes == 0) {
            cb = &amf->pending_operations[i];
            break;
        }
    }
    
    if (!cb) return -1;
    
    // Set up AIO control block
    memset(cb, 0, sizeof(struct aiocb));
    cb->aio_fildes = amf->mmf->file_descriptor;
    cb->aio_offset = offset;
    cb->aio_buf = buffer;
    cb->aio_nbytes = size;
    cb->aio_lio_opcode = LIO_READ;
    
    // Set up signal notification
    cb->aio_sigevent.sigev_notify = SIGEV_SIGNAL;
    cb->aio_sigevent.sigev_signo = SIGRTMIN;
    cb->aio_sigevent.sigev_value.sival_ptr = amf;
    
    // Check if data is already in memory mapping
    char *mapped_data = (char*)amf->mmf->base_address + offset;
    
    // Use mincore to check if pages are resident
    size_t page_size = getpagesize();
    size_t num_pages = (size + page_size - 1) / page_size;
    unsigned char *vec = malloc(num_pages);
    
    if (mincore(mapped_data, size, vec) == 0) {
        // Check if all pages are resident
        bool all_resident = true;
        for (size_t i = 0; i < num_pages; i++) {
            if (!(vec[i] & 1)) {
                all_resident = false;
                break;
            }
        }
        
        if (all_resident) {
            // Data is already in memory, perform synchronous copy
            memcpy(buffer, mapped_data, size);
            free(vec);
            
            // Simulate async completion
            if (callback) {
                callback(cb, user_data);
            }
            return 0;
        }
    }
    
    free(vec);
    
    // Submit asynchronous read
    if (aio_read(cb) < 0) {
        return -1;
    }
    
    amf->active_operations++;
    amf->total_operations++;
    
    return 0;
}

// Batch operations for high throughput
int submit_batch_operations(async_mmapped_file_t *amf, 
                           struct aiocb **operations, 
                           int num_operations) {
    // Ensure we don't exceed capacity
    if (amf->active_operations + num_operations > amf->max_operations) {
        return -1;
    }
    
    // Submit all operations in a batch
    if (lio_listio(LIO_NOWAIT, operations, num_operations, NULL) < 0) {
        return -1;
    }
    
    amf->active_operations += num_operations;
    amf->total_operations += num_operations;
    
    return 0;
}

// Wait for completion of all pending operations
void wait_for_completion(async_mmapped_file_t *amf) {
    while (amf->active_operations > 0) {
        struct timespec timeout = {0, 1000000}; // 1ms
        nanosleep(&timeout, NULL);
    }
}
```

## Enterprise Data Management Patterns

Production systems require sophisticated data management strategies that leverage memory mapping effectively.

### Concurrent Access Management

```c
#include <pthread.h>
#include <semaphore.h>

// Read-write lock optimized for memory-mapped files
typedef struct {
    pthread_rwlock_t rwlock;
    atomic_int active_readers;
    atomic_int active_writers;
    atomic_int pending_writers;
    
    // Memory synchronization
    pthread_mutex_t sync_mutex;
    pthread_cond_t sync_cond;
    bool sync_in_progress;
    
    // Performance monitoring
    uint64_t read_acquisitions;
    uint64_t write_acquisitions;
    uint64_t lock_contentions;
    struct timespec total_wait_time;
} mmf_rwlock_t;

mmf_rwlock_t* create_mmf_rwlock() {
    mmf_rwlock_t *lock = malloc(sizeof(mmf_rwlock_t));
    if (!lock) return NULL;
    
    pthread_rwlock_init(&lock->rwlock, NULL);
    atomic_store(&lock->active_readers, 0);
    atomic_store(&lock->active_writers, 0);
    atomic_store(&lock->pending_writers, 0);
    
    pthread_mutex_init(&lock->sync_mutex, NULL);
    pthread_cond_init(&lock->sync_cond, NULL);
    lock->sync_in_progress = false;
    
    lock->read_acquisitions = 0;
    lock->write_acquisitions = 0;
    lock->lock_contentions = 0;
    
    return lock;
}

// Memory-mapped file with concurrent access support
typedef struct {
    memory_mapped_file_t *mmf;
    mmf_rwlock_t *access_lock;
    
    // Version tracking for optimistic concurrency
    atomic_uint64_t version;
    
    // Dirty page tracking
    unsigned char *dirty_pages;
    size_t num_pages;
    pthread_mutex_t dirty_lock;
    
    // Background sync thread
    pthread_t sync_thread;
    volatile bool sync_running;
    int sync_interval_ms;
} concurrent_mmapped_file_t;

concurrent_mmapped_file_t* create_concurrent_mmapped_file(const char *filename,
                                                        size_t file_size,
                                                        int sync_interval_ms) {
    concurrent_mmapped_file_t *cmf = malloc(sizeof(concurrent_mmapped_file_t));
    if (!cmf) return NULL;
    
    cmf->mmf = create_memory_mapped_file(filename, file_size, O_RDWR, true);
    if (!cmf->mmf) {
        free(cmf);
        return NULL;
    }
    
    cmf->access_lock = create_mmf_rwlock();
    atomic_store(&cmf->version, 1);
    
    // Initialize dirty page tracking
    size_t page_size = getpagesize();
    cmf->num_pages = (file_size + page_size - 1) / page_size;
    cmf->dirty_pages = calloc((cmf->num_pages + 7) / 8, 1); // Bit array
    
    pthread_mutex_init(&cmf->dirty_lock, NULL);
    
    cmf->sync_interval_ms = sync_interval_ms;
    cmf->sync_running = true;
    
    // Start background sync thread
    pthread_create(&cmf->sync_thread, NULL, background_sync_thread, cmf);
    
    return cmf;
}

// Background synchronization thread
void* background_sync_thread(void *arg) {
    concurrent_mmapped_file_t *cmf = (concurrent_mmapped_file_t*)arg;
    
    while (cmf->sync_running) {
        struct timespec sleep_time = {
            .tv_sec = cmf->sync_interval_ms / 1000,
            .tv_nsec = (cmf->sync_interval_ms % 1000) * 1000000
        };
        nanosleep(&sleep_time, NULL);
        
        // Synchronize dirty pages
        sync_dirty_pages(cmf);
    }
    
    return NULL;
}

void sync_dirty_pages(concurrent_mmapped_file_t *cmf) {
    pthread_mutex_lock(&cmf->dirty_lock);
    
    size_t page_size = getpagesize();
    
    for (size_t page = 0; page < cmf->num_pages; page++) {
        size_t byte_index = page / 8;
        size_t bit_index = page % 8;
        
        if (cmf->dirty_pages[byte_index] & (1 << bit_index)) {
            // Page is dirty, sync it
            size_t offset = page * page_size;
            size_t sync_size = page_size;
            
            if (offset + sync_size > cmf->mmf->file_size) {
                sync_size = cmf->mmf->file_size - offset;
            }
            
            msync((char*)cmf->mmf->base_address + offset, sync_size, MS_ASYNC);
            
            // Clear dirty bit
            cmf->dirty_pages[byte_index] &= ~(1 << bit_index);
        }
    }
    
    pthread_mutex_unlock(&cmf->dirty_lock);
}

// Mark pages as dirty after write operations
void mark_dirty_pages(concurrent_mmapped_file_t *cmf, size_t offset, size_t size) {
    pthread_mutex_lock(&cmf->dirty_lock);
    
    size_t page_size = getpagesize();
    size_t start_page = offset / page_size;
    size_t end_page = (offset + size - 1) / page_size;
    
    for (size_t page = start_page; page <= end_page && page < cmf->num_pages; page++) {
        size_t byte_index = page / 8;
        size_t bit_index = page % 8;
        cmf->dirty_pages[byte_index] |= (1 << bit_index);
    }
    
    pthread_mutex_unlock(&cmf->dirty_lock);
}

// Thread-safe read with version checking
size_t concurrent_read(concurrent_mmapped_file_t *cmf, size_t offset,
                      void *buffer, size_t size, uint64_t *version) {
    struct timespec start_time, end_time;
    clock_gettime(CLOCK_MONOTONIC, &start_time);
    
    // Acquire read lock
    if (pthread_rwlock_rdlock(&cmf->access_lock->rwlock) != 0) {
        return 0;
    }
    
    clock_gettime(CLOCK_MONOTONIC, &end_time);
    
    // Update statistics
    atomic_fetch_add(&cmf->access_lock->active_readers, 1);
    cmf->access_lock->read_acquisitions++;
    
    // Check version if provided
    uint64_t current_version = atomic_load(&cmf->version);
    if (version && *version != 0 && *version != current_version) {
        // Version mismatch
        atomic_fetch_sub(&cmf->access_lock->active_readers, 1);
        pthread_rwlock_unlock(&cmf->access_lock->rwlock);
        *version = current_version;
        return 0;
    }
    
    // Perform read
    size_t bytes_read = 0;
    if (offset < cmf->mmf->file_size) {
        bytes_read = size;
        if (offset + size > cmf->mmf->file_size) {
            bytes_read = cmf->mmf->file_size - offset;
        }
        
        memcpy(buffer, (char*)cmf->mmf->base_address + offset, bytes_read);
    }
    
    if (version) {
        *version = current_version;
    }
    
    atomic_fetch_sub(&cmf->access_lock->active_readers, 1);
    pthread_rwlock_unlock(&cmf->access_lock->rwlock);
    
    return bytes_read;
}

// Thread-safe write with version increment
size_t concurrent_write(concurrent_mmapped_file_t *cmf, size_t offset,
                       const void *buffer, size_t size) {
    // Acquire write lock
    atomic_fetch_add(&cmf->access_lock->pending_writers, 1);
    
    if (pthread_rwlock_wrlock(&cmf->access_lock->rwlock) != 0) {
        atomic_fetch_sub(&cmf->access_lock->pending_writers, 1);
        return 0;
    }
    
    atomic_fetch_sub(&cmf->access_lock->pending_writers, 1);
    atomic_fetch_add(&cmf->access_lock->active_writers, 1);
    cmf->access_lock->write_acquisitions++;
    
    // Perform write
    size_t bytes_written = 0;
    if (offset < cmf->mmf->file_size) {
        bytes_written = size;
        if (offset + size > cmf->mmf->file_size) {
            bytes_written = cmf->mmf->file_size - offset;
        }
        
        memcpy((char*)cmf->mmf->base_address + offset, buffer, bytes_written);
        
        // Mark pages as dirty
        mark_dirty_pages(cmf, offset, bytes_written);
        
        // Increment version
        atomic_fetch_add(&cmf->version, 1);
    }
    
    atomic_fetch_sub(&cmf->access_lock->active_writers, 1);
    pthread_rwlock_unlock(&cmf->access_lock->rwlock);
    
    return bytes_written;
}
```

## Performance Monitoring and Optimization

Comprehensive monitoring is essential for optimizing memory-mapped file performance in production environments.

### Advanced Performance Metrics

```c
// Performance monitoring structure
typedef struct {
    // I/O statistics
    uint64_t total_reads;
    uint64_t total_writes;
    uint64_t bytes_read;
    uint64_t bytes_written;
    
    // Memory statistics
    uint64_t page_faults;
    uint64_t minor_faults;
    uint64_t major_faults;
    
    // Timing statistics
    double average_read_latency;
    double average_write_latency;
    double max_read_latency;
    double max_write_latency;
    
    // Cache statistics
    uint64_t cache_hits;
    uint64_t cache_misses;
    double hit_ratio;
    
    // NUMA statistics
    uint64_t local_node_accesses;
    uint64_t remote_node_accesses;
    
    // Contention statistics
    uint64_t lock_contentions;
    double average_lock_wait_time;
    
    pthread_mutex_t stats_mutex;
} performance_monitor_t;

performance_monitor_t* create_performance_monitor() {
    performance_monitor_t *monitor = calloc(1, sizeof(performance_monitor_t));
    if (!monitor) return NULL;
    
    pthread_mutex_init(&monitor->stats_mutex, NULL);
    return monitor;
}

// Update statistics with thread safety
void update_read_stats(performance_monitor_t *monitor, size_t bytes, double latency) {
    pthread_mutex_lock(&monitor->stats_mutex);
    
    monitor->total_reads++;
    monitor->bytes_read += bytes;
    
    // Update latency statistics (exponential moving average)
    if (monitor->total_reads == 1) {
        monitor->average_read_latency = latency;
    } else {
        monitor->average_read_latency = 0.9 * monitor->average_read_latency + 0.1 * latency;
    }
    
    if (latency > monitor->max_read_latency) {
        monitor->max_read_latency = latency;
    }
    
    pthread_mutex_unlock(&monitor->stats_mutex);
}

// Generate comprehensive performance report
void generate_performance_report(performance_monitor_t *monitor, 
                                memory_mapped_file_t *mmf) {
    pthread_mutex_lock(&monitor->stats_mutex);
    
    printf("=== Memory-Mapped File Performance Report ===\n");
    printf("File: %s\n", mmf->filename);
    printf("File Size: %zu bytes (%.2f MB)\n", 
           mmf->file_size, mmf->file_size / 1048576.0);
    printf("Mapped Size: %zu bytes (%.2f MB)\n", 
           mmf->mapped_size, mmf->mapped_size / 1048576.0);
    
    printf("\n--- I/O Statistics ---\n");
    printf("Total Reads: %lu\n", monitor->total_reads);
    printf("Total Writes: %lu\n", monitor->total_writes);
    printf("Bytes Read: %lu (%.2f MB)\n", 
           monitor->bytes_read, monitor->bytes_read / 1048576.0);
    printf("Bytes Written: %lu (%.2f MB)\n", 
           monitor->bytes_written, monitor->bytes_written / 1048576.0);
    
    printf("\n--- Latency Statistics ---\n");
    printf("Average Read Latency: %.3f ms\n", monitor->average_read_latency * 1000);
    printf("Average Write Latency: %.3f ms\n", monitor->average_write_latency * 1000);
    printf("Max Read Latency: %.3f ms\n", monitor->max_read_latency * 1000);
    printf("Max Write Latency: %.3f ms\n", monitor->max_write_latency * 1000);
    
    if (monitor->cache_hits + monitor->cache_misses > 0) {
        monitor->hit_ratio = (double)monitor->cache_hits / 
                           (monitor->cache_hits + monitor->cache_misses);
        printf("\n--- Cache Statistics ---\n");
        printf("Cache Hits: %lu\n", monitor->cache_hits);
        printf("Cache Misses: %lu\n", monitor->cache_misses);
        printf("Hit Ratio: %.2f%%\n", monitor->hit_ratio * 100);
    }
    
    if (monitor->local_node_accesses + monitor->remote_node_accesses > 0) {
        printf("\n--- NUMA Statistics ---\n");
        printf("Local Node Accesses: %lu\n", monitor->local_node_accesses);
        printf("Remote Node Accesses: %lu\n", monitor->remote_node_accesses);
        printf("NUMA Locality: %.2f%%\n", 
               100.0 * monitor->local_node_accesses / 
               (monitor->local_node_accesses + monitor->remote_node_accesses));
    }
    
    printf("\n--- Memory Statistics ---\n");
    printf("Total Page Faults: %lu\n", monitor->page_faults);
    printf("Minor Faults: %lu\n", monitor->minor_faults);
    printf("Major Faults: %lu\n", monitor->major_faults);
    
    if (monitor->lock_contentions > 0) {
        printf("\n--- Contention Statistics ---\n");
        printf("Lock Contentions: %lu\n", monitor->lock_contentions);
        printf("Average Lock Wait Time: %.3f ms\n", 
               monitor->average_lock_wait_time * 1000);
    }
    
    printf("=============================================\n");
    
    pthread_mutex_unlock(&monitor->stats_mutex);
}

// Automated optimization recommendations
void analyze_and_recommend(performance_monitor_t *monitor, 
                          memory_mapped_file_t *mmf) {
    printf("\n=== Performance Analysis & Recommendations ===\n");
    
    // Analyze hit ratio
    if (monitor->hit_ratio < 0.8 && monitor->cache_hits + monitor->cache_misses > 1000) {
        printf("⚠️  Low cache hit ratio (%.1f%%). Consider:\n", monitor->hit_ratio * 100);
        printf("   - Increasing cache size\n");
        printf("   - Optimizing access patterns\n");
        printf("   - Using memory-mapped file prefetching\n");
    }
    
    // Analyze NUMA locality
    double numa_locality = (double)monitor->local_node_accesses / 
                          (monitor->local_node_accesses + monitor->remote_node_accesses);
    if (numa_locality < 0.7 && monitor->local_node_accesses + monitor->remote_node_accesses > 1000) {
        printf("⚠️  Poor NUMA locality (%.1f%%). Consider:\n", numa_locality * 100);
        printf("   - Implementing NUMA-aware thread affinity\n");
        printf("   - Using NUMA-specific memory policies\n");
        printf("   - Partitioning data by NUMA node\n");
    }
    
    // Analyze page fault ratio
    if (monitor->major_faults > monitor->page_faults * 0.1) {
        printf("⚠️  High major fault ratio. Consider:\n");
        printf("   - Increasing available memory\n");
        printf("   - Using mlock() for critical sections\n");
        printf("   - Implementing better prefetching strategies\n");
    }
    
    // Analyze latency patterns
    if (monitor->max_read_latency > monitor->average_read_latency * 10) {
        printf("⚠️  High latency variance detected. Consider:\n");
        printf("   - Investigating I/O scheduling issues\n");
        printf("   - Using real-time scheduling for critical threads\n");
        printf("   - Implementing latency-aware load balancing\n");
    }
    
    printf("===============================================\n");
}
```

## Conclusion

Memory-mapped file I/O provides a powerful foundation for building high-performance applications that require efficient file access. The techniques presented in this guide demonstrate how to leverage memory mapping effectively, from basic operations to sophisticated enterprise-grade implementations with NUMA awareness, asynchronous I/O integration, and comprehensive performance monitoring.

Key considerations for successful memory-mapped file implementation include understanding access patterns, optimizing for NUMA topologies, implementing robust concurrent access controls, and maintaining comprehensive performance monitoring. When applied correctly, these techniques can deliver significant performance improvements over traditional file I/O methods, particularly in applications that process large datasets or require low-latency access to file contents.

The patterns and implementations shown here provide a solid foundation for building scalable, high-performance systems that can efficiently handle the demanding I/O requirements of modern enterprise applications while maintaining data integrity and optimal resource utilization.