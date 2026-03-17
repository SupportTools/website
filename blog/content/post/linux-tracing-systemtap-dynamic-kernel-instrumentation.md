---
title: "Linux Tracing with SystemTap: Dynamic Kernel Instrumentation for Production"
date: 2031-03-19T00:00:00-05:00
draft: false
tags: ["Linux", "SystemTap", "Tracing", "Kernel", "Performance", "eBPF"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to SystemTap dynamic kernel instrumentation: probe types, tapset library, script compilation, safety guarantees, function latency measurement, lock contention analysis, and comparison with eBPF."
more_link: "yes"
url: "/linux-tracing-systemtap-dynamic-kernel-instrumentation/"
---

SystemTap provides a scripting language for dynamic kernel and user-space instrumentation that predates eBPF by nearly a decade. While eBPF has largely superseded SystemTap for new development, SystemTap remains valuable on older kernels, for complex multi-probe correlations, and in environments where the eBPF toolchain is unavailable. More importantly, understanding SystemTap's probe model, safety guarantees, and tapset library provides conceptual grounding that transfers directly to eBPF. This guide covers production-grade SystemTap usage with emphasis on real-world debugging scenarios.

<!--more-->

# Linux Tracing with SystemTap: Dynamic Kernel Instrumentation for Production

## Section 1: SystemTap Architecture

### How SystemTap Works

SystemTap compiles scripts to C code, which is then compiled to kernel modules that are loaded and executed in-kernel. The compilation pipeline:

```
SystemTap script (.stp)
         ↓
  stap frontend (parser, semantic analyzer)
         ↓
  C code generation
         ↓
  GCC compilation → kernel module (.ko)
         ↓
  Module loading via modprobe
         ↓
  Probe activation (kprobes/uprobes/tracepoints)
         ↓
  Runtime execution in kernel context
         ↓
  Output through stapio transport
```

This compile-then-load model is the key difference from eBPF, which uses an in-kernel JIT compiler. SystemTap modules are full kernel modules with all the attendant capabilities and risks.

### Safety Guarantees

SystemTap's translator enforces several safety properties at compile time:

1. **No unbounded loops**: SystemTap scripts cannot contain while loops or for loops without a bound (the translator enforces this or the runtime catches it)
2. **Stack depth limiting**: Recursive function calls are limited
3. **Execution time limits**: Probes that run too long are aborted
4. **Memory limits**: Array sizes are bounded
5. **Guru mode**: Scripts requiring unsafe operations must explicitly declare guru mode with `%{` / `%}` brackets

These guarantees are weaker than eBPF's verifier-based approach but still prevent the most common accidental kernel panics.

### Installation

```bash
# Ubuntu/Debian
apt-get install -y systemtap systemtap-doc linux-headers-$(uname -r) \
  linux-image-$(uname -r)-dbgsym

# RHEL/CentOS/Fedora
dnf install systemtap systemtap-devel kernel-devel kernel-debuginfo

# Verify installation
stap -V

# Test with a hello world probe
stap -e 'probe begin { println("SystemTap is working") exit() }'
# SystemTap is working
```

### Enabling Debug Information

SystemTap requires kernel debug symbols for most operations:

```bash
# Ubuntu: Install debug kernel (separate repo)
echo "deb http://ddebs.ubuntu.com $(lsb_release -cs) main restricted universe multiverse
deb http://ddebs.ubuntu.com $(lsb_release -cs)-updates main restricted universe multiverse" | \
  sudo tee -a /etc/apt/sources.list.d/ddebs.list
apt-get install linux-image-$(uname -r)-dbgsym

# RHEL: Install debuginfo
dnf debuginfo-install kernel

# Check if symbols are available
stap -e 'probe kernel.function("sys_read") { println("read called") exit() }'
# If it compiles and runs, debug symbols are available
```

## Section 2: Probe Types

### kprobe: Kernel Function Entry

```stap
#!/usr/bin/stap
# Trace all kernel read() system call entries
# Shows process name, PID, and byte count

probe kernel.function("sys_read") {
    printf("READ: process=%s pid=%d fd=%d count=%d\n",
           execname(), pid(), $fd, $count)
}

probe begin {
    printf("Tracing sys_read... Press Ctrl+C to stop\n")
}
```

```bash
# Run for 10 seconds
stap read_trace.stp -c "sleep 10"
# Or run interactively
stap read_trace.stp
```

### kretprobe: Kernel Function Return

```stap
#!/usr/bin/stap
# Measure sys_read latency distribution

global read_entry_time, read_latency

probe kernel.function("sys_read") {
    read_entry_time[tid()] = gettimeofday_us()
}

probe kernel.function("sys_read").return {
    t = read_entry_time[tid()]
    if (t != 0) {
        latency = gettimeofday_us() - t
        read_latency <<< latency
        delete read_entry_time[tid()]
    }
}

probe end {
    printf("Read latency distribution (microseconds):\n")
    print(@hist_log(read_latency))
    printf("Count: %d\n", @count(read_latency))
    printf("Min:   %d us\n", @min(read_latency))
    printf("Max:   %d us\n", @max(read_latency))
    printf("Avg:   %d us\n", @avg(read_latency))
    printf("p95:   %d us\n", @percentile(read_latency, 95))
    printf("p99:   %d us\n", @percentile(read_latency, 99))
}
```

### uprobe: User-Space Function Probing

```stap
#!/usr/bin/stap
# Trace calls to malloc in libc

probe process("/lib/x86_64-linux-gnu/libc.so.6").function("malloc") {
    printf("malloc(%d) called by %s[%d]\n",
           $size, execname(), pid())
}

probe process("/lib/x86_64-linux-gnu/libc.so.6").function("malloc").return {
    printf("malloc returned %p\n", returnval())
}
```

```stap
#!/usr/bin/stap
# Trace a Go application function
# Note: Go function names are mangled
# Use 'nm ./myapp | grep <function>' to find the mangled name

probe process("./myapp").function("main.processRequest") {
    printf("[%s] processRequest called\n", ctime(gettimeofday_s()))
}

probe process("./myapp").function("main.processRequest").return {
    printf("[%s] processRequest returned: %d\n",
           ctime(gettimeofday_s()), returnval())
}
```

### Tracepoints: Stable Kernel Instrumentation Points

Tracepoints are explicitly placed hooks in the kernel source code. They provide stable, non-fragile probing points that survive kernel updates:

```stap
#!/usr/bin/stap
# Trace scheduler context switches
# Uses the sched:sched_switch tracepoint

probe kernel.trace("sched_switch") {
    printf("SWITCH: %s[%d] -> %s[%d] cpu=%d\n",
           prev_comm, prev_pid, next_comm, next_pid, cpu())
}
```

```stap
#!/usr/bin/stap
# Trace block I/O completion (disk operations)

global io_start_time

probe kernel.trace("block_rq_issue") {
    io_start_time[devname, sector] = gettimeofday_us()
}

probe kernel.trace("block_rq_complete") {
    t = io_start_time[devname, sector]
    if (t != 0) {
        latency = gettimeofday_us() - t
        printf("IO: dev=%s sector=%d bytes=%d latency=%d us\n",
               devname, sector, nr_sector * 512, latency)
        delete io_start_time[devname, sector]
    }
}
```

### Timer Probes

```stap
#!/usr/bin/stap
# Periodic sampling - print CPU usage every second

global process_ticks

probe perf.hw.cpu_cycles {
    process_ticks[execname(), pid()] += 1
}

probe timer.s(1) {
    printf("--- CPU Usage (1s window) ---\n")
    foreach ([name, pid] in process_ticks- limit 10) {
        printf("  %s[%d]: %d cycles\n", name, pid, process_ticks[name, pid])
    }
    delete process_ticks
}
```

## Section 3: The Tapset Library

SystemTap ships with a tapset library of pre-built probe aliases and utility functions. These abstractions make complex probing scenarios much simpler.

### Common Tapset Functions

```stap
# tapset/syscalls provides all system call probes
probe syscall.read {
    # Variables provided by the tapset:
    # name     - "read"
    # fd       - file descriptor
    # buf_uaddr - user buffer address
    # count    - bytes to read
    # retstr   - return value as string (in .return probes)
    printf("read(fd=%d, count=%d)\n", fd, count)
}

# tapset/context provides process context information
probe syscall.write {
    printf("write by pid=%d tid=%d execname=%s\n",
           pid(), tid(), execname())
    printf("  uid=%d gid=%d\n", uid(), gid())
    printf("  cmdline=%s\n", cmdline_str())
}
```

### Process-Level Tapsets

```stap
#!/usr/bin/stap
# Track process creation and termination

probe process.begin {
    printf("FORK: parent=%s[%d] child pid=%d\n",
           execname(), pid(), target_set_pid)
}

probe process.end {
    printf("EXIT: %s[%d] exit_code=%d\n",
           execname(), pid(), $ret)
}

probe process.exec {
    printf("EXEC: %s[%d] -> %s\n",
           execname(), pid(), filename)
}
```

### Network Tapsets

```stap
#!/usr/bin/stap
# Monitor TCP connections

probe tcp.connect {
    printf("TCP CONNECT: %s[%d] -> %s:%d\n",
           execname(), pid(), daddr, dport)
}

probe tcp.receive {
    printf("TCP RECV: %s:%d -> %s:%d len=%d\n",
           saddr, sport, daddr, dport, len)
}

probe tcp.sendmsg {
    printf("TCP SEND: %s[%d] len=%d flags=%d\n",
           execname(), pid(), len, flags)
}
```

### I/O Tapsets

```stap
#!/usr/bin/stap
# Monitor file I/O with per-file statistics

global read_bytes_by_file

probe vfs.read.return {
    if (retval > 0) {
        file = kernel_string($file->f_path.dentry->d_name.name)
        read_bytes_by_file[execname(), file] += retval
    }
}

probe end {
    printf("Bytes read by process/file:\n")
    foreach ([proc, file] in read_bytes_by_file- limit 20) {
        printf("  %s: %s: %d bytes\n", proc, file, read_bytes_by_file[proc, file])
    }
}
```

## Section 4: Production Use Cases

### Function Latency Measurement

A critical production debugging task: measuring the latency of specific kernel functions.

```stap
#!/usr/bin/stap
# Measure do_sys_open() latency with path information
# Useful for detecting slow filesystem operations

global open_entry_time, open_paths, latency_dist

probe syscall.open, syscall.openat {
    open_entry_time[tid()] = gettimeofday_us()
    open_paths[tid()] = filename
}

probe syscall.open.return, syscall.openat.return {
    t = open_entry_time[tid()]
    if (t != 0) {
        latency = gettimeofday_us() - t
        path = open_paths[tid()]

        # Record slow opens (> 1ms = 1000 us)
        if (latency > 1000) {
            printf("SLOW_OPEN: pid=%d proc=%s path=%s latency=%d us ret=%d\n",
                   pid(), execname(), path, latency, retval)
        }

        latency_dist <<< latency
        delete open_entry_time[tid()]
        delete open_paths[tid()]
    }
}

probe end {
    printf("\nopen() latency distribution:\n")
    print(@hist_log(latency_dist))
}
```

```bash
# Run this probe against a specific application
stap open_latency.stp -c "./myapp --workload" 2>&1
```

### Lock Contention Analysis

Mutex contention is a common performance bottleneck that's invisible to CPU profilers:

```stap
#!/usr/bin/stap
# Analyze kernel mutex contention
# Shows which mutexes are causing the most contention

global lock_entry_time, contention_by_lock

probe kernel.function("__mutex_lock_slowpath") {
    # This is called when a mutex can't be acquired immediately
    lock_entry_time[tid()] = gettimeofday_us()
}

probe kernel.function("mutex_lock").return {
    t = lock_entry_time[tid()]
    if (t != 0) {
        wait_time = gettimeofday_us() - t
        if (wait_time > 100) {  # Only track waits > 100 microseconds
            # Get the call stack to identify the contending code path
            stack = sprint_backtrace()
            contention_by_lock[stack] += wait_time
        }
        delete lock_entry_time[tid()]
    }
}

probe timer.s(10) {
    printf("=== Mutex Contention Top Paths (10s window) ===\n")
    i = 0
    foreach ([stack] in contention_by_lock- limit 5) {
        printf("--- Path %d (total wait: %d us) ---\n",
               ++i, contention_by_lock[stack])
        printf("%s\n", stack)
    }
    delete contention_by_lock
}
```

### Memory Allocation Tracking

```stap
#!/usr/bin/stap
# Track kernel memory allocations to find memory leaks

global allocs_by_caller, total_allocated

probe kernel.function("kmalloc").return {
    addr = returnval()
    if (addr != 0) {
        size = $size
        caller = sprint_backtrace()
        allocs_by_caller[caller] += size
        total_allocated += size
    }
}

probe kernel.function("kfree") {
    # Track frees to correlate with allocations
    # (simplified - real tracking needs to correlate addresses)
}

probe timer.s(30) {
    printf("=== Top Memory Allocators (total: %d bytes) ===\n", total_allocated)
    foreach ([caller] in allocs_by_caller- limit 10) {
        printf("%d bytes from:\n%s\n\n",
               allocs_by_caller[caller], caller)
    }
    total_allocated = 0
    delete allocs_by_caller
}
```

### CPU Hotspot Detection by Process

```stap
#!/usr/bin/stap
# Identify CPU-intensive processes and their code paths

global cpu_time_by_pid, cpu_by_function

probe perf.sw.cpu_clock {
    cpu_time_by_pid[execname(), pid()] += 1
    cpu_by_function[execname(), sprint_ubacktrace()] += 1
}

probe timer.s(5) {
    printf("=== CPU Hogs (5s window) ===\n")
    foreach ([name, pid] in cpu_time_by_pid- limit 10) {
        printf("  %s[%d]: %d samples\n", name, pid, cpu_time_by_pid[name, pid])
    }

    printf("\n=== CPU Intensive User-Space Code Paths ===\n")
    foreach ([proc, stack] in cpu_by_function- limit 5) {
        printf("--- %s ---\n%s\n\n", proc, stack)
    }

    delete cpu_time_by_pid
    delete cpu_by_function
}
```

### Network Latency Monitoring

```stap
#!/usr/bin/stap
# Measure network receive latency from interrupt to application delivery

global rx_time

probe netdev.receive {
    # Record when the kernel received the packet
    rx_time[dev_name] = gettimeofday_us()
}

probe socket.receive.return {
    if (retval > 0) {
        t = rx_time[execname()]
        if (t != 0) {
            latency = gettimeofday_us() - t
            printf("NET_LATENCY: proc=%s latency=%d us bytes=%d\n",
                   execname(), latency, retval)
        }
    }
}
```

## Section 5: Script Compilation and Module Loading

### Compile Once, Run Many Times

SystemTap's compilation overhead (typically 10-30 seconds) can be amortized by pre-compiling scripts:

```bash
# Compile script to kernel module
stap -m my_probe -p4 my_probe.stp

# This generates my_probe.ko in the current directory
ls my_probe.ko

# Run the pre-compiled module
staprun my_probe.ko

# Or run with arguments
staprun my_probe.ko -G threshold=5000

# The module can be run without the stap frontend
# Useful for production deployments where debug tools aren't installed
```

### Cross-Compilation for Target Systems

```bash
# Compile on a build server with debug symbols for deployment on production
# The target system needs staprun but not the full SystemTap toolchain

# Build server: compile for production kernel version
stap --kernel-release=5.15.0-1050-aws \
     -m production_probe \
     -p4 my_probe.stp

# Transfer to production
scp production_probe.ko prodserver:/tmp/

# Run on production (requires staprun and CAP_SYS_ADMIN or root)
ssh prodserver 'staprun /tmp/production_probe.ko'
```

### Command-Line Arguments

```stap
#!/usr/bin/stap
# Configurable threshold probe using command-line arguments
# Run: stap -G threshold=1000 -G target_pid=12345 latency_probe.stp

global threshold = 500  # Default threshold in microseconds
global target_pid = 0   # 0 = all processes

probe syscall.read.return {
    if (target_pid != 0 && pid() != target_pid) next

    # ... probe body using @threshold and @target_pid
}
```

```bash
# Run with custom arguments
stap -G threshold=2000 -G target_pid=$(pidof myapp) latency_probe.stp
```

## Section 6: SystemTap vs eBPF Comparison

### Architecture Comparison

| Aspect | SystemTap | eBPF |
|---|---|---|
| Kernel support | 2.6.16+ (2006) | 3.18+ for basic (5.x+ for full features) |
| Safety model | Compile-time heuristics | In-kernel verifier |
| Language | SystemTap scripting language | C subset, or libbpf/bpftrace |
| Compilation | Full C compilation (10-30s) | In-kernel JIT (< 1s) |
| Dynamic update | Requires module reload | Can update maps at runtime |
| User-space access | Limited, gurumode needed | Built-in map types |
| Kernel overhead | Kernel module (heavier) | eBPF programs (lighter) |
| Debugging | stap output, println | bpftrace output, bpf_printk |
| Distribution | Separate package | Built into kernel |

### When SystemTap is Still the Right Choice

```
Choose SystemTap when:
├── Kernel < 4.18 (eBPF CO-RE not available)
├── The target uses a non-standard kernel without CONFIG_BPF_SYSCALL
├── You need complex multi-array correlations that SystemTap's associative
│   arrays handle more naturally than eBPF maps
├── Script sharing with teams using older RHEL/CentOS 6/7 systems
└── The tapset library provides exactly the probe interface you need

Choose eBPF (bpftrace, libbpf, or Cilium) when:
├── Kernel 5.x+ (full eBPF feature set available)
├── You need portability across kernel versions (CO-RE)
├── Safety guarantees from the kernel verifier are required
├── Integration with Kubernetes/container tooling (most tools are eBPF-based)
├── Performance monitoring with minimal overhead
└── Building production-grade observability tools
```

### Equivalent Probes: SystemTap vs bpftrace

```stap
# SystemTap: measure read() latency
global times
probe syscall.read { times[tid()] = gettimeofday_us() }
probe syscall.read.return {
    if (times[tid()] != 0) {
        lat = gettimeofday_us() - times[tid()]
        printf("read latency: %d us\n", lat)
        delete times[tid()]
    }
}
```

```bash
# Equivalent bpftrace: measure read() latency
bpftrace -e '
tracepoint:syscalls:sys_enter_read { @start[tid] = nsecs; }
tracepoint:syscalls:sys_exit_read /@start[tid]/ {
    @us = hist((nsecs - @start[tid]) / 1000);
    delete(@start[tid]);
}'
```

### eBPF Equivalent for Lock Contention

```bash
# SystemTap equivalent using bpftrace
bpftrace -e '
kprobe:mutex_lock {
    @mutex_lock_start[tid] = nsecs;
}
kretprobe:mutex_lock /nsecs - @mutex_lock_start[tid] > 100000/ {
    printf("mutex wait: %d us from %s\n",
           (nsecs - @mutex_lock_start[tid]) / 1000,
           func);
    delete(@mutex_lock_start[tid]);
}'
```

## Section 7: Safety and Production Deployment

### Safety Limitations

SystemTap provides several safety nets, but they are not as strong as eBPF's verifier:

```stap
# This is safe - bounded loop
for (i = 0; i < 100; i++) { ... }

# This requires --unsafe or guru mode - unbounded potential
%{
void do_something() {
    // Direct kernel C code - no safety checks
}
%}

# Using guru mode (explicit unsafe declaration)
%!
// Guru mode script - use with extreme caution
probe kernel.function("schedule") {
    // Access internal kernel structures directly
}
```

### Production Checklist

```bash
# Before deploying a SystemTap probe to production:

# 1. Test in staging with identical kernel version
stap --test my_probe.stp

# 2. Use --suppress-handler-errors to prevent script errors from crashing
stap --suppress-handler-errors my_probe.stp

# 3. Set execution time limits
stap -DMAXACTION=10000 my_probe.stp  # Limit actions per probe
stap -DMAXMAPENTRIES=1024 my_probe.stp  # Limit array size
stap -DMAXTRYLOCK=500 my_probe.stp  # Limit spinlock attempts

# 4. Test with specific process first (-c flag)
stap my_probe.stp -c "myapp --test-mode"

# 5. Verify the probe compiles without guru mode requirements
stap -p3 my_probe.stp 2>&1 | grep -i "guru\|unsafe\|warning"
```

### Resource Control

```bash
# Run with resource limits
stap \
  -DMAXACTION=5000 \
  -DMAXMAPENTRIES=2048 \
  -DMAXSTRINGLEN=512 \
  -DINTERRUPTIBLE=1 \  # Allow interruption of long-running probes
  my_probe.stp

# Time-limited execution
stap my_probe.stp &
sleep 60
kill %1
```

## Section 8: Integrating SystemTap with Monitoring Systems

### Prometheus Exporter via SystemTap

```stap
#!/usr/bin/stap
# Write metrics to a file for Prometheus node exporter (textfile collector)

global syscall_latencies

probe syscall.read.return {
    syscall_latencies["read"] <<< returnval()
}

probe syscall.write.return {
    syscall_latencies["write"] <<< returnval()
}

probe timer.s(15) {
    fd = fopen("/var/lib/node_exporter/textfile_collector/syscall_metrics.prom", "w")
    if (fd != NULL) {
        foreach ([name] in syscall_latencies) {
            fprintf(fd, "# HELP syscall_%s_bytes_total Total bytes for syscall\n", name)
            fprintf(fd, "# TYPE syscall_%s_bytes_total counter\n", name)
            fprintf(fd, "syscall_%s_bytes_total %d\n", name, @sum(syscall_latencies[name]))
            fprintf(fd, "syscall_%s_count %d\n", name, @count(syscall_latencies[name]))
        }
        fclose(fd)
    }
    delete syscall_latencies
}
```

### Output Parsing for Alerting

```bash
#!/bin/bash
# Run SystemTap probe and parse output for alerting

stap slow_queries.stp 2>&1 | while IFS= read -r line; do
    # Parse SLOW_QUERY: latency=5432 query="SELECT..."
    if [[ "$line" =~ ^SLOW_QUERY ]]; then
        latency=$(echo "$line" | grep -o 'latency=[0-9]*' | cut -d= -f2)
        if [ "$latency" -gt 10000 ]; then
            echo "ALERT: Very slow query detected: $line" | \
              mail -s "Database Alert" ops@company.com
        fi
    fi
done
```

## Section 9: Debugging SystemTap Scripts

### Common Errors and Solutions

```bash
# Error: Cannot find module for kernel
# Solution: Install kernel headers for exact kernel version
uname -r  # Get exact version
apt-get install linux-headers-$(uname -r)

# Error: Pass 3: error: expected symbol... (tapset not found)
# Solution: Check tapset availability
stap -L 'syscall.read'  # List available probe variants

# Error: semantic error: missing type tag
# Solution: Enable debug symbols
apt-get install linux-image-$(uname -r)-dbgsym  # Ubuntu
dnf debuginfo-install kernel  # RHEL

# Error: too many pending operations (MAXACTION)
stap -DMAXACTION=20000 my_probe.stp

# Warning: probe overhead too high
stap -DSTP_NO_OVERLOAD my_probe.stp  # Disable overhead protection (dangerous)

# Debug output during compilation
stap -v my_probe.stp  # Verbose: show compilation stages
stap -vvv my_probe.stp  # Very verbose: show all details
```

### Interactive Debugging

```bash
# Test a probe without loading it
stap -p3 my_probe.stp  # Compile to C but don't build module
stap -p2 my_probe.stp  # Parse and analyze only (fastest)

# Print the generated C code
stap -p3 my_probe.stp > probe.c
cat probe.c | head -100

# Run with specific PID attachment
stap my_probe.stp -x $(pidof myapp)

# Use stap-merge for combining output from parallel stap instances
stap probe1.stp > output1.txt &
stap probe2.stp > output2.txt &
wait
stap-merge output1.txt output2.txt
```

## Summary

SystemTap's probe model - kprobes, uprobes, tracepoints, and timer probes combined with the tapset library - provides a comprehensive framework for dynamic kernel instrumentation. Its key strengths remain:

- The tapset library provides high-level, stable abstractions for common kernel subsystems (VFS, network, scheduler) that make complex probing accessible without deep kernel knowledge
- Associative arrays make per-thread, per-process, or per-file state tracking natural and concise compared to eBPF's explicit map declarations
- Pre-compilation to kernel modules allows probes to be deployed to systems where the full stap compilation toolchain isn't available
- The `guru mode` escape hatch allows accessing kernel internals that strict safety checking would prevent, at the cost of explicit acknowledgment of the risk

For new deployments on modern kernels (5.x+), eBPF tools (bpftrace for interactive investigation, libbpf for production agents) are generally preferred due to stronger safety guarantees, faster compilation, and broader ecosystem support. The conceptual foundations - probe types, stack walking, associative data collection, histogram building - are the same in both systems, making SystemTap knowledge directly transferable to eBPF development.
