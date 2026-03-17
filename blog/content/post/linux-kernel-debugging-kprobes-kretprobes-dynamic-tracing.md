---
title: "Linux Kernel Debugging: kprobes, kretprobes, and Dynamic Tracing"
date: 2029-05-11T00:00:00-05:00
draft: false
tags: ["Linux", "Kernel", "kprobes", "Debugging", "eBPF", "bpftrace", "perf", "SystemTap"]
categories: ["Linux", "Systems Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Linux kernel debugging with kprobes and kretprobes, including probe mechanics, perf-probe dynamic tracing, SystemTap alternatives, and bpftrace one-liners for investigating kernel behavior without rebooting or modifying source code."
more_link: "yes"
url: "/linux-kernel-debugging-kprobes-kretprobes-dynamic-tracing/"
---

kprobes are the Swiss Army knife of kernel debugging. They let you trap almost any kernel function or instruction at runtime — without patching the kernel, without rebooting, and without source modifications. When you're chasing a production performance regression, an intermittent kernel panic, or unexpected syscall behavior, kprobes give you the surgical access to kernel internals that no other tool provides. This post covers the mechanics from first principles, through practical perf-probe usage, to bpftrace one-liners that answer real operational questions.

<!--more-->

# Linux Kernel Debugging: kprobes, kretprobes, and Dynamic Tracing

## Section 1: kprobe Mechanics

A kprobe works by replacing the first byte of a target instruction with a breakpoint instruction (INT3 on x86-64, which is 0xCC). When execution hits that address, the CPU raises a fault, the kernel's kprobe handler runs your registered pre-handler, restores the original instruction via single-step execution in a private buffer, and returns control to normal execution.

### kprobe Execution Flow

```
Normal execution:
  kernel_function()  →  instruction₀  →  instruction₁  → ...

With kprobe at instruction₀:
  kernel_function()  →  INT3  →  kprobe_handler()
                                    → pre_handler()      [your code]
                                    → single-step copy    [original instruction₀]
                                    → post_handler()      [your code]
                              →  instruction₁  → ...
```

### Checking kprobe Support

```bash
# Verify kprobes are available
cat /sys/kernel/debug/kprobes/enabled
# Output: 1 = enabled, 0 = disabled

# List currently registered kprobes
cat /sys/kernel/debug/kprobes/list
# Format: address  type  symbol+offset
# c0000000 k  do_sys_openat2+0x0
# c0000020 r  do_sys_openat2+0x0   [kretprobe]

# Check which functions are blacklisted (cannot be kprobed)
cat /sys/kernel/debug/kprobes/blacklist

# Kernel config requirements
grep CONFIG_KPROBES /boot/config-$(uname -r)
grep CONFIG_KPROBES_ON_FTRACE /boot/config-$(uname -r)
grep CONFIG_HAVE_KPROBES /boot/config-$(uname -r)
```

### Kernel Symbols for Probing

```bash
# Find available symbols
cat /proc/kallsyms | grep do_sys_open
# ffffffffa1234567 T do_sys_openat2

# Filter by type (T = text/code = probeable)
# T = global text, t = local text, both work for kprobes
cat /proc/kallsyms | awk '$2 ~ /[tT]/ {print $3}' | grep -i "tcp_send"

# Check if a symbol is exported
grep -w tcp_sendmsg /proc/kallsyms

# Symbol offsets are useful for probing specific paths
nm -S /usr/lib/debug/boot/vmlinux-$(uname -r) | grep do_sys_openat2
```

## Section 2: Writing kprobe Modules

### Basic kprobe Kernel Module

```c
// kprobe_example.c
#include <linux/kernel.h>
#include <linux/module.h>
#include <linux/kprobes.h>
#include <linux/sched.h>
#include <linux/fs.h>
#include <linux/namei.h>

MODULE_LICENSE("GPL");
MODULE_AUTHOR("support.tools");
MODULE_DESCRIPTION("kprobe example for do_sys_openat2");

static int probe_count = 0;

/* Pre-handler: called before the probed instruction */
static int handler_pre(struct kprobe *p, struct pt_regs *regs)
{
    /* On x86-64:
     * rdi = first argument (int dfd)
     * rsi = second argument (const char __user *filename)
     * rdx = third argument (struct open_how __user *how)
     */
    const char __user *filename = (const char __user *)regs->si;
    char buf[256];

    if (strncpy_from_user(buf, filename, sizeof(buf)) > 0) {
        pr_info("kprobe: pid=%d comm=%s openat2(%s)\n",
                current->pid, current->comm, buf);
    }

    atomic_inc((atomic_t *)&probe_count);
    return 0;  /* 0 = continue execution, non-zero = abort (use carefully) */
}

/* Post-handler: called after the probed instruction (single-step) */
static void handler_post(struct kprobe *p, struct pt_regs *regs,
                          unsigned long flags)
{
    pr_debug("kprobe post: rax=%lx (return code)\n", regs->ax);
}

/* Fault handler: called if the probed instruction causes a fault */
static int handler_fault(struct kprobe *p, struct pt_regs *regs, int trapnr)
{
    pr_err("kprobe fault: trapnr=%d addr=%p\n", trapnr, p->addr);
    return 0;  /* 0 = let kernel handle the fault */
}

static struct kprobe kp = {
    .symbol_name    = "do_sys_openat2",
    .pre_handler    = handler_pre,
    .post_handler   = handler_post,
    .fault_handler  = handler_fault,
};

static int __init kprobe_init(void)
{
    int ret = register_kprobe(&kp);
    if (ret < 0) {
        pr_err("register_kprobe failed: %d\n", ret);
        return ret;
    }
    pr_info("kprobe registered at %p\n", kp.addr);
    return 0;
}

static void __exit kprobe_exit(void)
{
    unregister_kprobe(&kp);
    pr_info("kprobe unregistered. Total calls intercepted: %d\n", probe_count);
}

module_init(kprobe_init)
module_exit(kprobe_exit)
```

### Makefile for Kernel Module

```makefile
# Makefile
obj-m += kprobe_example.o

KERNEL_SRC ?= /lib/modules/$(shell uname -r)/build

all:
	$(MAKE) -C $(KERNEL_SRC) M=$(PWD) modules

clean:
	$(MAKE) -C $(KERNEL_SRC) M=$(PWD) clean

install:
	insmod kprobe_example.ko

uninstall:
	rmmod kprobe_example
```

```bash
# Build and load
make
sudo insmod kprobe_example.ko

# Verify it's loaded
sudo cat /sys/kernel/debug/kprobes/list | grep do_sys_openat2

# Watch output
sudo dmesg -w | grep kprobe

# Generate some file opens
ls /etc /proc /sys

# Unload
sudo rmmod kprobe_example
sudo dmesg | tail -5
```

## Section 3: kretprobes

kretprobes intercept the return of a function rather than (or in addition to) its entry. The kernel achieves this by replacing the return address on the stack with a "trampoline" function that calls your handler before jumping to the real return address.

### kretprobe Module

```c
// kretprobe_example.c
#include <linux/kernel.h>
#include <linux/module.h>
#include <linux/kprobes.h>
#include <linux/sched.h>
#include <linux/time.h>

MODULE_LICENSE("GPL");
MODULE_DESCRIPTION("kretprobe: measure do_sys_openat2 latency");

struct my_data {
    ktime_t entry_stamp;
    char filename[128];
};

/* Entry handler - save start time and filename */
static int entry_handler(struct kretprobe_instance *ri, struct pt_regs *regs)
{
    struct my_data *data;
    const char __user *filename = (const char __user *)regs->si;

    if (!current->mm)
        return 1;  /* Skip kernel threads */

    data = (struct my_data *)ri->data;
    data->entry_stamp = ktime_get();

    if (strncpy_from_user(data->filename, filename,
                           sizeof(data->filename)) < 0)
        data->filename[0] = '\0';

    return 0;
}

/* Return handler - compute latency and log result */
static int ret_handler(struct kretprobe_instance *ri, struct pt_regs *regs)
{
    struct my_data *data = (struct my_data *)ri->data;
    long retval = regs_return_value(regs);
    s64 delta_ns;

    delta_ns = ktime_to_ns(ktime_sub(ktime_get(), data->entry_stamp));

    if (retval >= 0) {
        /* Successful open: retval is the file descriptor */
        pr_info("openat2: pid=%d file=%s fd=%ld latency=%lldns\n",
                current->pid, data->filename, retval, delta_ns);
    } else {
        /* Failed open: retval is negative errno */
        pr_info("openat2: pid=%d file=%s error=%ld latency=%lldns\n",
                current->pid, data->filename, retval, delta_ns);
    }

    return 0;
}

static struct kretprobe my_kretprobe = {
    .handler         = ret_handler,
    .entry_handler   = entry_handler,
    .data_size       = sizeof(struct my_data),
    /* Probe up to 20 instances concurrently */
    .maxactive       = 20,
};

static int __init kretprobe_init(void)
{
    my_kretprobe.kp.symbol_name = "do_sys_openat2";
    int ret = register_kretprobe(&my_kretprobe);
    if (ret < 0) {
        pr_err("register_kretprobe failed: %d\n", ret);
        return ret;
    }
    pr_info("kretprobe for %s registered (nmissed will increment if maxactive too low)\n",
            my_kretprobe.kp.symbol_name);
    return 0;
}

static void __exit kretprobe_exit(void)
{
    unregister_kretprobe(&my_kretprobe);
    pr_info("kretprobe unregistered. nmissed=%d\n", my_kretprobe.nmissed);
}

module_init(kretprobe_init)
module_exit(kretprobe_exit)
```

### Multi-function kprobe Array

```c
// Probe multiple functions simultaneously
static struct kprobe *probes[] = {
    &(struct kprobe){
        .symbol_name = "tcp_connect",
        .pre_handler = tcp_connect_handler,
    },
    &(struct kprobe){
        .symbol_name = "tcp_close",
        .pre_handler = tcp_close_handler,
    },
    &(struct kprobe){
        .symbol_name = "__tcp_transmit_skb",
        .pre_handler = tcp_tx_handler,
    },
};

// Register all at once
register_kprobes(probes, ARRAY_SIZE(probes));

// Unregister all
unregister_kprobes(probes, ARRAY_SIZE(probes));
```

## Section 4: perf probe — Dynamic Tracing Without Modules

`perf probe` uses the kprobe infrastructure via the tracing subsystem but doesn't require writing kernel modules. It's available on any kernel with ftrace and CONFIG_KPROBE_EVENTS.

### Basic perf probe Usage

```bash
# Prerequisites
sudo apt-get install -y linux-tools-$(uname -r) linux-headers-$(uname -r)

# For symbol resolution with debug info
sudo apt-get install -y linux-image-$(uname -r)-dbgsym

# Add a probe at function entry
sudo perf probe --add do_sys_openat2

# Add a probe with local variables (requires debug info)
sudo perf probe --add 'do_sys_openat2 dfd filename'

# Add a probe at a specific line number (requires debug info)
sudo perf probe --add 'fs/namei.c:3456'

# Add a return probe
sudo perf probe --add 'do_sys_openat2%return $retval'

# List available probe points for a function
sudo perf probe --funcs | grep openat

# Show available variables at a probe point
sudo perf probe --vars do_sys_openat2

# List registered probes
sudo perf probe --list
```

### Recording and Analyzing

```bash
# Record trace with the probe
sudo perf record -e probe:do_sys_openat2 -a -g -- sleep 10

# Or record just for a specific command
sudo perf record -e probe:do_sys_openat2 ls /etc

# Report
sudo perf report --stdio

# Script output (shows each event)
sudo perf script

# Annotate with call graphs
sudo perf record -e probe:do_sys_openat2 -ag -- sleep 5
sudo perf report --call-graph graph --stdio
```

### probing tcp_sendmsg for Network Debugging

```bash
# Probe TCP send path
sudo perf probe --add 'tcp_sendmsg size'

# Record for 30 seconds
sudo perf record -e probe:tcp_sendmsg -a -- sleep 30

# Show send sizes
sudo perf script | awk '/tcp_sendmsg/ {print $NF}' | \
  awk -F= '{print $2}' | sort -n | uniq -c | sort -rn | head -20

# Cleanup
sudo perf probe --del tcp_sendmsg
```

### Tracing Scheduler Events

```bash
# Probe context switch
sudo perf probe --add '__schedule prev_state prev->pid prev->comm next->pid next->comm'

# Record
sudo perf record -e probe:__schedule -a -- sleep 5

# Analyze who is getting scheduled
sudo perf script | grep "next->comm" | awk '{print $NF}' | \
  sort | uniq -c | sort -rn | head -20
```

## Section 5: SystemTap Alternatives

SystemTap predates eBPF and provides a high-level scripting language for kernel tracing. While eBPF is generally preferred for new work, SystemTap remains useful when deeper kernel integration is needed.

### Basic SystemTap Script

```bash
# Install
sudo apt-get install -y systemtap systemtap-runtime linux-headers-$(uname -r)

# Hello world stap
stap -e 'probe kernel.function("do_sys_openat2") {
    printf("openat2: pid=%d comm=%s\n", pid(), execname())
}'
```

### SystemTap for Latency Analysis

```bash
# Save as openat_latency.stp
cat <<'STAP' > openat_latency.stp
global start_time

probe kernel.function("do_sys_openat2") {
    start_time[tid()] = gettimeofday_ns()
}

probe kernel.function("do_sys_openat2").return {
    if (start_time[tid()]) {
        latency_ns = gettimeofday_ns() - start_time[tid()]
        delete start_time[tid()]

        if ($return >= 0) {
            printf("openat2: pid=%d comm=%-16s latency=%d ns\n",
                   pid(), execname(), latency_ns)
        }
    }
}

probe timer.s(10) {
    exit()
}
STAP

sudo stap openat_latency.stp
```

### Comparing SystemTap vs eBPF/bpftrace

| Feature | SystemTap | bpftrace/eBPF |
|---------|-----------|----------------|
| Compilation | JIT to kernel module | JIT to eBPF bytecode |
| Kernel version | 2.6.x+ | 4.x+ (full 5.x+) |
| Safety | Less sandbox | Verifier-enforced |
| Language | Custom (C-like) | bpftrace language / C |
| Overhead | Moderate | Very low |
| Debug info required | Often yes | Sometimes |
| Maintenance | Legacy | Active |

## Section 6: bpftrace One-Liners for Kernel Debugging

bpftrace compiles probe scripts to eBPF bytecode and loads them into the kernel. It supports kprobes, kretprobes, tracepoints, USDT, and software events.

### Installation

```bash
# Ubuntu/Debian
sudo apt-get install -y bpftrace

# Check version (need 0.9+)
bpftrace --version

# List all available kprobe points
sudo bpftrace -l 'kprobe:*' | wc -l
sudo bpftrace -l 'kprobe:tcp_*'
```

### Essential bpftrace One-Liners

**File operations:**
```bash
# Count opens by process
sudo bpftrace -e '
kprobe:do_sys_openat2 {
    @opens[comm] = count();
}
interval:s:10 {
    print(@opens);
    clear(@opens);
    exit();
}'

# Trace file opens with names
sudo bpftrace -e '
kprobe:do_sys_openat2 {
    printf("%-6d %-16s %s\n", pid, comm, str(arg1));
}'

# Find which files are opened most
sudo bpftrace -e '
kprobe:do_sys_openat2 {
    @files[str(arg1)] = count();
}
END {
    print(@files, 20);
}'
```

**Network debugging:**
```bash
# Count TCP connections by destination port
sudo bpftrace -e '
kprobe:tcp_connect {
    $sk = (struct sock *)arg0;
    $dport = $sk->__sk_common.skc_dport;
    @connections[bswap16($dport)] = count();
}
END { print(@connections); }'

# TCP retransmit rate
sudo bpftrace -e '
kprobe:tcp_retransmit_skb {
    $sk = (struct sock *)arg0;
    @retransmits[ntop(AF_INET, $sk->__sk_common.skc_daddr)] = count();
}
interval:s:5 {
    print(@retransmits);
    clear(@retransmits);
}'

# TCP receive latency histogram
sudo bpftrace -e '
kprobe:tcp_rcv_established {
    @[comm] = hist(((struct sock *)arg0)->sk_rcvbuf);
}'
```

**Memory debugging:**
```bash
# kmalloc call sites
sudo bpftrace -e '
kprobe:__kmalloc {
    @alloc_sizes = hist(arg0);
    @alloc_callers[ksym(reg("ip"))] = count();
}
END { print(@alloc_sizes); }'

# Slab cache allocations
sudo bpftrace -e '
kprobe:kmem_cache_alloc {
    $cache = (struct kmem_cache *)arg0;
    @[str($cache->name)] = count();
}
END { print(@); }'

# Page fault count by process
sudo bpftrace -e '
kprobe:handle_mm_fault {
    @faults[comm, pid] = count();
}
interval:s:5 {
    print(@faults, 10);
    clear(@faults);
}'
```

**Scheduler debugging:**
```bash
# Run queue latency (time waiting for CPU)
sudo bpftrace -e '
tracepoint:sched:sched_wakeup,
tracepoint:sched:sched_wakeup_new {
    @qtime[args->pid] = nsecs;
}
tracepoint:sched:sched_switch {
    if (@qtime[args->next_pid]) {
        @rq_lat = hist((nsecs - @qtime[args->next_pid]) / 1000);
        delete(@qtime[args->next_pid]);
    }
}
END { print(@rq_lat); }'

# Involuntary context switches
sudo bpftrace -e '
tracepoint:sched:sched_switch {
    if (args->prev_state == 0) {
        @preempted[args->prev_comm] = count();
    }
}
interval:s:5 {
    print(@preempted, 10);
    clear(@preempted);
}'
```

**I/O debugging:**
```bash
# Block I/O latency by device
sudo bpftrace -e '
kprobe:blk_account_io_start {
    @start[arg0] = nsecs;
}
kprobe:blk_account_io_done {
    if (@start[arg0]) {
        @io_lat_us[((struct request *)arg0)->rq_disk->disk_name] =
            hist((nsecs - @start[arg0]) / 1000);
        delete(@start[arg0]);
    }
}
END { print(@io_lat_us); }'

# Slow block I/O (>10ms)
sudo bpftrace -e '
kprobe:blk_account_io_start { @start[arg0] = nsecs; }
kprobe:blk_account_io_done {
    $lat_ms = (nsecs - @start[arg0]) / 1000000;
    if (@start[arg0] && $lat_ms > 10) {
        printf("SLOW IO: dev=%s lat=%dms\n",
            ((struct request *)arg0)->rq_disk->disk_name,
            $lat_ms);
    }
    delete(@start[arg0]);
}'
```

### Full bpftrace Script: System Call Latency

```bash
cat <<'BPFTRACE' > syscall_lat.bt
#!/usr/bin/env bpftrace

// Measure latency for all syscalls, report top 10 slowest

BEGIN {
    printf("Tracing syscall latency for 30 seconds...\n");
}

tracepoint:raw_syscalls:sys_enter {
    @entry[tid] = nsecs;
    @syscall[tid] = args->id;
}

tracepoint:raw_syscalls:sys_exit {
    if (@entry[tid]) {
        $lat_ns = nsecs - @entry[tid];
        @lat[comm, @syscall[tid]] = max($lat_ns);
        @hist[comm, @syscall[tid]] = hist($lat_ns);
        delete(@entry[tid]);
        delete(@syscall[tid]);
    }
}

interval:s:30 {
    print(@lat, 20);
    exit();
}
BPFTRACE

sudo bpftrace syscall_lat.bt
```

## Section 7: Ftrace Integration

ftrace is the kernel's built-in tracing framework. kprobes integrate with ftrace via the tracing events interface.

### Direct ftrace Kprobe Events

```bash
# Set up a kprobe trace event without perf or bpftrace
cd /sys/kernel/debug/tracing

# Create a kprobe event
echo 'p:myprobes/openat2 do_sys_openat2 dfd=%di filename=%si:string' > \
  kprobe_events

# Enable the event
echo 1 > events/myprobes/openat2/enable

# Start tracing
echo 1 > tracing_on

# Read the trace buffer
cat trace

# Or follow in real time
cat trace_pipe &

# Generate activity
ls /etc /proc

# Stop tracing
echo 0 > tracing_on
echo 0 > events/myprobes/openat2/enable

# Remove the probe
echo '-:myprobes/openat2' >> kprobe_events

# Cleanup
kill %1 2>/dev/null
```

### kretprobe via ftrace

```bash
# Return probe with return value
echo 'r:myprobes/openat2_ret do_sys_openat2 retval=$retval' > kprobe_events

# Enable
echo 1 > events/myprobes/openat2_ret/enable
echo 1 > tracing_on

# Run test
cat /etc/hostname

# Read results
cat trace | grep openat2_ret
# Output: ... myprobes/openat2_ret: (do_sys_openat2+0x0 <- vfs_open) retval=0x3

# Cleanup
echo 0 > tracing_on
echo '' > kprobe_events
```

### Function Graph Tracing

```bash
# Trace complete function call graph from do_sys_openat2
echo function_graph > current_tracer
echo do_sys_openat2 > set_graph_function
echo 1 > tracing_on

# Run one open
echo "" > /tmp/test

# Stop
echo 0 > tracing_on
echo nop > current_tracer

# View call graph
cat trace | head -100
# Shows indented call tree with timing
```

## Section 8: Production Safety Considerations

### What Can Go Wrong

```bash
# Unsafe: probing functions on the probe execution path
# This causes infinite recursion and a kernel crash
# DO NOT probe: kprobe_handler, do_int3, die_nmi, etc.

# Safe check: verify the function is not in kprobe blacklist
cat /sys/kernel/debug/kprobes/blacklist | grep your_function

# Unsafe: writing to kernel memory in a probe handler
# Safe: read-only access with proper NULL checks and user-space copy functions

# Check module before loading
sudo modinfo kprobe_example.ko

# Test in a VM first
# Use QEMU with GDB stub for module debugging:
# qemu-system-x86_64 -s -S -kernel bzImage ...
# Then: gdb vmlinux -ex 'target remote :1234'
```

### Performance Impact Measurement

```bash
# Baseline: measure function call rate before probe
perf stat -e cycles,instructions,cache-misses -a -- sleep 5

# With kprobe: repeat measurement
sudo insmod kprobe_example.ko
perf stat -e cycles,instructions,cache-misses -a -- sleep 5
sudo rmmod kprobe_example

# kprobes using ftrace optimization have nearly zero overhead
# when no probe is triggered and ~100ns overhead when triggered

# Check if kprobes are using ftrace optimization
cat /sys/kernel/debug/kprobes/list | grep -i ftrace
# [FTRACE] suffix indicates ftrace-optimized probe (faster)
```

### Disabling a Probe Temporarily

```bash
# Via sysfs
echo 0 > /sys/kernel/debug/kprobes/enabled

# This globally disables all kprobes (emergency only)
# Better: unregister specific probes

# In module code
disable_kprobe(&kp);   // Temporarily disable
enable_kprobe(&kp);    // Re-enable
unregister_kprobe(&kp); // Permanently remove
```

## Section 9: Practical Debugging Scenarios

### Debugging an Intermittent ENOMEM

```bash
# Find where kmalloc is failing
sudo bpftrace -e '
kretprobe:__kmalloc {
    if (retval == 0) {
        printf("kmalloc ENOMEM: size=%d caller=%s comm=%s pid=%d\n",
            @last_size[tid], ksym(@last_caller[tid]), comm, pid);
    }
    delete(@last_size[tid]);
    delete(@last_caller[tid]);
}
kprobe:__kmalloc {
    @last_size[tid] = arg0;
    @last_caller[tid] = reg("ip");
}'
```

### Tracing Lock Contention

```bash
# Find mutex contention hotspots
sudo perf probe --add '__mutex_lock_slowpath owner'
sudo perf record -e probe:__mutex_lock_slowpath -ag -- sleep 30
sudo perf report --stdio --call-graph=graph | head -100
sudo perf probe --del __mutex_lock_slowpath
```

### Investigating Unexpected Reboots

```bash
# Probe kernel panic to capture stack
sudo bpftrace -e '
kprobe:panic {
    printf("PANIC: %s\n", str(arg0));
    printf("Stack:\n");
    print_ustack();
    // This won't actually prevent panic, just logs before it
}'

# Better: use kdump + crash for post-mortem
# Configure kdump:
sudo apt-get install -y kdump-tools crash linux-crashdump
sudo systemctl enable kdump
# After a panic, analyze:
sudo crash /usr/lib/debug/boot/vmlinux-$(uname -r) /var/crash/$(ls -t /var/crash | head -1)/dump.201*
```

kprobes, kretprobes, perf probe, and bpftrace form a complete dynamic tracing toolkit that covers everything from quick one-liners to complex multi-function analysis. The key is picking the right tool for the depth needed: bpftrace for operational queries, perf probe for performance analysis with call graphs, and custom kernel modules only when the higher-level tools can't expose what you need.
