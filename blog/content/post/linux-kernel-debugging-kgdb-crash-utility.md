---
title: "Linux Kernel Debugging: KGDB, crash-utility, and Kernel Crash Dump Analysis"
date: 2030-02-05T00:00:00-05:00
draft: false
tags: ["Linux", "Kernel", "Debugging", "KGDB", "crash-utility", "kdump", "ftrace", "vmcore"]
categories: ["Linux", "Systems Administration"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production kernel debugging techniques covering kdump crash dump collection, crash-utility vmcore analysis, kgdb remote debugging setup, and ftrace for kernel function tracing on enterprise Linux systems."
more_link: "yes"
url: "/linux-kernel-debugging-kgdb-crash-utility/"
---

Kernel panics and system hangs in production are among the most high-pressure incidents a systems engineer faces. Unlike application crashes with stack traces and logs, kernel-level failures often leave only a vmcore dump and a terse panic message. The ability to systematically analyze these artifacts — to understand exactly what sequence of events led to a NULL pointer dereference in interrupt context or a deadlock in a filesystem driver — separates engineers who can prevent recurrence from those who can only hope the problem does not repeat.

This guide covers the complete toolkit for kernel debugging on production Linux systems: setting up kdump for crash dump collection, analyzing vmcore files with the crash utility, setting up KGDB for interactive kernel debugging, and using ftrace to trace kernel function execution in live systems.

<!--more-->

## Kernel Crash Dump Infrastructure with kdump

kdump uses the Linux kexec mechanism to boot a secondary "capture kernel" immediately after a kernel panic. The capture kernel runs in a small reserved memory region that was not touched by the crashed kernel, allowing it to read the crashed kernel's memory and write it to disk.

### Installing and Configuring kdump

```bash
# RHEL/CentOS/Fedora
dnf install kexec-tools crash kernel-debuginfo

# Ubuntu/Debian
apt-get install kdump-tools crash linux-crashdump

# Verify kdump service
systemctl status kdump

# Check if kdump is active
kdumpctl status
```

### GRUB Configuration for kdump

The crashkernel boot parameter reserves memory for the capture kernel. The correct value depends on system RAM:

```bash
# /etc/default/grub
# For systems with > 8GB RAM, use auto:
GRUB_CMDLINE_LINUX="crashkernel=auto quiet"

# For precise control (reserve 512M starting at 16M):
GRUB_CMDLINE_LINUX="crashkernel=512M@16M quiet"

# For systems with large amounts of RAM (>64GB), use range syntax:
GRUB_CMDLINE_LINUX="crashkernel=4G-64G:512M,64G-1T:1G quiet"

# Apply GRUB changes
grub2-mkconfig -o /boot/grub2/grub.cfg

# Reboot to apply
reboot
```

### kdump Configuration File

```bash
# /etc/kdump.conf

# Dump target: local disk (recommended for production)
path /var/crash

# Or NFS target for remote storage (useful when local disk is full)
# net nfs-server.internal:/exports/crash

# Or SSH target
# ssh user@dump-server.internal

# Compression: use lz4 for fast compression or zstd for best ratio
core_collector makedumpfile -l --message-level 1 -d 31

# Compression with zstd (makedumpfile 1.7.0+)
# core_collector makedumpfile -Z --message-level 1 -d 31

# What to capture:
# -d 31 = skip zero pages + free pages + user data + hwpoison pages + cache pages
# -d 0  = capture everything (very large dumps)
# -d 17 = skip zero pages only (smaller but still large)

# Failure action if dump cannot be written
failure_action shell

# Default action after dump is written
default_action reboot

# Keep 3 crash dumps before rotating
extra_bins /sbin/ip
extra_modules ata_piix
```

### Testing kdump

```bash
# Test that kdump is properly configured
kdumpctl show-config

# Verify kdump is loaded (shows reserved memory)
cat /proc/iomem | grep "Crash kernel"
# d0000000-dfffffff : Crash kernel

# Trigger a test crash (WARNING: crashes the system immediately)
# Only do this in a test environment!
echo c > /proc/sysrq-trigger

# After reboot, verify the dump was created
ls -la /var/crash/
# drwxr-x--- 2 root root 4096 Feb  5 10:30 2030-02-05-10:30:15
ls -la /var/crash/2030-02-05-10:30:15/
# -rw------- 1 root root  156K vmcore-dmesg.txt
# -rw------- 1 root root  3.2G vmcore
```

### Automated Dump Processing with makedumpfile

```bash
#!/bin/bash
# /usr/local/bin/process-crash-dump.sh
# Called by kdump after dump collection

set -euo pipefail

DUMP_DIR="$1"
CRASH_DATE=$(date +%Y%m%d_%H%M%S)
HOSTNAME=$(hostname -s)
DEST_DIR="/var/crash/${HOSTNAME}_${CRASH_DATE}"
NFS_DEST="nfs-server.internal:/exports/crash/${HOSTNAME}_${CRASH_DATE}"

mkdir -p "${DEST_DIR}"

# Extract the panic message immediately
makedumpfile \
  --dump-dmesg \
  "${DUMP_DIR}/vmcore" \
  "${DEST_DIR}/dmesg.txt"

# Generate compressed dump with symbol resolution
makedumpfile \
  -c \
  --message-level 1 \
  -d 31 \
  "${DUMP_DIR}/vmcore" \
  "${DEST_DIR}/vmcore.compressed"

# Extract basic crash info for PagerDuty alert
PANIC_MSG=$(grep "Kernel panic\|BUG:\|OOPS:" "${DEST_DIR}/dmesg.txt" | head -5)
KERNEL_VER=$(cat "${DEST_DIR}/dmesg.txt" | grep "Linux version" | head -1)

# Send alert (example using curl to alerting system)
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d "{
    \"hostname\": \"${HOSTNAME}\",
    \"kernel\": \"${KERNEL_VER}\",
    \"panic\": \"${PANIC_MSG}\",
    \"dump_path\": \"${DEST_DIR}\"
  }" \
  "https://alerting.internal/api/v1/kernel-panic"

echo "Crash dump processed: ${DEST_DIR}"
```

## Analyzing vmcore with crash-utility

The crash utility is the standard tool for post-mortem kernel dump analysis. It provides a GDB-like interface for examining kernel data structures.

### Basic crash Invocation

```bash
# Basic invocation with vmcore and matching vmlinux
crash \
  /usr/lib/debug/lib/modules/$(uname -r)/vmlinux \
  /var/crash/2030-02-05-10:30:15/vmcore

# Or with package-provided debug symbols
crash \
  /usr/lib/debug/vmlinux-$(uname -r) \
  /var/crash/latest/vmcore

# crash prompt
crash>
```

### Essential crash Commands

```bash
# Show the panic message and stack trace
crash> bt
PID: 1234   TASK: ffff8881234abcd0  CPU: 3   COMMAND: "kworker/u8:3"
 #0 [ffffc90000987d80] machine_kexec at ffffffff81063a4b
 #1 [ffffc90000987dd8] __crash_kexec at ffffffff811a8c2d
 #2 [ffffc90000987ea0] crash_kexec at ffffffff811a9d93
 #3 [ffffc90000987eb8] oops_end at ffffffff81030d2b
 #4 [ffffc90000987ee0] no_context at ffffffff81077b29
 #5 [ffffc90000987f30] __bad_area_nosemaphore at ffffffff81077d4d
 #6 [ffffc90000987f80] do_page_fault at ffffffff81078b2b
 #7 [ffffc90000987fc0] page_fault at ffffffff81a01788
    [exception RIP: my_driver_read+0x47]
    RIP: ffffffffc05d1047  RSP: ffffc90000987f78  RFLAGS: 00010202
    RAX: 0000000000000000  RBX: ffff888112345678  RCX: 0000000000000001
    RDX: 0000000000000000  RSI: 00007fff56789abc  RDI: ffff888112345678
    CS: 0010  SS: 0018
 #8 [ffffc90000987fb0] vfs_read at ffffffff8128a3f4
 #9 [ffffc90000987fe8] ksys_read at ffffffff8128a8d2

# Display all CPUs' stack traces
crash> bt -a

# Show system information
crash> sys
      KERNEL: /usr/lib/debug/vmlinux-6.1.0
   DUMPFILE: /var/crash/2030-02-05-10:30:15/vmcore
       CPUS: 16
       DATE: Wed Feb  5 10:30:12 UTC 2030
     UPTIME: 47 days, 03:22:15
LOAD AVERAGE: 4.23, 4.18, 3.99
       TASKS: 847
    NODENAME: prod-node-42
     RELEASE: 6.1.0-28-amd64
     VERSION: #1 SMP PREEMPT_DYNAMIC Debian 6.1.99-1 (2024-07-15)
     MACHINE: x86_64  (3400 Mhz)
      MEMORY: 128 GB

# Show kernel log buffer (dmesg equivalent)
crash> log
[  0.000000] Linux version 6.1.0-28-amd64
...
[4066234.123456] BUG: kernel NULL pointer dereference, address: 0000000000000000
[4066234.123457] #PF: supervisor write access in kernel mode
[4066234.123458] #PF: error_code(0x0002) - not-present page
[4066234.123459] Oops: 0002 [#1] SMP NOPTI

# Show process list
crash> ps
   PID    PPID  CPU       TASK        ST  %MEM     VSZ    RSS  COMM
      0      0   0  ffffffff82412740  RU   0.0       0      0  [swapper/0]
   1234   5678   3  ffff8881234abcd0  UN   0.1  123456  65432  my-service
...

# Show tasks in UN (uninterruptible) state (common cause of system hangs)
crash> ps | grep UN

# Examine a specific task
crash> task ffff8881234abcd0
struct task_struct {
  state = 2,   # 2 = TASK_UNINTERRUPTIBLE
  stack = 0xffffc90000984000,
  ...
}

# Show virtual memory mappings for a process
crash> vm ffff8881234abcd0
PID: 1234  TASK: ffff8881234abcd0  CPU: 3   COMMAND: "my-service"
       MM              PGD          RSS    TOTAL_VM
ffff888089abcde0  ffff888056789000 65432k  3456789k
      VMA           START       END     FLAGS FILE
ffff888012345000 400000    500000 8000875 /usr/bin/my-service
...

# Show network connections
crash> net
SOCKET       SOCK       FAMILY:TYPE SOURCE-PORT   DESTINATION-PORT
ffff8880...  ffff8880...  AF_INET:STREAM  0.0.0.0:8080  0.0.0.0:0
```

### Examining Kernel Data Structures

```bash
# Display a struct by type and address
crash> struct task_struct ffff8881234abcd0
struct task_struct {
  thread_info = {
    flags = 2147483648,
    ...
  },
  state = 2,
  ...
}

# Display just specific fields
crash> struct task_struct.comm,pid ffff8881234abcd0
  comm = "my-driver-worker\000"
  pid = 1234

# Follow pointers in data structures
crash> struct inode ffff888056789abc
struct inode {
  i_mode = 33188,
  i_uid = {val = 1000},
  i_gid = {val = 1000},
  i_size = 0,
  ...
}

# Print kernel symbol value
crash> p jiffies
jiffies = $1 = 4066234123

# Examine memory at an address
crash> rd ffff888112345678 16
ffff888112345678:  0000000000000000 dead000000000100   ................
ffff888112345688:  dead000000000200 ffff888012345678   ........xV4.....
# dead000000000100 and dead000000000200 are kernel poison values
# indicating use-after-free

# Search for a pattern in kernel memory
crash> search ffff888000000000 0xdeadbeef
ffff888012345678: deadbeef

# List tasks blocking on a mutex
crash> mutex 0xffffffffc05d2080
crash> waitq 0xffffffffc05d2088
```

### Analyzing a NULL Pointer Dereference

```bash
# From the panic message, we know:
# exception RIP: my_driver_read+0x47
# This means the crash is at offset 0x47 in my_driver_read()

# Load the module's debug symbols if they're separate
crash> mod -s my_driver /usr/lib/debug/lib/modules/6.1.0/kernel/drivers/my_driver.ko

# Disassemble the function around the crash point
crash> dis my_driver_read
0xffffffffc05d1000 <my_driver_read>:    push   %rbp
0xffffffffc05d1001 <my_driver_read+1>:  mov    %rsp,%rbp
0xffffffffc05d1004 <my_driver_read+4>:  push   %r15
...
0xffffffffc05d1047 <my_driver_read+71>: mov    0x10(%rax),%rdx  # CRASH HERE
# rax is 0x0 (NULL), attempting to read offset 0x10 from NULL

# From the bt output, RBX = ffff888112345678 (the file structure?)
crash> struct file ffff888112345678
struct file {
  f_path = {
    mnt = 0xffff888023456789,
    dentry = 0xffff888034567890
  },
  f_inode = 0xffff888045678901,
  f_op = 0x0,  # THIS IS NULL - the file operations pointer is NULL
  ...
}
# Root cause: f_op (file operations struct pointer) is NULL
# The driver is not properly initializing f_op when opening the device
```

## KGDB: Interactive Kernel Debugging

KGDB allows you to debug a live kernel with GDB over a serial or network connection. This is particularly useful for debugging kernel modules during development.

### Setting Up KGDB

```bash
# Kernel config requirements (verify with config file)
grep -E "CONFIG_KGDB|CONFIG_KGDBOE|CONFIG_DEBUG_INFO" /boot/config-$(uname -r)
# CONFIG_KGDB=y
# CONFIG_KGDBOE=y          # KGDB over ethernet (netpoll)
# CONFIG_DEBUG_INFO=y
# CONFIG_FRAME_POINTER=y

# Configure kgdb via serial port at boot
# Add to kernel command line:
GRUB_CMDLINE_LINUX="kgdboc=ttyS0,115200 kgdbwait"
# kgdbwait causes the kernel to halt and wait for debugger attachment

# Or configure at runtime without reboot
echo ttyS0,115200 > /sys/module/kgdboc/parameters/kgdboc
# Or over network (KGDBOE) - useful for remote servers
echo "eth0" > /sys/module/kgdboe/parameters/kgdboe

# Trigger a breakpoint from the running kernel
echo g > /proc/sysrq-trigger
# System will halt here waiting for GDB connection
```

### GDB Configuration for KGDB

```bash
# On the development machine
gdb vmlinux

(gdb) set remotebaud 115200
(gdb) target remote /dev/ttyUSB0
# Or for network KGDB:
(gdb) target remote 192.168.1.100:2345

# Load module symbols after connecting
(gdb) add-symbol-file /path/to/my_driver.ko 0xffffffffc05d1000

# Set breakpoints
(gdb) break my_driver_read
(gdb) break drivers/block/loop.c:123

# Print variables
(gdb) print *inode
(gdb) print inode->i_size

# List processes
(gdb) info threads

# Continue execution
(gdb) continue

# Single step
(gdb) stepi
(gdb) nexti
```

### KGDB with QEMU for Safe Development

```bash
# Run kernel in QEMU with KGDB enabled
qemu-system-x86_64 \
  -kernel arch/x86/boot/bzImage \
  -hda rootdisk.img \
  -append "root=/dev/sda console=ttyS0 kgdboc=ttyS1,115200 kgdbwait nokaslr" \
  -serial stdio \
  -serial tcp::1234,server,nowait \
  -nographic \
  -m 2G \
  -cpu host \
  -smp 4

# Connect GDB in another terminal
gdb vmlinux
(gdb) target remote localhost:1234
(gdb) continue
```

## ftrace: Kernel Function Tracing

ftrace provides in-kernel function tracing without requiring recompilation or a debugger. It is safe to use on production systems with appropriate caution.

### Basic ftrace Usage

```bash
# Mount debugfs if not already mounted
mount -t debugfs none /sys/kernel/debug

# Change to the tracing directory
cd /sys/kernel/debug/tracing

# Show available tracers
cat available_tracers
# blk function_graph function nop ...

# Enable function tracer
echo function > current_tracer

# Trace a specific function
echo my_driver_read > set_ftrace_filter
echo 1 > tracing_on

# Run workload, then read trace
cat trace | head -50
# my-service-1234  [003] .... 4066234.123: my_driver_read <-vfs_read

# Disable tracing
echo 0 > tracing_on
echo nop > current_tracer
echo > set_ftrace_filter
```

### Function Graph Tracer

```bash
# Use function_graph to show call hierarchy and timing
echo function_graph > current_tracer
echo my_driver_read > set_graph_function
echo 1 > tracing_on

# This shows nested calls with timing
cat trace | head -30
# CPU DURATION                  FUNCTION CALLS
# | |   |   |                     |   |   |   |
# 3) + 12.345 us   |  my_driver_read() {
# 3)   0.123 us    |    mutex_lock();
# 3)   0.456 us    |    get_device_data();
# 3) + 11.234 us   |    copy_to_user();
# 3)               |  }
```

### Tracing Specific Events

```bash
# List available events
cat available_events | grep -E "sched:|mm:|block:"

# Enable scheduler events to trace context switches
echo 1 > events/sched/sched_switch/enable
echo 1 > events/sched/sched_wakeup/enable

# Enable memory allocation events
echo 1 > events/kmem/kmalloc/enable
echo 1 > events/kmem/kfree/enable

# Set a filter to trace only our process
echo "comm == 'my-service'" > events/sched/sched_switch/filter

# Show trace with event data
echo 1 > tracing_on
# ... run workload ...
echo 0 > tracing_on
cat trace | head -100
```

### trace-cmd for Production Tracing

trace-cmd wraps ftrace and makes it easier to use in production:

```bash
# Install trace-cmd
dnf install trace-cmd

# Record function calls for a specific command
trace-cmd record -p function_graph -g my_driver_read \
  -- my-test-program

# Or attach to a running process
trace-cmd record -p function -l my_driver_read \
  -P 1234 sleep 10

# Generate a report
trace-cmd report | head -100

# Generate a CPU-timeline report
trace-cmd report --cpu 3 | head -50

# Kernel VM latency tracing
trace-cmd record -e sched:sched_switch \
  -e irq:irq_handler_entry \
  -e irq:irq_handler_exit \
  sleep 30
```

### perf for Kernel Performance Analysis

```bash
# Record kernel function samples
perf record -g -a -e cycles:k sleep 30

# Show hottest kernel functions
perf report --no-children --kallsyms=/proc/kallsyms | head -30

# Record a specific event
perf record -g -a -e page-faults sleep 60

# Trace kernel calls from a process
perf trace -p 1234 --call-graph dwarf sleep 5

# Show cache miss statistics
perf stat -e cache-misses,cache-references,instructions,cycles \
  -p 1234 sleep 10

# Identify kernel lock contention
perf lock record -- my-program
perf lock report
```

## Kernel Module Debugging Techniques

### Adding Debug Output to Kernel Modules

```c
// my_driver.c - debugging instrumentation
#include <linux/kernel.h>
#include <linux/module.h>
#include <linux/debugfs.h>
#include <linux/seq_file.h>

/* Dynamic debug - controlled via debugfs without recompilation */
#define MY_DEBUG pr_debug

/* Statistics counters for debugfs */
static atomic_long_t read_count = ATOMIC_LONG_INIT(0);
static atomic_long_t error_count = ATOMIC_LONG_INIT(0);

/* debugfs interface */
static struct dentry *debug_dir;

static int stats_show(struct seq_file *m, void *v)
{
    seq_printf(m, "reads: %ld\nerrors: %ld\n",
               atomic_long_read(&read_count),
               atomic_long_read(&error_count));
    return 0;
}

static int stats_open(struct inode *inode, struct file *file)
{
    return single_open(file, stats_show, inode->i_private);
}

static const struct file_operations stats_fops = {
    .owner   = THIS_MODULE,
    .open    = stats_open,
    .read    = seq_read,
    .llseek  = seq_lseek,
    .release = single_release,
};

static int __init my_driver_init(void)
{
    debug_dir = debugfs_create_dir("my_driver", NULL);
    debugfs_create_file("stats", 0444, debug_dir, NULL, &stats_fops);

    /* Enable tracepoints */
    tracepoint_synchronize_unregister();

    return 0;
}
```

### Dynamic Debug

```bash
# Enable debug messages for a specific file at runtime
echo "file my_driver.c +p" > /sys/kernel/debug/dynamic_debug/control

# Enable all messages from a module
echo "module my_driver +p" > /sys/kernel/debug/dynamic_debug/control

# Show current dynamic debug state
cat /sys/kernel/debug/dynamic_debug/control | grep my_driver

# Enable with caller info (+f = function, +l = line, +m = module, +t = thread)
echo "module my_driver +pflmt" > /sys/kernel/debug/dynamic_debug/control

# Disable
echo "module my_driver -p" > /sys/kernel/debug/dynamic_debug/control
```

## Automated Crash Analysis

For production systems generating multiple crash dumps, automate initial analysis:

```bash
#!/bin/bash
# /usr/local/bin/analyze-crash.sh
# Usage: analyze-crash.sh <vmcore> <vmlinux>

set -euo pipefail

VMCORE="$1"
VMLINUX="$2"
REPORT_DIR="${3:-/var/reports/crashes}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
REPORT="${REPORT_DIR}/crash_${TIMESTAMP}.txt"

mkdir -p "${REPORT_DIR}"

cat > /tmp/crash_commands.txt << 'CRASH_EOF'
sys
log
bt
bt -a
ps | grep -v RU | head -30
net
files 1
quit
CRASH_EOF

echo "=== Crash Analysis Report ===" > "${REPORT}"
echo "Date: $(date)" >> "${REPORT}"
echo "VMcore: ${VMCORE}" >> "${REPORT}"
echo "Kernel: ${VMLINUX}" >> "${REPORT}"
echo "" >> "${REPORT}"

# Run crash analysis
crash "${VMLINUX}" "${VMCORE}" < /tmp/crash_commands.txt 2>&1 >> "${REPORT}"

# Extract key fields
PANIC_MSG=$(grep -m 1 "Kernel panic\|BUG:\|OOPS:" "${REPORT}" | head -1 || echo "No panic message found")
CRASH_FUNCTION=$(grep "exception RIP:" "${REPORT}" | head -1 || echo "No RIP found")

echo "=== Summary ===" >> "${REPORT}"
echo "Panic: ${PANIC_MSG}" >> "${REPORT}"
echo "Crash at: ${CRASH_FUNCTION}" >> "${REPORT}"

echo "Report generated: ${REPORT}"
cat "${REPORT}"
```

## Key Takeaways

**kdump is essential infrastructure**: Configure kdump before you need it. A system that panics without kdump configured leaves you with only the console output (if you were watching) and no ability to do post-mortem analysis. The memory reservation overhead is minimal and worth it on every production system.

**crash-utility is the primary analysis tool**: The crash utility provides a read-only, safe interface to examine kernel state from a vmcore. It cannot modify the running system. Master the `bt`, `log`, `ps`, `struct`, and `dis` commands — they solve 90% of kernel panic investigations.

**KGDB is for development, not production**: Interactive KGDB requires halting the kernel, which makes it inappropriate for live production systems. Use it in QEMU or a dedicated test system for driver and kernel module development.

**ftrace is safe for production use**: Unlike KGDB, ftrace can be enabled and disabled without interrupting the running system. Use trace-cmd for scripted tracing and perf for performance profiling. The function_graph tracer is particularly useful for understanding call hierarchies in complex driver code.

**Symbol matching is critical**: A vmcore from kernel 6.1.0-28-amd64 must be analyzed with vmlinux from exactly that build. Package manager debuginfo packages guarantee this match. Build and store your own vmlinux files if you build custom kernels.
