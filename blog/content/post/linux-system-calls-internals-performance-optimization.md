---
title: "Linux System Calls: Internals and Performance Optimization"
date: 2029-05-26T00:00:00-05:00
draft: false
tags: ["Linux", "System Calls", "Performance", "strace", "io_uring", "vDSO", "seccomp", "Kernel"]
categories: ["Linux", "Performance Engineering", "Systems Programming"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into Linux system call internals covering syscall tracing with strace and ltrace, vDSO optimization, syscall overhead measurement, io_uring vs traditional syscalls, and seccomp filtering performance impact."
more_link: "yes"
url: "/linux-system-calls-internals-performance-optimization/"
---

System calls are the boundary between user space and kernel space — every file operation, network request, and process management action crosses this boundary. Understanding syscall internals helps you diagnose performance bottlenecks, optimize hot paths, understand security filtering overhead, and design efficient I/O architectures. This guide covers the complete picture: how syscalls work mechanically, how to trace and profile them, virtual system calls (vDSO) for zero-overhead time reads, the revolutionary io_uring interface, and the performance cost of seccomp security filters.

<!--more-->

# Linux System Calls: Internals and Performance Optimization

## How System Calls Work

```
User Space:
  gettimeofday(&tv, NULL)
          │
          │  1. Set syscall number in %rax (e.g., 96 for gettimeofday)
          │  2. Set arguments in %rdi, %rsi, %rdx, %r10, %r8, %r9
          │  3. Execute SYSCALL instruction
          ▼
CPU Mode Switch (ring 3 → ring 0):
  - Save user stack pointer
  - Load kernel stack
  - Save registers
  - Disable interrupts
          │
          ▼
Kernel:
  sys_gettimeofday()
  (read kernel timekeeping structures)
          │
          │  - Restore registers
          │  - Switch back to ring 3
          ▼
User Space:
  - Return value in %rax
```

The mode switch itself takes roughly 100-300 nanoseconds on modern hardware (varies by CPU and mitigation status). For syscalls called millions of times per second (like `gettimeofday` or `clock_gettime`), this overhead is significant.

## Section 1: Measuring Syscall Overhead

### Counting Syscalls with strace

```bash
# Count syscalls for a command
strace -c ls /tmp
# % time     seconds  usecs/call     calls    errors syscall
# ------ ----------- ----------- --------- --------- ----------------
#  35.12    0.000234          46         5           read
#  22.43    0.000149          37         4           openat
#  18.91    0.000126          42         3           fstat
#  10.23    0.000068          22         3           close
#   8.15    0.000054          18         3           mmap
#   5.16    0.000034          34         1           munmap

# Trace with timestamps (microsecond precision)
strace -tt -T ls /tmp 2>&1 | head -20
# 10:23:45.123456 openat(AT_FDCWD, "/etc/ld.so.cache", O_RDONLY|O_CLOEXEC) = 3 <0.000087>
# 10:23:45.123543 fstat(3, {...}) = 0 <0.000012>
# 10:23:45.123555 mmap(NULL, 98765, PROT_READ, ...) = 0x7f... <0.000008>

# Trace a specific process
strace -p 12345 -e trace=read,write,send,recv

# Trace all network-related syscalls
strace -p 12345 -e trace=network

# Trace with string content
strace -e trace=write -s 128 my-program 2>&1 | grep 'write'

# Summary for a long-running process (attach and detach after 10s)
timeout 10 strace -cp 12345 2>&1
```

### ltrace for Library Call Overhead

```bash
# Trace library calls (as opposed to syscalls)
ltrace -c ls /tmp

# Contrast syscall vs library call overhead
# For printf("hello\n"):
# Library: printf → format string → write() syscall
# Each level adds overhead

# Count both library and syscall calls
ltrace -S -c my-program 2>&1 | head -30
```

### Benchmarking Syscall Overhead Directly

```c
// bench_syscall.c — measure raw syscall overhead
#include <stdio.h>
#include <time.h>
#include <sys/syscall.h>
#include <unistd.h>

#define ITERATIONS 10000000

int main() {
    struct timespec ts, start, end;
    long total_ns = 0;

    clock_gettime(CLOCK_MONOTONIC, &start);

    for (int i = 0; i < ITERATIONS; i++) {
        // getpid() is a simple syscall with no arguments
        syscall(SYS_getpid);
    }

    clock_gettime(CLOCK_MONOTONIC, &end);

    total_ns = (end.tv_sec - start.tv_sec) * 1000000000L +
               (end.tv_nsec - start.tv_nsec);

    printf("getpid() syscall: %ld ns per call (%ld total for %d calls)\n",
           total_ns / ITERATIONS, total_ns, ITERATIONS);

    return 0;
}
```

```bash
# Compile and run
gcc -O2 -o bench_syscall bench_syscall.c
./bench_syscall
# Without Spectre mitigations: ~100ns per call
# With KPTI/Retpoline: ~200-400ns per call

# Check what mitigations are active
cat /proc/cpuinfo | grep bugs
# bugs: spectre_v1 spectre_v2 spec_store_bypass mds swapgs taa mmio_stale_data retbleed
cat /sys/devices/system/cpu/vulnerabilities/spectre_v2
# Mitigation: Enhanced IBRS
```

## Section 2: vDSO — Virtual System Calls

The vDSO (virtual Dynamic Shared Object) is a small shared library automatically mapped into every process's address space by the kernel. It allows certain high-frequency syscalls to run entirely in user space by reading kernel data structures that are memory-mapped read-only into user space.

### How vDSO Works

```
Without vDSO:
  clock_gettime() → SYSCALL → kernel → read timekeeping → return
  Cost: ~200ns (full syscall + mode switch)

With vDSO:
  clock_gettime() → vDSO code → read mapped kernel memory directly → return
  Cost: ~4ns (just a memory read, no mode switch!)
```

### Syscalls Accelerated by vDSO

```bash
# List vDSO symbols
grep -c vdso /proc/1/maps  # Is vDSO mapped?
# Find the vDSO mapping
cat /proc/self/maps | grep vdso
# 7ffd12345000-7ffd12346000 r-xp 00000000 00:00 0   [vdso]

# Extract and inspect the vDSO
cat /proc/self/maps | grep vdso | awk '{print $1}' | head -1
# Use a tool to dump it:
dd if=/proc/self/mem bs=4096 skip=$((0x7ffd12345)) count=1 of=/tmp/vdso.so 2>/dev/null
nm /tmp/vdso.so
# Typical vDSO exports:
# __vdso_clock_gettime
# __vdso_clock_getres
# __vdso_gettimeofday
# __vdso_time
# __vdso_getcpu
```

### Benchmarking vDSO vs Syscall

```c
// bench_vdso.c
#include <stdio.h>
#include <time.h>
#include <sys/syscall.h>

#define N 10000000

static long bench_vdso() {
    struct timespec ts, start, end;
    clock_gettime(CLOCK_MONOTONIC, &start);
    for (int i = 0; i < N; i++) {
        clock_gettime(CLOCK_REALTIME, &ts);
    }
    clock_gettime(CLOCK_MONOTONIC, &end);
    return ((end.tv_sec - start.tv_sec) * 1000000000LL +
            (end.tv_nsec - start.tv_nsec)) / N;
}

static long bench_syscall() {
    struct timespec ts, start, end;
    clock_gettime(CLOCK_MONOTONIC, &start);
    for (int i = 0; i < N; i++) {
        // Force actual syscall, bypassing vDSO
        syscall(SYS_clock_gettime, CLOCK_REALTIME, &ts);
    }
    clock_gettime(CLOCK_MONOTONIC, &end);
    return ((end.tv_sec - start.tv_sec) * 1000000000LL +
            (end.tv_nsec - start.tv_nsec)) / N;
}

int main() {
    printf("clock_gettime via vDSO:   %ld ns\n", bench_vdso());
    printf("clock_gettime via syscall: %ld ns\n", bench_syscall());
    return 0;
}
```

```bash
gcc -O2 -o bench_vdso bench_vdso.c
./bench_vdso
# Typical output:
# clock_gettime via vDSO:    4 ns
# clock_gettime via syscall: 187 ns
# ~47x faster with vDSO!
```

### vDSO in Go

Go's runtime uses vDSO automatically for `time.Now()`:

```go
// Verify Go uses vDSO for time operations
package main

import (
    "fmt"
    "time"
    "testing"
)

func BenchmarkTimeNow(b *testing.B) {
    for i := 0; i < b.N; i++ {
        _ = time.Now()
    }
}

func main() {
    result := testing.Benchmark(BenchmarkTimeNow)
    fmt.Printf("time.Now(): %v ns/op\n", result.NsPerOp())
    // Output: time.Now(): 12 ns/op  (using vDSO internally)
}
```

```bash
# Confirm vDSO is used (should not show syscall for time)
strace -c -e trace=clock_gettime ./my-go-program
# If using vDSO, clock_gettime won't appear in strace output at all
# (vDSO calls don't go through the syscall interface)
```

## Section 3: Syscall Overhead Categories

### Categorizing Syscall Costs

| Category | Examples | Cost | Notes |
|----------|---------|------|-------|
| vDSO | clock_gettime, gettimeofday | 4-20 ns | No kernel transition |
| Fast path | getpid, getuid | 50-150 ns | Minimal kernel work |
| I/O (cached) | read (page cache hit) | 200-500 ns | Memory copy only |
| I/O (uncached) | read (disk miss) | 100-10,000 µs | Disk I/O dominates |
| Network | send/recv | 1-50 µs | Depends on stack |
| Fork/exec | fork, execve | 100-500 µs | Process creation |

### Profiling Syscall Frequency with perf

```bash
# Count syscalls system-wide for 10 seconds
perf stat -e 'syscalls:sys_enter_*' -a sleep 10 2>&1 | head -30

# Count syscalls for a specific process
perf stat -e 'syscalls:sys_enter_read,syscalls:sys_enter_write,syscalls:sys_enter_epoll_wait' \
  -p 12345 sleep 5

# Trace and count with BPF
bpftrace -e 'tracepoint:syscalls:sys_enter_* { @[probe] = count(); } END { print(@, 20); }' \
  -p 12345

# Find the top syscalls being called
bpftrace -e '
tracepoint:raw_syscalls:sys_enter {
    @syscalls[pid, comm] = count();
}
interval:s:5 {
    print(@syscalls, 10);
    clear(@syscalls);
}' 2>/dev/null | head -30
```

## Section 4: io_uring — Asynchronous I/O Revolution

`io_uring` (introduced in Linux 5.1) is the most significant I/O subsystem change since epoll. It provides asynchronous, batched I/O with minimal syscall overhead using shared ring buffers.

### Traditional I/O vs io_uring

```
Traditional read:
  1. read() syscall
  2. Context switch to kernel
  3. Check/fill page cache
  4. Copy data to user buffer
  5. Context switch back
  6. Return
  Total syscalls: 1 per operation

io_uring read:
  1. Prepare submission queue entry (SQE) — no syscall
  2. io_uring_enter() to submit batch (1 syscall for N operations)
  3. Kernel processes asynchronously
  4. Check completion queue (CQE) — no syscall if using polling
  Total syscalls: 1 per BATCH
```

### io_uring with liburing

```c
// io_uring_read_bench.c
#include <stdio.h>
#include <stdlib.h>
#include <fcntl.h>
#include <liburing.h>
#include <string.h>
#include <time.h>

#define QD    64      // Queue depth
#define BS    4096    // Block size
#define FILES 1000    // Number of read operations

static long bench_io_uring_read(const char *path) {
    struct io_uring ring;
    struct io_uring_sqe *sqe;
    struct io_uring_cqe *cqe;
    char **bufs;
    int *fds;
    struct timespec start, end;
    int total = FILES;
    int submitted = 0;
    int completed = 0;

    // Initialize io_uring with queue depth QD
    if (io_uring_queue_init(QD, &ring, 0) < 0) {
        perror("io_uring_queue_init");
        return -1;
    }

    bufs = malloc(FILES * sizeof(char *));
    fds  = malloc(FILES * sizeof(int));
    for (int i = 0; i < FILES; i++) {
        bufs[i] = aligned_alloc(512, BS);
        fds[i]  = open(path, O_RDONLY | O_DIRECT);
    }

    clock_gettime(CLOCK_MONOTONIC, &start);

    int in_flight = 0;
    int next = 0;

    while (completed < FILES) {
        // Submit up to QD operations at a time
        while (in_flight < QD && next < FILES) {
            sqe = io_uring_get_sqe(&ring);
            io_uring_prep_read(sqe, fds[next], bufs[next], BS, 0);
            sqe->user_data = next;
            next++;
            in_flight++;
        }

        if (in_flight > 0) {
            io_uring_submit(&ring);
        }

        // Collect completions
        int count;
        if (io_uring_peek_batch_cqe(&ring, &cqe, 1) > 0) {
            io_uring_cqe_seen(&ring, cqe);
            in_flight--;
            completed++;
        }
    }

    clock_gettime(CLOCK_MONOTONIC, &end);

    for (int i = 0; i < FILES; i++) {
        free(bufs[i]);
        close(fds[i]);
    }
    free(bufs);
    free(fds);
    io_uring_queue_exit(&ring);

    long elapsed_ns = (end.tv_sec - start.tv_sec) * 1000000000LL +
                      (end.tv_nsec - start.tv_nsec);
    return elapsed_ns;
}

static long bench_pread(const char *path) {
    char *buf = aligned_alloc(512, BS);
    struct timespec start, end;

    clock_gettime(CLOCK_MONOTONIC, &start);

    for (int i = 0; i < FILES; i++) {
        int fd = open(path, O_RDONLY | O_DIRECT);
        pread(fd, buf, BS, 0);
        close(fd);
    }

    clock_gettime(CLOCK_MONOTONIC, &end);
    free(buf);

    return (end.tv_sec - start.tv_sec) * 1000000000LL +
           (end.tv_nsec - start.tv_nsec);
}

int main(int argc, char *argv[]) {
    if (argc < 2) {
        fprintf(stderr, "Usage: %s <file>\n", argv[0]);
        return 1;
    }

    long uring_ns = bench_io_uring_read(argv[1]);
    long pread_ns = bench_pread(argv[1]);

    printf("io_uring: %ld ms for %d reads (%ld ns/read)\n",
           uring_ns / 1000000, FILES, uring_ns / FILES);
    printf("pread:    %ld ms for %d reads (%ld ns/read)\n",
           pread_ns / 1000000, FILES, pread_ns / FILES);
    printf("io_uring speedup: %.1fx\n", (double)pread_ns / uring_ns);

    return 0;
}
```

```bash
gcc -O2 -o io_uring_bench io_uring_read_bench.c -luring
# Create a test file
dd if=/dev/urandom of=/tmp/test_file bs=4096 count=1
./io_uring_bench /tmp/test_file
# Typical output (NVMe SSD):
# io_uring: 45 ms for 1000 reads (45000 ns/read)
# pread:    312 ms for 1000 reads (312000 ns/read)
# io_uring speedup: 6.9x
```

### io_uring in Go with uring Package

```go
package main

import (
    "fmt"
    "os"
    "time"
    "unsafe"

    "golang.org/x/sys/unix"
)

// io_uring setup via Go's unix package
func demonstrateIOUring() {
    // io_uring_setup syscall
    params := unix.IOURingParams{}
    ringFd, err := unix.IoUringSetup(128, &params)
    if err != nil {
        fmt.Printf("io_uring_setup failed: %v\n", err)
        return
    }
    defer unix.Close(ringFd)

    fmt.Printf("io_uring created: fd=%d, sq_entries=%d, cq_entries=%d\n",
        ringFd, params.SqEntries, params.CqEntries)

    // In production, use a library like:
    // github.com/iceber/iouring-go
    // github.com/pawelgaczynski/gain (for network io_uring)
}

// Comparison: standard file read
func standardRead(path string) time.Duration {
    start := time.Now()
    data, _ := os.ReadFile(path)
    _ = data
    return time.Since(start)
}
```

### io_uring in Production: Key Patterns

```bash
# Check io_uring kernel support
uname -r  # Need 5.1+ for basic io_uring, 5.6+ for full feature set
cat /proc/sys/kernel/io_uring_disabled
# 0 = enabled, 1 = disabled

# Enable io_uring (some distros disable it for security)
echo 0 > /proc/sys/kernel/io_uring_disabled

# Check if applications are using io_uring
strace -e trace=io_uring_enter,io_uring_setup,io_uring_register -p 12345

# Monitor io_uring operations with BPF
bpftrace -e '
tracepoint:io_uring:io_uring_submit_req {
    @[args->opcode] = count();
}
interval:s:1 {
    print(@);
    clear(@);
}'
```

## Section 5: seccomp — Syscall Filtering and Its Performance Impact

seccomp (Secure Computing Mode) restricts which syscalls a process can make. It is used by Docker, Kubernetes, systemd, and Chrome to reduce attack surface — but at a performance cost.

### seccomp Modes

```
seccomp Mode 1 (strict): only read, write, exit, sigreturn allowed
seccomp Mode 2 (filter): custom BPF filter applied to every syscall
```

### Measuring seccomp Overhead

```c
// seccomp_bench.c — measure seccomp filter overhead
#include <stdio.h>
#include <time.h>
#include <unistd.h>
#include <sys/syscall.h>
#include <sys/prctl.h>
#include <linux/seccomp.h>
#include <linux/filter.h>
#include <linux/audit.h>
#include <stddef.h>

#define N 10000000

static long bench_getpid(const char *label) {
    struct timespec start, end;
    clock_gettime(CLOCK_MONOTONIC, &start);
    for (int i = 0; i < N; i++) {
        syscall(SYS_getpid);
    }
    clock_gettime(CLOCK_MONOTONIC, &end);
    long ns = ((end.tv_sec - start.tv_sec) * 1000000000LL +
               (end.tv_nsec - start.tv_nsec)) / N;
    printf("%s: %ld ns/call\n", label, ns);
    return ns;
}

// Minimal seccomp filter that allows most syscalls
static void install_seccomp_filter() {
    struct sock_filter filter[] = {
        // Load syscall number
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        // Allow all syscalls (SECCOMP_RET_ALLOW)
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };

    struct sock_fprog prog = {
        .len = sizeof(filter) / sizeof(filter[0]),
        .filter = filter,
    };

    prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
    syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0, &prog);
}

int main() {
    long before = bench_getpid("Without seccomp");
    install_seccomp_filter();
    long after = bench_getpid("With seccomp (allow-all filter)");
    printf("Overhead: %.1f%%\n", 100.0 * (after - before) / before);
    return 0;
}
```

```bash
gcc -O2 -o seccomp_bench seccomp_bench.c
./seccomp_bench
# Typical output:
# Without seccomp: 147 ns/call
# With seccomp (allow-all filter): 203 ns/call
# Overhead: 38%
#
# Even an "allow all" filter adds overhead because every syscall
# must be evaluated by the BPF program
```

### Docker Default seccomp Profile Performance

```bash
# Run with default seccomp profile (Docker default)
docker run --rm alpine sh -c "
apk add -q util-linux
for i in 1 2 3; do
    time for j in \$(seq 100000); do true; done
done
"
# real    0m3.2s

# Run with seccomp disabled (for comparison)
docker run --rm --security-opt seccomp=unconfined alpine sh -c "
apk add -q util-linux
for i in 1 2 3; do
    time for j in \$(seq 100000); do true; done
done
"
# real    0m2.1s
# Approximately 50% overhead from Docker's seccomp profile
```

### Custom seccomp Profile for Performance

```json
// custom-seccomp.json — minimal profile for a Go HTTP server
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "archMap": [
    {
      "architecture": "SCMP_ARCH_X86_64",
      "subArchitectures": ["SCMP_ARCH_X86", "SCMP_ARCH_X32"]
    }
  ],
  "syscalls": [
    {
      "names": [
        "read", "write", "close", "fstat", "lseek", "mmap",
        "mprotect", "munmap", "brk", "pread64", "pwrite64",
        "readv", "writev", "access", "pipe", "select", "sched_yield",
        "mremap", "msync", "mincore", "madvise", "shmget", "shmat",
        "shmctl", "dup", "dup2", "nanosleep", "getitimer", "alarm",
        "setitimer", "getpid", "sendfile", "socket", "connect",
        "accept", "sendto", "recvfrom", "sendmsg", "recvmsg",
        "shutdown", "bind", "listen", "getsockname", "getpeername",
        "socketpair", "setsockopt", "getsockopt", "clone", "fork",
        "vfork", "execve", "exit", "wait4", "kill", "uname",
        "fcntl", "flock", "fsync", "fdatasync", "truncate",
        "ftruncate", "getcwd", "chdir", "fchdir", "rename", "mkdir",
        "rmdir", "creat", "link", "unlink", "symlink", "readlink",
        "chmod", "fchmod", "chown", "fchown", "lchown", "umask",
        "gettimeofday", "getrlimit", "getrusage", "sysinfo", "times",
        "getuid", "syslog", "getgid", "setuid", "setgid", "geteuid",
        "getegid", "setpgid", "getppid", "getpgrp", "setsid",
        "setreuid", "setregid", "getgroups", "setgroups", "setresuid",
        "getresuid", "setresgid", "getresgid", "getpgid", "setfsuid",
        "setfsgid", "getsid", "capget", "capset", "rt_sigaction",
        "rt_sigprocmask", "rt_sigreturn", "ioctl", "pread64",
        "readahead", "setxattr", "lsetxattr", "fsetxattr", "getxattr",
        "lgetxattr", "fgetxattr", "listxattr", "llistxattr",
        "flistxattr", "removexattr", "lremovexattr", "fremovexattr",
        "tkill", "futex", "sched_setaffinity", "sched_getaffinity",
        "set_thread_area", "io_setup", "io_destroy", "io_getevents",
        "io_submit", "io_cancel", "get_thread_area", "epoll_create",
        "epoll_ctl_old", "epoll_wait_old", "remap_file_pages",
        "getdents64", "set_tid_address", "restart_syscall",
        "semtimedop", "fadvise64", "timer_create", "timer_settime",
        "timer_gettime", "timer_getoverrun", "timer_delete",
        "clock_settime", "clock_gettime", "clock_getres",
        "clock_nanosleep", "exit_group", "epoll_wait", "epoll_ctl",
        "tgkill", "utimes", "vserver", "mbind", "set_mempolicy",
        "get_mempolicy", "mq_open", "mq_unlink", "mq_timedsend",
        "mq_timedreceive", "mq_notify", "mq_getsetattr", "kexec_load",
        "waitid", "add_key", "request_key", "keyctl", "ioprio_set",
        "ioprio_get", "inotify_init", "inotify_add_watch",
        "inotify_rm_watch", "openat", "mkdirat", "mknodat",
        "fchownat", "futimesat", "newfstatat", "unlinkat", "renameat",
        "linkat", "symlinkat", "readlinkat", "fchmodat", "faccessat",
        "pselect6", "ppoll", "unshare", "set_robust_list",
        "get_robust_list", "splice", "tee", "sync_file_range",
        "vmsplice", "move_pages", "utimensat", "epoll_pwait",
        "signalfd", "timerfd_create", "eventfd", "fallocate",
        "timerfd_settime", "timerfd_gettime", "accept4", "signalfd4",
        "eventfd2", "epoll_create1", "dup3", "pipe2", "inotify_init1",
        "preadv", "pwritev", "recvmmsg", "fanotify_init", "fanotify_mark",
        "prlimit64", "name_to_handle_at", "open_by_handle_at",
        "clock_adjtime", "syncfs", "sendmmsg", "setns", "getcpu",
        "process_vm_readv", "process_vm_writev", "kcmp", "finit_module",
        "sched_setattr", "sched_getattr", "renameat2", "seccomp",
        "getrandom", "memfd_create", "kexec_file_load", "bpf",
        "execveat", "userfaultfd", "membarrier", "mlock2",
        "copy_file_range", "preadv2", "pwritev2", "pkey_mprotect",
        "pkey_alloc", "pkey_free", "statx", "io_pgetevents",
        "rseq", "pidfd_send_signal", "io_uring_setup", "io_uring_enter",
        "io_uring_register", "open_tree", "move_mount", "fsopen",
        "fsconfig", "fsmount", "fspick", "pidfd_open", "clone3",
        "close_range", "openat2", "pidfd_getfd", "faccessat2",
        "process_madvise", "epoll_pwait2", "mount_setattr", "landlock_create_ruleset",
        "landlock_add_rule", "landlock_restrict_self"
      ],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

```bash
# Apply custom seccomp profile
docker run --rm --security-opt seccomp=custom-seccomp.json my-app

# For Kubernetes, use a SecurityContext
# Requires seccomp profiles to be on the node at /var/lib/kubelet/seccomp/
```

### Kubernetes seccomp

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: my-app
  annotations:
    # Legacy annotation method (pre-1.19)
    seccomp.security.alpha.kubernetes.io/pod: 'localhost/my-profile.json'
spec:
  securityContext:
    # Modern field (1.19+)
    seccompProfile:
      type: RuntimeDefault  # Use container runtime's default profile
      # OR:
      # type: Localhost
      # localhostProfile: my-profile.json  # relative to /var/lib/kubelet/seccomp/
      # OR:
      # type: Unconfined  # Disable seccomp (not recommended)
  containers:
  - name: app
    image: my-app:latest
    securityContext:
      seccompProfile:
        type: RuntimeDefault
```

## Section 6: Advanced Tracing with bpftrace

```bash
# Trace syscall latency histogram
bpftrace -e '
tracepoint:syscalls:sys_enter_read {
    @start[tid] = nsecs;
}
tracepoint:syscalls:sys_exit_read /retval >= 0 && @start[tid]/ {
    @read_latency = hist(nsecs - @start[tid]);
    delete(@start[tid]);
}
END { print(@read_latency); }'

# Find which functions are calling the most syscalls
bpftrace -e '
tracepoint:raw_syscalls:sys_enter {
    @[ustack, comm] = count();
}
END { print(@, 5); }' -p 12345

# Measure context switch rate
bpftrace -e '
tracepoint:sched:sched_switch {
    @context_switches = count();
}
interval:s:1 {
    printf("Context switches/sec: %d\n", @context_switches);
    clear(@context_switches);
}'
```

## Section 7: Practical Optimization Guide

### Reducing Syscall Count

```go
// BEFORE: one syscall per write
for _, line := range lines {
    fmt.Fprintln(w, line)  // Each may flush → write syscall
}

// AFTER: buffer writes, one syscall
bw := bufio.NewWriterSize(w, 64*1024)  // 64KB buffer
for _, line := range lines {
    fmt.Fprintln(bw, line)
}
bw.Flush()  // One write syscall

// BEFORE: sequential reads
for _, filename := range files {
    data, _ := os.ReadFile(filename)
    process(data)
}

// AFTER: async reads with io_uring (Go wrapper)
// Use github.com/iceber/iouring-go for high-throughput file processing
```

### Profiling Recommendations

```bash
# Quick: identify top syscalls
strace -c -p PID sleep 5

# Detailed: latency distribution
bpftrace -e 'tracepoint:syscalls:sys_exit_* { @[probe] = hist(retval); }' \
  -p PID sleep 5

# Complete syscall trace to file for offline analysis
strace -o /tmp/trace.txt -tt -T -y -yy -p PID sleep 5

# Parse strace output
python3 -c "
import re, collections
times = collections.defaultdict(list)
with open('/tmp/trace.txt') as f:
    for line in f:
        m = re.search(r'(\w+)\(.*\) = .* <(\d+\.\d+)>', line)
        if m:
            times[m.group(1)].append(float(m.group(2)))

for syscall, durations in sorted(times.items(), key=lambda x: sum(x[1]), reverse=True)[:10]:
    total = sum(durations)
    avg = total / len(durations) * 1000000  # µs
    print(f'{syscall:30s} count={len(durations):6d} total={total:.3f}s avg={avg:.1f}µs')
"
```

## Conclusion

System call optimization is a force multiplier for application performance. The key insights from this guide are: use `clock_gettime` and similar functions freely — the vDSO makes them nearly free at ~4ns. For I/O-intensive applications, `io_uring` delivers significant throughput improvements by batching operations and eliminating per-operation syscall overhead. When adding seccomp security profiles, measure the overhead — even an allow-all filter adds 30-50% latency to every syscall. Use `strace -c` to identify your syscall hotspots, then apply targeted optimizations: buffering I/O to reduce write/read call frequency, switching to `io_uring` for bulk operations, and using `bpftrace` to understand the full syscall landscape of your production workloads.
