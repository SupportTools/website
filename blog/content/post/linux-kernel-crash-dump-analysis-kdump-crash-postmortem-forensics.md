---
title: "Linux Kernel Crash Dump Analysis: kdump, crash, and Production Postmortem Forensics"
date: 2030-10-30T00:00:00-05:00
draft: false
tags: ["Linux", "kdump", "crash", "Kernel", "Debugging", "Incident Response", "Forensics"]
categories:
- Linux
- SRE
author: "Matthew Mattox - mmattox@support.tools"
description: "Kernel crash analysis guide covering kdump configuration and capture, crash tool for vmcore analysis, kernel stack trace interpretation, common kernel panic patterns, live kernel debugging with kdb, and building kernel crash analysis into incident response workflows."
more_link: "yes"
url: "/linux-kernel-crash-dump-analysis-kdump-crash-postmortem-forensics/"
---

When a Linux kernel panics in production, the vmcore file it leaves behind contains the complete state of the machine at the moment of failure: every running process, every kernel data structure, every lock, and the exact sequence of function calls that led to the crash. Extracting actionable information from that file requires the crash utility, debuginfo packages, and knowledge of what kernel structures to examine.

<!--more-->

## Section 1: kdump Architecture and Configuration

### How kdump Works

kdump operates by reserving a small amount of physical memory at boot for a second ("capture") kernel. When the primary kernel panics, the capture kernel boots into this reserved memory and uses `/sbin/makedumpfile` to write a filtered dump of the crashed kernel's memory to disk or a remote location. The capture kernel runs completely independently of the crashed system, making the dump reliable even when the primary kernel's memory allocator is corrupted.

### System Memory Reservation

```bash
# /etc/default/grub — Reserve 256M for capture kernel
# Adjust based on available RAM: typically 10-15% of total RAM, minimum 128M
GRUB_CMDLINE_LINUX="crashkernel=256M"

# For systems with more than 8 GB RAM, use the auto syntax
GRUB_CMDLINE_LINUX="crashkernel=512M,high"

# Update GRUB
grub2-mkconfig -o /boot/grub2/grub.cfg  # RHEL/Rocky
update-grub                               # Debian/Ubuntu

# Verify reservation after reboot
dmesg | grep -i crashkernel
cat /sys/kernel/kexec_crash_size  # 0 means no reservation
```

### kdump Service Configuration

```bash
# Install kdump utilities
# RHEL/Rocky
dnf install -y kexec-tools crash kernel-debuginfo-$(uname -r)

# Debian/Ubuntu
apt-get install -y kdump-tools crash linux-image-$(uname -r)-dbg

# Enable and start kdump
systemctl enable kdump
systemctl start kdump

# Verify kdump is ready
systemctl status kdump
kdumpctl status
```

### /etc/kdump.conf

```bash
# /etc/kdump.conf — Capture kernel configuration

# Write dump to local filesystem
path /var/crash

# Alternatively, write to a remote NFS server
# nfs 192.168.1.50:/exports/crash-dumps

# Alternatively, SSH to remote host
# ssh user@crash-server.internal
# sshkey /root/.ssh/id_ed25519

# Dump filtering level (reduces dump size)
# 0: no filtering (full dump)
# 1: exclude cache pages
# 2: exclude user process pages (default — captures kernel memory only)
# 3: exclude free pages
core_collector makedumpfile -l --message-level 1 -d 31

# Default action after dump is written
default reboot

# Preserve the last N crash dumps
# (not a built-in option; implement via post-script)
# post /usr/local/bin/rotate-crash-dumps.sh

# For systems with kernel text section KASLR (kernel 4.12+)
# makedumpfile will auto-detect KASLR offset
```

### Testing kdump

```bash
# Test that kdump is correctly configured (will crash the system — use in test environment only)
echo 1 > /proc/sysrq-trigger  # s — sync filesystems
echo c > /proc/sysrq-trigger  # c — trigger crash (oops)

# Non-destructive test: verify capture kernel boots correctly
kdumpctl propagate  # Copy necessary files to capture kernel initrd
kdumpctl start      # Load capture kernel via kexec

# Verify dump was written (after simulated crash)
ls -la /var/crash/
```

### Rotating Crash Dumps

Crash dumps can be 2-64 GB. Implement rotation to prevent filling the filesystem:

```bash
#!/usr/bin/env bash
# /usr/local/bin/rotate-crash-dumps.sh
# Called from kdump post hook after dump is written

CRASH_DIR="/var/crash"
MAX_DUMPS=3
MIN_FREE_GB=20

# Check free space
FREE_GB=$(df -BG "$CRASH_DIR" | awk 'NR==2{print $4}' | tr -d 'G')

# Remove oldest dumps if over limit or low on space
DUMP_COUNT=$(ls -dt "$CRASH_DIR"/*/vmcore 2>/dev/null | wc -l)

while [[ $DUMP_COUNT -gt $MAX_DUMPS || $FREE_GB -lt $MIN_FREE_GB ]]; do
    OLDEST=$(ls -dt "$CRASH_DIR"/*/vmcore 2>/dev/null | tail -1)
    if [[ -z "$OLDEST" ]]; then
        break
    fi
    OLDEST_DIR=$(dirname "$OLDEST")
    echo "Removing old crash dump: $OLDEST_DIR"
    rm -rf "$OLDEST_DIR"
    DUMP_COUNT=$(ls -dt "$CRASH_DIR"/*/vmcore 2>/dev/null | wc -l)
    FREE_GB=$(df -BG "$CRASH_DIR" | awk 'NR==2{print $4}' | tr -d 'G')
done
```

## Section 2: The crash Utility

### Opening a vmcore File

```bash
# Install matching debuginfo package
# The kernel version in the vmcore must match the debuginfo version
uname -r  # Note the kernel version on the crashed system
dnf install -y kernel-debuginfo-$(uname -r)  # RHEL/Rocky

# Open the crash dump
crash /usr/lib/debug/lib/modules/$(uname -r)/vmlinux \
  /var/crash/2030-10-30-14:32:18/vmcore

# Or specify both explicitly
crash /path/to/vmlinux /path/to/vmcore
```

### Essential crash Commands

```bash
# Inside the crash shell:

# Show crash reason and system information
crash> sys

# Show kernel version
crash> sys | grep RELEASE

# Show CPU count and system uptime
crash> sys | grep -E "CPUS|UPTIME"

# Show the kernel panic message
crash> dmesg | tail -100

# Show all running processes
crash> ps

# Show process by name
crash> ps | grep nginx

# Show detailed info about a specific process (by PID)
crash> task 1234

# Show kernel stack trace of a process
crash> bt 1234

# Show the stack trace of all threads
crash> foreach bt

# Show currently running process on each CPU at time of crash
crash> runq

# Show the interrupt stack for CPU 0
crash> bt -c 0

# Exit crash
crash> q
```

### Reading the Back Trace

The `bt` command is the starting point for almost every analysis. A typical crash backtrace:

```
crash> bt
PID: 2847   TASK: ffff888101234560  CPU: 3   COMMAND: "kworker/3:2"
 #0 [ffffb2e341147ab8] machine_kexec at ffffffff81062c0e
 #1 [ffffb2e341147b10] __crash_kexec at ffffffff810f3d66
 #2 [ffffb2e341147bd8] crash_kexec at ffffffff810f3e54
 #3 [ffffb2e341147bf0] oops_end at ffffffff810a6168
 #4 [ffffb2e341147c10] no_context at ffffffff8106e8f8
 #5 [ffffb2e341147c68] __bad_area_nosemaphore at ffffffff8106ec6a
 #6 [ffffb2e341147cb0] bad_area_nosemaphore at ffffffff8106f218
 #7 [ffffb2e341147cc0] do_page_fault at ffffffff81072b6e
 #8 [ffffb2e341147cf0] page_fault at ffffffff81a01bce
    [exception RIP: nvme_queue_rq+0x12a]
    RIP: ffffffffc09b4d2a  RSP: ffffb2e341147da0  RFLAGS: 00010202
    RAX: ffff888102345678  RBX: ffff888103456789  RCX: 0000000000000000
    RDX: 0000000000000000  RSI: ffff888104567890  RDI: 0000000000000000
    RBP: ffffb2e341147e00   R8: 0000000000000000   R9: 0000000000000000
    R10: 0000000000000001  R11: 0000000000000000  R12: ffff888105678901
    R13: ffff888106789012  R14: ffff888107890123  R15: ffff888108901234
    ORIG_RAX: ffffffffffffffff  CS: 0010  SS: 0018
 #9 [ffffb2e341147e08] blk_mq_dispatch_rq_list at ffffffff81567c34
#10 [ffffb2e341147e70] blk_mq_do_dispatch_sched at ffffffff8156830a
```

Reading the trace from bottom to top:
- Frame 10: Block layer dispatch scheduler (`blk_mq_do_dispatch_sched`)
- Frame 9: Dispatched to NVMe driver (`blk_mq_dispatch_rq_list`)
- Frame 8: **Crash site** — NVMe queue function (`nvme_queue_rq+0x12a`) caused a page fault
- Frames 7-4: Kernel page fault handler
- Frames 3-0: Crash dump initiation

The crash happened in the NVMe driver at `nvme_queue_rq+0x12a`. The RDI register is NULL (0x0), and a NULL dereference in the NVMe queue path is the likely cause.

## Section 3: Common Kernel Panic Patterns

### Null Pointer Dereference

```
BUG: kernel NULL pointer dereference, address: 0000000000000018
```

```bash
# In crash: find the faulting instruction
crash> dis -l nvme_queue_rq+0x12a
0xffffffffc09b4d2a <nvme_queue_rq+298>: movq  0x18(%rdi),%rax  # dereference NULL+0x18

# rdi was NULL — trace back to where it was set
# Look at frame 9 to see what was passed to nvme_queue_rq
crash> bt -f 1234  # Full frame data with register values
```

### Kernel Oops from Use-After-Free

```
general protection fault, probably for non-canonical address 0x6b6b6b6b6b6b6ba3
```

The value `0x6b6b6b6b...` is a kernel "poisoned" memory signature. `0x6b` is the byte written to freed kernel memory in debug builds (KASAN/SLUB debugging). Seeing this pattern in a GPF means the code accessed freed memory.

```bash
crash> kmem -s 0x6b6b6b6b6b6b6ba3
# Will report: address is in a freed slab object

# Find what slab the address belonged to
crash> kmem -o 0x6b6b6b6b6b6b6ba3
```

### Soft Lockup (CPU Stuck in Kernel Code)

```
BUG: soft lockup - CPU#0 stuck for 22s! [kworker/0:1:1234]
```

Soft lockups occur when a CPU spends more than the soft lockup threshold (default 20 seconds) in kernel mode without scheduling. Common causes: spinlock contention, infinite loops in driver code.

```bash
# In crash: look at the stuck CPU's stack
crash> bt -c 0

# Examine what lock is being waited on
crash> waitq  # Lists processes in wait queues

# Show all tasks in D (uninterruptible) state
crash> ps | grep " D "

# Examine a specific task's wait channel
crash> task 1234
# Look for "in" field showing the wait channel function
```

### Out-of-Memory Killer (OOM)

```
Out of memory: Kill process 4567 (java) score 850 or sacrifice child
```

```bash
# In crash: examine memory statistics at time of crash
crash> kmem -i  # Memory info

# Show slab usage
crash> kmem -s | sort -k3 -n | tail -20

# Show per-zone memory
crash> kmem -z

# Examine the OOM victim process
crash> task 4567
crash> vm 4567  # Virtual memory regions of the process
```

## Section 4: Examining Kernel Data Structures

### Examining the Task Structure

```bash
# Get all details of a process
crash> task 1234

# Show all open file descriptors
crash> files 1234

# Show memory mappings
crash> vm 1234

# Show signal state
crash> sig 1234

# Show process credentials (UID/GID)
crash> task 1234 | grep -A5 "cred"
```

### Examining Network State

```bash
# Show network socket state
crash> net -s

# Show routing table
crash> net -r

# Show network statistics
crash> net -S

# Show all open sockets
crash> foreach files | grep socket
```

### Examining Block I/O State

```bash
# Show I/O scheduler state
crash> runq

# Find processes waiting on I/O
crash> ps | grep " D "  # D = uninterruptible sleep (usually I/O wait)

# Examine a block device queue
crash> struct request_queue ffff888101234567

# Show storage device info
crash> lsmod | grep nvme
crash> mod -s nvme_core  # Show nvme_core module symbols
```

## Section 5: Automated Crash Analysis with crash Scripts

The `crash` utility supports scripting via its command syntax. Create analysis scripts for common patterns:

```bash
#!/usr/bin/env bash
# /usr/local/bin/analyze-crash.sh
# Generates a human-readable crash report

set -euo pipefail

VMCORE="${1:?Usage: $0 <vmcore-path>}"
KERNEL_DIR="${2:-/usr/lib/debug/lib/modules/$(uname -r)}"
VMLINUX="${KERNEL_DIR}/vmlinux"

if [[ ! -f "$VMLINUX" ]]; then
    echo "ERROR: vmlinux not found at $VMLINUX"
    echo "Install: dnf install kernel-debuginfo-$(uname -r)"
    exit 1
fi

REPORT_FILE="crash-report-$(date +%Y%m%d-%H%M%S).txt"

crash "$VMLINUX" "$VMCORE" << 'EOF' > "$REPORT_FILE" 2>&1
# System information
sys
# Kernel message buffer (last 200 lines)
dmesg | tail -200
# Crashed thread stack trace
bt
# All CPUs at time of crash
runq
# All processes
ps
# Processes in D state (I/O wait / uninterruptible)
ps | grep " D "
# Memory statistics
kmem -i
# Top slab consumers
kmem -s
# Module list
lsmod
q
EOF

echo "Report written to $REPORT_FILE"
echo ""
echo "=== Crash Summary ==="
grep -E "PANIC:|BUG:|WARNING:|OOPS:" "$REPORT_FILE" | head -5
```

### crash Command Script for Automated Analysis

Create a `.crash_commands` file for repeatable analysis sessions:

```bash
# /etc/crash/default_analysis.cmd
# Source this in crash for standard analysis

# Set output pager to disable (for scripted analysis)
set scroll off

# Print panic string and backtrace
sys
dmesg | tail -50
bt
runq
foreach bt

# Memory analysis
kmem -i
kmem -s | tail -20

# Check for lock contention
waitq

q
```

```bash
# Run crash with the command script
crash "$VMLINUX" "$VMCORE" < /etc/crash/default_analysis.cmd > analysis.txt 2>&1
```

## Section 6: Live Kernel Debugging with kdb

For non-production or test systems, kdb provides interactive kernel debugging without requiring a crash dump:

```bash
# Enable kdb via sysrq
echo "keyboard" > /sys/module/kdb/parameters/kbd_notifier

# Trigger kdb via sysrq
echo g > /proc/sysrq-trigger

# Or enable kdb in the GRUB command line
GRUB_CMDLINE_LINUX="kgdboc=ttyS0,115200 kgdbwait"
```

Inside kdb:

```bash
# kdb prompt
[0]kdb> help

# Show current process
[0]kdb> ps

# Show all processes
[0]kdb> ps A

# Show stack trace
[0]kdb> bt

# Show registers
[0]kdb> rd

# Examine memory
[0]kdb> md 0xffff888101234567 16  # 16 words starting at address

# Set breakpoint
[0]kdb> bp nvme_queue_rq

# Continue execution
[0]kdb> go
```

### kgdb for Remote Debugging

kgdb exposes the GDB remote serial protocol over a serial connection or network:

```bash
# On target system
# GRUB: kgdboc=eth0 kgdbwait

# On debugging workstation
gdb vmlinux
(gdb) set remotebaud 115200
(gdb) target remote /dev/ttyUSB0
# Or over network:
(gdb) target remote target-host:44444
(gdb) info threads
(gdb) thread 2
(gdb) bt
```

## Section 7: Integrating Crash Analysis into Incident Response

### Automated Crash Detection and Notification

```bash
#!/usr/bin/env bash
# /usr/local/bin/crash-monitor.sh
# Run as a daemon or from cron to detect new crash dumps and alert

CRASH_DIR="/var/crash"
SENTINEL_FILE="/var/run/crash-monitor.last"
ALERT_CMD="slack-notify"  # or any alerting command

last_check=$(cat "$SENTINEL_FILE" 2>/dev/null || echo 0)
now=$(date +%s)
echo "$now" > "$SENTINEL_FILE"

# Find crash directories created since last check
find "$CRASH_DIR" -name vmcore -newer "$SENTINEL_FILE" | while read -r vmcore; do
    crash_dir=$(dirname "$vmcore")
    crash_time=$(stat -c %y "$crash_dir" | cut -d. -f1)
    hostname=$(hostname -f)

    # Generate quick analysis
    analysis=$(crash /usr/lib/debug/lib/modules/$(uname -r)/vmlinux "$vmcore" << 'CRASHEOF' 2>&1
sys
dmesg | tail -30
bt
q
CRASHEOF
)

    # Extract the panic line
    panic_line=$(echo "$analysis" | grep -E "^(PANIC|BUG|Oops)" | head -1)

    # Send alert
    $ALERT_CMD --channel "#incidents" \
      --title "Kernel Panic on $hostname" \
      --body "Time: $crash_time
Crash: $panic_line
Dump: $crash_dir/vmcore
Run: crash /usr/lib/debug/lib/modules/$(uname -r)/vmlinux $crash_dir/vmcore"
done
```

### Crash Dump Kubernetes DaemonSet

For Kubernetes nodes, deploy a DaemonSet that monitors for crash dumps and uploads them to S3:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: crash-dump-collector
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: crash-dump-collector
  template:
    metadata:
      labels:
        app: crash-dump-collector
    spec:
      hostPID: true
      tolerations:
        - operator: Exists
      volumes:
        - name: crash-dir
          hostPath:
            path: /var/crash
            type: DirectoryOrCreate
      containers:
        - name: collector
          image: amazon/aws-cli:2
          command:
            - /bin/bash
            - -c
            - |
              while true; do
                for vmcore in /crashes/*/vmcore; do
                  [[ -f "$vmcore" ]] || continue
                  dir=$(dirname "$vmcore")
                  timestamp=$(basename "$dir")
                  node=$(hostname)
                  dest="s3://crash-dumps-bucket/$node/$timestamp/"
                  if aws s3 ls "$dest" &>/dev/null; then
                    echo "Already uploaded: $dest"
                  else
                    echo "Uploading crash dump from $dir"
                    aws s3 cp --recursive "$dir/" "$dest"
                    echo "Upload complete: $dest"
                  fi
                done
                sleep 60
              done
          env:
            - name: AWS_REGION
              value: us-east-1
          volumeMounts:
            - name: crash-dir
              mountPath: /crashes
          resources:
            requests:
              cpu: 10m
              memory: 32Mi
            limits:
              cpu: 100m
              memory: 128Mi
```

## Section 8: Kernel Panic Prevention and Early Detection

### panic_on_oops Kernel Parameter

By default, some kernel oops conditions do not halt the system. For production systems where data integrity is critical, configure the kernel to panic on any oops:

```bash
# /etc/sysctl.d/99-kernel-panic.conf

# Reboot after kernel panic (seconds; 0 = no auto-reboot)
kernel.panic = 30

# Panic on kernel oops (kernel bug, not just driver bug)
kernel.panic_on_oops = 1

# Panic on soft lockup (may generate too many false positives in busy VMs)
# kernel.softlockup_panic = 1

# Panic on RCU stall (usually indicates deadlock)
# kernel.rcu_cpu_stall_panic = 1

# Panic on memory corruption detection
kernel.panic_on_warn = 0  # Too aggressive for most production systems
```

### KASAN for Development and Staging

The Kernel Address SANitizer detects use-after-free and out-of-bounds memory accesses at runtime with minimal false positives:

```bash
# Kernel config options for KASAN (compile-time)
CONFIG_KASAN=y
CONFIG_KASAN_INLINE=y
CONFIG_KASAN_GENERIC=y

# Note: KASAN increases memory usage by 1/8 and slows the kernel 2-3x
# Not suitable for production, ideal for staging/test
```

### Kernel Memory Checker CronJob

```bash
#!/usr/bin/env bash
# /usr/local/bin/kernel-health-check.sh
# Proactive checks for kernel health indicators

ISSUES=0

# Check for kernel taint flags
TAINT=$(cat /proc/sys/kernel/tainted)
if [[ $TAINT -ne 0 ]]; then
    echo "WARNING: Kernel is tainted (flags=$TAINT)"
    echo "  Bit 0 (1): Module has proprietary license"
    echo "  Bit 1 (2): Module forced load"
    echo "  Bit 2 (4): SMP with non-SMP kernel"
    echo "  Bit 3 (8): Forced module unload"
    echo "  Bit 4 (16): Machine check exception occurred"
    echo "  See: /proc/sys/kernel/tainted_flags"
    ISSUES=$((ISSUES + 1))
fi

# Check for recent OOM events
OOM_COUNT=$(dmesg --since "1 hour ago" 2>/dev/null | grep -c "Out of memory" || echo 0)
if [[ $OOM_COUNT -gt 0 ]]; then
    echo "WARNING: $OOM_COUNT OOM events in the last hour"
    dmesg --since "1 hour ago" | grep "Out of memory" | tail -3
    ISSUES=$((ISSUES + 1))
fi

# Check for kernel stack protection violations
CANARY_COUNT=$(dmesg --since "24 hours ago" 2>/dev/null | grep -c "stack-protector" || echo 0)
if [[ $CANARY_COUNT -gt 0 ]]; then
    echo "CRITICAL: Stack canary violation detected — possible exploitation attempt"
    ISSUES=$((ISSUES + 1))
fi

# Check for MCE (hardware errors)
MCE_COUNT=$(dmesg --since "24 hours ago" 2>/dev/null | grep -c "Machine check" || echo 0)
if [[ $MCE_COUNT -gt 0 ]]; then
    echo "CRITICAL: $MCE_COUNT Machine Check Exception(s) detected"
    ISSUES=$((ISSUES + 1))
fi

# Check for RCU stalls
RCU_COUNT=$(dmesg --since "1 hour ago" 2>/dev/null | grep -c "rcu_sched detected stalls" || echo 0)
if [[ $RCU_COUNT -gt 0 ]]; then
    echo "WARNING: RCU stall detected — possible deadlock or performance issue"
    ISSUES=$((ISSUES + 1))
fi

if [[ $ISSUES -eq 0 ]]; then
    echo "OK: No kernel health issues detected"
fi

exit $ISSUES
```

Kernel crash analysis transforms opaque, catastrophic system failures into diagnosable root causes. The combination of kdump for reliable capture, the crash utility for interactive analysis, and automated tooling for upload and notification creates a complete crash forensics pipeline that can be integrated into standard incident response workflows.
