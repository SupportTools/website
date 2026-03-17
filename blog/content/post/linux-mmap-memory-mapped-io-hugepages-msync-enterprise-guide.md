---
title: "Linux Memory-Mapped I/O with mmap: File-Backed Maps, Anonymous Maps, MAP_HUGEPAGES, msync, and Process-Shared Memory"
date: 2032-02-11T00:00:00-05:00
draft: false
tags: ["Linux", "mmap", "Memory-Mapped I/O", "HugePages", "MAP_HUGETLB", "msync", "Shared Memory", "System Programming", "Performance"]
categories: ["Linux", "System Programming", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux mmap system programming: implementing file-backed and anonymous memory maps, using MAP_HUGETLB for large page optimization, synchronizing with msync, and building process-shared memory regions for inter-process communication in enterprise applications."
more_link: "yes"
url: "/linux-mmap-memory-mapped-io-hugepages-msync-enterprise-guide/"
---

Memory-mapped I/O (`mmap`) is one of the most powerful and misunderstood interfaces in the Linux kernel. At its core, `mmap` maps a file or device into virtual memory — the kernel's page cache becomes the backing store, and file I/O becomes load/store instructions. This avoids the double-copy overhead of `read()`/`write()` (kernel buffer to user buffer), eliminates system call overhead for sequential access, and enables powerful patterns like shared memory between processes without explicit IPC infrastructure. This guide provides deep coverage of every `mmap` pattern relevant to production systems programming.

<!--more-->

# Linux Memory-Mapped I/O with mmap: Enterprise System Programming Guide

## mmap Fundamentals

The `mmap` system call creates a mapping in the virtual address space of the calling process:

```c
void *mmap(void *addr,         /* hint for mapping address (usually NULL) */
           size_t length,       /* length of mapping in bytes */
           int prot,            /* PROT_READ | PROT_WRITE | PROT_EXEC | PROT_NONE */
           int flags,           /* MAP_SHARED | MAP_PRIVATE | MAP_ANONYMOUS | ... */
           int fd,              /* file descriptor (-1 for MAP_ANONYMOUS) */
           off_t offset);       /* offset in the file (must be page-aligned) */
```

Return value: the mapped address, or `MAP_FAILED` ((void *)-1) on error.

### Key Flag Combinations

| Flags | Description |
|---|---|
| `MAP_SHARED` | Writes are visible to other mappings of the same file |
| `MAP_PRIVATE` | Copy-on-Write — writes are private to this process |
| `MAP_ANONYMOUS` | Not backed by a file; memory initialized to zero |
| `MAP_FIXED` | Place mapping at exactly the specified address |
| `MAP_HUGETLB` | Use huge pages (2MB or 1GB) instead of 4KB pages |
| `MAP_LOCKED` | Lock pages in RAM (prevent swap) |
| `MAP_POPULATE` | Pre-fault all pages (avoids page fault latency later) |
| `MAP_NORESERVE` | Don't reserve swap space (overcommit aggressively) |

## File-Backed Memory Maps

### Basic File Read with mmap

```c
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>

// Read a file using mmap — zero copy compared to read()
int read_file_mmap(const char *path, char **out_data, size_t *out_len) {
    int fd = open(path, O_RDONLY);
    if (fd < 0) {
        perror("open");
        return -1;
    }

    struct stat st;
    if (fstat(fd, &st) < 0) {
        perror("fstat");
        close(fd);
        return -1;
    }

    if (st.st_size == 0) {
        *out_data = NULL;
        *out_len = 0;
        close(fd);
        return 0;
    }

    void *data = mmap(NULL, st.st_size, PROT_READ, MAP_SHARED, fd, 0);
    close(fd);  // File descriptor can be closed after mmap

    if (data == MAP_FAILED) {
        perror("mmap");
        return -1;
    }

    // Advise the kernel about expected access pattern
    madvise(data, st.st_size, MADV_SEQUENTIAL);

    *out_data = (char *)data;
    *out_len = (size_t)st.st_size;
    return 0;
}

void release_mmap(void *data, size_t len) {
    if (data && data != MAP_FAILED) {
        munmap(data, len);
    }
}
```

### Write-Through File Mapping

```c
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>

// Map a file for read/write — writes go directly to page cache
int map_file_rw(const char *path, void **out_addr, size_t *out_len) {
    int fd = open(path, O_RDWR);
    if (fd < 0) return -1;

    struct stat st;
    if (fstat(fd, &st) < 0) {
        close(fd);
        return -1;
    }

    size_t len = (size_t)st.st_size;
    void *addr = mmap(NULL, len, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    close(fd);

    if (addr == MAP_FAILED) return -1;

    *out_addr = addr;
    *out_len = len;
    return 0;
}
```

### Creating a File and Expanding It for Mapping

A common pattern for write-back databases:

```c
int create_mapped_file(const char *path, size_t size, void **out_addr) {
    // Create or truncate the file
    int fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) return -1;

    // Expand the file to the desired size
    // Method 1: ftruncate (preferred)
    if (ftruncate(fd, (off_t)size) < 0) {
        close(fd);
        return -1;
    }

    // Method 2: seek + write (alternative for non-sparse files)
    // lseek(fd, size - 1, SEEK_SET);
    // write(fd, "", 1);

    void *addr = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    close(fd);

    if (addr == MAP_FAILED) return -1;

    *out_addr = addr;
    return 0;
}
```

## msync: Flushing Memory Maps to Disk

Writes to a `MAP_SHARED` mapping go to the page cache, not immediately to disk. `msync` ensures durability.

```c
#include <sys/mman.h>

// msync flags:
// MS_SYNC     - block until I/O is complete (use for durability guarantees)
// MS_ASYNC    - initiate I/O but don't wait (use for performance)
// MS_INVALIDATE - invalidate cached data (other processes see fresh data)

// Sync the entire mapping to disk (durable write)
int sync_mapping(void *addr, size_t len) {
    if (msync(addr, len, MS_SYNC) < 0) {
        perror("msync");
        return -1;
    }
    return 0;
}

// Async sync — better performance, weaker durability guarantee
int async_sync_mapping(void *addr, size_t len) {
    return msync(addr, len, MS_ASYNC);
}

// Sync a partial range (e.g., only a modified record)
// Note: addr must be page-aligned
int sync_range(void *base, size_t offset, size_t length) {
    // Align down to page boundary
    long page_size = sysconf(_SC_PAGESIZE);
    size_t aligned_offset = offset & ~(page_size - 1);
    size_t adjusted_len = length + (offset - aligned_offset);

    char *aligned_addr = (char *)base + aligned_offset;
    return msync(aligned_addr, adjusted_len, MS_SYNC);
}
```

### When msync Is Required vs. Optional

- **Required for crash consistency**: If your application must guarantee that data survives a crash, use `MS_SYNC` before acknowledging writes to callers.
- **Optional for performance optimization**: For logging or analytics where some data loss on crash is acceptable, `MS_ASYNC` or no explicit `msync` is fine.
- **fsync equivalent**: `msync(addr, len, MS_SYNC)` followed by `fsync(fd)` is equivalent to `fsync(fd)` alone for file-backed mappings, but `msync` is needed if you've closed the file descriptor.

## Anonymous Memory Maps

Anonymous maps are not backed by any file. They're initialized to zero by the kernel.

### Large Buffer Allocation

```c
// Allocate a large buffer via mmap — better than malloc for very large sizes
// because it doesn't fragment the heap and can be released back to the OS
void *alloc_large_buffer(size_t size) {
    void *ptr = mmap(NULL, size,
                     PROT_READ | PROT_WRITE,
                     MAP_PRIVATE | MAP_ANONYMOUS,
                     -1, 0);
    if (ptr == MAP_FAILED) return NULL;
    return ptr;
}

void free_large_buffer(void *ptr, size_t size) {
    munmap(ptr, size);
}

// Example: allocate 1GB buffer for in-memory processing
void process_large_dataset(void) {
    size_t buffer_size = 1024UL * 1024 * 1024;  // 1GB
    void *buf = alloc_large_buffer(buffer_size);
    if (!buf) {
        perror("alloc_large_buffer");
        return;
    }

    // Process data...

    free_large_buffer(buf, buffer_size);
}
```

### Stack Allocation with mmap (Custom Stack for Threads)

```c
#include <pthread.h>
#include <sys/mman.h>

// Allocate a custom thread stack with a guard page
void *create_thread_stack(size_t stack_size, void **guard_page) {
    // Allocate stack + guard page
    size_t page_size = (size_t)sysconf(_SC_PAGESIZE);
    size_t total = stack_size + page_size;

    void *mem = mmap(NULL, total,
                     PROT_READ | PROT_WRITE,
                     MAP_PRIVATE | MAP_ANONYMOUS | MAP_STACK,
                     -1, 0);
    if (mem == MAP_FAILED) return NULL;

    // Make the guard page non-accessible (detect stack overflow)
    if (mprotect(mem, page_size, PROT_NONE) < 0) {
        munmap(mem, total);
        return NULL;
    }

    *guard_page = mem;
    return (char *)mem + page_size;  // Stack starts after guard page
}
```

## MAP_HUGETLB: Huge Page Support

On x86-64, the default page size is 4KB. Huge pages are 2MB or 1GB. The benefit: fewer TLB entries needed for the same working set, reducing TLB miss overhead significantly for large memory workloads.

### Checking Huge Page Availability

```bash
# Check current huge page configuration
cat /proc/meminfo | grep -i huge

# Output example:
# AnonHugePages:    524288 kB   <- THP (Transparent Huge Pages)
# ShmemHugePages:        0 kB
# HugePages_Total:      64
# HugePages_Free:       64
# HugePages_Rsvd:        0
# HugePages_Surp:        0
# Hugepagesize:       2048 kB  <- 2MB pages
# Hugetlb:          131072 kB

# Allocate huge pages persistently
echo 64 > /proc/sys/vm/nr_hugepages

# Or via sysctl
sysctl -w vm.nr_hugepages=64
```

### Explicit Huge Page Mapping (MAP_HUGETLB)

```c
#include <sys/mman.h>
#include <linux/mman.h>

// Map 2MB huge pages explicitly
void *alloc_hugepage_buffer(size_t size_bytes) {
    // Size must be a multiple of 2MB
    size_t huge_page_size = 2 * 1024 * 1024;
    size_t aligned_size = (size_bytes + huge_page_size - 1) & ~(huge_page_size - 1);

    void *ptr = mmap(NULL, aligned_size,
                     PROT_READ | PROT_WRITE,
                     MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB,
                     -1, 0);

    if (ptr == MAP_FAILED) {
        // Fallback to regular pages if huge pages unavailable
        perror("mmap MAP_HUGETLB");
        return mmap(NULL, size_bytes,
                    PROT_READ | PROT_WRITE,
                    MAP_PRIVATE | MAP_ANONYMOUS,
                    -1, 0);
    }

    return ptr;
}

// Map 1GB huge pages (requires 1GB hugepage support in kernel)
void *alloc_1gb_hugepage(void) {
    size_t gb = 1024UL * 1024 * 1024;
    return mmap(NULL, gb,
                PROT_READ | PROT_WRITE,
                MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB |
                (30 << MAP_HUGE_SHIFT),  // 30 = log2(1GB)
                -1, 0);
}
```

### Transparent Huge Pages (THP)

THP automatically promotes regular 4KB pages to 2MB huge pages when contiguous pages are available. For most applications, THP is preferable to explicit `MAP_HUGETLB`:

```bash
# Check THP policy
cat /sys/kernel/mm/transparent_hugepage/enabled
# always [madvise] never

# Enable THP for specific memory regions via madvise
```

```c
#include <sys/mman.h>

// Hint to the kernel that this memory region benefits from huge pages
void enable_thp_for_region(void *addr, size_t len) {
    madvise(addr, len, MADV_HUGEPAGE);
}

// Disable THP for a region (e.g., where huge pages hurt due to fragmentation)
void disable_thp_for_region(void *addr, size_t len) {
    madvise(addr, len, MADV_NOHUGEPAGE);
}
```

## Process-Shared Memory

### POSIX Shared Memory (shm_open)

```c
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>

#define SHM_NAME "/my_shared_memory"
#define SHM_SIZE (1024 * 1024)  // 1MB

// Writer process: create and populate shared memory
int shm_write(void) {
    // Create shared memory object
    int fd = shm_open(SHM_NAME, O_CREAT | O_RDWR, 0600);
    if (fd < 0) { perror("shm_open"); return -1; }

    // Set size
    if (ftruncate(fd, SHM_SIZE) < 0) {
        perror("ftruncate");
        close(fd);
        return -1;
    }

    // Map it
    void *addr = mmap(NULL, SHM_SIZE,
                      PROT_READ | PROT_WRITE,
                      MAP_SHARED, fd, 0);
    close(fd);

    if (addr == MAP_FAILED) { perror("mmap"); return -1; }

    // Write data
    snprintf((char *)addr, SHM_SIZE, "Hello from writer PID %d", getpid());

    // Ensure other processes see the write
    msync(addr, SHM_SIZE, MS_SYNC);

    munmap(addr, SHM_SIZE);
    return 0;
}

// Reader process: open and read shared memory
int shm_read(void) {
    int fd = shm_open(SHM_NAME, O_RDONLY, 0);
    if (fd < 0) { perror("shm_open"); return -1; }

    void *addr = mmap(NULL, SHM_SIZE, PROT_READ, MAP_SHARED, fd, 0);
    close(fd);

    if (addr == MAP_FAILED) { perror("mmap"); return -1; }

    printf("Reader sees: %s\n", (char *)addr);

    munmap(addr, SHM_SIZE);
    return 0;
}

// Cleanup
void shm_cleanup(void) {
    shm_unlink(SHM_NAME);
}
```

### Shared Memory with Mutex and Condition Variable

For synchronized inter-process communication:

```c
#include <pthread.h>
#include <sys/mman.h>

typedef struct {
    pthread_mutex_t mutex;
    pthread_cond_t  cond;
    int             data_ready;
    char            data[4096];
} SharedBuffer;

// Initialize shared memory with process-shared mutex
int create_shared_buffer(SharedBuffer **out) {
    size_t size = sizeof(SharedBuffer);

    void *addr = mmap(NULL, size,
                      PROT_READ | PROT_WRITE,
                      MAP_SHARED | MAP_ANONYMOUS,
                      -1, 0);
    if (addr == MAP_FAILED) return -1;

    SharedBuffer *buf = (SharedBuffer *)addr;

    // Initialize mutex with PTHREAD_PROCESS_SHARED attribute
    pthread_mutexattr_t mattr;
    pthread_mutexattr_init(&mattr);
    pthread_mutexattr_setpshared(&mattr, PTHREAD_PROCESS_SHARED);
    pthread_mutexattr_settype(&mattr, PTHREAD_MUTEX_ROBUST);
    pthread_mutex_init(&buf->mutex, &mattr);
    pthread_mutexattr_destroy(&mattr);

    // Initialize condition variable with process-shared attribute
    pthread_condattr_t cattr;
    pthread_condattr_init(&cattr);
    pthread_condattr_setpshared(&cattr, PTHREAD_PROCESS_SHARED);
    pthread_cond_init(&buf->cond, &cattr);
    pthread_condattr_destroy(&cattr);

    buf->data_ready = 0;

    *out = buf;
    return 0;
}

// Producer: write data and signal consumer
void produce(SharedBuffer *buf, const char *message) {
    pthread_mutex_lock(&buf->mutex);
    strncpy(buf->data, message, sizeof(buf->data) - 1);
    buf->data_ready = 1;
    pthread_cond_signal(&buf->cond);
    pthread_mutex_unlock(&buf->mutex);
}

// Consumer: wait for data and read it
void consume(SharedBuffer *buf, char *out, size_t out_size) {
    pthread_mutex_lock(&buf->mutex);
    while (!buf->data_ready) {
        pthread_cond_wait(&buf->cond, &buf->mutex);
    }
    strncpy(out, buf->data, out_size - 1);
    buf->data_ready = 0;
    pthread_mutex_unlock(&buf->mutex);
}
```

## madvise: Performance Optimization Hints

```c
#include <sys/mman.h>

void optimize_mapping_access(void *addr, size_t len, const char *pattern) {
    if (strcmp(pattern, "sequential") == 0) {
        // Tell kernel to read ahead aggressively
        madvise(addr, len, MADV_SEQUENTIAL);
    } else if (strcmp(pattern, "random") == 0) {
        // Disable read-ahead (avoid wasting memory on unused pages)
        madvise(addr, len, MADV_RANDOM);
    } else if (strcmp(pattern, "willneed") == 0) {
        // Pre-fault pages into memory (eliminate future page faults)
        madvise(addr, len, MADV_WILLNEED);
    } else if (strcmp(pattern, "dontneed") == 0) {
        // Release memory back to kernel (but keep mapping)
        // Note: MAP_PRIVATE pages are zeroed; MAP_SHARED pages may be evicted
        madvise(addr, len, MADV_DONTNEED);
    } else if (strcmp(pattern, "free") == 0) {
        // Mark pages as reusable (lazily freed)
        // Linux 4.5+: more efficient than DONTNEED for MAP_PRIVATE
        madvise(addr, len, MADV_FREE);
    }
}
```

## mlock: Preventing Page Swapping

For latency-sensitive applications where swap latency is unacceptable:

```c
#include <sys/mman.h>

// Lock a memory region in RAM — prevents page swap
int lock_in_memory(void *addr, size_t len) {
    if (mlock(addr, len) < 0) {
        perror("mlock");
        // May fail with ENOMEM if RLIMIT_MEMLOCK is too low
        return -1;
    }
    return 0;
}

// Lock all current and future memory (use for real-time processes)
int lock_all_memory(void) {
    if (mlockall(MCL_CURRENT | MCL_FUTURE) < 0) {
        perror("mlockall");
        return -1;
    }
    return 0;
}

// In main() for real-time/low-latency applications:
void setup_rt_memory(void) {
    // Increase RLIMIT_MEMLOCK first
    struct rlimit rl;
    getrlimit(RLIMIT_MEMLOCK, &rl);
    rl.rlim_cur = rl.rlim_max;
    setrlimit(RLIMIT_MEMLOCK, &rl);

    // Lock all memory
    lock_all_memory();

    // Pre-fault the stack by writing to it
    char stack_array[1024 * 1024];  // 1MB
    memset(stack_array, 0, sizeof(stack_array));
}
```

## Practical Application: Memory-Mapped Database

A simplified write-ahead log using mmap:

```c
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <stdint.h>
#include <string.h>

#define WAL_MAGIC 0x57414C30  // "WAL0"
#define WAL_MAX_SIZE (64 * 1024 * 1024)  // 64MB

typedef struct {
    uint32_t magic;
    uint64_t write_pos;
    uint64_t commit_pos;
    uint8_t  data[];
} WALHeader;

typedef struct {
    int       fd;
    WALHeader *header;
    size_t    size;
} WAL;

// Open or create a WAL file
WAL *wal_open(const char *path) {
    int fd = open(path, O_RDWR | O_CREAT, 0644);
    if (fd < 0) return NULL;

    struct stat st;
    fstat(fd, &st);

    // Expand to WAL_MAX_SIZE if smaller
    if (st.st_size < WAL_MAX_SIZE) {
        if (ftruncate(fd, WAL_MAX_SIZE) < 0) {
            close(fd);
            return NULL;
        }
    }

    void *addr = mmap(NULL, WAL_MAX_SIZE,
                      PROT_READ | PROT_WRITE,
                      MAP_SHARED, fd, 0);
    close(fd);
    if (addr == MAP_FAILED) return NULL;

    WAL *wal = malloc(sizeof(WAL));
    wal->header = (WALHeader *)addr;
    wal->size = WAL_MAX_SIZE;

    // Initialize if new file
    if (wal->header->magic != WAL_MAGIC) {
        memset(addr, 0, sizeof(WALHeader));
        wal->header->magic = WAL_MAGIC;
        wal->header->write_pos = 0;
        wal->header->commit_pos = 0;
        msync(addr, sizeof(WALHeader), MS_SYNC);
    }

    return wal;
}

// Append a record to the WAL
int wal_append(WAL *wal, const void *data, size_t len) {
    size_t capacity = wal->size - sizeof(WALHeader);
    if (wal->header->write_pos + len > capacity) {
        return -1;  // WAL full
    }

    // Write data directly via pointer (no system call)
    memcpy(wal->header->data + wal->header->write_pos, data, len);
    wal->header->write_pos += len;

    // Sync the data pages
    size_t offset = sizeof(WALHeader) + wal->header->write_pos - len;
    char *base = (char *)wal->header;
    msync(base + (offset & ~4095UL),
          len + (offset & 4095UL),
          MS_SYNC);

    return 0;
}

// Commit: advance commit_pos and sync the header
int wal_commit(WAL *wal) {
    wal->header->commit_pos = wal->header->write_pos;
    return msync(wal->header, sizeof(WALHeader), MS_SYNC);
}
```

## Performance Benchmarking: mmap vs. read()

```c
#include <time.h>
#include <stdio.h>

#define FILE_SIZE (256 * 1024 * 1024)  // 256MB

void bench_read_syscall(const char *path) {
    int fd = open(path, O_RDONLY);
    char *buf = malloc(FILE_SIZE);

    struct timespec start, end;
    clock_gettime(CLOCK_MONOTONIC, &start);

    ssize_t total = 0, n;
    while ((n = read(fd, buf + total, FILE_SIZE - total)) > 0)
        total += n;

    clock_gettime(CLOCK_MONOTONIC, &end);

    double elapsed = (end.tv_sec - start.tv_sec) +
                     (end.tv_nsec - start.tv_nsec) / 1e9;
    printf("read() time: %.3fs, throughput: %.1f MB/s\n",
           elapsed, FILE_SIZE / elapsed / 1e6);

    free(buf);
    close(fd);
}

void bench_mmap(const char *path) {
    int fd = open(path, O_RDONLY);

    struct timespec start, end;
    clock_gettime(CLOCK_MONOTONIC, &start);

    void *addr = mmap(NULL, FILE_SIZE, PROT_READ, MAP_SHARED, fd, 0);
    madvise(addr, FILE_SIZE, MADV_SEQUENTIAL);

    // Force all pages into memory
    size_t checksum = 0;
    for (size_t i = 0; i < FILE_SIZE; i += 4096) {
        checksum += ((unsigned char *)addr)[i];
    }

    clock_gettime(CLOCK_MONOTONIC, &end);

    double elapsed = (end.tv_sec - start.tv_sec) +
                     (end.tv_nsec - start.tv_nsec) / 1e9;
    printf("mmap() time: %.3fs, throughput: %.1f MB/s (checksum: %zu)\n",
           elapsed, FILE_SIZE / elapsed / 1e6, checksum);

    munmap(addr, FILE_SIZE);
    close(fd);
}
```

## Summary

`mmap` is a foundational performance optimization and IPC primitive in Linux systems programming. Key guidelines:

- Use `MAP_SHARED` for file-backed maps where writes should persist; `MAP_PRIVATE` for copy-on-write reads.
- Always call `msync(addr, len, MS_SYNC)` before acknowledging durable writes to callers.
- Use `MAP_HUGETLB` or `MADV_HUGEPAGE` for large working sets (>256MB) to reduce TLB pressure.
- Use POSIX `shm_open` + `mmap(MAP_SHARED)` for inter-process shared memory.
- Initialize process-shared mutexes with `PTHREAD_PROCESS_SHARED` attribute.
- Call `madvise(MADV_SEQUENTIAL)` for sequential scan patterns; `MADV_RANDOM` for random access.
- Use `mlock`/`mlockall` for real-time or latency-sensitive workloads where swap latency is unacceptable.
