---
title: "Linux Kernel Debugging: KGDB, KDB, and Dynamic Debug for Production Issues"
date: 2031-06-03T00:00:00-05:00
draft: false
tags: ["Linux", "Kernel", "Debugging", "KGDB", "KDB", "lockdep", "RCU"]
categories:
- Linux
- Systems
- Debugging
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-grade guide to Linux kernel debugging covering KGDB remote debugging, KDB built-in debugger commands, dynamic debug for targeted logging, kernel oops analysis, lockdep for deadlock detection, and RCU debugging techniques."
more_link: "yes"
url: "/linux-kernel-debugging-kgdb-kdb-dynamic-debug-guide/"
---

When a kernel module panics, a device driver deadlocks, or a production system starts throwing cryptic oops messages, you need debugger-level visibility into kernel state. Linux provides multiple debugging facilities for different scenarios: KGDB for remote symbolic debugging with gdb, KDB for hands-on local debugging without a second machine, dynamic debug for surgical logging insertion without kernel recompilation, and lockdep for compile-time deadlock detection. This guide covers the complete toolkit with production-ready procedures.

<!--more-->

# Linux Kernel Debugging: KGDB, KDB, and Dynamic Debug for Production Issues

## Section 1: Kernel Debugging Prerequisites

### Verifying Kernel Debug Configuration

Most distribution kernels ship with enough debug infrastructure for common use cases, but some options require custom builds:

```bash
# Check which debug options are compiled in
zcat /proc/config.gz | grep -E "CONFIG_KGDB|CONFIG_KDB|CONFIG_DYNAMIC_DEBUG|CONFIG_LOCKDEP|CONFIG_DEBUG_KERNEL"

# Key options to verify:
# CONFIG_KGDB=y           - KGDB kernel debugger
# CONFIG_KDB=y            - KDB built-in debugger (usually =n in production kernels)
# CONFIG_DYNAMIC_DEBUG=y  - Dynamic debug (in most distro kernels)
# CONFIG_LOCKDEP=y        - Lock dependency checker
# CONFIG_DEBUG_KERNEL=y   - Master debug switch
# CONFIG_FRAME_POINTER=y  - Better stack traces
# CONFIG_KALLSYMS=y       - Symbol resolution (required for oops analysis)
# CONFIG_MAGIC_SYSRQ=y    - SysRq key support (required for KGDB entry)

# Check running kernel config
grep CONFIG_KGDB /boot/config-$(uname -r)
```

### Building a Debug Kernel

For deep debugging, you may need to compile your own kernel:

```bash
# Clone kernel source
git clone https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git
cd linux
git checkout v6.6  # or desired version

# Start from existing config
cp /boot/config-$(uname -r) .config
make olddefconfig

# Enable debugging options
scripts/config --enable CONFIG_KGDB
scripts/config --enable CONFIG_KGDB_SERIAL_CONSOLE
scripts/config --enable CONFIG_KDB
scripts/config --set-val CONFIG_KDB_KEYBOARD y
scripts/config --enable CONFIG_DYNAMIC_DEBUG
scripts/config --enable CONFIG_LOCKDEP
scripts/config --enable CONFIG_PROVE_LOCKING
scripts/config --enable CONFIG_DEBUG_LOCKDEP
scripts/config --enable CONFIG_FRAME_POINTER
scripts/config --disable CONFIG_RANDOMIZE_BASE  # Disable KASLR for debugging

# Build (this takes 30-60 minutes)
make -j$(nproc) bindeb-pkg

# Install
sudo dpkg -i ../linux-image-*.deb ../linux-headers-*.deb
sudo update-grub
```

## Section 2: KGDB Remote Debugging

KGDB (Kernel GNU Debugger) allows you to debug a running Linux kernel from a second machine using the standard GNU debugger (gdb). The two systems communicate via a serial line or network socket.

### KGDB Architecture

```
[Target Machine]                    [Debug Machine]
 Linux kernel                        gdb client
 with KGDB stub  ←— serial/network —→  + vmlinux
       ↓                                    ↓
  Receives gdb       Sends commands,   Displays source,
  protocol msgs      reads registers   sets breakpoints
```

### Setting Up Serial-Based KGDB

**Target machine configuration** (add to kernel command line in grub):

```bash
# /etc/default/grub
GRUB_CMDLINE_LINUX="kgdboc=ttyS0,115200 kgdbwait"
# kgdboc: KGDB over console (serial port, baud rate)
# kgdbwait: halt at boot and wait for debugger connection

# For a VM using a virtual serial port:
GRUB_CMDLINE_LINUX="kgdboc=ttyS0,115200"

# Update grub
update-grub
```

**Trigger KGDB entry without reboot** (on target machine):

```bash
# Method 1: SysRq key (requires CONFIG_MAGIC_SYSRQ=y)
echo g > /proc/sysrq-trigger

# Method 2: Panic trigger (for testing panic handler behavior)
# WARNING: causes a kernel panic
echo c > /proc/sysrq-trigger

# Method 3: From kernel code (in a module)
# kgdb_breakpoint();
```

### Connecting gdb to the Target

```bash
# On the debug machine, with the target paused at KGDB:

# Start gdb with the kernel's vmlinux (must match target kernel exactly)
gdb vmlinux

# Connect to target via serial
(gdb) set remotebaud 115200
(gdb) target remote /dev/ttyUSB0

# Or via network (if using kgdboe - KGDB over Ethernet):
(gdb) target remote :1234  # kgdboe default port

# You should see: Remote debugging from host...
# Target is now stopped at the KGDB entry point
```

### Core gdb Commands for Kernel Debugging

```gdb
# Print kernel version and build info
(gdb) p linux_banner

# Get current task information
(gdb) p *current_task
(gdb) p current_task->comm    # Process name
(gdb) p current_task->pid     # PID

# Examine the call stack
(gdb) bt
# #0  kgdb_handle_exception (...)
# #1  kgdb_ll_trap (...)
# #2  do_debug (...)
# ...

# Set a breakpoint in the kernel
(gdb) b sys_open
(gdb) b ext4_file_open

# Continue execution
(gdb) c

# Step over a line
(gdb) n

# Step into a function
(gdb) s

# Print a struct
(gdb) p *(struct task_struct *)current
(gdb) p *(struct super_block *)sb

# Print memory
(gdb) x/10gx 0xffffffff81234567  # 10 quad-words in hex

# Print linked list (requires lx-dmesg from gdb scripts)
# Load helper scripts from kernel source
(gdb) source /path/to/linux/scripts/gdb/vmlinux-gdb.py
(gdb) lx-dmesg   # Print kernel log
(gdb) lx-ps      # List processes
(gdb) lx-mounts  # List mounts

# Examine kernel symbols
(gdb) info symbol 0xffffffff81234567

# Watchpoint: break when memory is written
(gdb) watch *(int *)0xffffffff81234abc

# Print all kernel modules
(gdb) lx-lsmod
```

### KGDB over Network (kgdboe)

```bash
# Load kgdboe module on target
modprobe kgdboe kgdboe=@/eth0,@<debug-machine-ip>/

# On debug machine, use udp for kgdboe
(gdb) target remote udp:<target-ip>:31337
```

## Section 3: KDB - The Built-in Kernel Debugger

KDB is a simpler debugger that runs inside the kernel without requiring a second machine. It is accessible via the system console or keyboard and is excellent for quick diagnostics.

### Entering KDB

```bash
# Method 1: SysRq + g (requires CONFIG_MAGIC_SYSRQ)
# Press Alt+SysRq+g on the physical console
# Or:
echo g > /proc/sysrq-trigger

# Method 2: Panic handler (system enters KDB on panic if configured)
# Kernel command line: kgdb_notifier=on

# KDB prompt appears:
# Entering kdb (current=0xffff..., pid 1234) on processor 0 due to Keyboard Entry
# [0]kdb>
```

### Essential KDB Commands

```
# Help
[0]kdb> help
[0]kdb> ?

# System information
[0]kdb> ps              # List running processes
[0]kdb> ps A            # List ALL processes including sleeping
[0]kdb> cpu             # Show CPU info
[0]kdb> dmesg           # Print kernel log buffer
[0]kdb> version         # Kernel version

# Stack traces
[0]kdb> bt              # Backtrace for current process
[0]kdb> bt <pid>        # Backtrace for specific PID
[0]kdb> bta             # Backtrace ALL threads (very verbose)

# Memory examination
[0]kdb> md 0xffffffff81234567 8   # Display 8 words at address
[0]kdb> mdp <ptr> 20              # Display 20 bytes pointed to by ptr
[0]kdb> mds 0xffffffff81234567    # Display as struct

# Memory modification (use with extreme caution in production)
[0]kdb> mm 0xffffffff81234567 0x0  # Write 0 to address

# Registers
[0]kdb> rd              # Display registers

# Breakpoints
[0]kdb> bp sys_open           # Set breakpoint on symbol
[0]kdb> bp 0xffffffff81234567 # Set breakpoint on address
[0]kdb> bl                    # List breakpoints
[0]kdb> bc 1                  # Clear breakpoint 1

# Module information
[0]kdb> lsmod             # List loaded modules
[0]kdb> modinfo <module>  # Module details

# Search memory for pattern
[0]kdb> sr                # Search registers for value

# Continue execution
[0]kdb> go                # Continue running
[0]kdb> ss                # Single step

# Switch CPU context
[0]kdb> cpu 2             # Switch to CPU 2's context
[0]kdb> cpu               # Show which CPU you're on
```

### Practical KDB Investigation

```bash
# Scenario: investigating a hung task
[0]kdb> ps A | grep D    # Find tasks in D state (uninterruptible sleep)

# Get stack trace for the hung task (PID 4321)
[0]kdb> bt 4321
# [<ffffffff8141a5e3>] __down_read+0x33/0x130
# [<ffffffff81234abc>] ext4_file_read_iter+0x5c/0x90
# [<ffffffff81283210>] vfs_read+0x110/0x1a0
# This shows the task is stuck waiting on a read-write semaphore

# Examine the semaphore
[0]kdb> md 0xffff888012345678 4
# Shows the semaphore owner info

# Look at system memory
[0]kdb> md 0xffffffff82000000 32  # Examine kernel data segment
```

## Section 4: Dynamic Debug

Dynamic debug (dyndbg) allows you to enable or disable specific `pr_debug()` and `dev_dbg()` messages in the kernel and modules at runtime without recompilation. This is the safest debugging tool for production systems.

### Basic dyndbg Usage

```bash
# Check if dynamic debug is available
ls /sys/kernel/debug/dynamic_debug/
# control  (the control file)

# List all available debug points
cat /sys/kernel/debug/dynamic_debug/control | head -20
# format:
# <module>:<filename>:<line>:<function> <flags> <format>

# Count total debug points
wc -l /sys/kernel/debug/dynamic_debug/control

# Enable debug for a specific module
echo "module ext4 +p" > /sys/kernel/debug/dynamic_debug/control

# Enable debug for a specific file
echo "file drivers/net/ethernet/intel/igb/igb_main.c +p" > /sys/kernel/debug/dynamic_debug/control

# Enable debug for a specific function
echo "func ext4_write_begin +p" > /sys/kernel/debug/dynamic_debug/control

# Enable debug for a specific line
echo "file fs/ext4/file.c line 120-135 +p" > /sys/kernel/debug/dynamic_debug/control

# Enable with stack trace (+s) and line info (+l)
echo "module nfs +psl" > /sys/kernel/debug/dynamic_debug/control

# Disable debug messages
echo "module ext4 -p" > /sys/kernel/debug/dynamic_debug/control

# Watch the messages
dmesg -w | grep ext4_write_begin
```

### dyndbg Flags

```
p - print (emit the debug message)
f - print function name
l - print line number
m - print module name
t - print thread ID
s - print stack trace
_ - no flags (clear all)
```

### Boot-Time Dynamic Debug

Enable debug messages before they would normally be available:

```bash
# Add to kernel command line in grub
GRUB_CMDLINE_LINUX="dyndbg='module mymodule +p'"

# Multiple rules
GRUB_CMDLINE_LINUX="dyndbg='module drm +p; module i915 +p'"
```

### Adding dyndbg to Your Module

```c
/* my_driver.c */
#define pr_fmt(fmt) KBUILD_MODNAME ": " fmt

#include <linux/module.h>
#include <linux/printk.h>
#include <linux/dynamic_debug.h>

static int my_probe(struct platform_device *pdev)
{
    /* These messages are controlled by dyndbg */
    pr_debug("Probing device %s\n", dev_name(&pdev->dev));

    /* dev_dbg is the device-aware variant */
    dev_dbg(&pdev->dev, "Hardware version: 0x%x\n", read_hw_version());

    return 0;
}

static void my_transfer(struct my_device *dev, size_t len)
{
    pr_debug("Starting transfer: len=%zu\n", len);
    /* ... transfer code ... */
    pr_debug("Transfer complete: %zu bytes\n", len);
}
```

### Practical dyndbg Workflow

```bash
# Scenario: debugging NFS mount failures

# Step 1: Enable NFS client debug
echo "module nfs +p" > /sys/kernel/debug/dynamic_debug/control
echo "module nfsv4 +p" > /sys/kernel/debug/dynamic_debug/control

# Step 2: Capture messages
dmesg -w > /tmp/nfs-debug.log 2>&1 &
DMESG_PID=$!

# Step 3: Reproduce the issue
mount -t nfs4 192.168.1.1:/export /mnt/nfs

# Step 4: Stop capture and analyze
kill $DMESG_PID
grep -E "error|fail|WARN" /tmp/nfs-debug.log

# Step 5: Disable debug when done
echo "module nfs -p" > /sys/kernel/debug/dynamic_debug/control
echo "module nfsv4 -p" > /sys/kernel/debug/dynamic_debug/control
```

## Section 5: Kernel Oops Analysis

A kernel oops is an error condition that the kernel can usually recover from (unlike a panic). Understanding oops output is a critical skill.

### Reading an Oops Message

```
[12345.678901] BUG: unable to handle kernel NULL pointer dereference at 0000000000000010
[12345.678902] #PF: supervisor read access in kernel mode
[12345.678903] #PF: error_code(0x0000) - not-present page
[12345.678904] PGD 0 P4D 0
[12345.678905] Oops: 0000 [#1] SMP PTI
[12345.678906] CPU: 3 PID: 1234 Comm: my_daemon Tainted: G OE  5.15.0-91-generic #101-Ubuntu
[12345.678907] Hardware name: Dell Inc. PowerEdge R740/0H21J3, BIOS 2.9.4 01/09/2020
[12345.678908] RIP: 0010:my_module_read+0x4c/0x90 [my_module]
[12345.678909] Code: 41 54 55 48 89 fd 53 ...
[12345.678910] RSP: 0018:ffffc90001234ab0 EFLAGS: 00010286
[12345.678911] RAX: 0000000000000000 RBX: ffff888012345678 RCX: 0000000000000000
[12345.678912] RDX: 0000000000000000 RSI: 00007f1234567890 RDI: ffff888098765432
[12345.678913] ...
[12345.678914] Call Trace:
[12345.678915]  <TASK>
[12345.678916]  vfs_read+0xc1/0x1d0
[12345.678917]  ksys_read+0x5b/0xd0
[12345.678918]  __x64_sys_read+0x1a/0x20
[12345.678919]  do_syscall_64+0x5b/0xc0
[12345.678920]  entry_SYSCALL_64_after_hwframe+0x44/0xae
```

### Decoding an Oops with addr2line

```bash
# Decode the RIP address to find the exact source line
# First, locate the vmlinux or the module's .ko file

# For a kernel symbol
addr2line -e /usr/lib/debug/lib/modules/$(uname -r)/vmlinux \
    ffffffff81234abc

# For a module symbol - need the .ko file with debug symbols
# Extract the offset from the oops: my_module_read+0x4c
objdump -dS my_module.ko | grep -A5 "<my_module_read>"
# Then find the instruction at offset 0x4c

# Or use gdb with vmlinux
gdb vmlinux
(gdb) list *(my_module_read+0x4c)

# decode_stacktrace.sh from kernel tools
./scripts/decode_stacktrace.sh vmlinux . < oops.txt
```

### Using faddr2line for Module Symbols

```bash
# faddr2line is the recommended tool for module function+offset
scripts/faddr2line my_module.ko my_module_read+0x4c

# Output:
# my_module_read (include/linux/compiler.h:88)
# <- drivers/my_module/driver.c:145
```

### Automated Oops Analysis with oops-analyzer

```bash
# Install crash utility for kernel crash dump analysis
apt-get install crash

# Analyze a vmcore dump
crash /usr/lib/debug/lib/modules/$(uname -r)/vmlinux /var/crash/vmcore

crash> bt                  # Backtrace at time of crash
crash> ps                  # Process list at time of crash
crash> log                 # Kernel message log
crash> mod                 # Module list
crash> files <pid>         # Open files for a process
crash> vm <pid>            # Virtual memory for a process
crash> irq                 # IRQ state
```

## Section 6: lockdep - Lock Dependency Checker

lockdep validates locking order at runtime and detects potential deadlocks before they occur. It works by building a directed graph of lock acquisition sequences and detecting cycles.

### Enabling lockdep

```bash
# Verify lockdep is compiled in
grep CONFIG_PROVE_LOCKING /boot/config-$(uname -r)
# CONFIG_PROVE_LOCKING=y

# lockdep is active by default when CONFIG_PROVE_LOCKING=y
# Check lockdep stats
cat /proc/lock_stat

# Lock statistics
# class name    con-bounces    contentions   waittime-min   waittime-max
# &mm->mmap_lock-W:              0              1         0.00ns      99.00ns
```

### Reading a lockdep Warning

```
======================================================
WARNING: possible circular locking dependency detected
5.15.0 #1 Not tainted
------------------------------------------------------
worker_thread/1234 is trying to acquire lock:
ffffffff82345678 (rcu_read_lock){....}-{1:2}, at: some_function+0x42/0x90

but task is already holding lock:
ffffffff81234567 (my_mutex){+.+.}-{3:3}, at: my_function+0x12/0x50

which lock already depends on the new lock.

the existing dependency chain (in reverse order) is:

-> #1 (my_mutex){+.+.}-{3:3}:
       mutex_lock_nested+0x45/0x100
       some_function+0x42/0x90

-> #0 (rcu_read_lock){....}-{1:2}:
       rcu_read_lock+0x11/0x30
       my_function+0x12/0x50

other info that might help us debug this:
 Possible unsafe locking scenario:

       CPU0                    CPU1
       ----                    ----
  lock(my_mutex);
                               lock(rcu_read_lock);
                               lock(my_mutex);
  lock(rcu_read_lock);
```

### Fixing lockdep Violations

```c
/* Problem: lock A -> lock B in one code path,
   but lock B -> lock A in another */

/* Wrong: creates ABBA deadlock potential */
static void path_one(void)
{
    mutex_lock(&lock_a);
    mutex_lock(&lock_b);  /* lockdep warns: B after A */
    /* ... */
    mutex_unlock(&lock_b);
    mutex_unlock(&lock_a);
}

static void path_two(void)
{
    mutex_lock(&lock_b);
    mutex_lock(&lock_a);  /* lockdep warns: A after B */
    /* ... */
    mutex_unlock(&lock_a);
    mutex_unlock(&lock_b);
}

/* Fix: establish consistent lock ordering */
static void path_one_fixed(void)
{
    mutex_lock(&lock_a);  /* Always: A before B */
    mutex_lock(&lock_b);
    mutex_unlock(&lock_b);
    mutex_unlock(&lock_a);
}

static void path_two_fixed(void)
{
    mutex_lock(&lock_a);  /* Always: A before B */
    mutex_lock(&lock_b);
    mutex_unlock(&lock_b);
    mutex_unlock(&lock_a);
}
```

### Lock Class Annotations

```c
#include <linux/lockdep.h>

/* Annotate lock subclasses for legitimate nested same-lock acquisitions */
static struct mutex parent_lock;
static struct mutex child_lock;

/* Use lockdep_set_class to distinguish locks of the same type */
LOCKDEP_KEYS(lock_key, 2);  /* Two subclasses: parent and child */

void init_locks(void)
{
    mutex_init(&parent_lock);
    mutex_init(&child_lock);
    lockdep_set_class_and_subclass(&parent_lock, &lock_key, 0);
    lockdep_set_class_and_subclass(&child_lock, &lock_key, 1);
}

void nested_acquire(void)
{
    /* This is valid: child_lock always acquired after parent_lock */
    mutex_lock(&parent_lock);
    mutex_lock_nested(&child_lock, SINGLE_DEPTH_NESTING);
    mutex_unlock(&child_lock);
    mutex_unlock(&parent_lock);
}
```

## Section 7: RCU Debugging

RCU (Read-Copy-Update) is a synchronization mechanism that allows reads to proceed without locks. Incorrect RCU usage can cause use-after-free bugs or data corruption that is difficult to reproduce.

### Common RCU Bugs

```c
/* Bug 1: Accessing RCU-protected data outside of read-side critical section */
struct rcu_data {
    int value;
    struct rcu_head rcu;
};

static struct rcu_data __rcu *global_data;

/* WRONG: no rcu_read_lock */
int bad_reader(void)
{
    struct rcu_data *data = rcu_dereference(global_data); /* lockdep warns */
    return data->value;  /* data may be freed concurrently */
}

/* CORRECT */
int good_reader(void)
{
    struct rcu_data *data;
    int val;

    rcu_read_lock();
    data = rcu_dereference(global_data);
    if (data)
        val = data->value;
    else
        val = -ENODATA;
    rcu_read_unlock();
    return val;
}

/* Bug 2: Sleeping inside RCU read-side critical section */
int bad_sleeping_reader(void)
{
    rcu_read_lock();
    struct rcu_data *data = rcu_dereference(global_data);
    msleep(100);  /* WRONG: may sleep inside RCU read-side section */
    rcu_read_unlock();
    return 0;
}
```

### RCU Debugging Tools

```bash
# Enable RCU debug checking
# Kernel command line: rcupdate.rcu_self_test=1

# Check RCU state
cat /sys/kernel/debug/rcu/

# rcu_bh, rcu_sched, rcu_tasks_* directories

# Force RCU callbacks to run (useful in testing)
echo 1 > /sys/kernel/debug/rcu_expedited

# Check for stalled RCU grace periods
dmesg | grep "RCU Stall"
# RCU: INFO: rcu_sched self-detected stall on CPU
# This indicates a CPU is not passing through quiescent states

# CONFIG_RCU_STALL_COMMON=y (default in most kernels)
# RCU will print warnings if a grace period takes too long
```

### CONFIG_PROVE_RCU

```bash
# With CONFIG_PROVE_RCU=y, the kernel checks:
# - rcu_dereference() called outside rcu_read_lock()
# - rcu_dereference_protected() called without the expected lock held
# - Sleeping inside RCU read-side critical sections

# This will produce a warning like:
# WARNING: suspicious RCU usage
# drivers/my_module/driver.c:123: suspicious rcu_dereference_check() usage!
#
# other info that might help us debug this:
#
# RCU used illegally from softirq context!
# Call Trace:
#  dump_stack+0x5f/0x7c
#  lockdep_rcu_suspicious+0xd1/0xf8
#  my_driver_read+0x4c/0x90 [my_module]
```

## Section 8: Memory Debugging

### KASAN (Kernel Address Sanitizer)

KASAN detects use-after-free and out-of-bounds memory accesses:

```bash
# Enable in kernel config
# CONFIG_KASAN=y
# CONFIG_KASAN_INLINE=y  (faster, larger kernel)

# KASAN report example:
# ==================================================================
# BUG: KASAN: slab-out-of-bounds in my_function+0x4c/0x90
# Write of size 4 at addr ffff888012345678 by task my_daemon/1234
#
# CPU: 2 PID: 1234 Comm: my_daemon
# Call Trace:
#  kasan_report+0x3e/0x50
#  my_function+0x4c/0x90 [my_module]
#  ...
#
# Allocated by task 1234:
#  kmalloc+0x24/0x100
#  my_alloc+0x20/0x40 [my_module]
# ==================================================================
```

### KMSAN (Kernel Memory Sanitizer)

KMSAN detects uses of uninitialized memory:

```bash
# Enable: CONFIG_KMSAN=y
# Much slower than KASAN, use only during development

# Example report:
# BUG: KMSAN: uninit-value in my_function+0x12/0x30
# at: local variable of type 'int' allocated at:
#   my_function+0x0/0x30
```

## Section 9: ftrace for Function Tracing

ftrace provides function-level tracing without requiring a full debugger session:

```bash
# Mount debugfs if not mounted
mount -t debugfs none /sys/kernel/debug

# List available tracers
cat /sys/kernel/debug/tracing/available_tracers
# blk  function_graph  wakeup_dl  wakeup_rt  wakeup  function  nop

# Enable function tracer
echo function > /sys/kernel/debug/tracing/current_tracer

# Trace a specific function
echo ext4_file_write_iter > /sys/kernel/debug/tracing/set_ftrace_filter

# Enable tracing
echo 1 > /sys/kernel/debug/tracing/tracing_on

# ... reproduce the issue ...

# Disable tracing
echo 0 > /sys/kernel/debug/tracing/tracing_on

# Read trace output
cat /sys/kernel/debug/tracing/trace | head -50

# Function graph tracer (shows call depth and duration)
echo function_graph > /sys/kernel/debug/tracing/current_tracer
echo ext4_file_write_iter > /sys/kernel/debug/tracing/set_graph_function
echo 1 > /sys/kernel/debug/tracing/tracing_on
# ... reproduce ...
cat /sys/kernel/debug/tracing/trace
#  0)               |  ext4_file_write_iter() {
#  0)               |    ext4_write_checks() {
#  0)   1.234 us    |      ext4_inode_journal_mode();
#  0)   2.345 us    |    }
#  0)   3.456 us    |  }
```

### Tracing Specific Events

```bash
# List available events
cat /sys/kernel/debug/tracing/available_events | grep ext4

# Enable specific events
echo ext4:ext4_write_begin > /sys/kernel/debug/tracing/set_event
echo ext4:ext4_write_end >> /sys/kernel/debug/tracing/set_event

# Trace with filter (only events from a specific process)
echo "pid == 1234" > /sys/kernel/debug/tracing/events/ext4/ext4_write_begin/filter

echo 1 > /sys/kernel/debug/tracing/tracing_on
# ... reproduce ...
echo 0 > /sys/kernel/debug/tracing/tracing_on
cat /sys/kernel/debug/tracing/trace
```

## Section 10: Production Debugging Checklist

### When a System Shows Symptoms

```bash
#!/bin/bash
# kernel-debug-triage.sh - First response for kernel issues

echo "=== Kernel Debug Triage ==="
date

echo "--- Kernel Version ---"
uname -a

echo "--- Recent Kernel Messages ---"
dmesg -T | tail -100

echo "--- OOM/Panic in last 24h ---"
dmesg -T | grep -E "Out of memory|Killed process|BUG:|WARN:|RIP:|Call Trace" | head -50

echo "--- Load Average ---"
uptime

echo "--- Memory Pressure ---"
cat /proc/meminfo | grep -E "MemTotal|MemFree|Cached|SwapFree|Dirty"

echo "--- Hung Tasks ---"
cat /proc/sysrq-trigger  # Read current tasks in D state
ps aux | awk '$8=="D" {print $0}'

echo "--- Lockdep Violations ---"
cat /proc/lockdep_stats

echo "--- RCU Stalls ---"
dmesg | grep "RCU"

echo "--- Module Issues ---"
lsmod | head -20
dmesg | grep -i "module\|driver" | grep -iE "error|fail" | head -20

echo "--- Filesystem Errors ---"
dmesg | grep -iE "EXT4|XFS|BTRFS" | grep -iE "error|corrupt|failed" | head -20
```

## Conclusion

Kernel debugging requires the right tool for each scenario. Dynamic debug is the safest production option: it can be enabled and disabled at runtime without side effects. For investigating live deadlocks or hanging systems, KDB provides immediate access without external infrastructure. For systematic debugging of kernel modules during development, KGDB with gdb gives you full symbolic debugging capabilities. lockdep and KASAN should be enabled in all development and testing kernels to catch locking violations and memory errors before they reach production. When investigating production oops reports, the combination of addr2line/faddr2line, the crash utility, and ftrace provides the complete picture needed to understand and fix the root cause.
