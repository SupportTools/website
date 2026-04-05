---
title: "Linux Kernel Tracing with BPFTrace: One-Liners, Scripts, USDT Probes, and Production Debugging"
date: 2032-04-03T00:00:00-05:00
draft: false
tags: ["BPFTrace", "eBPF", "Linux", "Kernel Tracing", "USDT", "Performance", "Debugging", "Observability"]
categories:
- Linux
- Performance
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to Linux kernel tracing with BPFTrace, covering one-liners, production scripts, USDT probes, and systematic debugging workflows for complex performance problems."
more_link: "yes"
url: "/linux-kernel-tracing-bpftrace-usdt-probes-production-debugging/"
---

BPFTrace is the Swiss Army knife of Linux performance analysis. Built on top of the eBPF subsystem, it provides a high-level tracing language that makes kernel internals accessible without writing a single line of kernel module code. In production environments where traditional profiling tools fall short, BPFTrace delivers the surgical precision needed to diagnose latency spikes, resource contention, and subtle kernel-level interactions that surface only under real load.

This guide covers the full spectrum of BPFTrace usage: from quick one-liners that answer immediate questions to multi-page production scripts that collect structured telemetry, USDT probes for application-level tracing, and systematic debugging workflows for complex multi-layered problems.

<!--more-->

## Architecture and Installation

### How BPFTrace Works

BPFTrace compiles its high-level tracing language down to eBPF bytecode, which the kernel verifier checks before loading into the kernel. The tracing programs attach to:

- **kprobes/kretprobes**: Dynamic kernel function entry and return probes
- **tracepoints**: Static, stable kernel instrumentation points
- **uprobes/uretprobes**: Dynamic user-space function probes
- **USDT probes**: User-level statically defined tracing
- **software/hardware perf events**: CPU performance counters
- **intervals and timers**: Periodic actions

The eBPF virtual machine executes these programs in kernel context with safety guarantees enforced by the verifier. Maps are used to communicate data between the kernel-side eBPF programs and user-space BPFTrace.

```
┌─────────────────────────────────────────────────────────┐
│                    BPFTrace Script                       │
│  probe:filter { action }                                 │
└──────────────────┬──────────────────────────────────────┘
                   │ compile
                   ▼
┌─────────────────────────────────────────────────────────┐
│                  eBPF Bytecode                           │
└──────────────────┬──────────────────────────────────────┘
                   │ verify + load
                   ▼
┌─────────────────────────────────────────────────────────┐
│               Linux Kernel                               │
│  kprobes  tracepoints  uprobes  USDT  perf events       │
│                    │                                     │
│               eBPF Maps ◄──────────────────────────────┐│
└──────────────────────────────────────────────────────────┘
                   │ read maps
                   ▼
            User-space output
```

### Installation on Enterprise Linux Distributions

**RHEL/CentOS/Rocky Linux 8+:**

```bash
# Enable EPEL
dnf install -y epel-release

# Install BPFTrace and dependencies
dnf install -y bpftrace bpftrace-tools kernel-devel

# Verify installation
bpftrace --version
# bpftrace v0.19.1

# Check kernel BTF availability (required for CO-RE)
ls /sys/kernel/btf/vmlinux
```

**Ubuntu/Debian:**

```bash
apt-get update
apt-get install -y bpftrace linux-headers-$(uname -r)

# For the latest version via snap
snap install bpftrace

# Verify
bpftrace --version
```

**Building from Source (latest features):**

```bash
# Install build dependencies
apt-get install -y cmake llvm-dev clang libelf-dev libz-dev \
    libfl-dev libbfd-dev libdw-dev bison flex

# Clone and build
git clone https://github.com/bpftrace/bpftrace
cd bpftrace
mkdir build && cd build
cmake -DCMAKE_BUILD_TYPE=Release ..
make -j$(nproc)
make install
```

### Kernel Requirements

```bash
# Check kernel config for required features
zcat /proc/config.gz | grep -E "CONFIG_BPF|CONFIG_KPROBES|CONFIG_UPROBES|CONFIG_TRACEPOINTS"

# Minimum required kernel features
CONFIG_BPF=y
CONFIG_BPF_SYSCALL=y
CONFIG_BPF_JIT=y
CONFIG_KPROBES=y
CONFIG_UPROBES=y
CONFIG_TRACEPOINTS=y
CONFIG_DEBUG_INFO_BTF=y    # For BTF-based type information
```

## Essential One-Liners

One-liners are the fastest path from question to answer. These examples cover the most common production scenarios.

### System Call Analysis

```bash
# Count all syscalls by name for a specific PID
bpftrace -e 'tracepoint:syscalls:sys_enter_* /pid == 12345/ { @[probe] = count(); }'

# Trace slow system calls (>10ms)
bpftrace -e '
tracepoint:syscalls:sys_enter_read { @start[tid] = nsecs; }
tracepoint:syscalls:sys_exit_read
/@start[tid]/
{
  $delta = nsecs - @start[tid];
  if ($delta > 10000000) {
    printf("slow read: pid=%d comm=%s duration=%dms\n",
      pid, comm, $delta/1000000);
  }
  delete(@start[tid]);
}'

# Summarize read sizes in a histogram
bpftrace -e '
tracepoint:syscalls:sys_enter_read {
  @size_hist = hist(args->count);
}'

# Watch for specific file opens
bpftrace -e '
tracepoint:syscalls:sys_enter_openat {
  printf("%-6d %-16s %s\n", pid, comm, str(args->filename));
}'
```

### CPU and Scheduler Analysis

```bash
# CPU run queue latency histogram
bpftrace -e '
tracepoint:sched:sched_wakeup,
tracepoint:sched:sched_wakeup_new
{ @qtime[args->pid] = nsecs; }

tracepoint:sched:sched_switch
{
  if (args->prev_state == TASK_RUNNING) {
    @qtime[args->prev_pid] = nsecs;
  }
  $ns = @qtime[args->next_pid];
  if ($ns) {
    @runq_lat = hist((nsecs - $ns) / 1000);
    delete(@qtime[args->next_pid]);
  }
}'

# Off-CPU analysis (time threads are blocked)
bpftrace -e '
tracepoint:sched:sched_switch
{
  if (args->prev_state != TASK_RUNNING) {
    @offcpu_start[args->prev_pid] = nsecs;
  }

  $start = @offcpu_start[args->next_pid];
  if ($start != 0) {
    @offcpu_us[args->next_comm] = hist((nsecs - $start) / 1000);
    delete(@offcpu_start[args->next_pid]);
  }
}'

# Context switch rate by process
bpftrace -e '
tracepoint:sched:sched_switch {
  @switches[args->prev_comm] = count();
}'
```

### Memory Analysis

```bash
# Page faults by process
bpftrace -e '
software:page-fault:1 {
  @faults[comm] = count();
}'

# OOM kill events
bpftrace -e '
tracepoint:oom:oom_score_adj_update {
  printf("OOM score adj: pid=%d comm=%s score=%d\n",
    args->pid, args->comm, args->oom_score_adj);
}'

# Memory allocation failures
bpftrace -e '
kprobe:__alloc_pages_nodemask {
  @allocs[comm] = count();
}
kretprobe:__alloc_pages_nodemask
/retval == 0/
{
  @failures[comm] = count();
}'

# Huge page usage
bpftrace -e '
tracepoint:huge_memory:mm_collapse_huge_page {
  printf("huge page collapse: pid=%d comm=%s\n", pid, comm);
}'
```

### Network Analysis

```bash
# TCP connections by destination
bpftrace -e '
tracepoint:tcp:tcp_connect {
  printf("connect: pid=%-6d comm=%-16s\n", pid, comm);
}'

# TCP retransmissions
bpftrace -e '
tracepoint:tcp:tcp_retransmit_skb {
  @retransmits[comm] = count();
}'

# DNS query latency (port 53 udp)
bpftrace -e '
tracepoint:syscalls:sys_enter_sendto
/args->addr != 0/
{
  $sa = (struct sockaddr_in *)args->addr;
  if ($sa->sin_port == 0x3500) {  /* port 53 in network byte order */
    @dns_start[tid] = nsecs;
  }
}
tracepoint:syscalls:sys_exit_recvfrom
/@dns_start[tid]/
{
  @dns_lat_us = hist((nsecs - @dns_start[tid]) / 1000);
  delete(@dns_start[tid]);
}'

# Socket buffer drops
bpftrace -e '
tracepoint:skb:kfree_skb {
  @drops[comm] = count();
}'
```

### Disk I/O Analysis

```bash
# Block I/O latency histogram by device
bpftrace -e '
tracepoint:block:block_rq_issue {
  @start[args->dev, args->sector] = nsecs;
}
tracepoint:block:block_rq_complete
/@start[args->dev, args->sector]/
{
  @lat_us[args->dev, args->rwbs] =
    hist((nsecs - @start[args->dev, args->sector]) / 1000);
  delete(@start[args->dev, args->sector]);
}'

# I/O size distribution
bpftrace -e '
tracepoint:block:block_rq_issue {
  @sizes_kb[args->rwbs] = hist(args->bytes / 1024);
}'

# Processes doing most I/O
bpftrace -e '
tracepoint:block:block_rq_issue {
  @io_ops[comm, args->rwbs] = count();
  @io_bytes[comm, args->rwbs] = sum(args->bytes);
}'
```

## Production Tracing Scripts

One-liners answer specific questions, but production debugging often requires structured scripts that run for extended periods, produce formatted output, and correlate data from multiple sources.

### Latency Outlier Detection

```bash
#!/usr/bin/env bpftrace
// latency-outlier.bt — detect and report latency outliers across
// multiple system call categories

BEGIN {
  printf("Latency outlier detector started. Tracking threshold: 10ms\n");
  printf("%-10s %-16s %-8s %-12s %s\n",
    "TIME(ms)", "COMM", "PID", "SYSCALL", "LATENCY(ms)");
}

tracepoint:syscalls:sys_enter_read,
tracepoint:syscalls:sys_enter_write,
tracepoint:syscalls:sys_enter_sendto,
tracepoint:syscalls:sys_enter_recvfrom,
tracepoint:syscalls:sys_enter_pread64,
tracepoint:syscalls:sys_enter_pwrite64,
tracepoint:syscalls:sys_enter_fsync,
tracepoint:syscalls:sys_enter_fdatasync
{
  @entry_time[tid] = nsecs;
  @entry_probe[tid] = probe;
}

tracepoint:syscalls:sys_exit_read,
tracepoint:syscalls:sys_exit_write,
tracepoint:syscalls:sys_exit_sendto,
tracepoint:syscalls:sys_exit_recvfrom,
tracepoint:syscalls:sys_exit_pread64,
tracepoint:syscalls:sys_exit_pwrite64,
tracepoint:syscalls:sys_exit_fsync,
tracepoint:syscalls:sys_exit_fdatasync
/@entry_time[tid]/
{
  $lat_ns = nsecs - @entry_time[tid];
  $lat_ms = $lat_ns / 1000000;

  if ($lat_ms > 10) {
    printf("%-10llu %-16s %-8d %-12s %d\n",
      elapsed / 1000000,
      comm,
      pid,
      @entry_probe[tid],
      $lat_ms);

    @outliers[comm, @entry_probe[tid]] = count();
    @max_latency[comm, @entry_probe[tid]] = max($lat_ns);
  }

  @latency_hist[@entry_probe[tid]] = hist($lat_ns / 1000);

  delete(@entry_time[tid]);
  delete(@entry_probe[tid]);
}

interval:s:60 {
  printf("\n--- 60-second summary ---\n");
  print(@outliers);
  print(@max_latency);
  clear(@outliers);
  clear(@max_latency);
}

END {
  printf("\n--- Final latency histograms (microseconds) ---\n");
  print(@latency_hist);
  clear(@latency_hist);
}
```

### Lock Contention Analysis

```bash
#!/usr/bin/env bpftrace
// mutex-contention.bt — analyze pthread mutex contention in applications
// Usage: bpftrace mutex-contention.bt -p <PID>

#include <pthread.h>

BEGIN {
  printf("Tracing mutex contention for PID %d\n", $1);
  printf("%-16s %-12s %-12s\n", "FUNCTION", "WAIT_US", "HOLD_US");
}

uprobe:/lib/x86_64-linux-gnu/libpthread.so.0:pthread_mutex_lock
/pid == $1/
{
  @mutex_contention_start[tid] = nsecs;
}

uretprobe:/lib/x86_64-linux-gnu/libpthread.so.0:pthread_mutex_lock
/pid == $1 && @mutex_contention_start[tid]/
{
  $wait_us = (nsecs - @mutex_contention_start[tid]) / 1000;
  @wait_hist = hist($wait_us);

  if ($wait_us > 1000) {
    printf("HIGH CONTENTION: wait=%dus stack:\n", $wait_us);
    printf("%s\n", ustack());
  }

  @mutex_lock_time[uarg(0)] = nsecs;
  delete(@mutex_contention_start[tid]);
}

uprobe:/lib/x86_64-linux-gnu/libpthread.so.0:pthread_mutex_unlock
/pid == $1 && @mutex_lock_time[uarg(0)]/
{
  $hold_us = (nsecs - @mutex_lock_time[uarg(0)]) / 1000;
  @hold_hist = hist($hold_us);
  delete(@mutex_lock_time[uarg(0)]);
}

interval:s:10 {
  printf("\n--- Mutex wait latency (us) ---\n");
  print(@wait_hist);
  printf("--- Mutex hold time (us) ---\n");
  print(@hold_hist);
  clear(@wait_hist);
  clear(@hold_hist);
}
```

### TCP Connection State Machine Tracker

```bash
#!/usr/bin/env bpftrace
// tcp-state-tracker.bt — track TCP connection state transitions
// and identify anomalous connection patterns

#include <net/tcp_states.h>
#include <linux/tcp.h>

BEGIN {
  // TCP state names mapping
  @state_names[1]  = "ESTABLISHED";
  @state_names[2]  = "SYN_SENT";
  @state_names[3]  = "SYN_RECV";
  @state_names[4]  = "FIN_WAIT1";
  @state_names[5]  = "FIN_WAIT2";
  @state_names[6]  = "TIME_WAIT";
  @state_names[7]  = "CLOSE";
  @state_names[8]  = "CLOSE_WAIT";
  @state_names[9]  = "LAST_ACK";
  @state_names[10] = "LISTEN";
  @state_names[11] = "CLOSING";

  printf("TCP connection state tracker started\n");
  printf("%-26s %-8s %-16s %s -> %s\n",
    "TIME", "PID", "COMM", "OLD_STATE", "NEW_STATE");
}

kprobe:tcp_set_state
{
  $sk = (struct sock *)arg0;
  $new_state = arg1;
  $old_state = $sk->__sk_common.skc_state;

  // Only trace transitions that indicate issues
  if ($new_state == 7 || $new_state == 8 || $new_state == 9) {
    printf("%-26llu %-8d %-16s %s -> %s\n",
      nsecs,
      pid,
      comm,
      @state_names[$old_state],
      @state_names[$new_state]);
  }

  @transitions[@state_names[$old_state], @state_names[$new_state]] = count();
}

kprobe:tcp_reset
{
  $sk = (struct sock *)arg0;
  printf("TCP RESET: pid=%d comm=%s\n", pid, comm);
  @resets[comm] = count();
}

interval:s:30 {
  printf("\n--- State transitions (30s) ---\n");
  print(@transitions);
  printf("--- RST counts ---\n");
  print(@resets);
  clear(@transitions);
  clear(@resets);
}
```

### Memory Pressure Investigation Script

```bash
#!/usr/bin/env bpftrace
// memory-pressure.bt — comprehensive memory pressure investigation
// Tracks allocations, failures, reclaim activity, and OOM events

BEGIN {
  printf("Memory pressure investigator started\n");
  printf("Sampling allocation failures and reclaim activity\n");
}

// Track kmalloc failures
kprobe:kmalloc,
kprobe:kzalloc
{
  @alloc_size[comm] = hist(arg0);
  @alloc_attempts[comm] = count();
}

kretprobe:kmalloc,
kretprobe:kzalloc
/retval == 0/
{
  @kmalloc_failures[comm] = count();
  printf("ALLOC FAIL: comm=%s stack:\n%s\n", comm, kstack());
}

// Page reclaim tracking
tracepoint:vmscan:mm_vmscan_direct_reclaim_begin
{
  @reclaim_start[tid] = nsecs;
  @reclaim_initiator[tid] = comm;
  printf("Direct reclaim BEGIN: comm=%s order=%d\n",
    comm, args->order);
}

tracepoint:vmscan:mm_vmscan_direct_reclaim_end
/@reclaim_start[tid]/
{
  $duration_ms = (nsecs - @reclaim_start[tid]) / 1000000;
  printf("Direct reclaim END: comm=%s duration=%dms reclaimed=%d\n",
    @reclaim_initiator[tid], $duration_ms, args->nr_reclaimed);

  if ($duration_ms > 100) {
    printf("  WARNING: Long reclaim stall > 100ms\n");
    @long_reclaims[@reclaim_initiator[tid]] = count();
  }

  @reclaim_duration_ms = hist($duration_ms);
  delete(@reclaim_start[tid]);
  delete(@reclaim_initiator[tid]);
}

// Compaction events
tracepoint:compaction:mm_compaction_begin
{
  printf("Memory compaction started\n");
  @compactions = count();
}

// OOM kill
tracepoint:oom:mark_victim
{
  printf("OOM VICTIM: pid=%d comm=%s\n", args->pid, args->comm);
  @oom_kills[args->comm] = count();
}

// Swap activity
tracepoint:writeback:writeback_pages_written
{
  @writeback_pages = count();
}

interval:s:60 {
  printf("\n=== 60s Memory Pressure Summary ===\n");
  printf("Allocation failures by process:\n");
  print(@kmalloc_failures);
  printf("\nDirect reclaim duration histogram (ms):\n");
  print(@reclaim_duration_ms);
  printf("\nLong reclaim stalls (>100ms):\n");
  print(@long_reclaims);
  printf("\nCompactions: %d\n", @compactions);
  printf("\nOOM kills:\n");
  print(@oom_kills);

  clear(@kmalloc_failures);
  clear(@reclaim_duration_ms);
  clear(@long_reclaims);
  @compactions = 0;
}
```

## USDT Probes: Application-Level Tracing

USDT (User-level Statically Defined Tracing) probes are compiled into applications as no-op NOP instructions that BPFTrace can activate without recompilation. This allows tracing production binaries with minimal overhead.

### Finding USDT Probes

```bash
# List all USDT probes in a binary
bpftrace -l 'usdt:/usr/bin/ruby:*'
bpftrace -l 'usdt:/usr/lib/jvm/java-17-openjdk-amd64/lib/server/libjvm.so:*'

# Using tplist from BCC tools
tplist -l /usr/lib/x86_64-linux-gnu/libpython3.10.so.1.0

# Using readelf to find probe notes
readelf -n /usr/bin/python3 | grep -A4 "NT_GNU_BUILD_NOTE\|stapsdt"

# Example output for Python:
# python:function__entry
# python:function__return
# python:import__find__load__start
# python:import__find__load__done
# python:gc__start
# python:gc__done
# python:line
```

### Tracing Python Applications

```bash
#!/usr/bin/env bpftrace
// python-tracer.bt — trace Python function execution with flame-graph data

BEGIN {
  printf("Python function tracer started\n");
  printf("Attach to python process with -p <PID>\n");
}

usdt:/usr/bin/python3:python:function__entry
{
  @py_func_start[tid, arg2, arg1] = nsecs;  // arg1=filename, arg2=funcname
}

usdt:/usr/bin/python3:python:function__return
{
  $start = @py_func_start[tid, arg2, arg1];
  if ($start != 0) {
    $duration_us = (nsecs - $start) / 1000;
    if ($duration_us > 10000) {  // functions > 10ms
      printf("SLOW PYTHON FUNC: %s() in %s: %dus\n",
        str(arg2), str(arg1), $duration_us);
    }
    @func_time_us[str(arg2)] = hist($duration_us);
    delete(@py_func_start[tid, arg2, arg1]);
  }
}

usdt:/usr/bin/python3:python:gc__start
{
  @gc_start_ns[arg0] = nsecs;  // arg0 = GC generation
  printf("GC START: generation=%d\n", arg0);
}

usdt:/usr/bin/python3:python:gc__done
/@gc_start_ns[arg0]/
{
  $duration_us = (nsecs - @gc_start_ns[arg0]) / 1000;
  printf("GC DONE: generation=%d duration=%dus collected=%d\n",
    arg0, $duration_us, arg1);
  @gc_duration_us[arg0] = hist($duration_us);
  delete(@gc_start_ns[arg0]);
}

END {
  printf("\n--- Slow function execution times (us) ---\n");
  print(@func_time_us);
  printf("\n--- GC pause times by generation (us) ---\n");
  print(@gc_duration_us);
}
```

### Tracing Java/JVM Applications

```bash
#!/usr/bin/env bpftrace
// jvm-tracer.bt — trace JVM GC pauses and JIT compilation activity
// Requires: -XX:+ExtendedDTraceProbes JVM flag

usdt:/usr/lib/jvm/java-17-openjdk-amd64/lib/server/libjvm.so:hotspot:gc__begin
{
  @gc_start[arg0] = nsecs;  // arg0 = GC ID
  printf("JVM GC BEGIN: type=%d\n", arg0);
}

usdt:/usr/lib/jvm/java-17-openjdk-amd64/lib/server/libjvm.so:hotspot:gc__end
/@gc_start[arg0]/
{
  $duration_ms = (nsecs - @gc_start[arg0]) / 1000000;
  printf("JVM GC END: type=%d duration=%dms\n", arg0, $duration_ms);

  if ($duration_ms > 50) {
    printf("  WARNING: GC pause > 50ms!\n");
    @long_gc_pauses = count();
  }

  @gc_pause_ms = hist($duration_ms);
  delete(@gc_start[arg0]);
}

usdt:/usr/lib/jvm/java-17-openjdk-amd64/lib/server/libjvm.so:hotspot:method__compile__begin
{
  printf("JIT compile begin: %s.%s\n", str(arg1), str(arg3));
  @jit_compile_start[tid] = nsecs;
}

usdt:/usr/lib/jvm/java-17-openjdk-amd64/lib/server/libjvm.so:hotspot:method__compile__end
/@jit_compile_start[tid]/
{
  $duration_us = (nsecs - @jit_compile_start[tid]) / 1000;
  @jit_compile_us = hist($duration_us);
  delete(@jit_compile_start[tid]);
}

interval:s:30 {
  printf("\n--- JVM GC pause histogram (ms) ---\n");
  print(@gc_pause_ms);
  printf("Long GC pauses (>50ms): %d\n", @long_gc_pauses);
  printf("\n--- JIT compile time histogram (us) ---\n");
  print(@jit_compile_us);
}
```

### Adding USDT Probes to Go Applications

Go applications can have USDT probes added using the `go-usdt` library or by embedding probe sites manually.

```go
// main.go — Go application with USDT probes
package main

import (
    "fmt"
    "time"
    // go-usdt provides USDT probe integration
    // "github.com/planetscale/vtprotobuf/codec/grpc"
)

// To add USDT probes to Go, use the libstapsdt approach:
// The probes are defined as NOP instructions that debuggers/tracers
// can activate via the note section in the ELF binary.

// For production use, consider using probes via CGo:
/*
#cgo LDFLAGS: -lSystemTap-sdt
#include <sys/sdt.h>

void fire_request_probe(int pid, long latency_us) {
    DTRACE_PROBE2(myapp, request__done, pid, latency_us);
}

void fire_cache_probe(const char* key, int hit) {
    DTRACE_PROBE2(myapp, cache__access, key, hit);
}
*/
// import "C"

func processRequest(requestID string) {
    start := time.Now()

    // Simulate work
    time.Sleep(10 * time.Millisecond)

    latencyUs := time.Since(start).Microseconds()
    fmt.Printf("Request %s completed in %dus\n", requestID, latencyUs)

    // Fire USDT probe when using CGo integration:
    // C.fire_request_probe(C.int(os.Getpid()), C.long(latencyUs))
}

func main() {
    for i := 0; i < 100; i++ {
        go processRequest(fmt.Sprintf("req-%d", i))
    }
    time.Sleep(5 * time.Second)
}
```

Tracing the Go application:

```bash
#!/usr/bin/env bpftrace
// go-app-tracer.bt — trace Go application USDT probes
// Also demonstrates uprobe-based Go tracing without USDT

// Trace Go HTTP handler execution using uprobes
uprobe:/usr/local/bin/myapp:net/http.(*ServeMux).ServeHTTP
{
  @http_req_start[tid] = nsecs;
}

uretprobe:/usr/local/bin/myapp:net/http.(*ServeMux).ServeHTTP
/@http_req_start[tid]/
{
  $lat_us = (nsecs - @http_req_start[tid]) / 1000;
  @http_lat_us = hist($lat_us);
  delete(@http_req_start[tid]);
}

// Trace Go GC using runtime tracepoints
usdt:/usr/local/bin/myapp:go:gc__start
{
  @go_gc_start = nsecs;
}

usdt:/usr/local/bin/myapp:go:gc__done
/@go_gc_start/
{
  $duration_us = (nsecs - @go_gc_start) / 1000;
  printf("Go GC: %dus\n", $duration_us);
  @go_gc_us = hist($duration_us);
  delete(@go_gc_start);
}
```

## Production Debugging Workflows

### Systematic Latency Investigation

When a service reports elevated p99 latency, use this structured workflow:

```bash
#!/usr/bin/env bpftrace
// p99-latency-investigation.bt — systematic latency root cause analysis
// Phase 1: Identify which layer is contributing to latency

// Step 1: Is it CPU scheduling latency?
tracepoint:sched:sched_switch
{
  if (args->next_comm == "my-service") {
    if (@cpu_wait_start[args->next_pid]) {
      $wait_us = (nsecs - @cpu_wait_start[args->next_pid]) / 1000;
      @cpu_sched_wait_us = hist($wait_us);
      delete(@cpu_wait_start[args->next_pid]);
    }
  }

  if (args->prev_comm == "my-service" && args->prev_state != TASK_RUNNING) {
    @cpu_wait_start[args->prev_pid] = nsecs;
  }
}

// Step 2: Is it disk I/O?
tracepoint:block:block_rq_issue
/comm == "my-service"/
{
  @disk_io_start[args->dev, args->sector] = nsecs;
}

tracepoint:block:block_rq_complete
/@disk_io_start[args->dev, args->sector]/
{
  $lat_us = (nsecs - @disk_io_start[args->dev, args->sector]) / 1000;
  @disk_lat_us = hist($lat_us);
  delete(@disk_io_start[args->dev, args->sector]);
}

// Step 3: Is it network?
tracepoint:net:net_dev_xmit
/comm == "my-service"/
{
  @net_xmit = count();
}

// Step 4: Is it lock contention?
kprobe:mutex_lock_slowpath
/comm == "my-service"/
{
  @mutex_wait_start[tid] = nsecs;
}

kretprobe:mutex_lock_slowpath
/comm == "my-service" && @mutex_wait_start[tid]/
{
  $wait_us = (nsecs - @mutex_wait_start[tid]) / 1000;
  @mutex_wait_us = hist($wait_us);
  delete(@mutex_wait_start[tid]);
}

interval:s:30 {
  printf("\n=== Latency source breakdown (30s) ===\n");
  printf("CPU scheduling wait:\n");
  print(@cpu_sched_wait_us);
  printf("\nDisk I/O latency:\n");
  print(@disk_lat_us);
  printf("\nMutex contention wait:\n");
  print(@mutex_wait_us);
  printf("\nNetwork transmits: %d\n", @net_xmit);
}
```

### Container-Aware Tracing

In containerized environments, traces need to be filtered by container or cgroup.

```bash
#!/usr/bin/env bpftrace
// container-tracer.bt — cgroup-aware tracing for containers
// Filter by cgroup to trace specific containers

#include <linux/sched.h>
#include <linux/cgroup-defs.h>

// Helper to get container ID from cgroup path
// The container ID is typically the last 64 chars of the cgroup path

kprobe:sys_read
{
  $task = (struct task_struct *)curtask;
  $cgroup = $task->cgroups->subsys[0]->cgroup;

  // Filter for specific cgroup (container)
  // In practice, check the cgroup name or ID
  @sys_read_by_cgroup[cgroup] = count();
}

// Trace syscall latency with cgroup context
tracepoint:syscalls:sys_enter_futex
{
  @futex_entry[tid] = nsecs;
}

tracepoint:syscalls:sys_exit_futex
/@futex_entry[tid]/
{
  $lat_us = (nsecs - @futex_entry[tid]) / 1000;
  if ($lat_us > 5000) {  // > 5ms futex wait
    printf("SLOW FUTEX: pid=%d comm=%s cgroup=%s lat=%dus\n",
      pid, comm, cgroup, $lat_us);
  }
  @futex_lat_us[cgroup] = hist($lat_us);
  delete(@futex_entry[tid]);
}
```

### Flame Graph Generation

```bash
# Capture CPU profiles for flame graph generation
bpftrace -e '
profile:hz:99 {
  @[kstack(), ustack(), comm] = count();
}
interval:s:30 {
  exit();
}' > /tmp/bpftrace-stacks.txt

# Convert to flame graph format
# Use stackcollapse-bpftrace.pl from FlameGraph toolkit
git clone https://github.com/brendangregg/FlameGraph
cd FlameGraph

perl stackcollapse-bpftrace.pl /tmp/bpftrace-stacks.txt > /tmp/collapsed.txt
perl flamegraph.pl /tmp/collapsed.txt > /tmp/flamegraph.svg

# Or use the built-in histogram output for quick analysis
bpftrace -e '
profile:hz:99 /comm == "my-service"/ {
  @[ustack()] = count();
}
interval:s:10 {
  print(@);
  clear(@);
}'
```

## Advanced BPFTrace Features

### Working with Kernel Data Structures

```bash
#!/usr/bin/env bpftrace
// kernel-structs.bt — accessing complex kernel data structures

#include <linux/fs.h>
#include <linux/mm.h>
#include <linux/sched.h>

// Trace VFS read operations with file details
kprobe:vfs_read
{
  $file = (struct file *)arg0;
  $dentry = $file->f_path.dentry;
  $inode = $dentry->d_inode;

  printf("vfs_read: pid=%d file=%s size=%d ino=%d\n",
    pid,
    str($dentry->d_name.name),
    arg2,
    $inode->i_ino);
}

// Monitor task virtual memory areas
kprobe:do_mmap
{
  $task = (struct task_struct *)curtask;
  $mm = $task->mm;

  printf("mmap: pid=%d vm_area_count=%d\n",
    pid,
    $mm->map_count);

  @mmap_by_comm[comm] = count();
}

// Track huge page faults
kprobe:do_huge_pmd_anonymous_page
{
  printf("Huge page fault: pid=%d addr=0x%lx\n", pid, arg1);
  @huge_page_faults[comm] = count();
}
```

### Aggregation and Statistics

```bash
#!/usr/bin/env bpftrace
// advanced-stats.bt — demonstrates BPFTrace statistical capabilities

// Running percentile estimation using histograms
tracepoint:syscalls:sys_exit_read
/args->ret > 0/
{
  @read_bytes = hist(args->ret);
  @read_bytes_lhist = lhist(args->ret, 0, 65536, 4096);
  @total_reads = count();
  @total_bytes_read = sum(args->ret);
  @max_read = max(args->ret);
  @min_read = min(args->ret);
  @avg_read = avg(args->ret);
}

interval:s:10 {
  printf("=== Read statistics ===\n");
  printf("Total reads: %d\n", @total_reads);
  printf("Total bytes: %d\n", @total_bytes_read);
  printf("Max: %d  Min: %d  Avg: %d\n", @max_read, @min_read, @avg_read);
  printf("Distribution:\n");
  print(@read_bytes);
}
```

## Operational Considerations

### Performance Overhead

BPFTrace programs have measurable but generally acceptable overhead:

```bash
# Measure BPFTrace overhead on a specific workload
# Run baseline
sysbench cpu --cpu-max-prime=20000 run > baseline.txt

# Run with BPFTrace attached
bpftrace -e '
tracepoint:syscalls:sys_enter_read { @c = count(); }
' &
BPFTRACE_PID=$!
sysbench cpu --cpu-max-prime=20000 run > with-tracing.txt
kill $BPFTRACE_PID

# Compare results
# Typical overhead for tracepoint-based probes: 1-5%
# Kprobe overhead is higher: 5-15% for hot paths
# Profile-based (sampling): very low overhead

# Minimize overhead techniques:
# 1. Use tracepoints over kprobes where possible
# 2. Filter aggressively with /conditions/
# 3. Use maps for aggregation, not printf
# 4. Avoid ustack()/kstack() in hot paths
```

### Safety in Production

```bash
# BPFTrace safety constraints enforced by the kernel verifier:
# - No unbounded loops
# - Memory access bounds checked
# - Stack size limited
# - Maximum map sizes enforced

# Recommended production settings
BPFTRACE_STRLEN=128      # Max string length
BPFTRACE_MAP_KEYS_MAX=4096  # Max map entries
BPFTRACE_LOG_SIZE=1048576   # BPF verifier log size

# Run with limited output to prevent overwhelming terminals
bpftrace -e 'kprobe:vfs_read { @[comm] = count(); }' 2>&1 | head -1000
```

### Integration with Monitoring Systems

```bash
#!/bin/bash
# bpftrace-to-prometheus.sh — export BPFTrace metrics to Prometheus

# Run BPFTrace and output JSON
bpftrace --format=json -e '
interval:s:15 {
  print(@syscall_counts);
  print(@disk_lat_us);
  print(@net_drops);
  clear(@syscall_counts);
  clear(@disk_lat_us);
  clear(@net_drops);
}

tracepoint:syscalls:sys_enter_read {
  @syscall_counts["read"] = count();
}

tracepoint:block:block_rq_complete {
  @disk_lat_us = hist(
    (nsecs - @disk_start[args->dev, args->sector]) / 1000
  );
}

tracepoint:skb:kfree_skb {
  @net_drops = count();
}
' | python3 /opt/bpftrace-exporter/parse_and_push.py \
    --pushgateway http://prometheus-pushgateway:9091 \
    --job bpftrace-metrics \
    --instance $(hostname)
```

## Conclusion

BPFTrace transforms kernel observability from a specialized discipline requiring kernel module development into an accessible production tool. The combination of one-liners for immediate insights, structured scripts for sustained investigations, and USDT probes for application-level visibility makes it the most versatile tracing tool available on Linux today.

The key to effective BPFTrace usage is understanding which probe type matches the problem domain, filtering aggressively to minimize overhead, and building a library of scripts that can be quickly adapted to new symptoms. Production teams that invest in BPFTrace proficiency gain the ability to answer questions that would otherwise require application restarts, code changes, or extended debugging sessions.

Start with the one-liners, build up to scripts, and progressively instrument critical application paths with USDT probes for a comprehensive observability posture that works from the metal up.
