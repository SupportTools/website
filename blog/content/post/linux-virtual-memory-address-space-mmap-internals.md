---
title: "Linux Virtual Memory: Address Space Layout and mmap Internals"
date: 2029-07-05T00:00:00-05:00
draft: false
tags: ["Linux", "Virtual Memory", "mmap", "ASLR", "Huge Pages", "Memory", "Systems Programming"]
categories: ["Linux", "Systems Programming", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into Linux virtual memory: process address space layout, ASLR, mmap flags (MAP_ANONYMOUS, MAP_SHARED, MAP_HUGETLB), huge page mmap, memory-mapped I/O, /proc/PID/maps interpretation, and practical applications for Go and C programs."
more_link: "yes"
url: "/linux-virtual-memory-address-space-mmap-internals/"
---

Every running process on Linux operates in its own virtual address space, a 64-bit (on amd64) address range that the kernel translates to physical RAM via page tables. Understanding this layout — where the stack lives, how shared libraries are mapped, what mmap does at the kernel level — is essential for debugging memory issues, optimizing I/O-heavy applications, and implementing memory-mapped caches. This post covers the complete virtual memory model with practical examples in Go and C.

<!--more-->

# Linux Virtual Memory: Address Space Layout and mmap Internals

## The 64-Bit Virtual Address Space

On x86_64 Linux with 4-level page tables, each process has a 128 TiB user-space virtual address space (addresses 0 to 0x00007fffffffffff). The kernel occupies the upper portion of the 64-bit space (addresses 0xffff800000000000 and above).

Within the user-space portion, the canonical layout (with ASLR enabled) is approximately:

```
┌────────────────────────────────────────────┐ 0x00007fffffffffff (128 TiB)
│                   Stack                    │ grows downward
│           (thread stacks above)            │
├────────────────────────────────────────────┤
│                    ↓                       │
│                  (gap)                     │
│                    ↑                       │
├────────────────────────────────────────────┤
│           mmap() allocations               │
│      (shared libs, anonymous mmap,         │
│       file-backed mmap, stack guards)      │
├────────────────────────────────────────────┤
│                   Heap                     │ grows upward via brk()
├────────────────────────────────────────────┤
│                   BSS                      │ uninitialized globals
├────────────────────────────────────────────┤
│                  Data                      │ initialized globals
├────────────────────────────────────────────┤
│                  Text                      │ executable code (ELF .text)
├────────────────────────────────────────────┤
│               [reserved]                   │
└────────────────────────────────────────────┘ 0x0000000000000000
```

## Section 1: Reading /proc/PID/maps

`/proc/PID/maps` shows the complete virtual memory map of a process. Each line describes one virtual memory area (VMA):

```
address-range           perms  offset  dev    inode  pathname
7f8b2c000000-7f8b2c200000 rw-p 00000000 00:00 0
7f8b2c200000-7f8b2c400000 ---p 00000000 00:00 0
7f8b2c400000-7f8b2e400000 rw-p 00000000 00:00 0
7f8b2e531000-7f8b2e76e000 r--p 00000000 08:01 131082 /usr/lib/x86_64-linux-gnu/libc.so.6
7f8b2e76e000-7f8b2e8f6000 r-xp 0023d000 08:01 131082 /usr/lib/x86_64-linux-gnu/libc.so.6
7f8b2e8f6000-7f8b2e94a000 r--p 003c5000 08:01 131082 /usr/lib/x86_64-linux-gnu/libc.so.6
7f8b2e94a000-7f8b2e94e000 r--p 00418000 08:01 131082 /usr/lib/x86_64-linux-gnu/libc.so.6
7f8b2e94e000-7f8b2e950000 rw-p 0041c000 08:01 131082 /usr/lib/x86_64-linux-gnu/libc.so.6
7fff12345000-7fff12366000 rw-p 00000000 00:00 0     [stack]
7fff123bb000-7fff123bf000 r--p 00000000 00:00 0     [vvar]
7fff123bf000-7fff123c1000 r-xp 00000000 00:00 0     [vdso]
ffffffffff600000-ffffffffff601000 --xp 00000000 00:00 0 [vsyscall]
```

### Permission Flags

| Flag | Meaning |
|------|---------|
| r    | Readable |
| w    | Writable |
| x    | Executable |
| p    | Private (copy-on-write) |
| s    | Shared |
| -    | Not present |

### Understanding the Go Runtime's Memory Map

```bash
# View memory map of a running Go process
cat /proc/$(pgrep mygoapp)/maps

# Or use pmap for a formatted view
pmap -x $(pgrep mygoapp)

# Go uses large anonymous mmap() regions for its heap
# These appear as rw-p regions with no pathname and large size
```

Reading maps in Go:

```go
package procmaps

import (
    "bufio"
    "fmt"
    "os"
    "strconv"
    "strings"
)

type MemoryRegion struct {
    Start   uint64
    End     uint64
    Perms   string
    Offset  uint64
    Dev     string
    Inode   uint64
    Path    string
    SizeKiB uint64
}

func ReadMaps(pid int) ([]MemoryRegion, error) {
    path := fmt.Sprintf("/proc/%d/maps", pid)
    f, err := os.Open(path)
    if err != nil {
        return nil, err
    }
    defer f.Close()

    var regions []MemoryRegion
    scanner := bufio.NewScanner(f)
    for scanner.Scan() {
        line := scanner.Text()
        fields := strings.Fields(line)
        if len(fields) < 5 {
            continue
        }

        // Parse address range
        parts := strings.SplitN(fields[0], "-", 2)
        start, _ := strconv.ParseUint(parts[0], 16, 64)
        end, _ := strconv.ParseUint(parts[1], 16, 64)
        offset, _ := strconv.ParseUint(fields[2], 16, 64)
        inode, _ := strconv.ParseUint(fields[4], 10, 64)

        var path string
        if len(fields) >= 6 {
            path = fields[5]
        }

        regions = append(regions, MemoryRegion{
            Start:   start,
            End:     end,
            Perms:   fields[1],
            Offset:  offset,
            Dev:     fields[3],
            Inode:   inode,
            Path:    path,
            SizeKiB: (end - start) / 1024,
        })
    }
    return regions, scanner.Err()
}

func SumByType(regions []MemoryRegion) map[string]uint64 {
    totals := make(map[string]uint64)
    for _, r := range regions {
        switch {
        case r.Path == "[heap]":
            totals["heap"] += r.SizeKiB
        case r.Path == "[stack]":
            totals["stack"] += r.SizeKiB
        case strings.HasSuffix(r.Path, ".so") || strings.Contains(r.Path, ".so."):
            totals["libraries"] += r.SizeKiB
        case r.Path == "":
            totals["anonymous"] += r.SizeKiB
        default:
            totals["files"] += r.SizeKiB
        }
    }
    return totals
}
```

## Section 2: ASLR — Address Space Layout Randomization

ASLR randomizes the base addresses of the stack, heap, and shared library mappings at each program execution. This makes it much harder for attackers to construct reliable exploits.

```bash
# ASLR configuration
cat /proc/sys/kernel/randomize_va_space
# 0 = disabled
# 1 = random stack and mmap
# 2 = full ASLR (recommended, default)

# Disable ASLR for debugging a specific process
setarch $(uname -m) --addr-no-randomize ./myprogram

# Or via sysctl (system-wide, not for production!)
sysctl -w kernel.randomize_va_space=0
```

```bash
# Observe ASLR in action
# Without ASLR: same address every run
setarch x86_64 --addr-no-randomize /bin/bash -c 'cat /proc/self/maps | head -5'

# With ASLR: different addresses each run
/bin/bash -c 'cat /proc/self/maps | head -5'
```

### ASLR Impact on Container Security

ASLR provides reduced security within containers for two reasons:

1. **64-bit Linux** has 28 bits of ASLR entropy for mmap (2^28 = 268 million possible positions), making brute-force infeasible.

2. **Container processes share the kernel**, so kernel ASLR settings apply to all containers.

The practical recommendation: never disable ASLR on hosts running containers, even for debugging. Use `ptrace`-based debuggers that work within ASLR.

## Section 3: mmap System Call Deep Dive

`mmap` maps files or anonymous memory into the virtual address space. It is the foundation of:
- Dynamic library loading
- Memory-mapped file I/O
- Large heap allocations (malloc/free uses mmap for large allocations)
- Shared memory between processes
- Go's runtime memory management

### mmap Signature and Flags

```c
void *mmap(void *addr, size_t length, int prot, int flags, int fd, off_t offset);
```

Critical `flags` combinations:

```
MAP_PRIVATE | MAP_ANONYMOUS  → Private anonymous memory (heap-like)
MAP_SHARED  | MAP_ANONYMOUS  → Shared memory (survives fork, IPC)
MAP_PRIVATE | (file fd)      → Private file mapping (COW copy of file)
MAP_SHARED  | (file fd)      → Shared file mapping (writes go to file)
MAP_HUGETLB                  → Use huge pages (2MiB or 1GiB)
MAP_POPULATE                 → Pre-fault pages (avoid page faults later)
MAP_LOCKED                   → Lock pages in RAM (no swap)
MAP_FIXED                    → Map at exactly the specified address
```

### Anonymous Private Memory

```go
package mmap

import (
    "fmt"
    "os"
    "syscall"
    "unsafe"
)

// AllocateAnonymous allocates length bytes of private anonymous memory.
// Equivalent to malloc for large allocations.
func AllocateAnonymous(length int) ([]byte, error) {
    data, err := syscall.Mmap(
        -1,                         // fd = -1 for anonymous
        0,                          // offset
        length,
        syscall.PROT_READ|syscall.PROT_WRITE,
        syscall.MAP_PRIVATE|syscall.MAP_ANONYMOUS,
    )
    if err != nil {
        return nil, fmt.Errorf("mmap anonymous %d bytes: %w", length, err)
    }
    return data, nil
}

// Free releases the mmap'd memory back to the OS.
func Free(data []byte) error {
    return syscall.Munmap(data)
}

// Advise tells the kernel how the memory will be accessed
// (for readahead and eviction decisions)
func Advise(data []byte, advice int) error {
    _, _, errno := syscall.Syscall(
        syscall.SYS_MADVISE,
        uintptr(unsafe.Pointer(&data[0])),
        uintptr(len(data)),
        uintptr(advice),
    )
    if errno != 0 {
        return errno
    }
    return nil
}

// Useful madvise values
const (
    MADV_NORMAL     = 0  // default access pattern
    MADV_RANDOM     = 1  // random access (disables readahead)
    MADV_SEQUENTIAL = 2  // sequential access (aggressive readahead)
    MADV_WILLNEED   = 3  // will access soon (pre-fault pages)
    MADV_DONTNEED   = 4  // won't access (allow eviction)
    MADV_FREE       = 8  // lazy free (mark pages as available but keep them)
    MADV_HUGEPAGE   = 14 // enable transparent huge pages for this region
    MADV_NOHUGEPAGE = 15 // disable THP for this region
)
```

### File-Backed mmap for Memory-Mapped I/O

Memory-mapped file I/O can be significantly faster than read/write syscalls for random-access patterns because it avoids copying data between the page cache and a userspace buffer.

```go
package mmapfile

import (
    "fmt"
    "os"
    "syscall"
)

type MappedFile struct {
    data []byte
    size int64
}

// Open maps a file into the process's address space for reading.
func Open(path string) (*MappedFile, error) {
    f, err := os.Open(path)
    if err != nil {
        return nil, err
    }
    defer f.Close()

    info, err := f.Stat()
    if err != nil {
        return nil, err
    }
    size := info.Size()
    if size == 0 {
        return &MappedFile{size: 0}, nil
    }

    data, err := syscall.Mmap(
        int(f.Fd()),
        0,
        int(size),
        syscall.PROT_READ,
        syscall.MAP_PRIVATE, // private mapping: writes don't go to file
    )
    if err != nil {
        return nil, fmt.Errorf("mmap %q: %w", path, err)
    }

    return &MappedFile{data: data, size: size}, nil
}

func (m *MappedFile) Data() []byte { return m.data }
func (m *MappedFile) Size() int64  { return m.size }

func (m *MappedFile) Close() error {
    if m.data == nil {
        return nil
    }
    err := syscall.Munmap(m.data)
    m.data = nil
    return err
}

// ReadAt reads from the mapped file at a given offset without any syscall.
// This is the primary benefit of mmap: random access with pointer arithmetic.
func (m *MappedFile) ReadAt(offset, length int64) ([]byte, error) {
    if offset < 0 || length < 0 || offset+length > m.size {
        return nil, fmt.Errorf("read [%d:%d] out of bounds (size=%d)",
            offset, offset+length, m.size)
    }
    return m.data[offset : offset+length], nil
}
```

### Writable Shared File Mapping (Persistent Data Store)

```go
// Writable mmap for a data store (writes go directly to file)
func OpenWritable(path string, size int) (*MappedFile, error) {
    // Create or open file, ensure it has the right size
    f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0644)
    if err != nil {
        return nil, err
    }
    defer f.Close()

    // Truncate/extend to desired size
    if err := f.Truncate(int64(size)); err != nil {
        return nil, err
    }

    data, err := syscall.Mmap(
        int(f.Fd()),
        0,
        size,
        syscall.PROT_READ|syscall.PROT_WRITE,
        syscall.MAP_SHARED, // writes are visible to all mappers and flush to file
    )
    if err != nil {
        return nil, fmt.Errorf("mmap writable %q: %w", path, err)
    }

    return &MappedFile{data: data, size: int64(size)}, nil
}

// Msync flushes dirty pages to the underlying file.
// Call this before munmap or after critical writes to ensure durability.
func (m *MappedFile) Msync() error {
    _, _, errno := syscall.Syscall(
        syscall.SYS_MSYNC,
        uintptr(unsafe.Pointer(&m.data[0])),
        uintptr(len(m.data)),
        syscall.MS_SYNC, // wait for pages to be written
    )
    if errno != 0 {
        return errno
    }
    return nil
}
```

## Section 4: Huge Pages with mmap

Normal pages are 4 KiB. With 64 GiB of RAM, a process using all of it requires 16 million page table entries. Managing these entries consumes CPU time (TLB misses) and memory (page table overhead).

Huge pages (2 MiB on x86_64) reduce the number of page table entries by 512x. For processes with large working sets (databases, in-memory caches), huge pages can improve performance 5-20%.

### Types of Huge Pages in Linux

1. **Standard huge pages** (explicit, via `hugetlbfs`): Pre-allocated at boot, guaranteed availability
2. **Transparent Huge Pages (THP)**: Kernel automatically promotes 4K pages to 2M pages
3. **MAP_HUGETLB**: Request huge pages explicitly in mmap()

### Allocating with MAP_HUGETLB

```go
package hugepages

import (
    "fmt"
    "syscall"
    "unsafe"
)

const (
    MAP_HUGETLB  = 0x40000
    HUGETLB_FLAG_ENCODE_SHIFT = 26
    // 2MB huge pages
    MAP_HUGE_2MB = 21 << HUGETLB_FLAG_ENCODE_SHIFT // 21 = log2(2MB)
    // 1GB huge pages (for very large allocations)
    MAP_HUGE_1GB = 30 << HUGETLB_FLAG_ENCODE_SHIFT
)

// AllocateHuge allocates memory using 2MB huge pages.
// The system must have huge pages pre-allocated:
//   echo 512 > /proc/sys/vm/nr_hugepages
func AllocateHuge(sizeBytes int) ([]byte, error) {
    // Round up to 2MB alignment
    const hugepageSize = 2 * 1024 * 1024
    aligned := (sizeBytes + hugepageSize - 1) & ^(hugepageSize - 1)

    ptr, _, errno := syscall.Syscall6(
        syscall.SYS_MMAP,
        0, // let kernel choose address
        uintptr(aligned),
        syscall.PROT_READ|syscall.PROT_WRITE,
        syscall.MAP_PRIVATE|syscall.MAP_ANONYMOUS|uintptr(MAP_HUGETLB)|uintptr(MAP_HUGE_2MB),
        ^uintptr(0), // fd = -1
        0,           // offset
    )
    if errno != 0 {
        return nil, fmt.Errorf("mmap MAP_HUGETLB: %w (ensure nr_hugepages > 0)", errno)
    }

    return (*[1 << 40]byte)(unsafe.Pointer(ptr))[:aligned:aligned], nil
}

// CheckHugepageAvailability returns the number of free huge pages.
func CheckHugepageAvailability() (int, error) {
    data, err := os.ReadFile("/proc/sys/vm/nr_hugepages")
    if err != nil {
        return 0, err
    }
    var n int
    fmt.Sscanf(strings.TrimSpace(string(data)), "%d", &n)
    return n, nil
}
```

### Configuring Huge Pages on Kubernetes Nodes

```bash
# Pre-allocate 2MB huge pages (persistent across reboots via systemd)
cat /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages
# Set to 512 pages = 1GiB
echo 512 > /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages

# Persistent configuration
cat >> /etc/systemd/system/configure-hugepages.service << 'EOF'
[Unit]
Description=Configure huge pages
Before=kubelet.service

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'echo 512 > /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl enable configure-hugepages
```

```yaml
# Kubernetes pod requesting huge pages
apiVersion: v1
kind: Pod
spec:
  containers:
  - name: redis
    image: redis:7
    resources:
      requests:
        hugepages-2Mi: "512Mi"
        memory: "1Gi"
      limits:
        hugepages-2Mi: "512Mi"
        memory: "1Gi"
    volumeMounts:
    - name: hugepage
      mountPath: /hugepages
  volumes:
  - name: hugepage
    emptyDir:
      medium: HugePages-2Mi
```

### Transparent Huge Pages (THP)

```bash
# THP configuration
cat /sys/kernel/mm/transparent_hugepage/enabled
# [always] madvise never
# 'always' = kernel tries to use huge pages everywhere
# 'madvise' = only for regions that called madvise(MADV_HUGEPAGE)
# 'never' = disable THP

# For databases (PostgreSQL, MySQL): 'never' or 'madvise' is recommended
# THP can cause latency spikes during compaction
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag
```

## Section 5: Shared Memory with MAP_SHARED

Multiple processes can share the same physical memory pages by mapping the same file (or anonymous memory created with `memfd_create`) with MAP_SHARED.

```go
package shmem

import (
    "fmt"
    "os"
    "syscall"
    "unsafe"
)

// CreateSharedBlock creates a named shared memory block accessible
// by multiple processes.
func CreateSharedBlock(name string, sizeBytes int) (*SharedBlock, error) {
    // memfd_create creates an anonymous file in RAM
    fd, _, errno := syscall.Syscall(
        319, // SYS_memfd_create on x86_64
        uintptr(unsafe.Pointer(syscall.StringBytePtr(name))),
        uintptr(1), // MFD_CLOEXEC
        0,
    )
    if errno != 0 {
        return nil, fmt.Errorf("memfd_create %q: %w", name, errno)
    }

    // Set the size
    if err := syscall.Ftruncate(int(fd), int64(sizeBytes)); err != nil {
        syscall.Close(int(fd))
        return nil, fmt.Errorf("ftruncate: %w", err)
    }

    // Map it
    data, err := syscall.Mmap(
        int(fd),
        0,
        sizeBytes,
        syscall.PROT_READ|syscall.PROT_WRITE,
        syscall.MAP_SHARED,
    )
    if err != nil {
        syscall.Close(int(fd))
        return nil, fmt.Errorf("mmap shared: %w", err)
    }

    return &SharedBlock{
        fd:   int(fd),
        data: data,
        size: sizeBytes,
    }, nil
}

type SharedBlock struct {
    fd   int
    data []byte
    size int
}

// FD returns the file descriptor that can be passed to child processes
// via fork/exec or Unix socket (SCM_RIGHTS) for sharing.
func (b *SharedBlock) FD() int       { return b.fd }
func (b *SharedBlock) Data() []byte  { return b.data }
func (b *SharedBlock) Size() int     { return b.size }

func (b *SharedBlock) Close() error {
    err := syscall.Munmap(b.data)
    syscall.Close(b.fd)
    return err
}
```

## Section 6: Memory-Mapped I/O for Databases

Memory-mapped I/O is the foundation of many high-performance databases (LMDB, RocksDB via mmap, BoltDB). The key insight: the kernel's page cache IS the database buffer pool. No separate buffer management is needed.

### Implementing a Simple Append-Only Log

```go
package mmaplog

import (
    "encoding/binary"
    "fmt"
    "os"
    "syscall"
    "sync/atomic"
    "unsafe"
)

const (
    initialSize = 64 * 1024 * 1024  // 64 MiB initial mapping
    growFactor  = 2
)

type AppendLog struct {
    f     *os.File
    data  []byte
    size  int64        // current file size
    write atomic.Int64 // write offset (atomic for lock-free reads of committed entries)
}

func OpenLog(path string) (*AppendLog, error) {
    f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0644)
    if err != nil {
        return nil, err
    }

    info, _ := f.Stat()
    size := info.Size()
    if size < initialSize {
        size = initialSize
        f.Truncate(size)
    }

    data, err := syscall.Mmap(
        int(f.Fd()), 0, int(size),
        syscall.PROT_READ|syscall.PROT_WRITE,
        syscall.MAP_SHARED,
    )
    if err != nil {
        f.Close()
        return nil, fmt.Errorf("mmap log: %w", err)
    }

    // Find the write position (scan for last committed entry)
    log := &AppendLog{f: f, data: data, size: size}
    log.write.Store(log.findEnd())
    return log, nil
}

// Append writes an entry to the log and returns its offset.
// Entry format: [length: 4 bytes][data: length bytes]
func (l *AppendLog) Append(data []byte) (int64, error) {
    entryLen := 4 + int64(len(data))

    // Reserve space atomically
    offset := l.write.Add(entryLen) - entryLen

    // Grow mapping if needed
    if offset+entryLen > l.size {
        if err := l.grow(offset + entryLen); err != nil {
            return -1, err
        }
    }

    // Write entry directly to mmap'd region (no syscall)
    binary.LittleEndian.PutUint32(l.data[offset:], uint32(len(data)))
    copy(l.data[offset+4:], data)

    return offset, nil
}

func (l *AppendLog) findEnd() int64 {
    var pos int64
    for pos+4 <= int64(len(l.data)) {
        length := int64(binary.LittleEndian.Uint32(l.data[pos:]))
        if length == 0 {
            break
        }
        pos += 4 + length
    }
    return pos
}

func (l *AppendLog) grow(minSize int64) error {
    newSize := l.size
    for newSize < minSize {
        newSize *= growFactor
    }

    // Unmap current region
    syscall.Munmap(l.data)

    // Extend file
    l.f.Truncate(newSize)

    // Remap at new size
    data, err := syscall.Mmap(
        int(l.f.Fd()), 0, int(newSize),
        syscall.PROT_READ|syscall.PROT_WRITE,
        syscall.MAP_SHARED,
    )
    if err != nil {
        return fmt.Errorf("mmap grow: %w", err)
    }

    l.data = data
    l.size = newSize
    return nil
}

func (l *AppendLog) Sync() error {
    _, _, errno := syscall.Syscall(
        syscall.SYS_MSYNC,
        uintptr(unsafe.Pointer(&l.data[0])),
        uintptr(l.write.Load()),
        syscall.MS_SYNC,
    )
    if errno != 0 {
        return errno
    }
    return nil
}
```

## Section 7: Diagnosing Memory Issues

### smaps: Detailed Memory Usage

`/proc/PID/smaps` provides RSS, PSS, and anonymous vs file-backed breakdown per VMA:

```bash
# RSS (Resident Set Size) vs PSS (Proportional Set Size)
# PSS divides shared pages by the number of processes sharing them
grep -E "(Size|Rss|Pss|Shared|Private|Anonymous)" /proc/$(pgrep myapp)/smaps | head -40

# Summary via smaps_rollup (kernel 4.14+)
cat /proc/$(pgrep myapp)/smaps_rollup
```

```go
package memory

import (
    "bufio"
    "fmt"
    "os"
    "strconv"
    "strings"
)

type SmapsEntry struct {
    Size          int64
    Rss           int64
    Pss           int64
    SharedClean   int64
    SharedDirty   int64
    PrivateClean  int64
    PrivateDirty  int64
    Anonymous     int64
    AnonHugePages int64
}

func GetMemorySummary(pid int) (*SmapsEntry, error) {
    path := fmt.Sprintf("/proc/%d/smaps_rollup", pid)
    f, err := os.Open(path)
    if err != nil {
        // Fall back to summing smaps
        return sumSmaps(pid)
    }
    defer f.Close()

    entry := &SmapsEntry{}
    scanner := bufio.NewScanner(f)
    for scanner.Scan() {
        line := scanner.Text()
        fields := strings.Fields(line)
        if len(fields) < 2 {
            continue
        }
        val, _ := strconv.ParseInt(fields[1], 10, 64)
        switch fields[0] {
        case "Rss:":
            entry.Rss = val
        case "Pss:":
            entry.Pss = val
        case "Private_Dirty:":
            entry.PrivateDirty = val
        case "Anonymous:":
            entry.Anonymous = val
        case "AnonHugePages:":
            entry.AnonHugePages = val
        }
    }
    return entry, scanner.Err()
}
```

### Detecting Memory Leaks with mmap

```bash
# Watch memory growth over time
watch -n5 'cat /proc/$(pgrep myapp)/status | grep -E "(VmRSS|VmSize|VmAnon)"'

# Track mmap allocations with strace
strace -e trace=mmap,munmap,mprotect -p $(pgrep myapp) -o mmap.log

# Use valgrind massif for detailed heap profiles (development)
valgrind --tool=massif --pages-as-heap=yes ./myapp
ms_print massif.out.* | head -100
```

## Section 8: mmap in the Go Runtime

Go manages its heap using mmap internally. Understanding this is useful when debugging Go memory issues:

```go
// Go runtime uses these mmap calls internally:
// 1. Initial heap: MAP_PRIVATE | MAP_ANONYMOUS, huge chunks
// 2. Stack memory: MAP_PRIVATE | MAP_ANONYMOUS, 8KB default, grows as needed
// 3. Memory for GC metadata: MAP_PRIVATE | MAP_ANONYMOUS

// You can observe Go's mmap usage:
import "runtime"

func printGoMemStats() {
    var ms runtime.MemStats
    runtime.ReadMemStats(&ms)
    fmt.Printf("HeapSys: %d MiB\n", ms.HeapSys/1024/1024)
    fmt.Printf("HeapInuse: %d MiB\n", ms.HeapInuse/1024/1024)
    fmt.Printf("HeapReleased: %d MiB\n", ms.HeapReleased/1024/1024)
    fmt.Printf("StackInuse: %d MiB\n", ms.StackInuse/1024/1024)
    fmt.Printf("MSpanInuse: %d MiB\n", ms.MSpanInuse/1024/1024)
}
```

```bash
# Force Go to return memory to OS
# By default, Go returns unused heap memory after 5 minutes (Go 1.12+)
# Use GOGC or debug.FreeOSMemory() to control this
GOGC=50 ./myapp  # More aggressive GC, returns memory sooner

# GOMEMLIMIT (Go 1.19+) caps total memory usage
GOMEMLIMIT=1GiB ./myapp
```

## Conclusion

Linux virtual memory is a rich subsystem that underpins everything from container isolation to database performance. Key takeaways:

- Every process has its own virtual address space; `/proc/PID/maps` shows the complete layout
- ASLR randomizes load addresses to mitigate exploitation; never disable it on production systems
- `mmap` is the universal memory management primitive: anonymous memory for heaps, file-backed for I/O, shared for IPC
- `MAP_HUGETLB` reduces TLB pressure for large working sets; critical for databases and in-memory caches
- `madvise` hints allow the kernel to optimize page eviction and readahead for your access pattern
- `msync` provides durability for memory-mapped writes; use `MS_SYNC` for crash-safe semantics
- The Go runtime uses mmap internally; `GOMEMLIMIT` and `GOGC` control how aggressively it returns pages to the OS

For production debugging, always start with `/proc/PID/smaps_rollup` for a concise memory usage summary, and use `pmap -x` for a human-readable breakdown of the virtual address space.
