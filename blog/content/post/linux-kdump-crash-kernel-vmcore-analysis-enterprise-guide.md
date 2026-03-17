---
title: "Linux kdump v2: Crash Kernel Configuration, vmcore Analysis with crash Utility, and Kernel Module Debugging"
date: 2032-02-08T00:00:00-05:00
draft: false
tags: ["Linux", "kdump", "kernel", "crash", "vmcore", "Debugging", "System Administration", "kexec", "Kernel Modules"]
categories: ["Linux", "System Administration", "Debugging"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Linux kdump v2: configuring crash kernels with correct memory reservations, capturing vmcore dumps, analyzing kernel panics with the crash utility, and debugging loadable kernel modules in enterprise environments."
more_link: "yes"
url: "/linux-kdump-crash-kernel-vmcore-analysis-enterprise-guide/"
---

Kernel panics in production Linux systems are rare but catastrophic when they occur. Without a properly configured kdump environment, the only evidence you have is a console screenshot or a brief message in serial logs before the machine reboots. With kdump, you capture the complete memory state of the running kernel at the moment of panic, enabling full post-mortem analysis: stack traces for every CPU, process states, memory allocator state, locking status, and the exact source location of the bug.

This guide covers the complete kdump stack from kernel configuration through vmcore capture to deep analysis with the `crash` utility and kernel module debugging techniques used in enterprise environments.

<!--more-->

# Linux kdump v2: Crash Kernel Configuration and vmcore Analysis

## How kdump Works

kdump uses `kexec` to pre-load a second (crash) kernel into a reserved memory region during normal system startup. When the primary kernel panics:

1. The panic handler calls `machine_crash_shutdown()`.
2. `kexec` boots the crash kernel from the reserved memory — without BIOS/UEFI initialization.
3. The crash kernel mounts a minimal initramfs.
4. The crash kernel captures `/proc/vmcore` (the panicked kernel's memory).
5. The capture script saves the vmcore to disk, network, or SSH destination.
6. The crash kernel reboots the system normally.

```
Normal kernel memory layout:
┌────────────────────────────┐
│   Normal kernel + apps     │ ← crashes here
│   (uses 0 to total RAM)    │
│                            │
│   ┌────────────────────┐   │
│   │  Crash kernel zone  │   │ ← reserved at boot (e.g., 256M@32M)
│   │  (kexec pre-loaded) │   │
│   └────────────────────┘   │
└────────────────────────────┘
```

## Kernel Configuration Requirements

### Verifying kdump Kernel Support

```bash
# Check if crash kernel support is compiled in
grep -E "CONFIG_KEXEC|CONFIG_CRASH_DUMP|CONFIG_PROC_VMCORE" /boot/config-$(uname -r)

# Expected output:
# CONFIG_KEXEC=y
# CONFIG_CRASH_DUMP=y
# CONFIG_PROC_VMCORE=y

# Check if current kernel is a crash kernel
cat /proc/cmdline | grep -q "crashkernel" && echo "Running as crash kernel" || echo "Normal kernel"

# Check crash kernel is loaded
cat /sys/kernel/kexec_crash_loaded
# Output: 1 (loaded) or 0 (not loaded)
```

### crashkernel Parameter Sizing

The most critical and error-prone part of kdump configuration is the `crashkernel=` parameter.

**Sizing formula for modern kernels** (Linux 5.x+):

| System RAM | Recommended crashkernel value |
|---|---|
| < 4GB | `256M` |
| 4GB - 64GB | `512M` |
| 64GB - 512GB | `1G` |
| > 512GB | `2G` |

**Auto-sizing (recommended for RHEL/Rocky/AlmaLinux):**

```bash
# crashkernel=auto lets the kernel determine the requirement
# Requires CONFIG_ARCH_CRASHKERNEL_DEFAULT
GRUB_CMDLINE_LINUX="crashkernel=auto"
```

**Manual sizing with offset (required on some systems):**

```bash
# Reserve 512MB starting at physical address 128MB
# Useful for systems where memory below 4GB is fragmented
GRUB_CMDLINE_LINUX="crashkernel=512M@128M"

# For UEFI systems with 64-bit address space:
GRUB_CMDLINE_LINUX="crashkernel=512M,high"
```

### Configuring crashkernel in GRUB2

```bash
# /etc/default/grub
GRUB_CMDLINE_LINUX="rd.lvm.lv=rhel/root rd.lvm.lv=rhel/swap \
    crashkernel=512M \
    rhgb quiet"

# Regenerate GRUB config
# For BIOS systems:
grub2-mkconfig -o /boot/grub2/grub.cfg

# For UEFI systems:
grub2-mkconfig -o /boot/efi/EFI/redhat/grub.cfg

# Reboot to apply
systemctl reboot
```

## Installing and Configuring kdump

### Package Installation

```bash
# RHEL/Rocky/AlmaLinux
dnf install kexec-tools crash kernel-debuginfo-$(uname -r) -y

# Ubuntu/Debian
apt-get install kdump-tools crash linux-image-$(uname -r)-dbg -y

# SUSE/openSUSE
zypper install kexec-tools kdump crash kernel-default-debuginfo
```

### kdump Configuration File

```bash
# /etc/kdump.conf (RHEL/Rocky/CentOS)

# Dump target: where to save the vmcore
# Options: local path, NFS, SSH, raw partition
path /var/crash

# Alternatively, save to NFS
#nfs 192.168.10.50:/export/kdumps

# Save to SSH (requires passwordless key auth for root)
#ssh root@crash-server.example.com
#sshkey /root/.ssh/id_rsa_kdump

# Save to raw partition (fastest, no filesystem overhead)
#raw /dev/sdb

# Core collector: controls what gets saved
# makedumpfile compresses and filters the vmcore
core_collector makedumpfile -l --message-level 7 -d 31
# -l: lzo compression
# -d 31: exclude zero pages, free pages, user-space pages (saves 70-90% space)
# -d 1: exclude zero pages only (maximum completeness)

# makedumpfile dump levels:
# 1  = exclude zero pages
# 2  = exclude non-private cache pages
# 4  = exclude private cache pages
# 8  = exclude free pages
# 16 = exclude user process data pages
# 31 = all of the above

# What to do if vmcore capture fails
default reboot

# Extra modules to load in crash kernel
extra_modules ata_piix sd_mod

# Actions after dump:
# reboot, halt, poweroff, shell, dump_to_rootfs
default reboot
```

### Enabling and Testing kdump

```bash
# Enable kdump service
systemctl enable --now kdump

# Verify status
systemctl status kdump

# Check that crash kernel is loaded
cat /sys/kernel/kexec_crash_loaded

# View current crashkernel reservation
cat /proc/iomem | grep "Crash kernel"
# Output: 0c000000-2bffffff : Crash kernel (192MB reserved)

# Test kdump WITHOUT actually crashing (dry run)
# This reboots into crash kernel and captures an artificial dump
kdumpctl test

# Force a kernel panic for testing (ONLY in test environments)
# WARNING: This crashes the running kernel immediately
# echo c > /proc/sysrq-trigger
```

## vmcore Analysis with crash Utility

### Installing debug symbols

```bash
# RHEL/Rocky
debuginfo-install kernel-$(uname -r)

# Or download manually
rpm -ivh kernel-debuginfo-$(uname -r).rpm \
         kernel-debuginfo-common-x86_64-$(uname -r).rpm

# Ubuntu
apt-get install linux-image-$(uname -r)-dbg

# Verify debug info is available
ls /usr/lib/debug/lib/modules/$(uname -r)/vmlinux*
# or
ls /boot/vmlinux-$(uname -r)
```

### Opening a vmcore

```bash
# Basic syntax
crash /usr/lib/debug/lib/modules/$(uname -r)/vmlinux \
      /var/crash/$(date +%Y-%m-%d)/vmcore

# For a live kernel (analysis without a panic)
crash

# With kernel module symbols
crash /path/to/vmlinux /path/to/vmcore
```

### crash Session: Essential Commands

```bash
# After opening crash:

crash> sys
# Shows system information: kernel version, panic message, hostname

crash> bt
# Back trace of the current task (the one that caused the panic)

crash> bt -a
# Back trace of ALL tasks across ALL CPUs
# Large output — pipe to a file: bt -a > /tmp/all_bt.txt

crash> log
# Show kernel message buffer (dmesg at time of crash)
# Often reveals the panic message and context

crash> ps
# Show all running processes at time of crash

crash> ps | grep UN
# Show processes in uninterruptible sleep (potential deadlock candidates)

crash> files <pid>
# Show open files for a specific process

crash> vm <pid>
# Show virtual memory mappings for a process

crash> struct task_struct <address>
# Dump a specific kernel struct at a memory address
```

### Analyzing a Null Pointer Dereference

```bash
crash> sys
      KERNEL: /usr/lib/debug/lib/modules/6.1.0/vmlinux
    DUMPFILE: /var/crash/2032-02-08/vmcore
        CPUS: 16
        DATE: Tue Feb  8 03:42:17 2032
      UPTIME: 15 days, 02:31:44
LOAD AVERAGE: 2.47, 2.51, 2.43
       TASKS: 512
    NODENAME: prod-worker-07
     RELEASE: 6.1.0-26-amd64
     VERSION: #1 SMP PREEMPT_DYNAMIC Debian 6.1.112-1
     MACHINE: x86_64  (3600 Mhz)
      MEMORY: 63.8 GB
       PANIC: "BUG: kernel NULL pointer dereference, address: 0000000000000018"

crash> bt
PID: 2847   TASK: ffff9a3c42d10000  CPU: 5   COMMAND: "mydriver"
 #0 [ffffa99b417dbb58] machine_kexec at ffffffff8105d4ab
 #1 [ffffa99b417dbb80] __crash_kexec at ffffffff81119b2d
 #2 [ffffa99b417dbc48] panic at ffffffff81078b4e
 #3 [ffffa99b417dbcc8] no_context at ffffffff81063c1a
 #4 [ffffa99b417dbd18] do_page_fault at ffffffff81064c28
 #5 [ffffa99b417dbd98] page_fault at ffffffff81a01882
    [exception RIP: mymodule_process+0x48]
    RIP: ffffffffc0823048  RSP: ffffa99b417dbe50  RFLAGS: 00010202
    RAX: 0000000000000000  RBX: ffff9a3c5b870000  RCX: 0000000000000000
    RDX: 0000000000000018  RSI: 0000000000000001  RDI: ffff9a3c5b870000
 #6 [ffffa99b417dbef0] mymodule_ioctl at ffffffffc082359c
 #7 [ffffa99b417dbf18] do_vfs_ioctl at ffffffff8124e7e2
```

The stack shows the crash happened at `mymodule_process+0x48` — 0x48 bytes into the `mymodule_process` function. The address being dereferenced was `0x0 + 0x18 = 0x18`, indicating a NULL pointer being accessed at field offset `0x18`.

### Decoding the Fault Address

```bash
# Get source/line information from RIP value
crash> dis -l ffffffffc0823048
0xffffffffc0823048 <mymodule_process+0x48>:    mov    0x18(%rax),%rdi
                                               ^ dereferences RAX (which was 0)

# Disassemble the function around the crash point
crash> dis -r mymodule_process
   0xffffffffc0823000 <mymodule_process>:       push   %rbp
   0xffffffffc0823001 <mymodule_process+1>:     mov    %rsp,%rbp
   ...
   0xffffffffc0823040 <mymodule_process+0x40>:  mov    (%rdi),%rax    ← load pointer
   0xffffffffc0823044 <mymodule_process+0x44>:  test   %rax,%rax      ← check for NULL?
   0xffffffffc0823048 <mymodule_process+0x48>:  mov    0x18(%rax),%rdi  ← CRASH: NULL
```

The disassembly reveals the code loaded a pointer (likely a struct field), and the `test` instruction was present but the branch was not taken — meaning the NULL check existed but the branch logic was wrong.

### Inspecting Kernel Structures

```bash
# Dump the struct at a specific address
crash> struct sk_buff ffff9a3c42d10080

# Print a specific field
crash> p ((struct task_struct *)ffff9a3c42d10000)->comm
# Output: $1 = "mydriver\000\000\000\000\000\000\000"

# Get offset of a field within a struct
crash> offsetof task_struct comm
# Output: offsetof(task_struct, comm) = 624

# Show struct layout with field offsets
crash> struct -o request_queue
```

### Analyzing Kernel Memory

```bash
# Show memory usage breakdown
crash> kmem -i

# Show slab allocator statistics
crash> kmem -s

# Find where a specific physical address is used
crash> kmem 0xffff9a3c42d10000

# Show virtual to physical mapping
crash> vtop 0xffff9a3c42d10000

# Show physical page info
crash> ptob 0x42d10
```

### Examining CPU States at Panic

```bash
# Show what each CPU was doing
crash> foreach bt
# Runs bt for every task — shows parallel execution context

# Show registers at time of panic for each CPU
crash> struct pt_regs $(bt -r | grep "^RIP:")

# Show NMI backtrace if available
crash> bt -n
```

## Kernel Module Debugging

### Loading Module Symbols in crash

When the panic involves a loadable kernel module, its symbols must be loaded separately:

```bash
# List modules that were loaded at crash time
crash> mod
     MODULE       NAME         SIZE  OBJECT FILE
ffffffffc07e8680  mymodule    32768  (not loaded)
ffffffffc07f0000  iptable_nat 28672  (not loaded)

# Load module symbols (need the .ko file from the running system)
crash> mod -s mymodule /lib/modules/6.1.0/extra/mymodule.ko
# After this, bt will show function names instead of raw addresses
```

### Compiling Modules with Debug Info

For modules you control, compile with debug info enabled:

```makefile
# Module Makefile
obj-m := mymodule.o
EXTRA_CFLAGS := -g -O0  # -O0 for better stack traces (disable in production)

# Or with frame pointer (helps crash reconstruct stacks)
EXTRA_CFLAGS := -g -fno-omit-frame-pointer
```

### Dynamic Debug in Modules

```bash
# Enable pr_debug() and dev_dbg() output for a specific module
echo "module mymodule +p" > /sys/kernel/debug/dynamic_debug/control

# Enable for a specific file and line
echo "file mymodule.c line 42 +p" > /sys/kernel/debug/dynamic_debug/control

# Show all current dynamic debug settings
cat /sys/kernel/debug/dynamic_debug/control | grep mymodule
```

### Debugging with ftrace

```bash
# Trace all function calls in a module
echo mymodule_function > /sys/kernel/debug/tracing/set_ftrace_filter
echo function > /sys/kernel/debug/tracing/current_tracer
echo 1 > /sys/kernel/debug/tracing/tracing_on

# Read the trace
cat /sys/kernel/debug/tracing/trace

# Stop tracing
echo 0 > /sys/kernel/debug/tracing/tracing_on
```

### kprobes for Dynamic Tracing Without Recompile

```bash
# Add a probe at function entry
echo 'p:myprobe mymodule_process' > /sys/kernel/debug/tracing/kprobe_events

# Add a probe at function return with return value
echo 'r:myretprobe mymodule_process $retval' >> /sys/kernel/debug/tracing/kprobe_events

# Enable the probe
echo 1 > /sys/kernel/debug/tracing/events/kprobes/enable

# Read results
cat /sys/kernel/debug/tracing/trace
```

## Automated kdump Analysis with makedumpfile

```bash
# Convert raw vmcore to filtered ELF dumpfile (smaller, faster to analyze)
makedumpfile -d 31 -l /var/crash/vmcore /var/crash/vmcore.filtered

# Extract only the kernel data pages (fastest load in crash)
makedumpfile -d 31 -F /var/crash/vmcore /var/crash/vmcore.flat

# Convert flat format back to ELF for crash compatibility
makedumpfile -R /var/crash/vmcore.elf < /var/crash/vmcore.flat
```

## Enterprise kdump Deployment with systemd

### Ensuring kdump Service Reliability

```bash
# /etc/systemd/system/kdump.service.d/override.conf
[Service]
# Ensure kdump starts after network (for remote dumps)
After=network-online.target
Wants=network-online.target

# Restart on failure
Restart=on-failure
RestartSec=5s
```

### Monitoring kdump Health

```bash
#!/bin/bash
# kdump-health-check.sh — run from cron or monitoring agent

# Check crash kernel is loaded
if [ "$(cat /sys/kernel/kexec_crash_loaded 2>/dev/null)" != "1" ]; then
    echo "CRITICAL: kdump crash kernel not loaded"
    exit 2
fi

# Check kdump service is active
if ! systemctl is-active kdump > /dev/null 2>&1; then
    echo "CRITICAL: kdump service not active"
    exit 2
fi

# Check dump target has sufficient space
DUMP_PATH=$(grep "^path" /etc/kdump.conf | awk '{print $2}')
AVAIL=$(df -BM "$DUMP_PATH" 2>/dev/null | tail -1 | awk '{print $4}' | tr -d M)
if [ "${AVAIL:-0}" -lt 2048 ]; then
    echo "WARNING: kdump dump path has less than 2GB free (${AVAIL}MB)"
    exit 1
fi

echo "OK: kdump operational, crash kernel loaded, ${AVAIL}MB available"
exit 0
```

### Prometheus Node Exporter Textfile for kdump Status

```bash
#!/bin/bash
# /usr/local/bin/kdump-metrics.sh — write to node_exporter textfile dir

METRICS_FILE="/var/lib/node_exporter/textfile_collector/kdump.prom"

crash_loaded=$(cat /sys/kernel/kexec_crash_loaded 2>/dev/null || echo "0")
crash_size=$(cat /proc/iomem 2>/dev/null | grep "Crash kernel" | \
    awk -F'[-:]' '{printf "%d", ("0x"$2 - "0x"$1) / 1048576}')

cat > "$METRICS_FILE" <<EOF
# HELP kdump_crash_kernel_loaded Whether the crash kernel is loaded (1=yes, 0=no)
# TYPE kdump_crash_kernel_loaded gauge
kdump_crash_kernel_loaded ${crash_loaded}

# HELP kdump_crash_kernel_reserved_mib Reserved memory for crash kernel in MiB
# TYPE kdump_crash_kernel_reserved_mib gauge
kdump_crash_kernel_reserved_mib ${crash_size:-0}
EOF
```

## Analyzing Real-World Panic Scenarios

### Scenario: Use-After-Free in Network Driver

```bash
crash> bt
 #0 machine_kexec
 #1 __crash_kexec
 #2 panic
 #3 do_page_fault
 #4 page_fault
    [RIP: net/core/skbuff.c:kfree_skb+0x8e]

# The skb was already freed but something still held a reference
# Check for freed object detection with KASAN (if compiled in):
crash> log | grep "KASAN"
# Shows the allocation/free stack if KASAN was enabled
```

### Scenario: Lock Deadlock

```bash
crash> ps | grep " UN"
# List all processes in uninterruptible sleep — potential deadlock

# For each suspicious PID, trace its wait chain:
crash> bt 1234
# Stack shows process blocked on mutex_lock or spin_lock

# Show lock holder
crash> struct mutex <lock_address>
# owner field shows which task holds the lock
```

## Summary

A fully configured kdump environment transforms opaque production kernel panics into actionable debugging sessions. Key points:

- Size crashkernel reservation conservatively — too small and the crash kernel OOMs during capture.
- Use `makedumpfile -d 31 -l` for production to save disk space while retaining all kernel data.
- Always install matching `kernel-debuginfo` packages — symbol mismatches produce garbage output.
- The `crash` utility `bt`, `log`, `ps`, and `dis` commands answer 90% of panic investigations.
- Load module symbols with `mod -s` when crashes involve loadable kernel modules.
- Monitor kdump health with Prometheus metrics — a non-functional kdump is invisible until a panic occurs.
