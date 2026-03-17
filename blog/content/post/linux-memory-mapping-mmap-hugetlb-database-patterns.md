---
title: "Linux Memory Mapping: mmap, HugeTLB Mappings, and Memory-Mapped Database Patterns"
date: 2030-04-14T00:00:00-05:00
draft: false
tags: ["Linux", "mmap", "HugeTLB", "Memory Management", "LMDB", "SQLite", "Performance"]
categories: ["Linux", "Systems Programming"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux mmap system call internals, anonymous vs file-backed mappings, MAP_SHARED vs MAP_PRIVATE semantics, hugetlbfs configuration, and memory-mapped database patterns with LMDB and SQLite WAL."
more_link: "yes"
url: "/linux-memory-mapping-mmap-hugetlb-database-patterns/"
---

Memory mapping is one of the most powerful and most misunderstood features of the Linux kernel. When you call `mmap`, you are not just allocating memory — you are creating a direct window into the virtual address space that the kernel, the MMU, and the page cache all cooperate to keep coherent. Understanding these internals is the difference between an application that runs at disk bandwidth limits and one that thrashes the TLB under load.

This guide covers the full stack: the `mmap` system call from userspace through VMA management in the kernel, the distinction between anonymous and file-backed mappings, the semantics of `MAP_SHARED` versus `MAP_PRIVATE`, hugetlbfs for high-throughput workloads, and finally the database engines (LMDB and SQLite WAL) that put all of these primitives to production use.

<!--more-->

## mmap System Call Internals

### The Virtual Memory Area (VMA)

Every `mmap` call creates or extends a Virtual Memory Area (VMA) — the kernel's bookkeeping structure for a contiguous region of a process's address space. The kernel represents these as a red-black tree plus a linked list anchored in `mm_struct`. Understanding VMAs is fundamental to understanding what `mmap` actually does.

```c
/* Simplified kernel VMA structure (linux/mm_types.h) */
struct vm_area_struct {
    unsigned long vm_start;       /* start address within vm_mm */
    unsigned long vm_end;         /* first byte after our end address */
    struct vm_area_struct *vm_next, *vm_prev;
    struct rb_node vm_rb;         /* red-black tree node */
    struct mm_struct *vm_mm;      /* the address space we belong to */
    pgprot_t vm_page_prot;        /* access permissions */
    unsigned long vm_flags;       /* VM_READ, VM_WRITE, VM_EXEC, etc. */
    struct file *vm_file;         /* file backed mapping, or NULL */
    unsigned long vm_pgoff;       /* offset within vm_file in PAGE_SIZE units */
    const struct vm_operations_struct *vm_ops;
};
```

When the kernel receives an `mmap` syscall it:

1. Validates parameters against `RLIMIT_AS` and address space limits
2. Finds a suitable gap in the process virtual address space via `get_unmapped_area`
3. Allocates and initializes a `vm_area_struct`
4. For file-backed mappings, calls `file->f_op->mmap` to let the filesystem register its `vm_ops`
5. Inserts the VMA into the red-black tree and linked list
6. Returns the start virtual address

No physical pages are allocated yet. That is the entire point of demand paging.

### Page Fault Handling

The first access to any page in a mmap region triggers a page fault. The kernel's fault handler (`handle_mm_fault`) dispatches based on VMA type:

```
Access to unmapped page
        |
        v
handle_mm_fault()
        |
        +-- Anonymous mapping --> alloc_zeroed_user_highpage_movable()
        |
        +-- File-backed mapping --> vm_ops->fault() --> page cache lookup
                                                      --> read from disk if not cached
```

For file-backed mappings, the page cache is the central coordinator. When page N of a file is faulted in, the kernel checks if that page is already in the page cache. If it is (because another process or a prior `read()` cached it), the physical page is simply mapped into the faulting process's page table. If it is not, a new page is allocated, the data is read from disk, the page is inserted into the cache, and then mapped. This is why `mmap` can be faster than `read()` for large files accessed repeatedly — the read path also goes through the page cache, but it additionally involves a copy into a userspace buffer.

### Inspecting VMAs with /proc

```bash
# Examine the VMA layout of a running process
cat /proc/<pid>/maps

# More detailed output including RSS and PSS
cat /proc/<pid>/smaps

# Summarised memory statistics
cat /proc/<pid>/smaps_rollup
```

Example output from `/proc/<pid>/maps`:

```
7f8a40000000-7f8a80000000 rw-p 00000000 00:00 0
7f8a80000000-7f8a80021000 r--p 00000000 fd:01 12345678  /usr/lib/libc.so.6
7f8a80021000-7f8a80180000 r-xp 00021000 fd:01 12345678  /usr/lib/libc.so.6
7f8a80180000-7f8a801cf000 r--p 00180000 fd:01 12345678  /usr/lib/libc.so.6
```

Columns: address range, permissions (rwxp where p=private/s=shared), offset, device, inode, pathname.

## Anonymous vs File-Backed Mappings

### Anonymous Mappings

Anonymous mappings have no backing file. They are used for heap allocations (glibc's `malloc` calls `mmap` for large allocations), stack extensions, and explicit application-level memory allocation.

```c
#include <sys/mman.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(void) {
    size_t size = 64 * 1024 * 1024; /* 64 MB */

    /* Anonymous private mapping - used for heap-like allocations */
    void *anon = mmap(NULL, size,
                      PROT_READ | PROT_WRITE,
                      MAP_ANONYMOUS | MAP_PRIVATE,
                      -1, 0);
    if (anon == MAP_FAILED) {
        perror("mmap anonymous");
        return 1;
    }

    /* Pages are demand-allocated; write to commit them */
    memset(anon, 0x42, size);

    printf("Anonymous mapping at: %p\n", anon);
    printf("PID: %d - check /proc/%d/smaps\n", getpid(), getpid());

    munmap(anon, size);
    return 0;
}
```

Anonymous mappings are backed by the swap device when the system is under memory pressure. The kernel tracks them via `struct anon_vma` and the reverse mapping infrastructure.

### File-Backed Mappings

File-backed mappings create a direct correspondence between a virtual address range and a region of a file. Reading or writing the memory is equivalent to reading or writing the file, with the page cache as intermediary.

```c
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <stdint.h>

typedef struct {
    uint64_t magic;
    uint64_t record_count;
    uint64_t data_offset;
    char     padding[4072]; /* pad to 4096 bytes */
} FileHeader;

typedef struct {
    uint64_t id;
    char     name[56];
    double   value;
} Record;

int main(void) {
    const char *path = "/tmp/mmap_demo.db";
    size_t header_size = sizeof(FileHeader);
    size_t num_records = 1000;
    size_t total_size = header_size + num_records * sizeof(Record);

    /* Create and size the file */
    int fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) { perror("open"); return 1; }

    if (ftruncate(fd, (off_t)total_size) < 0) {
        perror("ftruncate");
        close(fd);
        return 1;
    }

    /* Map the entire file */
    void *base = mmap(NULL, total_size,
                      PROT_READ | PROT_WRITE,
                      MAP_SHARED,   /* writes go back to file */
                      fd, 0);
    close(fd); /* fd no longer needed after mmap */

    if (base == MAP_FAILED) {
        perror("mmap");
        return 1;
    }

    /* Write header */
    FileHeader *hdr = (FileHeader *)base;
    hdr->magic        = 0xDEADBEEFCAFEBABEULL;
    hdr->record_count = num_records;
    hdr->data_offset  = header_size;

    /* Write records */
    Record *records = (Record *)((char *)base + header_size);
    for (size_t i = 0; i < num_records; i++) {
        records[i].id    = i;
        snprintf(records[i].name, sizeof(records[i].name), "record_%zu", i);
        records[i].value = (double)i * 3.14159;
    }

    /* Ensure data is flushed to disk */
    if (msync(base, total_size, MS_SYNC) < 0) {
        perror("msync");
    }

    printf("Written %zu records to %s\n", num_records, path);

    munmap(base, total_size);
    return 0;
}
```

Compile and run:

```bash
gcc -O2 -o mmap_demo mmap_demo.c && ./mmap_demo
```

## MAP_SHARED vs MAP_PRIVATE

### MAP_SHARED Semantics

`MAP_SHARED` means writes to the mapped region are visible to other processes mapping the same file, and are eventually propagated to the underlying file. The kernel uses a single set of page cache pages for all `MAP_SHARED` mappings of the same file region.

```c
/* Producer process */
int fd = open("/tmp/shared.bin", O_RDWR | O_CREAT, 0644);
ftruncate(fd, 4096);
int *shared = (int *)mmap(NULL, 4096,
                          PROT_READ | PROT_WRITE,
                          MAP_SHARED, fd, 0);
close(fd);

shared[0] = 42;                         /* immediately visible to other MAP_SHARED mappers */
msync(shared, 4096, MS_ASYNC);          /* schedule writeback to disk */
munmap(shared, 4096);
```

```c
/* Consumer process (can run simultaneously) */
int fd = open("/tmp/shared.bin", O_RDONLY);
int *shared = (int *)mmap(NULL, 4096, PROT_READ, MAP_SHARED, fd, 0);
close(fd);

printf("Value: %d\n", shared[0]);   /* sees 42 if producer ran */
munmap(shared, 4096);
```

Key property: `MAP_SHARED` mappings participate in the page cache coherency protocol. All processes sharing the same file page share the exact same physical page frame. A write by any one of them is immediately visible to the others — no system call required.

### MAP_PRIVATE and Copy-on-Write

`MAP_PRIVATE` creates a copy-on-write (COW) mapping. Reads go to the original page (file or anonymous). The first write to a page triggers the kernel to allocate a new physical page, copy the original content, update the page table entry, and then perform the write. From that point on, the process has a private copy of that page.

```c
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(void) {
    int fd = open("/etc/hostname", O_RDONLY);
    if (fd < 0) { perror("open"); return 1; }

    struct stat st;
    fstat(fd, &st);
    size_t size = ((size_t)st.st_size + 4095UL) & ~4095UL; /* round to page */

    /* MAP_PRIVATE: writes do NOT go back to the file */
    char *buf = (char *)mmap(NULL, size,
                             PROT_READ | PROT_WRITE,
                             MAP_PRIVATE,
                             fd, 0);
    close(fd);

    if (buf == MAP_FAILED) { perror("mmap"); return 1; }

    printf("Original hostname: %s", buf);

    /* This write triggers COW - file is NOT modified */
    strncpy(buf, "modified-hostname\n", size);
    printf("Modified (in memory only): %s", buf);

    munmap(buf, size);
    return 0;
}
```

`MAP_PRIVATE` is critical for executable loading. When the dynamic linker maps a shared library, it uses `MAP_PRIVATE` for the `.text` section so that if any process needs to modify code (e.g., for trampolines), it gets a private copy without affecting other processes using the same library.

### fork() and Copy-on-Write

The interaction between `fork()` and `MAP_PRIVATE` mappings is where COW becomes most visible in practice:

```c
#include <sys/mman.h>
#include <sys/wait.h>
#include <stdio.h>
#include <unistd.h>

int main(void) {
    /* Allocate 1 GB of anonymous private memory */
    size_t size = 1UL * 1024UL * 1024UL * 1024UL;
    char *mem = (char *)mmap(NULL, size,
                             PROT_READ | PROT_WRITE,
                             MAP_ANONYMOUS | MAP_PRIVATE,
                             -1, 0);
    if (mem == MAP_FAILED) { perror("mmap"); return 1; }

    /* Touch all pages to commit them before fork */
    for (size_t i = 0; i < size; i += 4096)
        mem[i] = (char)(i & 0xFF);

    printf("Parent PID %d: before fork, RSS ~1GB\n", getpid());

    pid_t child = fork();
    if (child == 0) {
        /* Child: only modifying a small portion causes COW on those pages */
        for (size_t i = 0; i < 4096 * 10; i++)
            mem[i] = 0xFF; /* triggers COW for 10 pages only */

        printf("Child PID %d: only ~40KB of new physical pages allocated\n",
               getpid());
        _exit(0);
    }

    waitpid(child, NULL, 0);
    munmap(mem, size);
    return 0;
}
```

After `fork()`, both parent and child map to the same physical pages. Only when a page is written does the kernel allocate a new page for the writer. This is what makes `fork()` + `exec()` efficient — most pages are never written and are never duplicated.

## HugeTLB Mappings

### The TLB Problem at Scale

The Translation Lookaside Buffer (TLB) is a hardware cache mapping virtual page numbers to physical frame numbers. A modern CPU's L1 TLB covers perhaps 64 entries, each covering 4 KB — that is 256 KB of address space. With 64-entry L2 TLBs and 1024-entry L3 TLBs you can cover a few hundred megabytes before TLB misses dominate. For a database with a 64 GB working set using 4 KB pages, TLB pressure alone can reduce throughput by 30-50%.

Huge pages solve this by using 2 MB or 1 GB page sizes. One 2 MB TLB entry covers what would otherwise require 512 regular entries.

```bash
# Check huge page support
cat /proc/meminfo | grep -i huge

# Example output:
# AnonHugePages:    524288 kB  (Transparent Huge Pages)
# ShmemHugePages:        0 kB
# HugePages_Total:    1024
# HugePages_Free:      896
# HugePages_Rsvd:        0
# HugePages_Surp:        0
# Hugepagesize:       2048 kB
# Hugetlb:         2097152 kB

# Allocate 1024 static huge pages (2 MB each = 2 GB total)
echo 1024 | sudo tee /proc/sys/vm/nr_hugepages

# Persist across reboots
echo "vm.nr_hugepages = 1024" | sudo tee -a /etc/sysctl.d/99-hugepages.conf
sudo sysctl -p /etc/sysctl.d/99-hugepages.conf
```

### Static HugeTLB Mappings

```c
#include <sys/mman.h>
#include <stdio.h>
#include <string.h>

/* Requires: echo 16 > /proc/sys/vm/nr_hugepages */
#define HUGEPAGE_SIZE (2UL * 1024UL * 1024UL)  /* 2 MB */
#define NUM_HUGEPAGES 16
#define TOTAL_SIZE    (HUGEPAGE_SIZE * NUM_HUGEPAGES)

int main(void) {
    /* MAP_HUGETLB flag on anonymous mapping */
    void *mem = mmap(NULL, TOTAL_SIZE,
                     PROT_READ | PROT_WRITE,
                     MAP_ANONYMOUS | MAP_PRIVATE | MAP_HUGETLB,
                     -1, 0);

    if (mem == MAP_FAILED) {
        perror("mmap MAP_HUGETLB (check /proc/sys/vm/nr_hugepages)");
        return 1;
    }

    printf("Huge page mapping at %p, size %lu MB\n",
           mem, TOTAL_SIZE / (1024*1024));

    /* Write to commit all huge pages */
    memset(mem, 0, TOTAL_SIZE);

    printf("All %d huge pages committed successfully\n", NUM_HUGEPAGES);

    munmap(mem, TOTAL_SIZE);
    return 0;
}
```

### Mounting hugetlbfs for File-Backed Huge Pages

```bash
# Create hugetlbfs mount for shared huge-page files
sudo mkdir -p /mnt/huge
sudo mount -t hugetlbfs -o uid=1000,gid=1000,pagesize=2M nodev /mnt/huge

# Make permanent in /etc/fstab:
# nodev /mnt/huge hugetlbfs uid=1000,gid=1000,pagesize=2M 0 0

# Verify
mount | grep huge
# nodev on /mnt/huge type hugetlbfs (rw,relatime,pagesize=2M)
```

### Transparent Huge Pages (THP)

THP allows the kernel to automatically promote groups of contiguous 4 KB pages to 2 MB pages without application changes. The tradeoff is occasional latency spikes from page promotion and the risk of fragmentation-induced compaction stalls.

```bash
# Check THP status
cat /sys/kernel/mm/transparent_hugepage/enabled
# [always] madvise never

# For database workloads: use madvise mode
echo madvise | sudo tee /sys/kernel/mm/transparent_hugepage/enabled

# Check if THP promotion is happening
cat /proc/vmstat | grep thp
# thp_fault_alloc 42
# thp_collapse_alloc 17
# thp_split_page 3
```

```c
#include <sys/mman.h>
#include <stddef.h>
#include <stdio.h>

/* Database buffer pool with THP opt-in */
void *allocate_buffer_pool(size_t size) {
    /* Align to 2 MB boundary for THP eligibility */
    size_t huge_align = 2UL * 1024UL * 1024UL;
    size_t aligned_size = (size + huge_align - 1) & ~(huge_align - 1);

    void *mem = mmap(NULL, aligned_size,
                     PROT_READ | PROT_WRITE,
                     MAP_ANONYMOUS | MAP_PRIVATE,
                     -1, 0);
    if (mem == MAP_FAILED) return NULL;

    /* Advise kernel to use huge pages for this region */
    madvise(mem, aligned_size, MADV_HUGEPAGE);

    /* Pre-fault pages in large chunks to encourage THP promotion */
    volatile char *p = (volatile char *)mem;
    for (size_t i = 0; i < aligned_size; i += huge_align) {
        p[i] = 0; /* touch first byte of each 2MB region */
    }

    return mem;
}
```

## msync Strategies

The `msync` system call flushes dirty pages from a `MAP_SHARED` mapping back to the underlying file. Understanding when and how to call it is critical for correctness and performance.

### msync Flag Reference

```c
#include <sys/mman.h>
#include <time.h>
#include <stdio.h>
#include <string.h>

/*
 * msync flags:
 *   MS_SYNC:       block until all dirty pages are written to disk
 *   MS_ASYNC:      schedule writeback, return immediately
 *   MS_INVALIDATE: invalidate clean cached pages (force re-read)
 */

/* Strategy 1: MS_SYNC for durable writes (highest safety, highest latency) */
void sync_durable(void *addr, size_t len) {
    struct timespec t0, t1;
    clock_gettime(CLOCK_MONOTONIC, &t0);

    if (msync(addr, len, MS_SYNC) < 0)
        perror("msync MS_SYNC");

    clock_gettime(CLOCK_MONOTONIC, &t1);
    long us = (long)((t1.tv_sec - t0.tv_sec) * 1000000L +
                     (t1.tv_nsec - t0.tv_nsec) / 1000L);
    fprintf(stderr, "MS_SYNC %zu bytes: %ld us\n", len, us);
}

/* Strategy 2: MS_ASYNC for background writeback (high throughput) */
void sync_async(void *addr, size_t len) {
    msync(addr, len, MS_ASYNC);
}

/* Strategy 3: Periodic sync with dirty page tracking */
typedef struct {
    void    *base;
    size_t   length;
    size_t   page_size;
    uint8_t *dirty_bitmap; /* 1 bit per page */
} DirtyTracker;

void mark_dirty(DirtyTracker *dt, size_t offset, size_t len) {
    size_t start_page = offset / dt->page_size;
    size_t end_page   = (offset + len + dt->page_size - 1) / dt->page_size;
    for (size_t p = start_page; p < end_page; p++) {
        dt->dirty_bitmap[p / 8] |= (uint8_t)(1u << (p % 8));
    }
}

void sync_dirty_pages(DirtyTracker *dt) {
    size_t num_pages = dt->length / dt->page_size;
    size_t start = (size_t)-1;

    for (size_t p = 0; p <= num_pages; p++) {
        int dirty = (p < num_pages) &&
                    (dt->dirty_bitmap[p / 8] & (uint8_t)(1u << (p % 8)));

        if (dirty && start == (size_t)-1) {
            start = p;
        } else if (!dirty && start != (size_t)-1) {
            size_t run_offset = start * dt->page_size;
            size_t run_len    = (p - start) * dt->page_size;
            msync((char *)dt->base + run_offset, run_len, MS_ASYNC);
            start = (size_t)-1;
        }
    }
    memset(dt->dirty_bitmap, 0, (num_pages + 7) / 8);
}
```

## LMDB: A Production mmap Database

LMDB (Lightning Memory-Mapped Database) is a B-tree key-value store built entirely on `mmap`. It is the reference implementation for how to build a robust, high-performance database using memory mapping.

### LMDB Architecture

```
LMDB File Layout:
+------------------+
| Meta Page 0      |  4096 bytes - contains root B-tree page numbers
| Meta Page 1      |  4096 bytes - second meta page for atomic updates
+------------------+
| B-tree Pages     |  4096 bytes each - leaf/branch nodes
| ...              |
+------------------+

Key design decisions:
- Entire file mmap with MAP_SHARED
- Two meta pages enable atomic updates (one always valid)
- MVCC via copy-on-write on write path
- Readers never block writers, writers never block readers
- No write-ahead log - the B-tree IS the log
```

### LMDB Usage Patterns

```c
/* LMDB usage example demonstrating mmap-based database patterns */
/* Build: gcc -O2 -o lmdb_demo lmdb_demo.c -llmdb */
/* Requires: apt-get install liblmdb-dev */

#include <lmdb.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#define CHECK(expr) do {                              \
    int _rc = (expr);                                 \
    if (_rc != 0) {                                   \
        fprintf(stderr, "%s: %s\n", #expr,           \
                mdb_strerror(_rc));                   \
        exit(1);                                      \
    }                                                 \
} while(0)

int main(void) {
    MDB_env  *env;
    MDB_dbi   dbi;
    MDB_txn  *txn;
    MDB_val   key, val;

    CHECK(mdb_env_create(&env));

    /* Set map size to 10 GB - maximum database size */
    /* LMDB uses sparse files; actual disk usage grows with data */
    CHECK(mdb_env_set_mapsize(env, 10ULL * 1024ULL * 1024ULL * 1024ULL));
    CHECK(mdb_env_set_maxdbs(env, 16));
    CHECK(mdb_env_open(env, "/tmp/lmdb_demo", 0, 0644));

    /* Write transaction */
    CHECK(mdb_txn_begin(env, NULL, 0, &txn));
    CHECK(mdb_dbi_open(txn, "users", MDB_CREATE, &dbi));

    /* Insert 100k records */
    for (int i = 0; i < 100000; i++) {
        char key_buf[32], val_buf[128];
        snprintf(key_buf, sizeof(key_buf), "user:%08d", i);
        snprintf(val_buf, sizeof(val_buf),
                 "{\"id\":%d,\"name\":\"User%d\",\"score\":%.2f}",
                 i, i, (double)i * 1.23456);

        key.mv_size = strlen(key_buf);
        key.mv_data = key_buf;
        val.mv_size = strlen(val_buf);
        val.mv_data = val_buf;

        CHECK(mdb_put(txn, dbi, &key, &val, 0));
    }

    /* Commit atomically - updates one meta page, never corrupts the other */
    CHECK(mdb_txn_commit(txn));

    /* Read transaction - zero-copy, reads directly from mmap region */
    CHECK(mdb_txn_begin(env, NULL, MDB_RDONLY, &txn));

    char lookup_key[] = "user:00042000";
    key.mv_size = strlen(lookup_key);
    key.mv_data = lookup_key;

    int rc = mdb_get(txn, dbi, &key, &val);
    if (rc == 0) {
        /* val.mv_data points directly into the mmap region - zero copy */
        printf("Found: %.*s\n", (int)val.mv_size, (char *)val.mv_data);
    }

    mdb_txn_abort(txn); /* read-only txn: abort == commit for cleanup */

    MDB_envinfo info;
    mdb_env_info(env, &info);
    printf("Map size: %zu MB\n", info.me_mapsize / (1024*1024));
    printf("Last page: %zu\n", info.me_last_pgno);

    mdb_env_close(env);
    return 0;
}
```

### LMDB Durability Flags

```c
/* Durability modes */

/* Default: fully durable, fdatasync on commit */
mdb_env_open(env, path, 0, 0644);

/* No sync at all - fastest, data loss on crash (good for caches) */
mdb_env_open(env, path, MDB_NOSYNC, 0644);

/* Sync data but not metadata - compromise */
mdb_env_open(env, path, MDB_NOMETASYNC, 0644);

/* Use MAP_SHARED + mmap writes instead of pwrite */
mdb_env_open(env, path, MDB_WRITEMAP, 0644);

/* MDB_WRITEMAP + MDB_MAPASYNC: writes go directly to mmap,
 * kernel async writeback, no explicit msync on commit */
mdb_env_open(env, path, MDB_WRITEMAP | MDB_MAPASYNC, 0644);
```

## SQLite WAL Mode and mmap

SQLite's Write-Ahead Logging (WAL) mode uses mmap for the WAL index (`.wal-shm` file), allowing multiple readers to efficiently locate which WAL frames to read.

```bash
# Enable WAL mode
sqlite3 /tmp/test.db "PRAGMA journal_mode=WAL;"
# Returns: wal

# Configure mmap for the database itself
sqlite3 /tmp/test.db "PRAGMA mmap_size=1073741824;" # 1 GB mmap
sqlite3 /tmp/test.db "PRAGMA mmap_size;"            # verify

# WAL mode creates three files
ls -la /tmp/test.db*
# test.db      - main database (can be mmap)
# test.db-wal  - write-ahead log
# test.db-shm  - shared memory index (mmap by all connections)
```

### SQLite mmap Configuration

```c
/* SQLite mmap configuration for production workloads */
/* Build: gcc -O2 -o sqlite_mmap sqlite_mmap.c -lsqlite3 */

#include <sqlite3.h>
#include <stdio.h>
#include <stdlib.h>

int main(void) {
    sqlite3 *db;
    sqlite3_stmt *stmt;
    int rc;

    rc = sqlite3_open("/tmp/sqlite_mmap_demo.db", &db);
    if (rc != SQLITE_OK) {
        fprintf(stderr, "Cannot open: %s\n", sqlite3_errmsg(db));
        return 1;
    }

    /* Enable WAL mode */
    sqlite3_exec(db, "PRAGMA journal_mode=WAL;", NULL, NULL, NULL);

    /* Enable mmap for read performance: 2 GB */
    sqlite3_exec(db, "PRAGMA mmap_size=2147483648;", NULL, NULL, NULL);

    /* WAL auto-checkpoint after 1000 pages */
    sqlite3_exec(db, "PRAGMA wal_autocheckpoint=1000;", NULL, NULL, NULL);

    /* Tune page cache */
    sqlite3_exec(db, "PRAGMA cache_size=-65536;", NULL, NULL, NULL); /* 64 MB */
    sqlite3_exec(db, "PRAGMA synchronous=NORMAL;", NULL, NULL, NULL);

    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS metrics ("
        "  id      INTEGER PRIMARY KEY,"
        "  ts      INTEGER NOT NULL,"
        "  host    TEXT NOT NULL,"
        "  metric  TEXT NOT NULL,"
        "  value   REAL NOT NULL"
        ");",
        NULL, NULL, NULL);

    /* Bulk insert using prepared statements */
    sqlite3_exec(db, "BEGIN;", NULL, NULL, NULL);
    rc = sqlite3_prepare_v2(db,
        "INSERT INTO metrics(ts, host, metric, value) VALUES(?,?,?,?)",
        -1, &stmt, NULL);
    if (rc != SQLITE_OK) {
        fprintf(stderr, "prepare: %s\n", sqlite3_errmsg(db));
        return 1;
    }

    for (int i = 0; i < 100000; i++) {
        sqlite3_bind_int64(stmt, 1, 1700000000LL + i);
        sqlite3_bind_text(stmt, 2, "host-01", -1, SQLITE_STATIC);
        sqlite3_bind_text(stmt, 3, "cpu_usage", -1, SQLITE_STATIC);
        sqlite3_bind_double(stmt, 4, (double)(i % 100) / 100.0);

        sqlite3_step(stmt);
        sqlite3_reset(stmt);
    }

    sqlite3_finalize(stmt);
    sqlite3_exec(db, "COMMIT;", NULL, NULL, NULL);

    /* Read using mmap path */
    rc = sqlite3_prepare_v2(db,
        "SELECT COUNT(*), AVG(value) FROM metrics WHERE host='host-01'",
        -1, &stmt, NULL);
    if (rc == SQLITE_OK && sqlite3_step(stmt) == SQLITE_ROW) {
        printf("Count: %lld, Avg: %.4f\n",
               sqlite3_column_int64(stmt, 0),
               sqlite3_column_double(stmt, 1));
    }
    sqlite3_finalize(stmt);

    sqlite3_close(db);
    return 0;
}
```

## madvise Hints for Performance

```c
/* Key madvise flags for database workloads */
#include <sys/mman.h>

void configure_access_pattern(void *ptr, size_t len, int pattern) {
    switch (pattern) {
    case 0:
        /* Sequential access: kernel will readahead aggressively */
        madvise(ptr, len, MADV_SEQUENTIAL);
        break;
    case 1:
        /* Random access: disable readahead */
        madvise(ptr, len, MADV_RANDOM);
        break;
    case 2:
        /* Will need this memory soon: start background readahead */
        madvise(ptr, len, MADV_WILLNEED);
        break;
    case 3:
        /* Will not need this: allow reclaim */
        madvise(ptr, len, MADV_DONTNEED);
        break;
    case 4:
        /* Do not include in core dump */
        madvise(ptr, len, MADV_DONTDUMP);
        break;
    case 5:
        /* Merge adjacent pages into huge pages (THP opt-in) */
        madvise(ptr, len, MADV_HUGEPAGE);
        break;
    }
}
```

## Monitoring mmap Usage in Production

```bash
# Monitor page fault rates
perf stat -e major-faults,minor-faults ./your_program

# Watch TLB miss rate
perf stat -e dTLB-load-misses,dTLB-loads ./your_program

# Check system-wide mmap activity
cat /proc/vmstat | grep -E "pgfault|pgmajfault|pswpin|pswpout"

# Per-process memory map overhead
/usr/bin/time -v ./your_program 2>&1 | grep "Major (requiring I/O) page faults"

# Watch for high page reclaim pressure
vmstat -w 1

# Identify processes with large mmap footprints
awk '/^VmRSS:/{rss=$2} /^Name:/{name=$2} END{print rss, name}' \
    /proc/*/status 2>/dev/null | sort -rn | head -20

# Check huge page utilization
grep -E "HugePages|AnonHuge|Hugepagesize" /proc/meminfo
```

## Production Safety Patterns

### SIGBUS Handling for Truncated Files

```c
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <signal.h>
#include <setjmp.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

/* Validate file before mapping */
int safe_mmap_file(const char *path, void **out_ptr, size_t *out_size) {
    int fd = open(path, O_RDONLY);
    if (fd < 0) return -1;

    struct stat st;
    if (fstat(fd, &st) < 0) { close(fd); return -1; }

    /* Never mmap a zero-size file */
    if (st.st_size == 0) { close(fd); return -1; }

    size_t size = ((size_t)st.st_size + 4095UL) & ~4095UL;

    void *ptr = mmap(NULL, size, PROT_READ, MAP_SHARED, fd, 0);
    close(fd);

    if (ptr == MAP_FAILED) return -1;

    *out_ptr  = ptr;
    *out_size = size;
    return 0;
}

/* SIGBUS handler for files truncated while mapped */
static sigjmp_buf sigbus_jmp;

static void sigbus_handler(int sig) {
    (void)sig;
    siglongjmp(sigbus_jmp, 1);
}

int safe_read_mapped(void *ptr, size_t offset, void *dst, size_t len) {
    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = sigbus_handler;
    sa.sa_flags   = SA_RESETHAND;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGBUS, &sa, NULL);

    if (sigsetjmp(sigbus_jmp, 1) != 0) {
        /* File was truncated while we were reading */
        fprintf(stderr, "SIGBUS: file truncated during mmap read\n");
        return -1;
    }

    memcpy(dst, (char *)ptr + offset, len);
    return 0;
}
```

## Key Takeaways

Memory mapping with `mmap` is a powerful primitive that eliminates unnecessary data copies by letting the virtual memory subsystem and page cache work together directly. The key design principles from production systems using mmap are:

**Anonymous vs file-backed**: Use anonymous mappings for application memory where file backing is not needed. Use file-backed mappings when the data must survive process restart or be shared across processes.

**MAP_SHARED vs MAP_PRIVATE**: `MAP_SHARED` is for inter-process communication and database files — writes propagate to disk and other mappers. `MAP_PRIVATE` is for executable loading and COW data structures.

**HugeTLB**: Required for any workload with a working set larger than a few hundred megabytes that performs random access. The TLB pressure reduction from 2 MB pages is measurable and significant in NUMA systems.

**msync strategy**: Choose `MS_SYNC` for transaction commit durability, `MS_ASYNC` for background writeback, and consider `MDB_WRITEMAP | MDB_MAPASYNC` for throughput-critical paths where the OS can manage coherency.

**LMDB's lesson**: A B-tree built on `MAP_SHARED` file mapping with two meta pages for atomic updates is all you need for a fully ACID key-value store. The simplicity of the design is a direct consequence of building on the right primitives.

**SQLite WAL**: The `.wal-shm` shared memory file is itself an mmap-based data structure that coordinates WAL frame visibility across multiple reader processes — a practical example of mmap as IPC substrate.

**Safety first**: Always handle `SIGBUS` when working with file-backed mappings in production code, and always validate file size before mapping to avoid zero-size mapping errors.
