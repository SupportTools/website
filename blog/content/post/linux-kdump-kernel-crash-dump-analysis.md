---
title: "Linux Kdump: Kernel Crash Dump Analysis with crash and gdb"
date: 2029-10-04T00:00:00-05:00
draft: false
tags: ["Linux", "Kdump", "Kernel", "Debugging", "Crash Analysis", "Production"]
categories: ["Linux", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux kdump configuration, kexec crash kernel setup, vmcore analysis with the crash tool, kernel oops analysis, and extracting process state from vmcore files for production incident investigation."
more_link: "yes"
url: "/linux-kdump-kernel-crash-dump-analysis/"
---

When a Linux system experiences a kernel panic, the system reboots — and without kdump configured, you lose all evidence of what caused the crash. Kdump uses kexec to load a second "capture kernel" that runs when the primary kernel crashes, capturing the entire memory state before reboot. The resulting vmcore file contains everything: the kernel call stack at the moment of crash, the states of all processes, kernel data structures, and system memory.

This guide covers kdump configuration from scratch, vmcore analysis using the `crash` utility, kernel oops interpretation, and practical techniques for extracting actionable information from production crash dumps.

<!--more-->

# Linux Kdump: Kernel Crash Dump Analysis with crash and gdb

## Section 1: Kdump Architecture

### How Kdump Works

```
Normal Operation:
┌──────────────────────────────────────────────────────┐
│ Primary Kernel                                        │
│  - Full system running                                │
│  - kexec has pre-loaded capture kernel into reserved  │
│    memory (crashkernel= region)                       │
└──────────────────────────────────────────────────────┘

On Kernel Panic/Oops:
┌──────────────────────────────────────────────────────┐
│ Capture Kernel (minimal, just enough to write dump)   │
│  - Executes immediately via kexec (no BIOS POST)      │
│  - Maps primary kernel's memory as /proc/vmcore       │
│  - kdump service copies vmcore to disk                │
│  - System reboots normally                            │
└──────────────────────────────────────────────────────┘
```

The capture kernel runs in a small reserved memory region (`crashkernel=` boot parameter) completely isolated from the crashed kernel's memory. This isolation ensures the capture kernel can read the crash state reliably.

## Section 2: Kdump Installation and Configuration

### Installing Kdump

```bash
# RHEL/CentOS/Fedora
dnf install kexec-tools crash kernel-debuginfo

# Ubuntu/Debian
apt-get install linux-crashdump kdump-tools crash

# Verify kdump service
systemctl status kdump
```

### Configuring crashkernel Memory Reservation

The `crashkernel=` boot parameter reserves memory for the capture kernel. The amount needed depends on RAM and workload:

```bash
# Check current crashkernel setting
cat /proc/cmdline | grep crashkernel

# Rule of thumb:
# < 4GB RAM:  crashkernel=64M
# 4-64GB RAM: crashkernel=128M
# > 64GB RAM: crashkernel=256M

# RHEL/CentOS: Edit GRUB
vi /etc/default/grub
# Add to GRUB_CMDLINE_LINUX:
GRUB_CMDLINE_LINUX="... crashkernel=256M"

# Apply
grub2-mkconfig -o /boot/grub2/grub.cfg  # BIOS
grub2-mkconfig -o /boot/efi/EFI/redhat/grub.cfg  # UEFI

# Ubuntu: Edit GRUB
vi /etc/default/grub.d/kdump-tools.cfg
GRUB_CMDLINE_LINUX_DEFAULT="$GRUB_CMDLINE_LINUX_DEFAULT crashkernel=256M"
update-grub

# Reboot to apply
reboot
```

### Verifying Memory Reservation

```bash
# After reboot, verify crashkernel memory is reserved
cat /proc/iomem | grep "Crash kernel"
# Output: 22000000-2fffffff : Crash kernel (256MB reserved)

# Check kdump is operational
kdumpctl status
# Output: Kdump is operational
```

### /etc/kdump.conf Configuration

```bash
# /etc/kdump.conf — core kdump configuration

# Where to save the dump
path /var/crash

# Save to a separate filesystem (recommended)
# ext4 /dev/sdb1
# nfs my-nfs-server:/var/crash

# Save to SSH (send over network)
# ssh user@backup-server
# sshkey /root/.ssh/kdump_id_rsa

# What to capture (core_collector)
# makedumpfile options:
# -l: LZO compression
# -d 31: exclude pages not needed for analysis
#   bit 0: zero pages
#   bit 1: cache pages
#   bit 2: cache private
#   bit 3: user pages
#   bit 4: free pages
core_collector makedumpfile -l --message-level 1 -d 31

# Dump format
# makedumpfile -f ELF for compatibility with crash/gdb
# makedumpfile -f KDUMP for smaller files (default)

# Post-dump action
# default: reboot
# halt: stop system after dump (useful for inspection)
# poweroff
default reboot

# Notification (webhook)
# failure_action shell
# KDUMP_NOTIFICATION_URL=https://hooks.slack.com/services/<WORKSPACE_ID>/<CHANNEL_ID>/<WEBHOOK_TOKEN>

# Filtering: only save kernel space (skip user pages for smaller dumps)
# -d 31 above already excludes user pages
```

### NFS Dump Target (for production)

```bash
# /etc/kdump.conf for NFS dump target
nfs backup-server.example.com:/var/crash/kdump
path /hostname

# Ensure NFS mount works from minimal capture kernel
# Test the NFS configuration:
kdumpctl propagate

# Verify the capture kernel can mount NFS:
kdumpctl --test-boot
```

## Section 3: Triggering a Test Crash

```bash
# WARNING: This will crash the system immediately
# Ensure a proper crash dump is configured before testing

# Method 1: sysrq (immediate crash for testing)
echo 1 > /proc/sys/kernel/sysrq
echo c > /proc/sysrq-trigger

# Method 2: Direct kernel memory write (via /dev/mem — requires CONFIG_DEVMEM)
# NOT recommended for production

# Method 3: KDB kernel debugger
echo kdb > /sys/module/kgdboc/parameters/kgdboc
echo g > /proc/sysrq-trigger
# At KDB prompt:
# go   — continue
# dumpall — dump all processes
# ps   — show processes
# md 0xffffffffc0000000 10 — dump memory at address

# Method 4: kdump test via kexec (safer — tests the capture kernel loads)
kdumpctl test
# If successful: "Test kexec load succeeded"
```

## Section 4: Analyzing vmcore with the crash Tool

The `crash` utility provides a GDB-like interface for kernel crash analysis. It requires:
1. The vmcore file (from `/var/crash/<timestamp>/vmcore`)
2. The kernel debug symbols (vmlinux with debug info)

### Finding the Right Debug Symbols

```bash
# Identify the crashed kernel version from vmcore
file /var/crash/*/vmcore
# vmcore: ELF 64-bit LSB core file, x86-64, version 1 (SYSV), SVR4-style

# Or check kernel version from kdump directory
ls /var/crash/

# For RHEL/CentOS: install kernel-debuginfo
dnf install "kernel-debuginfo-$(uname -r)"
# Symbols at: /usr/lib/debug/lib/modules/$(uname -r)/vmlinux

# For Ubuntu: install linux-image-<version>-dbgsym
apt-get install linux-image-$(uname -r)-dbgsym
# Symbols at: /usr/lib/debug/boot/vmlinux-$(uname -r)

# From kernel-devel + custom build:
ls /boot/vmlinux-$(uname -r)
```

### Starting crash Analysis

```bash
# Basic invocation
crash /usr/lib/debug/lib/modules/$(uname -r)/vmlinux \
      /var/crash/127.0.0.1-2024-10-15-03:14:59/vmcore

# Or for the current running kernel (live analysis)
crash /usr/lib/debug/lib/modules/$(uname -r)/vmlinux

# crash will display:
#       KERNEL: /usr/lib/debug/lib/modules/5.14.0-162.el9.x86_64/vmlinux
#     DUMPFILE: /var/crash/vmcore
#         CPUS: 8
#         DATE: Tue Oct 15 03:14:59 2024
#       UPTIME: 42 days, 03:22:11
# LOAD AVERAGE: 0.15, 0.12, 0.09
#        TASKS: 412
#     NODENAME: prod-server-01
#      RELEASE: 5.14.0-162.el9.x86_64
#      VERSION: #1 SMP Fri Sep 30 11:56:52 EDT 2022
#      MACHINE: x86_64
#       MEMORY: 64 GB
#        PANIC: "general protection fault, probably for non-canonical address
#                 0x0000607f9bbbf6a3: 0000 [#1] SMP"
#          PID: 12847
#      COMMAND: "mysqld"
#         TASK: ffff8881fb220000  [THREAD_INFO: ffff8881fb220000]
#          CPU: 3
#        STATE: TASK_RUNNING (PANIC)
```

### Essential crash Commands

```bash
# Show the crash backtrace (most important first step)
crash> bt
# PID: 12847  TASK: ffff8881fb220000  CPU: 3  COMMAND: "mysqld"
#  #0 [ffffc90008d07c28] machine_kexec at ffffffffa0268a06
#  #1 [ffffc90008d07c80] __crash_kexec at ffffffffa0325d24
#  #2 [ffffc90008d07d50] crash_kexec at ffffffffa0325e47
#  #3 [ffffc90008d07d68] oops_end at ffffffffa02a82b6
#  ...
#  #8 [ffffc90008d07e80] do_general_protection at ffffffffa02a8e98
#  #9 [ffffc90008d07eb8] general_protection at ffffffffa0200d15
#     [exception RIP: some_function+0x123]
#  ...

# Show all processes
crash> ps
#    PID    PPID  CPU   TASK            ST  %MEM      VSZ      RSS  COMM
#      0       0   0  ffffffffa0e18700  RU   0.0        0        0  [swapper/0]
#  12847    1234   3  ffff8881fb220000  RU   2.3  6234512  1523404  mysqld
#  ...

# Show backtrace for a specific PID
crash> bt 12847

# Show backtrace for all tasks (can be very long)
crash> foreach bt

# Show all kernel threads
crash> ps -k

# Examine a specific task's state
crash> task 12847

# List open files for a task
crash> files 12847

# Show virtual memory map for a process
crash> vm 12847

# Show memory info
crash> kmem -i

# Show slab allocator stats
crash> kmem -s

# Kernel log buffer (dmesg equivalent)
crash> log
# or
crash> log -m  # Show timestamp with messages

# Disassemble a function
crash> dis some_function
crash> dis -l ffffffffa02a8e98  # Disassemble at specific address

# Read memory at address
crash> rd 0xffff8881fb220000
crash> rd -s 0xffff8881fb220000  # Read as string
crash> rd -64 0xffff8881fb220000 10  # Read 10 64-bit values

# Print kernel data structure
crash> struct task_struct ffff8881fb220000
crash> struct task_struct.comm ffff8881fb220000  # Specific field

# Show network connections
crash> net
```

## Section 5: Analyzing a Kernel Oops

A kernel oops is a non-fatal kernel error that gets logged before the system potentially panics. Understanding the oops message is crucial.

### Anatomy of a Kernel Oops

```
BUG: general protection fault, probably for non-canonical address 0x0000607f9bbbf6a3: 0000 [#1] SMP
CPU: 3 PID: 12847 Comm: mysqld Not tainted 5.14.0-162.el9.x86_64 #1
Hardware name: VMware Virtual Platform/...
RIP: 0010:some_module_function+0x123/0x456 [mymodule]
```

Breaking this down:

```bash
# "BUG: general protection fault"
# → Attempted to access an invalid memory address
# → 0x0000607f9bbbf6a3 = corrupted pointer (user-space address in kernel mode)

# "0000 [#1]"
# → die counter = 1 (first oops)

# "CPU: 3 PID: 12847"
# → Happened on CPU 3, process 12847 (mysqld)

# "Not tainted"
# → No out-of-tree or proprietary modules loaded

# "RIP: 0010:some_module_function+0x123/0x456"
# → Instruction Pointer: offset 0x123 into some_module_function, total size 0x456
```

### Decoding Module Addresses with addr2line

```bash
# Find which kernel module contains the crashing function
# The oops usually lists the module in brackets: [mymodule]

# Get the module's memory range
cat /proc/modules | grep mymodule
# mymodule 45056 0 - Live 0xffffffffc0000000

# Calculate the offset within the module
# RIP = 0xffffffffc0000123
# Module base = 0xffffffffc0000000
# Offset = 0x123

# Decode with addr2line (requires debug symbols or debuginfo)
addr2line -e /usr/lib/debug/lib/modules/$(uname -r)/mymodule.ko.debug \
  -f -i 0x123

# Alternative: decode the entire call stack
cat /var/crash/oops.txt | grep -E "^\[<[0-9a-f]+>\]" | \
  while read line; do
    addr=$(echo $line | grep -oP '(?<=\[<)[0-9a-f]+(?=>])')
    faddr2line -e /usr/lib/debug/vmlinux $addr
  done
```

### Using crash to Analyze the Oops Context

```bash
# In crash, examine the state at the crash point
crash> bt -f 12847
# Shows full backtrace with stack frame contents

# Look at the registers at crash time
crash> bt -r 12847
# RAX: xxxxxxxx  RBX: xxxxxxxx  RCX: xxxxxxxx
# RDX: xxxxxxxx  RSI: xxxxxxxx  RDI: xxxxxxxx
# ...
# RIP: xxxxxxxx  RSP: xxxxxxxx  RBP: xxxxxxxx

# Examine the code at the crash point
crash> dis -l ffffffffc0000123
# 0xffffffffc0000120 <some_function+0x120>:  mov    rax,QWORD PTR [rbx+0x10]
# 0xffffffffc0000124 <some_function+0x124>:  mov    rcx,QWORD PTR [rax]   ← crash here
# → rax = 0x0000607f9bbbf6a3 = corrupted pointer

# Look at the struct that was being accessed
# If rbx contains a pointer to a kernel struct:
crash> struct my_struct 0x<rbx value>
```

## Section 6: Analyzing Process State from vmcore

One of the most powerful uses of crash analysis is understanding what all processes were doing at the time of the crash.

### Identifying Hung Processes

```bash
# In crash: find processes in uninterruptible sleep (D state)
crash> ps | grep " UN "
# PID 5432 mysqld  UN  (waiting on I/O or mutex)
# PID 7891 java    UN

# Show why a process is sleeping
crash> bt 5432
# Stack trace shows:
# #0 mutex_lock
# #1 ext4_journal_start
# #2 ext4_write_begin
# → Process stuck waiting for filesystem journal

# Check what mutex/lock is held
crash> struct task_struct.blocked 5432
```

### Extracting Process Memory State

```bash
# Show virtual memory areas for a specific process
crash> vm 12847
# PID: 12847  TASK: ffff8881fb220000  CPU: 3  COMMAND: "mysqld"
#
# VMA           START           END    FLAGS FILE
# ffff8881b4400000  400000         401000  0x8040875 /usr/sbin/mysqld
# ffff8881b4401000  401000        5678000  0x8040873 /usr/sbin/mysqld
# ...

# Dump a specific memory region to a file
crash> rd -a 0x00007f1234560000 > /tmp/mysqld_heap.txt

# Search process memory for a pattern
crash> search -u 0xdeadbeef  # Search user space
crash> search -k 0xdeadbeef  # Search kernel space
```

### Finding Memory Leaks via Slab Analysis

```bash
# Show slab allocator statistics
crash> kmem -s
# CACHE              OBJSIZE  ALLOCATED  TOTAL  SLABS  SSIZE  NAME
# ffff888100005900       192     1024M  1200M   5000      8  dentry
# → "dentry" cache is abnormally large → potential dentry leak

# Investigate the oversized slab
crash> kmem -S dentry
# Shows all dentry objects with their addresses

# Find slab objects of a specific type exceeding a threshold
crash> kmem -s | awk '$4 > 10000 {print}' | head -20
```

## Section 7: Crash Analysis Scripts

### Automated First-Pass Analysis

```bash
#!/bin/bash
# kdump-first-pass.sh — automated crash dump analysis

VMCORE=$1
VMLINUX=${2:-/usr/lib/debug/lib/modules/$(uname -r)/vmlinux}

if [ ! -f "$VMCORE" ]; then
    echo "Usage: $0 <vmcore> [vmlinux]"
    exit 1
fi

REPORT="/tmp/crash_analysis_$(date +%Y%m%d_%H%M%S).txt"

echo "Analyzing $VMCORE..." | tee "$REPORT"

# Run crash commands and capture output
crash "$VMLINUX" "$VMCORE" <<'CRASH_COMMANDS' | tee -a "$REPORT"
# System overview
sys
# Panic message
log | head -50
# Backtrace of crashing process
bt
# All processes
ps
# Processes in D state (blocked)
ps | grep " UN "
# Memory usage
kmem -i
# Large slab caches (potential leaks)
kmem -s
# Network connections
net
# Exit
q
CRASH_COMMANDS

echo ""
echo "Analysis complete: $REPORT"
```

### Memory Corruption Detection

```bash
#!/usr/bin/expect
# crash-detect-corruption.exp — detect common memory corruption patterns

set vmlinux [lindex $argv 0]
set vmcore [lindex $argv 1]

spawn crash $vmlinux $vmcore

expect "crash>"
send "sys\r"

expect "crash>"
send "bt\r"

expect "crash>"
# Look for common corruption indicators
send "foreach bt\r"

expect "crash>"
# Check for kernel NULL pointer dereferences
send "log | grep -i 'null pointer\\|BUG:\\|Oops:'\r"

expect "crash>"
send "q\r"
expect eof
```

## Section 8: Using gdb with vmcore

For situations where `crash` doesn't have the right module or for userspace crash analysis:

```bash
# Analyze vmcore with gdb (requires ELF format vmcore)
gdb /usr/lib/debug/lib/modules/$(uname -r)/vmlinux /var/crash/vmcore

# In gdb:
(gdb) info threads
(gdb) thread 3     # Switch to thread 3

# Read a kernel data structure
(gdb) print *(struct task_struct *)0xffff8881fb220000

# Show call stack for thread
(gdb) bt full

# Read memory at address
(gdb) x/20gx 0xffff8881fb220000

# Disassemble around crash point
(gdb) x/20i $rip-20

# Find symbol at address
(gdb) info symbol 0xffffffff81a2b456

# Show all stack frames for all threads
(gdb) thread apply all bt

# Search for a pattern in kernel memory
(gdb) find 0xffff880000000000, +0x40000000, 0xdeadbeef
```

## Section 9: Kernel Module Development Crash Analysis

When a kernel module causes crashes, the analysis workflow requires module-specific symbols:

```bash
# Load module debug symbols into crash
crash> mod -s mymodule /usr/lib/debug/lib/modules/$(uname -r)/mymodule.ko.debug
# Module mymodule loaded at 0xffffffffc0000000

# Now crash knows the module's symbols
crash> bt
# #8 [ffffc90008d07e80] my_function at ffffffffc0000123 [mymodule]
#    → crash can now show the actual function name

# Disassemble module function with source correlation
crash> dis -l my_function
# FILE: /home/developer/mymodule/mymodule.c
# LINE: 456
# 0xffffffffc0000120 <my_function+0x120>:  ...

# Show module data structures
crash> list my_list_head.next -s my_struct  # Walk a linked list
```

## Section 10: Kdump Operational Considerations

### Storage Requirements

```bash
# Calculate expected vmcore size
# makedumpfile with -d 31 typically produces 5-20% of RAM size
# For a 64GB system with -d 31: ~3-12GB per crash dump

# Check available space
df -h /var/crash

# Set a size limit (in MB) to prevent disk exhaustion
# In /etc/kdump.conf:
# core_collector makedumpfile -l --message-level 1 -d 31 --max-mapnr-bits 46

# Compress old dumps automatically
find /var/crash -name "vmcore" -mtime +7 -exec gzip {} \;
```

### Automating Analysis and Notification

```bash
# Post-kdump hook script (/etc/kdump/post.d/notify.sh)
#!/bin/bash
CRASH_DIR=$1

# Extract crash reason
PANIC_MSG=$(crash /usr/lib/debug/lib/modules/$(uname -r)/vmlinux \
  $CRASH_DIR/vmcore <<'EOF'
log | grep -E "Oops:|BUG:|kernel BUG"
q
EOF
)

# Send notification
curl -s -X POST \
  "https://hooks.slack.com/services/<WORKSPACE_ID>/<CHANNEL_ID>/<WEBHOOK_TOKEN>" \
  -H "Content-Type: application/json" \
  -d "{
    \"text\": \"Kernel crash on $(hostname)!\",
    \"attachments\": [{
      \"color\": \"danger\",
      \"text\": \"${PANIC_MSG}\"
    }]
  }"
```

### Systemd Override for Kdump Service

```bash
# Increase memory for complex systems (more deps in capture kernel)
mkdir -p /etc/systemd/system/kdump.service.d/
cat > /etc/systemd/system/kdump.service.d/memory.conf <<EOF
[Service]
Environment=KDUMP_COMMANDLINE_APPEND="maxcpus=1 irqpoll nr_cpus=1 reset_devices udev.children-max=2 panic=10"
EOF

systemctl daemon-reload
systemctl restart kdump
```

## Summary

Kdump provides an essential safety net for production Linux systems — without it, kernel panics leave no forensic trail. Key operational guidance:

- Configure `crashkernel=256M` for systems with 64GB+ RAM; smaller systems can use 128M
- Use NFS or SSH targets for crash dumps on ephemeral infrastructure or when local disk may be corrupted
- `makedumpfile -d 31` reduces vmcore size by 80-95% while preserving all kernel-analysis-relevant data
- The `crash` tool is the primary analysis tool; start with `bt` (backtrace), `log` (kernel messages), and `ps` to understand the crash context
- Module debuginfo is required for meaningful analysis of module-related crashes
- The `foreach bt` command in crash provides call stacks for all processes — invaluable for finding cascading lock dependencies
- Automate first-pass analysis and notification to reduce mean time to investigation for production incidents

Kdump analysis is a skill built through practice. Consider deliberately causing test crashes on non-production systems to build familiarity with the analysis workflow before you need it in a production incident.
