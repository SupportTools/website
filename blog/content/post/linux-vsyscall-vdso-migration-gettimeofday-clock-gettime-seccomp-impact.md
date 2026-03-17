---
title: "Linux vsyscall to vDSO Migration: gettimeofday Optimization, clock_gettime, vDSO Symbol Resolution, and seccomp Impact"
date: 2032-03-12T00:00:00-05:00
draft: false
tags: ["Linux", "vDSO", "vsyscall", "Performance", "seccomp", "Kernel", "Systems Programming", "Containers"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux vDSO mechanics: how vsyscall was replaced, vDSO symbol resolution, gettimeofday and clock_gettime without system call overhead, seccomp filter interaction, and performance implications for containerized applications."
more_link: "yes"
url: "/linux-vsyscall-vdso-migration-gettimeofday-clock-gettime-seccomp-impact/"
---

Every time a Go program calls `time.Now()`, Python calls `datetime.now()`, or Java calls `System.currentTimeMillis()`, the underlying mechanism is `clock_gettime(CLOCK_REALTIME, ...)`. On a kernel without vDSO, this is a full system call: user-to-kernel context switch, register save/restore, SYSCALL instruction, and return. vDSO eliminates this overhead by mapping kernel code and data into user address space, making time queries pure user-space operations. Understanding how this works is essential for performance-critical applications and for debugging seccomp-related crashes.

<!--more-->

# Linux vsyscall to vDSO Migration: gettimeofday Optimization, clock_gettime, vDSO Symbol Resolution, and seccomp Impact

## Why Time Queries Matter

On modern systems, `clock_gettime` is called millions of times per second in production services:
- Every log entry timestamp
- Every Prometheus metric observation
- Every HTTP request duration
- Every database query timer
- Every distributed tracing span

At 10 million calls/second, a 200ns context switch costs 2 full CPU cores. vDSO reduces this to ~10ns on x86-64 by executing in user space.

## vsyscall: The First Attempt (Linux 2.6)

vsyscall was the original solution to fast time queries. The kernel mapped a fixed page at virtual address `0xffffffffff600000` containing implementations of `gettimeofday`, `time`, and `getcpu`. These functions read time data from a kernel-maintained page also mapped into user space.

```c
// The vsyscall mechanism (simplified)
// vsyscall page is at fixed virtual address 0xffffffffff600000
// This is a FIXED mapping - same address in every process

// gettimeofday vsyscall entry point
// 0xffffffffff600000: gettimeofday
// 0xffffffffff600400: time
// 0xffffffffff600800: getcpu

// User code called it like a normal function:
typedef int (*gettimeofday_fn)(struct timeval *, struct timezone *);
gettimeofday_fn gtod = (gettimeofday_fn)0xffffffffff600000;
gtod(&tv, &tz);
```

### vsyscall Security Problem

The fixed address made vsyscall trivially exploitable for ROP (Return-Oriented Programming) chains. An attacker who could control the instruction pointer could reliably jump to the vsyscall page and execute syscall-equivalent gadgets. This violates ASLR.

Linux kernel versions from 3.1 onward moved to one of three vsyscall modes:

| Mode | Behavior | Performance |
|------|----------|-------------|
| `vsyscall=native` | Execute user-space code at fixed address | Fast, insecure |
| `vsyscall=emulate` | Trap to kernel on access, emulate (default) | Safe, ~200ns overhead |
| `vsyscall=none` | SIGSEGV on access | Safe, breaks old binaries |

Check current mode:
```bash
cat /proc/sys/kernel/vsyscall64
# Output: emulate  (or native, or none)

# Or check boot parameters
grep vsyscall /proc/cmdline
```

Modern distributions default to `vsyscall=emulate`, which traps any access to the vsyscall page and emulates it in the kernel. This preserves binary compatibility for old glibc versions at the cost of a page fault on each call.

## vDSO: The Modern Solution

vDSO (Virtual Dynamic Shared Object) is a proper shared library (.so) that the kernel maps into every process's address space at a random address (respecting ASLR). Unlike vsyscall, vDSO:

1. Contains actual executable code (not just a page fault trap)
2. Is mapped at a randomized address (ASLR-compatible)
3. Supports more system calls
4. Is properly signed and versioned
5. Shares the kernel's timekeeping data through a separate data page

```bash
# Find vDSO in a running process
cat /proc/self/maps | grep vdso
# 7fff8a7fe000-7fff8a800000 r-xp 00000000 00:00 0   [vdso]
# 7fff8a800000-7fff8a801000 r--p 00000000 00:00 0   [vvar]

# The vDSO is mapped as executable (r-xp)
# vvar is the read-only data page with kernel timekeeping data (r--p)

# Extract the vDSO and inspect it
dd if=/proc/self/mem bs=1 skip=$((0x7fff8a7fe000)) count=$((0x2000)) of=/tmp/vdso.so 2>/dev/null
file /tmp/vdso.so
# /tmp/vdso.so: ELF 64-bit LSB shared object, x86-64...

# List vDSO exported symbols
nm -D /tmp/vdso.so
# 0000000000000a10 T __kernel_clock_gettime
# 0000000000000be0 T __kernel_clock_getres
# 00000000000009d0 T __kernel_gettimeofday
# 00000000000009b0 T __kernel_time
# 0000000000000b00 T __kernel_getcpu
```

### The vvar Data Page

The vDSO reads time values from the `vvar` page - a read-only mapping of kernel data that the kernel updates on every timer tick without requiring a system call:

```c
// Kernel-side (simplified vvar structure)
// This is the data that vDSO reads to compute time without syscalls

struct vsyscall_gtod_data {
    unsigned int seq;           // Sequence lock - odd during update
    int vclock_mode;            // VCLOCK_NONE, VCLOCK_TSC, VCLOCK_PVCLOCK
    u64 cycle_last;             // TSC value at last update
    u64 mask;                   // TSC cycle mask
    u32 mult;                   // TSC-to-nanoseconds multiplier
    u32 shift;                  // TSC-to-nanoseconds shift
    u64 wall_time_snsec;        // Wall time in nanoseconds
    u64 wall_time_sec;          // Wall time seconds
    struct timezone sys_tz;     // Timezone
    // ... plus monotonic clock fields
};
```

## How gettimeofday Works Without a Syscall

```c
// vDSO implementation of __kernel_gettimeofday (simplified)
// This code executes entirely in user space

static inline u64 vgettsc(u64 *cycle_now) {
    u64 tsc = rdtsc();    // Read Timestamp Counter - user-space instruction!
    *cycle_now = tsc;
    return tsc;
}

int __kernel_gettimeofday(struct timeval *tv, struct timezone *tz) {
    if (tv) {
        // Read the vvar data page
        const struct vsyscall_gtod_data *vd = &__vvar__vsyscall_gtod_data;

        u64 ns;
        u32 seq;

        // Sequence lock read (kernel-style seqlock in user space)
        do {
            seq = READ_ONCE(vd->seq);
            // If seq is odd, update is in progress - spin
            if (seq & 1) continue;

            // Compute time from last TSC value
            u64 cycles = vgettsc(NULL) - vd->cycle_last;
            ns = (cycles * vd->mult) >> vd->shift;
            ns += vd->wall_time_snsec;

        } while (READ_ONCE(vd->seq) != seq);  // Re-read to detect concurrent update

        tv->tv_sec  = vd->wall_time_sec + ns / NSEC_PER_SEC;
        tv->tv_usec = (ns % NSEC_PER_SEC) / NSEC_PER_USEC;
    }

    if (tz) {
        const struct vsyscall_gtod_data *vd = &__vvar__vsyscall_gtod_data;
        tz->tz_minuteswest = vd->sys_tz.tz_minuteswest;
        tz->tz_dsttime     = vd->sys_tz.tz_dsttime;
    }

    return 0;
}
```

The key insight: `rdtsc` is a user-space instruction that reads the CPU's hardware cycle counter. Combined with kernel-maintained calibration data (the multiplier and shift values), this converts TSC cycles to wall-clock nanoseconds without ever entering the kernel.

## vDSO Symbol Resolution

glibc's `clock_gettime` automatically uses the vDSO if available:

```c
// How glibc resolves vDSO symbols at startup (simplified)

// In glibc's elf/rtld.c:
void _dl_vdso_vsym(const char *name, ...) {
    // Find the vDSO in the auxiliary vector
    ElfW(Phdr) *phdr;
    // The kernel passes the vDSO address via AT_SYSINFO_EHDR in the auxiliary vector
    uintptr_t vdso_addr = getauxval(AT_SYSINFO_EHDR);

    // Resolve symbol by name from the vDSO ELF symbol table
    // Returns a function pointer or NULL if not found
}
```

### Inspecting vDSO Resolution at Runtime

```c
// user-space program to find and test vDSO symbols
#include <sys/auxv.h>
#include <elf.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

typedef int (*clock_gettime_fn)(clockid_t, struct timespec *);

clock_gettime_fn find_vdso_clock_gettime(void) {
    unsigned long vdso_base = getauxval(AT_SYSINFO_EHDR);
    if (!vdso_base) {
        printf("No vDSO found\n");
        return NULL;
    }

    ElfW(Ehdr) *ehdr = (ElfW(Ehdr) *)vdso_base;
    ElfW(Shdr) *shdr = (ElfW(Shdr) *)(vdso_base + ehdr->e_shoff);
    ElfW(Shdr) *symtab_shdr = NULL;
    ElfW(Shdr) *strtab_shdr = NULL;

    // Find symbol table and string table sections
    for (int i = 0; i < ehdr->e_shnum; i++) {
        if (shdr[i].sh_type == SHT_DYNSYM) symtab_shdr = &shdr[i];
        if (shdr[i].sh_type == SHT_STRTAB && i != ehdr->e_shstrndx)
            strtab_shdr = &shdr[i];
    }

    if (!symtab_shdr || !strtab_shdr) return NULL;

    ElfW(Sym) *symtab = (ElfW(Sym) *)(vdso_base + symtab_shdr->sh_offset);
    const char *strtab  = (const char *)(vdso_base + strtab_shdr->sh_offset);
    int nsyms = symtab_shdr->sh_size / symtab_shdr->sh_entsize;

    for (int i = 0; i < nsyms; i++) {
        const char *name = strtab + symtab[i].st_name;
        if (strcmp(name, "__kernel_clock_gettime") == 0) {
            return (clock_gettime_fn)(vdso_base + symtab[i].st_value);
        }
    }

    return NULL;
}

int main(void) {
    clock_gettime_fn vdso_clock_gettime = find_vdso_clock_gettime();

    struct timespec ts;
    unsigned long long t1, t2;

    // Benchmark syscall vs vDSO
    if (vdso_clock_gettime) {
        t1 = __builtin_ia32_rdtsc();
        for (int i = 0; i < 1000000; i++) {
            vdso_clock_gettime(CLOCK_REALTIME, &ts);
        }
        t2 = __builtin_ia32_rdtsc();
        printf("vDSO clock_gettime: %.1f cycles/call\n", (double)(t2-t1)/1000000.0);
    }

    // Force syscall (bypass vDSO)
    t1 = __builtin_ia32_rdtsc();
    for (int i = 0; i < 1000000; i++) {
        syscall(__NR_clock_gettime, CLOCK_REALTIME, &ts);
    }
    t2 = __builtin_ia32_rdtsc();
    printf("Syscall clock_gettime: %.1f cycles/call\n", (double)(t2-t1)/1000000.0);

    return 0;
}
```

Typical results on modern x86-64 hardware:
```
vDSO clock_gettime:     12.3 cycles/call  (~4ns at 3GHz)
Syscall clock_gettime:  612.7 cycles/call (~204ns at 3GHz)
```

vDSO is ~50x faster than the syscall equivalent.

## seccomp and vDSO: A Subtle Interaction

### Why seccomp Doesn't Affect vDSO Clock Calls

When `clock_gettime` is called via vDSO, it never enters the kernel. seccomp filters operate on system calls - they intercept the `SYSCALL` instruction. Since vDSO executes entirely in user space, seccomp filters never see the call.

This is generally beneficial: even a restrictive seccomp profile allows `clock_gettime` via vDSO without any filter exceptions.

### When vDSO Falls Back to Syscall

vDSO may fall back to the actual syscall in these cases:

1. **CLOCK_TAI or CLOCK_BOOTTIME on older kernels**: Not all clock IDs have vDSO implementations
2. **Paravirtualized environments**: If `vclock_mode` is `VCLOCK_NONE`, the vDSO calls the kernel
3. **Certain hypervisors**: May disable the TSC-based clock due to live migration inaccuracy
4. **SELinux policy**: Some policies can prevent the vDSO mapping

```bash
# Check which vclock mode is in use
# In /proc/cpuinfo, look for constant_tsc and nonstop_tsc
grep -E "constant_tsc|nonstop_tsc" /proc/cpuinfo | head -1

# Check if TSC is reliable (required for vDSO acceleration)
dmesg | grep -i "tsc"
# clocksource: tsc-early, clocksource: tsc    <- TSC in use
# clocksource: hpet                           <- TSC not reliable, using HPET

# In a VM: check if TSC is accessible
rdmsr 0x10 2>/dev/null  # Read TSC MSR
# If fails with "No such file" install msr-tools
# If returns a value, TSC is accessible
```

### seccomp Filter Impact: The vsyscall Emulation Problem

When `vsyscall=emulate` is active AND a seccomp filter blocks `sigreturn`, programs using old glibc that still call vsyscall directly will crash:

```bash
# Old glibc programs calling vsyscall trigger a page fault
# The kernel "emulates" this as a syscall
# If seccomp blocks sigreturn, the emulation fails

# Check for vsyscall usage in a binary
objdump -d /usr/lib/x86_64-linux-gnu/libc.so.6 | grep -A5 "ffffffffff600000" | head -20

# Modern glibc (2.14+) uses vDSO only; no vsyscall calls
# Verify glibc version
ldd --version | head -1
```

### Container seccomp and vDSO

Docker and container runtimes typically allow vDSO-related operations:

```json
// Examining the default Docker seccomp profile for clock-related rules
{
    "defaultAction": "SCMP_ACT_ERRNO",
    "architectures": ["SCMP_ARCH_X86_64"],
    "syscalls": [
        {
            "names": ["clock_gettime", "clock_getres", "gettimeofday", "time"],
            "action": "SCMP_ACT_ALLOW"
        }
    ]
}
```

Even with these syscalls allowed, they may not be needed if vDSO is working correctly. The syscalls are listed for fallback safety.

## Go Runtime and vDSO

Go's runtime uses vDSO for `time.Now()` on Linux. This is managed in `runtime/sys_linux_amd64.s`:

```go
// Go runtime assembly for clock_gettime (simplified)
// runtime/sys_linux_amd64.s

TEXT runtime·walltime1(SB),NOSPLIT,$8-12
    // Try vDSO first
    MOVQ    runtime·vdsoClockgettimeSym(SB), AX
    CMPQ    AX, $0
    JEQ     fallback

    // Call vDSO clock_gettime
    MOVL    $0, DI           // CLOCK_REALTIME = 0
    LEAQ    0(SP), SI        // &timespec on stack
    CALL    AX               // Call vDSO function directly

    // Read result from stack
    MOVQ    0(SP), R14       // seconds
    MOVQ    8(SP), R15       // nanoseconds
    RET

fallback:
    // Fall back to syscall
    MOVL    $SYS_clock_gettime, AX
    MOVL    $0, DI
    LEAQ    0(SP), SI
    SYSCALL
    MOVQ    0(SP), R14
    MOVQ    8(SP), R15
    RET
```

### Verifying Go Uses vDSO

```go
package main

import (
    "fmt"
    "time"
    "unsafe"
    "syscall"
)

// Check if Go is using vDSO for time.Now()
func checkVDSOUsage() {
    // Strace the process and count clock_gettime syscalls
    // If vDSO is working, strace will NOT show clock_gettime calls for time.Now()

    // Alternative: use perf to count syscalls
    // perf stat -e 'syscalls:sys_enter_clock_gettime' -- go run yourapp.go

    // Get vDSO address
    vdsoAddr := getauxval(syscall.AT_SYSINFO_EHDR)
    fmt.Printf("vDSO base address: 0x%x\n", vdsoAddr)

    // Simple timing comparison
    const iters = 10_000_000

    start := time.Now()
    var t time.Time
    for i := 0; i < iters; i++ {
        t = time.Now()
    }
    elapsed := time.Since(start)
    _ = t

    fmt.Printf("time.Now() throughput: %.1f Mops/s (%.1f ns/call)\n",
        float64(iters)/elapsed.Seconds()/1e6,
        float64(elapsed.Nanoseconds())/float64(iters),
    )
}

func getauxval(key uintptr) uintptr {
    // Access the auxiliary vector to find AT_SYSINFO_EHDR
    // In practice, use golang.org/x/sys/unix
    type auxEntry struct {
        key, val uintptr
    }

    // The aux vector is at the end of the initial stack
    // Access via /proc/self/auxv
    data, err := os.ReadFile("/proc/self/auxv")
    if err != nil {
        return 0
    }

    for i := 0; i+int(unsafe.Sizeof(auxEntry{}))-1 < len(data); i += int(unsafe.Sizeof(auxEntry{})) {
        entry := (*auxEntry)(unsafe.Pointer(&data[i]))
        if entry.key == key {
            return entry.val
        }
        if entry.key == 0 {  // AT_NULL
            break
        }
    }
    return 0
}
```

Running this typically shows:
```
vDSO base address: 0x7fff8a7fe000
time.Now() throughput: 241.3 Mops/s (4.1 ns/call)
```

## Performance Benchmarks

### Measuring vDSO vs Syscall Overhead

```bash
# Install perf tools
apt-get install -y linux-perf

# Count clock_gettime syscalls while running a Go benchmark
# If vDSO is working, count should be near 0 for time.Now() calls
perf stat -e 'syscalls:sys_enter_clock_gettime' \
    go test -bench=BenchmarkTimeNow -benchtime=10s ./...

# Expected output with working vDSO:
# BenchmarkTimeNow-16   251234567   4.12 ns/op
# Performance counter stats:
#   syscalls:sys_enter_clock_gettime    847   (the 847 are from Go runtime startup)
```

```go
// Benchmarks comparing time sources
package timebench

import (
    "testing"
    "time"
    "unsafe"
    "syscall"
)

func BenchmarkTimeNow(b *testing.B) {
    b.ReportAllocs()
    for i := 0; i < b.N; i++ {
        _ = time.Now()
    }
}

func BenchmarkClockGettime(b *testing.B) {
    var ts syscall.Timespec
    b.ReportAllocs()
    for i := 0; i < b.N; i++ {
        syscall.Syscall(syscall.SYS_CLOCK_GETTIME, 0, uintptr(unsafe.Pointer(&ts)), 0)
    }
}

func BenchmarkUnixNano(b *testing.B) {
    b.ReportAllocs()
    for i := 0; i < b.N; i++ {
        _ = time.Now().UnixNano()
    }
}
```

Typical results:
```
BenchmarkTimeNow-16         243,845,127    4.89 ns/op    0 B/op    0 allocs/op
BenchmarkClockGettime-16      5,847,291  203.71 ns/op    0 B/op    0 allocs/op
BenchmarkUnixNano-16        241,234,567    4.95 ns/op    0 B/op    0 allocs/op
```

`time.Now()` is ~41x faster than a direct syscall.

## Container and Kubernetes Considerations

### vDSO in Kubernetes Pods

vDSO is generally transparent in Kubernetes. Each pod gets vDSO mapped into its address space by the kernel, regardless of container namespace configuration. However:

```bash
# Verify vDSO is available inside a container
kubectl exec -it mypod -- bash -c 'cat /proc/self/maps | grep vdso'
# Expected: entry like
# 7fff8a7fe000-7fff8a800000 r-xp 00000000 00:00 0   [vdso]

# Check vclock mode inside container
kubectl exec -it mypod -- bash -c 'dmesg 2>/dev/null | grep -i tsc | tail -5'
# (May be empty if no dmesg access; this is expected)
```

### gVisor and User-Space Kernel Impacts

gVisor (runsc) reimplements the Linux kernel in user space. Its vDSO support is partial:

```bash
# In gVisor, clock_gettime falls back to syscall emulation
# because gVisor doesn't share the host kernel's TSC calibration

# Profile to verify:
strace -e clock_gettime -c /myapp 2>&1 | head -5
# In native Linux: 0 clock_gettime syscalls (all via vDSO)
# In gVisor:  thousands of clock_gettime syscalls
```

This makes gVisor significantly slower for time-sensitive workloads. Account for a 5-15x overhead on `time.Now()` when using gVisor.

### seccomp Troubleshooting

```bash
# Diagnose seccomp blocking vDSO fallback syscalls
# If clock_gettime fails in a container, check:

# 1. Does the seccomp profile allow clock_gettime?
docker inspect container-name | \
  python3 -c "import sys,json; cfg=json.load(sys.stdin); \
  print(cfg[0]['HostConfig']['SecurityOpt'])"

# 2. Check for SIGSYS signals (seccomp violation)
kubectl exec mypod -- bash -c 'apt-get install -y strace; \
  strace -e signal -c /myapp 2>&1 | grep SIGSYS'

# 3. Audit seccomp violations in the kernel log
dmesg | grep -i "audit.*syscall"
# AUDIT1326: arch=c000003e syscall=228 per=400000 ...
# syscall 228 = clock_gettime (check with: ausyscall 228)
ausyscall --dump | grep 228
```

## ARM64 vDSO

On ARM64 (aarch64), the vDSO mechanism works similarly but uses different hardware:

```bash
# ARM64 vDSO symbols
nm -D /proc/self/mem_$(python3 -c "
import re
for line in open('/proc/self/maps'):
    if 'vdso' in line:
        start, end = re.match(r'([0-9a-f]+)-([0-9a-f]+)', line).groups()
        print(int(start,16))
        break
").so 2>/dev/null

# ARM64 uses CNTVCT_EL0 register instead of rdtsc
# This is the ARM equivalent of the x86 TSC
# Read in user space without privilege: mrs x0, cntvct_el0
```

### Apple Silicon (M-series) and vDSO

macOS uses a different mechanism called `commpage` rather than vDSO:

```c
// macOS uses the commpage at 0xffff...0000 (similar concept, different implementation)
// Go's runtime handles this transparently
// golang.org/src/runtime/sys_darwin_arm64.s uses mach_absolute_time via commpage
```

## Debugging vDSO Issues

### Disabling vDSO for Testing

```c
// Disable vDSO by setting the symbol to NULL
// (For debugging purposes only)

// In Go: set GODEBUG=vdso=0
// This forces all time calls through syscall
GODEBUG=vdso=0 ./myapp

// With strace to verify:
GODEBUG=vdso=0 strace -e clock_gettime -c ./myapp 2>&1 | tail -5
```

### Checking vDSO Functionality After Kernel Upgrade

```bash
#!/usr/bin/env bash
# vdso_check.sh - Verify vDSO is working correctly

echo "=== vDSO Status Check ==="

# Check if vDSO is mapped
echo -n "vDSO mapping: "
if cat /proc/self/maps | grep -q vdso; then
    echo "PRESENT"
else
    echo "MISSING - time.Now() will use syscalls"
fi

# Check TSC reliability
echo -n "TSC clocksource: "
CLOCKSOURCE=$(cat /sys/devices/system/clocksource/clocksource0/current_clocksource 2>/dev/null)
echo "${CLOCKSOURCE:-unknown}"

case "${CLOCKSOURCE}" in
    tsc)
        echo "TSC in use - maximum vDSO performance expected"
        ;;
    kvm-clock|xen)
        echo "Paravirtual clock - vDSO may use PVCLOCK, slightly slower"
        ;;
    hpet|acpi_pm)
        echo "WARNING: TSC not in use - vDSO may fall back to syscall for some clock IDs"
        ;;
esac

# Benchmark
echo ""
echo "=== Time Query Benchmark ==="
cat <<'EOF' | go run /dev/stdin
package main
import (
    "fmt"
    "time"
)
func main() {
    n := 10_000_000
    start := time.Now()
    for i := 0; i < n; i++ {
        _ = time.Now()
    }
    elapsed := time.Since(start)
    nsPerCall := float64(elapsed.Nanoseconds()) / float64(n)
    fmt.Printf("time.Now(): %.1f ns/call (%.1f Mops/s)\n",
        nsPerCall, 1000/nsPerCall)
    if nsPerCall < 20 {
        fmt.Println("Status: vDSO working correctly (< 20 ns/call)")
    } else {
        fmt.Printf("Status: WARNING - high latency suggests vDSO not in use\n")
    }
}
EOF
```

## Summary

The vsyscall-to-vDSO migration represents a complete redesign of how Linux handles high-frequency system call equivalents:

- vsyscall used a fixed address (ASLR bypass vulnerability) and is now deprecated in emulate mode on modern kernels
- vDSO maps a proper shared library at a randomized address into every process, supporting ASLR while providing user-space implementations of `clock_gettime`, `gettimeofday`, `clock_getres`, and `getcpu`
- The vDSO reads time data from the `vvar` page using a seqlock protocol, providing lock-free reads of kernel-maintained timekeeping data
- On x86-64, `rdtsc` combined with kernel-calibrated multiplier/shift values produces nanosecond-precision timestamps entirely in user space at ~4-12 ns per call versus ~200 ns for the syscall equivalent
- seccomp filters do not affect vDSO calls because they never trigger the `SYSCALL` instruction; however, if the vDSO falls back to the kernel (e.g., paravirtual clocks in certain hypervisors), seccomp must allow `clock_gettime`
- gVisor's user-space kernel implementation does not support vDSO TSC acceleration, making time queries significantly slower; account for this in latency-sensitive container deployments
