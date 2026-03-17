---
title: "Linux kdump and Crash Analysis: Configuring Kernel Crash Dumps and Analyzing Core Dumps with crash"
date: 2031-09-21T00:00:00-05:00
draft: false
tags: ["Linux", "kdump", "Crash Analysis", "Kernel", "Debugging", "System Administration"]
categories:
- Linux
- System Administration
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to configuring Linux kdump for kernel crash capture, analyzing vmcore files with the crash utility, interpreting kernel panics, and integrating crash analysis into production incident response workflows."
more_link: "yes"
url: "/linux-kdump-crash-analysis-kernel-core-dumps/"
---

A kernel panic on a production system is one of the most disruptive events a systems engineer faces. Without a kernel crash dump, you are left with whatever the serial console or IPMI remote console captured before the screen froze — often just a partial stack trace, sometimes nothing at all. With kdump properly configured, the kernel's final memory state is captured to disk by a second mini-kernel, giving you a complete snapshot of what happened: the call stack, the CPU registers, the contents of kernel data structures, the list of running processes, and the memory allocator state at the moment of the crash.

This post covers kdump configuration end-to-end on RHEL/Rocky Linux and Ubuntu, crash analysis with the `crash` utility, common panic signatures and their interpretation, and integration of crash analysis into production incident response.

<!--more-->

# Linux kdump and Crash Analysis

## How kdump Works

kdump operates in two phases:

**Phase 1: Capture kernel boot** — At normal system startup, a second compressed kernel image (the "capture kernel" or "kdump kernel") is loaded into a reserved portion of memory, set aside exclusively for crash capture. This reserved region is configured via `crashkernel=` on the kernel command line.

**Phase 2: Crash capture** — When the production kernel panics, the hardware CPU is reset and boots into the capture kernel. The capture kernel can access the crashed kernel's memory (which is still intact because it was not overwritten during the reset) and writes the contents to a vmcore file, then reboots normally.

The critical insight is that the capture kernel runs in a completely fresh environment — no corrupted kernel state, no locked spinlocks, no unreachable filesystems — while having read-only access to the crashed kernel's memory.

## Installation and Configuration

### RHEL 9 / Rocky Linux 9 / AlmaLinux 9

```bash
# Install kdump packages
dnf install -y kexec-tools crash kernel-debuginfo

# Enable kdump service
systemctl enable --now kdump

# Verify status
kdumpctl status
```

Configure `/etc/kdump.conf`:

```bash
# /etc/kdump.conf

# Where to save the vmcore
# Option 1: Local path
path /var/crash

# Option 2: NFS mount (recommended for production - local disk may fail)
# nfs my-crash-server.example.com:/exports/crashes

# Option 3: SSH remote copy
# ssh root@crash-server.example.com
# sshkey /root/.ssh/kdump_rsa

# Core compression
core_collector makedumpfile -l --message-level 1 -d 31

# What to do after capture (reboot, halt, shell, etc.)
default reboot

# Filter levels for makedumpfile:
# 0 = zero pages (free memory)    - save, saves space
# 1 = cache pages                 - exclude, usually not needed
# 2 = cache private               - exclude
# 4 = user pages                  - exclude for kernel analysis
# 8 = free pages                  - exclude
# 16 = huge pages                 - exclude
# -d 31 = exclude levels 1+2+4+8+16 (keep only kernel pages)
```

Configure the boot parameter in `/etc/default/grub`:

```bash
# Add crashkernel to GRUB_CMDLINE_LINUX
GRUB_CMDLINE_LINUX="crashkernel=auto quiet"
```

For systems with more than 4 GB RAM, use explicit sizing:

```bash
# Reserve 512 MB for the capture kernel, starting at 256 MB offset
GRUB_CMDLINE_LINUX="crashkernel=512M,high crashkernel=72M,low"
```

```bash
# Rebuild GRUB config and reboot
grub2-mkconfig -o /boot/grub2/grub.cfg
reboot
```

Verify the reservation:

```bash
cat /proc/cmdline | grep crashkernel
# ... crashkernel=512M,high crashkernel=72M,low ...

cat /proc/iomem | grep "Crash kernel"
# 10000000-4fffffff : Crash kernel
```

### Ubuntu 22.04 / 24.04

```bash
# Install packages
apt install -y linux-crashdump crash makedumpfile

# Enable kdump during installation or after
dpkg-reconfigure linux-crashdump
# Select "Yes" when asked to enable kdump

# Verify
systemctl status kdump-tools

# Configuration file
cat /etc/default/kdump-tools
```

Ubuntu configuration:

```bash
# /etc/default/kdump-tools

USE_KDUMP=1
KDUMP_SYSCTL="kernel.panic_on_oops=1"

# Where to save
KDUMP_COREDIR="/var/crash"

# Compression
MAKEDUMP_ARGS="-c -d 31"

# Auto-reboot after capture
KDUMP_FAIL_CMD="reboot -f"
KDUMP_DUMP_DMESG=1
```

## Testing kdump Configuration

Test that kdump is configured correctly without waiting for a real kernel panic:

```bash
# DANGEROUS: This will crash the system and trigger kdump
# Test on a non-production system or in a VM
echo c > /proc/sysrq-trigger

# After reboot, check for the vmcore
ls -la /var/crash/
# drwxr-xr-x  2 root root 4096 Sep 21 03:42 2031-09-21-03:42/

ls -la /var/crash/2031-09-21-03:42/
# -rw------- 1 root root 89156608  vmcore
# -rw-r--r-- 1 root root     4096  vmcore-dmesg.txt
```

## The crash Utility

The `crash` utility is an interactive debugger for kernel core dumps, built on top of GDB. It requires:

1. The vmcore file (from kdump)
2. The `vmlinux` file (the uncompressed kernel with debug symbols)

```bash
# Install debug symbols (RHEL/Rocky)
dnf debuginfo-install kernel-$(uname -r)

# Install debug symbols (Ubuntu)
apt install linux-image-$(uname -r)-dbgsym

# Locate vmlinux
ls /usr/lib/debug/lib/modules/$(uname -r)/vmlinux
# or
ls /usr/lib/debug/boot/vmlinux-$(uname -r)

# Launch crash
crash /usr/lib/debug/lib/modules/$(uname -r)/vmlinux \
      /var/crash/2031-09-21-03:42/vmcore
```

You will see output like:

```
      KERNEL: /usr/lib/debug/lib/modules/6.1.0-26-amd64/vmlinux
    DUMPFILE: /var/crash/2031-09-21-03:42/vmcore  [PARTIAL DUMP]
        CPUS: 8
        DATE: Mon Sep 21 03:42:17 EDT 2031
      UPTIME: 3 days, 14:22:31
LOAD AVERAGE: 0.12, 0.08, 0.03
       TASKS: 312
    NODENAME: prod-worker-03
     RELEASE: 6.1.0-26-amd64
     VERSION: #1 SMP Debian 6.1.112-1 (2031-09-10)
     MACHINE: x86_64  (3200 Mhz)
      MEMORY: 62.8 GB
       PANIC: "Oops: general protection fault, probably for non-canonical address 0xdead000000000100: 0000 [#1] PREEMPT SMP NOPTI"
         PID: 8421
     COMMAND: "myapp"
      KERNEL: /usr/lib/debug/lib/modules/6.1.0-26-amd64/vmlinux
        TASK: ffff8881f3a84000  [THREAD_INFO: ffff8881f3a84000]
         CPU: 3
       STATE: TASK_RUNNING (PANIC)

crash>
```

## Essential crash Commands

### bt — Back Trace

The most important command. Shows the kernel call stack at the time of the crash:

```
crash> bt
PID: 8421   TASK: ffff8881f3a84000  CPU: 3   COMMAND: "myapp"
 #0 [ffff88820ee03a60] machine_kexec at ffffffff81063750
 #1 [ffff88820ee03ab0] __crash_kexec at ffffffff811cc030
 #2 [ffff88820ee03b70] crash_kexec at ffffffff811cc11c
 #3 [ffff88820ee03b88] oops_end at ffffffff81021e58
 #4 [ffff88820ee03ba8] exc_general_protection at ffffffff81a22e7c
 #5 [ffff88820ee03bc8] asm_exc_general_protection at ffffffff81c01152
    [exception RIP: kmem_cache_alloc+0x97]
    RIP: ffffffff81338db7  RSP: ffff88820ee03c78  RFLAGS: 00010086
    RAX: dead000000000100  RBX: 000000000000000c  RCX: 0000000000000000
    RDX: 0000000000000000  RSI: 00000000000000c0  RDI: ffff888100003600
    ...
 #6 [ffff88820ee03c80] my_driver_allocate at ffffffffc0a1b2c3 [my_driver]
 #7 [ffff88820ee03cd0] my_driver_write at ffffffffc0a1b4e7 [my_driver]
 #8 [ffff88820ee03d00] vfs_write at ffffffff81348c2a
```

The magic value `0xdead000000000100` is a poison value placed by the kernel slab allocator into freed objects. Its appearance in `RAX` means the code tried to dereference a pointer that had already been freed — a use-after-free bug.

### bt -a — All CPUs

```
crash> bt -a
PID: 0    TASK: ffffffff82812780  CPU: 0   COMMAND: "swapper/0"
 #0 [fffffe0000000f10] crash_nmi_callback at ffffffff81063540
 ...

PID: 0    TASK: ffff888200115780  CPU: 1   COMMAND: "swapper/1"
 ...
```

### ps — Process List

```
crash> ps
   PID    PPID  CPU       TASK        ST  %MEM     VSZ    RSS  COMM
      0       0   0  ffffffff82812780  RU   0.0       0      0  swapper/0
      1       0   0  ffff888200114800  IN   0.0  168260   7480  systemd
   8421    8400   3  ffff8881f3a84000  RU   0.1  234560  45320  myapp   <<ACTIVE>>
```

### dmesg — Kernel Ring Buffer

```
crash> dmesg | tail -50
[432851.234567] BUG: unable to handle page fault for address: dead000000000100
[432851.234589] #PF: supervisor write access in kernel mode
[432851.234601] #PF: error_code(0x0002) - not-present page
[432851.234615] PGD 0 P4D 0
[432851.234625] Oops: 0002 [#1] PREEMPT SMP NOPTI
[432851.234638] CPU: 3 PID: 8421 Comm: myapp Tainted: G           OE
[432851.234651] Hardware name: Dell PowerEdge R750, BIOS 2.18.1
```

### struct — Inspect Kernel Structures

```
crash> struct task_struct ffff8881f3a84000
struct task_struct {
  thread_info = {
    flags = 2097152,
    status = 0
  },
  __state = 0,
  stack = 0xffff88820ee00000,
  usage = {
    counter = 2
  },
  flags = 4194624,
  ptrace = 0,
  on_cpu = 1,
  ...
  comm = "myapp\000\000\000\000\000\000\000\000\000\000",
  pid = 8421,
  ...
}
```

### kmem — Memory Information

```
crash> kmem -i
                 PAGES        TOTAL      PERCENTAGE
    TOTAL MEM  16244686      62.1 GB         ----
         FREE    234567       917 MB    1% of TOTAL MEM
         USED  16010119      61.2 GB   98% of TOTAL MEM
       SHARED    123456       482 MB    0% of TOTAL MEM
      BUFFERS     45678       178 MB    0% of TOTAL MEM
       CACHED   8901234      34.0 GB   54% of TOTAL MEM
         SLAB   1234567       4.7 GB    7% of TOTAL MEM
```

### log — System Log Messages

```
crash> log | grep -A5 "Oops"
```

### mod — Loaded Modules

```
crash> mod
     MODULE       NAME          SIZE  OBJECT FILE
ffffffffc0a1a000  my_driver    65536  (not loaded)
ffffffffc0a1b000  vfio          98304  (not loaded)
```

### sym — Symbol Lookup

```
crash> sym kmem_cache_alloc
ffffffff81338d20 (T) kmem_cache_alloc /build/linux/mm/slab_common.c: 1067

crash> sym -l ffffffffc0a1b2c3
ffffffffc0a1b2c3 (t) my_driver_allocate+0x83 [my_driver]
```

## Common Panic Signatures

### Use-After-Free

```
RIP: kmem_cache_alloc+0x97
RAX: dead000000000100
```

The value `0xdead000000000100` (and nearby values like `0xdead000000000200`) are SLUB/SLAB poison values. This almost always indicates a use-after-free or a double-free bug.

Analysis steps:
1. Find the structure that was freed
2. Trace back to where the free occurred
3. Find where the second access happened

### NULL Pointer Dereference

```
BUG: unable to handle page fault for address: 0000000000000000
```

or near-null (offset within a struct):

```
BUG: unable to handle page fault for address: 0000000000000048
```

The second form suggests a valid pointer to a structure where a member at offset 0x48 was NULL.

```bash
crash> struct -o net_device | grep 0x48
  [48] struct net_device_ops *netdev_ops;
```

This tells you `netdev_ops` was NULL in a `net_device` structure.

### Stack Overflow

```
PANIC: "kernel stack overflow detected"
```

```
crash> bt -s 8421
   [stack trace with stack overflow indicators]
```

Check kernel stack depth configuration:

```bash
# Stack size is typically 8KB or 16KB
grep KSTACK /boot/config-$(uname -r)
# CONFIG_THREAD_INFO_IN_TASK=y
# CONFIG_THREAD_SIZE_ORDER=2   # 2^2 × 4096 = 16384 bytes
```

### Hung Task / RCU Stall

```
INFO: task kworker/1:1:234 blocked for more than 120 seconds.
```

```
crash> ps | grep UN
  8421  8400   3  ffff8881f3a84000  UN   0.1  234560  45320  myapp
crash> bt 8421
```

Look for spinlock contentions, sleeping in atomic context, or live locks.

### Out-of-Memory

```
Out of memory: Kill process 8421 (myapp) score 892 or sacrifice child
```

```
crash> kmem -i
# Check memory usage
crash> ps | sort -k8 -rn | head
# Find highest memory users at time of crash
```

## Automating Crash Analysis

Create a crash analysis script for consistent incident response:

```bash
#!/bin/bash
# analyze-crash.sh - Automated crash analysis

VMCORE="${1:-$(ls -t /var/crash/*/vmcore 2>/dev/null | head -1)}"
VMLINUX="/usr/lib/debug/lib/modules/$(uname -r)/vmlinux"
REPORT_DIR="/var/crash/reports/$(date +%Y%m%d-%H%M%S)"

if [ ! -f "$VMCORE" ]; then
    echo "ERROR: vmcore not found: $VMCORE"
    exit 1
fi

if [ ! -f "$VMLINUX" ]; then
    echo "ERROR: vmlinux not found: $VMLINUX"
    echo "Install: dnf debuginfo-install kernel-$(uname -r)"
    exit 1
fi

mkdir -p "$REPORT_DIR"

CRASH_SCRIPT=$(mktemp)
cat > "$CRASH_SCRIPT" <<'EOF'
# Auto-analysis script for crash
set height 0
set width 200

echo "=== PANIC MESSAGE ==="
log | tail -100

echo ""
echo "=== ACTIVE TASK BACKTRACE ==="
bt

echo ""
echo "=== ALL CPU BACKTRACES ==="
bt -a

echo ""
echo "=== PROCESS LIST (sorted by state) ==="
ps

echo ""
echo "=== MEMORY INFORMATION ==="
kmem -i

echo ""
echo "=== SLAB INFORMATION ==="
kmem -s

echo ""
echo "=== LOADED MODULES ==="
mod

echo ""
echo "=== IRQ INFORMATION ==="
irq

quit
EOF

echo "Analyzing crash dump: $VMCORE"
echo "Output: $REPORT_DIR/crash-report.txt"

crash "$VMLINUX" "$VMCORE" < "$CRASH_SCRIPT" > "$REPORT_DIR/crash-report.txt" 2>&1

# Extract the panic message for quick reference
PANIC=$(grep "PANIC:" "$REPORT_DIR/crash-report.txt" | head -1)
COMMAND=$(grep "COMMAND:" "$REPORT_DIR/crash-report.txt" | head -1)
DATE=$(grep "DATE:" "$REPORT_DIR/crash-report.txt" | head -1)

# Generate summary
cat > "$REPORT_DIR/summary.txt" <<EOF
=== CRASH SUMMARY ===
System: $(hostname)
$DATE
$PANIC
$COMMAND

Vmcore: $VMCORE
Size: $(du -h "$VMCORE" | cut -f1)
Full report: $REPORT_DIR/crash-report.txt
EOF

cat "$REPORT_DIR/summary.txt"
rm -f "$CRASH_SCRIPT"
```

## Configuring Remote Crash Collection

For production fleets, shipping vmcore files to a central server is essential:

```bash
# /etc/kdump.conf for SSH remote collection
ssh root@crash-collector.internal.example.com
sshkey /root/.ssh/kdump_id_rsa
path /var/crash
core_collector makedumpfile -c -d 31
default reboot
```

Set up the SSH key without a passphrase (kdump runs before SSH agent):

```bash
# Generate dedicated kdump key
ssh-keygen -t ed25519 -f /root/.ssh/kdump_id_rsa -N ""
ssh-copy-id -i /root/.ssh/kdump_id_rsa.pub root@crash-collector.internal.example.com

# Test connection
kdumpctl propagate

# Rebuild initrd with the key
kdumpctl rebuild
```

Crash collector server configuration:

```bash
# On crash-collector: create receiving directories per host
for host in worker-01 worker-02 worker-03; do
    mkdir -p /var/crash/$host
done

# Rsyslog rule to alert on new crash files
cat > /etc/rsyslog.d/kdump-alert.conf <<'EOF'
template(name="kdump_notify" type="string"
  string="New kernel crash dump from %HOSTNAME% at %timegenerated%\n")

if $msg contains 'kdump' then
  action(type="ommail"
    server="smtp.internal.example.com"
    to="oncall@example.com"
    from="kdump-alerts@example.com"
    subject.template="kdump_notify")
EOF
```

## Integration with PagerDuty / Alerting

```bash
# /etc/kdump.conf - custom post-capture script
post_core_collector_script /usr/local/bin/kdump-alert.sh
```

```bash
#!/bin/bash
# /usr/local/bin/kdump-alert.sh
# Called by kdump after core collection

VMCORE_PATH="$1"
HOSTNAME=$(hostname)
TIMESTAMP=$(date -Iseconds)

# Quick panic extraction from dmesg
PANIC_MSG=$(dmesg | grep -E "(Oops|BUG|PANIC|Kernel panic)" | tail -3 | tr '\n' ' ')

# Send PagerDuty alert
curl -s -X POST https://events.pagerduty.com/v2/enqueue \
    -H "Content-Type: application/json" \
    -d "{
        \"routing_key\": \"<pagerduty-routing-key>\",
        \"event_action\": \"trigger\",
        \"payload\": {
            \"summary\": \"Kernel panic on $HOSTNAME\",
            \"severity\": \"critical\",
            \"source\": \"$HOSTNAME\",
            \"custom_details\": {
                \"panic_message\": \"$PANIC_MSG\",
                \"vmcore_path\": \"$VMCORE_PATH\",
                \"timestamp\": \"$TIMESTAMP\"
            }
        }
    }" > /dev/null

echo "Alert sent for crash on $HOSTNAME"
```

## Storage Planning for vmcore Files

vmcore files can be large. The `makedumpfile` compression and filtering are essential:

| Filter Level | What is excluded | Typical size (32 GB RAM) |
|--------------|-----------------|--------------------------|
| `-d 0` | Nothing | 32 GB |
| `-d 1` | Zero pages | 8 GB |
| `-d 17` | Zero + cache + free | 2 GB |
| `-d 31` | All non-kernel pages | 500 MB - 2 GB |

For 100-node fleets with 32 GB RAM each, using `-d 31` and `-c` (zlib compression):

```
Estimated storage: 100 nodes × 2 GB × 30 day retention = 6 TB
```

A dedicated NFS or S3-backed storage volume is recommended over local disk on each node.

## Summary

kdump provides an irreplaceable safety net for production Linux systems. The one-time configuration cost — installing packages, reserving crash kernel memory, configuring the capture target — pays dividends the moment you encounter an unexplained kernel panic. Combined with the `crash` utility and debug symbols, you can typically identify the root cause of a kernel panic within an hour of the event: finding the panicking task, reading the call stack, identifying poison values or NULL pointers, and correlating with loaded kernel modules. Automating the collection and initial analysis steps means that the on-call engineer receives a structured report rather than a blank terminal.
