---
title: "Linux Kdump and Crash Analysis: Kernel Panic Investigation in Production Systems"
date: 2030-12-29T00:00:00-05:00
draft: false
tags: ["Linux", "kdump", "crash", "kernel", "debugging", "vmcore", "kexec", "SRE"]
categories:
- Linux
- Operations
- Debugging
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux kdump kernel crash dump collection and analysis using the crash tool, covering kexec configuration, dump targets (local/NFS/SSH), crash tool commands for analyzing kernel panics and OOM events, vmcore analysis workflow, and automated crash reporting pipelines."
more_link: "yes"
url: "/linux-kdump-crash-analysis-kernel-panic-investigation/"
---

A kernel panic in a production system is one of the most opaque failures an operations team faces. Without a crash dump, you have kernel logs that may be incomplete, console output that may have scrolled, and no way to examine the kernel's state at the moment of failure. Kdump solves this by using kexec to boot a secondary "capture kernel" that runs when the main kernel panics, saves the memory dump, and reboots into the normal kernel. This guide covers the complete kdump workflow from configuration through crash analysis.

<!--more-->

# Linux Kdump and Crash Analysis: Kernel Panic Investigation in Production Systems

## Understanding kexec and kdump Architecture

**kexec** allows loading a new kernel into memory and executing it directly, bypassing BIOS/UEFI. The crash kernel is loaded at boot time into a reserved memory region (configured via `crashkernel=` kernel parameter). When a panic occurs:

1. The panicking kernel invokes `machine_crash_shutdown()`
2. kexec transfers execution to the crash kernel
3. The crash kernel boots in a minimal environment with access to the original kernel's memory
4. `/proc/vmcore` provides access to the crashed kernel's memory
5. makedumpfile or dd captures the dump to storage
6. The system reboots normally

The critical requirement is that the crash kernel must complete before the memory is overwritten. This means the capture process runs in a minimal initrd environment with no network file system or complex storage drivers that might fail.

## Installing and Configuring kdump

### RHEL/CentOS/Fedora

```bash
# Install kdump tools
dnf install -y kexec-tools crash kernel-debuginfo kernel-debuginfo-common

# Enable and start kdump service
systemctl enable kdump
systemctl start kdump

# Check kdump status
kdumpctl status
```

### Debian/Ubuntu

```bash
# Install crash dump utilities
apt-get install -y linux-crashdump makedumpfile crash

# Enable kdump via kernel parameter (Ubuntu uses linux-crashdump)
dpkg-reconfigure -plow linux-crashdump
# Select "Yes" when asked to enable kdump

# Verify kdump is enabled
cat /etc/default/kdump-tools
```

### Kernel Parameter Configuration

The `crashkernel` parameter reserves memory for the crash kernel:

```bash
# Check current kernel parameters
cat /proc/cmdline

# For systems with < 4GB RAM
crashkernel=128M

# For systems with 4-64GB RAM (recommended)
crashkernel=256M

# For systems with > 64GB RAM
crashkernel=512M

# Auto-size based on available memory (RHEL 8+)
crashkernel=auto

# Specify memory range (high/low)
# Required for systems with IOMMU or large memory configurations
crashkernel=256M,high
crashkernel=72M,low

# Edit GRUB configuration
# RHEL/CentOS:
grubby --update-kernel=ALL --args="crashkernel=256M"

# Ubuntu:
sed -i 's/GRUB_CMDLINE_LINUX_DEFAULT="/GRUB_CMDLINE_LINUX_DEFAULT="crashkernel=256M /' /etc/default/grub
update-grub

# Verify after reboot
grep crashkernel /proc/cmdline
```

### kdump Configuration File

```bash
# /etc/kdump.conf - comprehensive production configuration

# Storage target - choose ONE of the following:

# Option 1: Local filesystem dump (simplest, requires enough disk space)
path /var/crash

# Option 2: Raw disk (fastest, for dedicated dump partitions)
# raw /dev/sdb1

# Option 3: NFS mount (for centralized dump collection)
# nfs 10.0.1.5:/exports/kdumps
# path /hostname

# Option 4: SSH target (most secure, suitable for high-security environments)
# ssh user@dump-server.example.com
# sshkey /root/.ssh/kdump_rsa
# path /var/crash

# Option 5: iSCSI target
# iSCSI configuration requires additional setup

# Core collection settings
core_collector makedumpfile -l --message-level 7 -d 31

# -l: compression (lzo algorithm)
# -d 31: dump level bits:
#   bit 0: zero pages
#   bit 1: cache pages
#   bit 2: cache private pages
#   bit 3: user pages
#   bit 4: free pages
# Sum of bits 0-4 = 31: exclude all non-essential pages

# Alternatively for full dump (debugging complex issues):
# core_collector makedumpfile -c --message-level 7 -d 0
# -d 0: include all pages
# -c: gzip compression (slower but smaller)

# Post-dump script (called after dump completes)
# post_reboot_script /etc/kdump/post-reboot.sh

# Default action if kdump fails
failure_action reboot  # or 'halt', 'poweroff', 'shell'

# Disk space requirements
force_rebuild 0
disk_timeout 30

# Additional modules needed in initrd
# extra_modules = ahci nvme virtio_blk

# Blacklist modules that might conflict
# module_blacklist nvidiafb
```

### Verifying kdump Is Ready

```bash
# Check kdump service status
systemctl status kdump

# Verify crash kernel is loaded
cat /sys/kernel/kexec_crash_loaded
# Should output: 1

# Check reserved memory
cat /proc/iomem | grep -i crash
# Example: f0000000-ffffffff : Crash kernel

# Test kdump without rebooting (optional, DISRUPTS THE SYSTEM)
# WARNING: This will crash the system!
# echo 1 > /proc/sysrq-trigger  # Only on test systems!

# Simulate kdump to verify configuration without actual crash
kdumpctl propagate  # Tests SSH key distribution for remote dumps
kdumpctl show-mem   # Shows memory settings
```

## NFS and SSH Target Configuration

### NFS Target Setup

```bash
# On the dump server:
# Install NFS server
dnf install nfs-utils
mkdir -p /exports/kdumps
chmod 755 /exports/kdumps

# Configure exports (restrict by IP for security)
cat >> /etc/exports << 'EOF'
/exports/kdumps 10.0.0.0/24(rw,sync,no_root_squash,no_subtree_check)
EOF

exportfs -ra
systemctl enable --now nfs-server

# On the production system:
cat > /etc/kdump.conf << 'EOF'
nfs 10.0.1.5:/exports/kdumps
path /crash
core_collector makedumpfile -l --message-level 7 -d 31
failure_action reboot
EOF

# Rebuild initrd with NFS support
kdumpctl rebuild

# Test the configuration
kdumpctl propagate
```

### SSH Target Setup

SSH is more secure than NFS as it encrypts the dump in transit:

```bash
# Generate dedicated SSH key for kdump (no passphrase)
ssh-keygen -t rsa -b 4096 -N "" -f /root/.ssh/kdump_rsa

# Copy the public key to the dump server
ssh-copy-id -i /root/.ssh/kdump_rsa.pub dump@10.0.1.5

# Configure kdump.conf
cat > /etc/kdump.conf << 'EOF'
ssh dump@10.0.1.5
sshkey /root/.ssh/kdump_rsa
path /var/crash
core_collector makedumpfile -l --message-level 7 -d 31
failure_action reboot
EOF

# Rebuild initrd with SSH support
kdumpctl rebuild

# Test connectivity
kdumpctl propagate
# Should output: OK

# Verify the setup
kdumpctl status
```

## Triggering Test Panics Safely

For testing kdump in staging/test environments:

```bash
# Method 1: sysrq (immediate kernel panic)
# WARNING: Will crash the system immediately!
echo 1 > /proc/sysrq-trigger

# Method 2: Kernel panic via /proc/sysrq-trigger (safer on test VMs)
echo c > /proc/sysrq-trigger  # 'c' = crash/panic

# Method 3: netdump trigger (triggers over network for automation)
# Requires netconsole setup

# Method 4: Software-induced panic via systemd
# For testing without system reboot, use virtual machine
virsh inject-nmi <vm-name>

# Check dump was created
ls -la /var/crash/
```

## Analyzing Crash Dumps with the crash Tool

The `crash` utility from Red Hat is the standard tool for analyzing Linux kernel crash dumps. It provides a gdb-like interface to the crash dump.

### Starting a Crash Analysis Session

```bash
# Basic invocation
crash /boot/vmlinuz-$(uname -r) /var/crash/$(ls -t /var/crash/ | head -1)/vmcore

# With debug info from separate package
crash /usr/lib/debug/lib/modules/$(uname -r)/vmlinux \
      /var/crash/$(ls -t /var/crash/ | head -1)/vmcore

# Example session start output:
#       KERNEL: /usr/lib/debug/lib/modules/5.14.0-427.16.1.el9_4.x86_64/vmlinux
#     DUMPFILE: /var/crash/2024-12-29-14:30:00/vmcore
#         CPUS: 8
#         DATE: Mon Dec 29 14:29:57 UTC 2024
#       UPTIME: 47 days, 03:22:51
# LOAD AVERAGE: 2.47, 2.31, 2.18
#        TASKS: 1247
#     NODENAME: prod-server-01
#      RELEASE: 5.14.0-427.16.1.el9_4.x86_64
#      VERSION: #1 SMP PREEMPT_DYNAMIC Mon May 20 08:45:39 EDT 2024
#      MACHINE: x86_64  (2394 Mhz)
#       MEMORY: 31.8 GB
#        PANIC: "Oops: general protection fault..." <-- or "Kernel panic"
#          PID: 12345
#      COMMAND: "myapp"
#       KERNEL: 5.14.0-427.16.1.el9_4.x86_64
# crash>
```

### Essential crash Commands

```bash
# In crash session:

# Show why the system crashed
crash> sys
crash> log              # Kernel message buffer (dmesg equivalent)
crash> log -T           # With timestamps

# Show all processes at time of crash
crash> ps              # All processes
crash> ps -a           # All processes with arguments
crash> ps -G           # All processes with group info

# Show the process that triggered the crash
crash> task            # Current task (caused the crash)
crash> task -x         # With hex addresses

# Backtrace - most critical for understanding the crash
crash> bt              # Backtrace of crashed process
crash> bt -a           # Backtraces of ALL processes (use carefully on large systems)
crash> bt -f           # Full backtrace with frame data
crash> bt <pid>        # Backtrace of specific PID

# Memory information
crash> kmem -i         # Kernel memory usage summary
crash> kmem -s         # Slab allocator statistics
crash> kmem -f         # Free memory
crash> kmem -S         # Per-NUMA node statistics

# Virtual memory
crash> vm             # Virtual memory of current task
crash> vm <pid>       # Virtual memory of specific process

# Files and network
crash> files          # Open files of current task
crash> net            # Network state summary
crash> net -a         # All network interfaces
crash> net -s         # Socket table

# Kernel data structures
crash> struct task_struct <address>  # Print task_struct contents
crash> list task_struct.tasks ffffXXX  # Follow linked list

# Search kernel memory
crash> search -k <value>    # Search kernel memory for value
crash> search -u <pid> <value>  # Search process memory

# CPU information
crash> cpu             # CPU state at crash
crash> irq             # IRQ statistics

# Exit crash
crash> quit
```

### Analyzing a Kernel Oops

Kernel oops messages follow a standard format. Here is how to decode them:

```
BUG: unable to handle kernel NULL pointer dereference at 0000000000000068
PGD 0 P4D 0
Oops: 0002 [#1] SMP NOPTI
CPU: 3 PID: 12345 Comm: myapp Tainted: G        W  OE     5.14.0-427 #1
Hardware name: VMware, Inc. VMware Virtual Platform/440BX Desktop Reference Platform
RIP: 0010:netif_receive_skb_core+0x1a8/0xe80
```

Breaking down the information:
- `NULL pointer dereference at 0x68`: Accessing offset 0x68 from a null pointer (usually a null struct member)
- `Oops: 0002`: Error code bits (bit 0=page not present, bit 1=write, bit 2=user mode)
- `CPU: 3 PID: 12345`: Which CPU and process was running
- `RIP: 0010:netif_receive_skb_core+0x1a8`: Instruction pointer in `netif_receive_skb_core` at offset 0x1a8

```bash
# In crash session, decode the crash location
crash> dis netif_receive_skb_core+0x1a8
# Shows the exact instruction that faulted

# Print the function
crash> dis -l netif_receive_skb_core | less

# Find the source file/line for this address
crash> sym 0xffffffffc0a5b1a8  # Convert address to symbol

# Get the full backtrace
crash> bt 12345
#  PID: 12345  TASK: ffff8881234567a0  CPU: 3   COMMAND: "myapp"
# #0  netif_receive_skb_core
# #1  netif_receive_skb
# #2  net_rx_action
# #3  __do_softirq
# #4  asm_call_irq_on_stack
```

### Analyzing an OOM Kill Event

```bash
# Look for OOM kill in kernel log
crash> log | grep -E "(Out of memory|OOM|oom_kill)"

# Find the process that was killed
crash> log | grep -A 5 "Out of memory"
# Output will show the killed process PID and memory state

# Examine memory state at crash
crash> kmem -i
crash> kmem -S  # NUMA statistics

# Find slab memory consumers (memory leaks often show here)
crash> kmem -s | sort -k7 -rn | head -20

# Examine specific slab cache
crash> kmem -s dentry  # dentries are often memory leak culprits
```

### Analyzing a Deadlock or Hung Task

```bash
# Show all waiting processes
crash> ps -p  # Show processes in various states
# D = uninterruptible sleep (disk wait or lock wait)
# K = running in kernel

# Find processes stuck in D state
crash> ps | grep " D "

# Examine the stuck process
crash> bt <pid>
# Look for lock-related functions in the backtrace

# Show mutex/spinlock holders
crash> runq  # Show running processes per CPU

# Check lock statistics
crash> lockdep  # Requires CONFIG_LOCKDEP

# Examine wait queues
crash> waitq   # Show wait queue contents
```

### Analyzing Memory Corruption

```bash
# Show the exact memory contents around a faulting address
crash> rd 0xffff8881234567a0 32  # Read 32 quads from address

# Check if a pointer looks valid (within kernel address space)
crash> sym <address>

# Look for pattern in memory (useful for finding corrupted structures)
crash> search -s 0xdeadbeef    # Search for stack canary violations

# Examine page flags
crash> page <address>

# Show physical memory map
crash> ptov <phys_addr>  # Physical to virtual address conversion
crash> vtop <virt_addr>  # Virtual to physical address conversion
```

## Automated Crash Analysis Pipeline

### Crash Report Generation Script

```bash
#!/bin/bash
# /usr/local/bin/analyze-crash.sh
# Automated crash dump analysis for production systems

CRASH_DIR="${1:-/var/crash}"
OUTPUT_DIR="${2:-/var/log/crash-reports}"
KERNEL_DEBUG="/usr/lib/debug/lib/modules/$(uname -r)/vmlinux"

# Find the most recent crash dump
LATEST_DUMP=$(find "$CRASH_DIR" -name "vmcore" -printf '%T@ %p\n' 2>/dev/null | \
    sort -n | tail -1 | awk '{print $2}')

if [ -z "$LATEST_DUMP" ]; then
    echo "No crash dump found in $CRASH_DIR"
    exit 0
fi

DUMP_DATE=$(dirname "$LATEST_DUMP" | xargs basename)
REPORT_FILE="${OUTPUT_DIR}/crash-report-${DUMP_DATE}.txt"
mkdir -p "$OUTPUT_DIR"

echo "Analyzing crash dump: $LATEST_DUMP"
echo "Generating report: $REPORT_FILE"

# Create crash analysis script
CRASH_SCRIPT=$(mktemp)
cat > "$CRASH_SCRIPT" << 'CRASH_CMDS'
set hash off
set scroll off

echo "=== CRASH SUMMARY ==="
sys

echo ""
echo "=== KERNEL LOG (last 100 lines) ==="
log -T | tail -100

echo ""
echo "=== CRASH BACKTRACE ==="
bt

echo ""
echo "=== ALL PROCESS STATES ==="
ps

echo ""
echo "=== MEMORY SUMMARY ==="
kmem -i

echo ""
echo "=== SLAB MEMORY (top consumers) ==="
kmem -s

echo ""
echo "=== CPU STATE AT CRASH ==="
cpu

echo ""
echo "=== RUNNING QUEUE ==="
runq

quit
CRASH_CMDS

# Run crash analysis
crash "$KERNEL_DEBUG" "$LATEST_DUMP" < "$CRASH_SCRIPT" > "$REPORT_FILE" 2>&1
rm -f "$CRASH_SCRIPT"

echo "=== CRASH REPORT GENERATED ==="
echo "Location: $REPORT_FILE"

# Extract crash reason for notification
CRASH_REASON=$(grep "PANIC:" "$REPORT_FILE" | head -1)
echo "Crash reason: $CRASH_REASON"

# Send notification (adjust for your notification system)
if command -v mail &>/dev/null; then
    mail -s "Kernel Crash: ${HOSTNAME} - ${CRASH_REASON}" \
        ops@example.com < "$REPORT_FILE"
fi

# Optional: upload to central storage
if [ -n "$CRASH_UPLOAD_URL" ]; then
    curl -s -X POST "$CRASH_UPLOAD_URL" \
        -H "Content-Type: text/plain" \
        -H "X-Hostname: ${HOSTNAME}" \
        -H "X-Crash-Date: ${DUMP_DATE}" \
        --data-binary "@${REPORT_FILE}"
fi
```

### Automated Post-Crash Action Script

```bash
#!/bin/bash
# /etc/kdump/post-reboot.sh
# Runs after kdump capture completes and before reboot

LOG_FILE="/var/log/kdump-post.log"
CRASH_DIR="/var/crash"

{
    echo "=== kdump post-reboot script started at $(date) ==="

    # Find the dump that was just created
    LATEST_DUMP=$(find "$CRASH_DIR" -name "vmcore" -newer /proc/uptime 2>/dev/null | head -1)

    if [ -n "$LATEST_DUMP" ]; then
        echo "Crash dump captured: $LATEST_DUMP"
        echo "Dump size: $(du -sh $LATEST_DUMP 2>/dev/null | cut -f1)"

        # Create metadata file alongside the dump
        cat > "$(dirname $LATEST_DUMP)/metadata.txt" << METADATA
Hostname: $(hostname -f)
Crash Time: $(date)
Kernel: $(uname -r)
Uptime: $(uptime)
Load Average: $(cat /proc/loadavg)
Memory Info:
$(cat /proc/meminfo | head -20)
Disk Usage:
$(df -h)
METADATA

    else
        echo "WARNING: No crash dump found after kdump completion"
    fi

    # Trigger crash analysis service on next boot
    touch /var/run/pending-crash-analysis

} >> "$LOG_FILE" 2>&1
```

### Systemd Service for Post-Boot Analysis

```ini
# /etc/systemd/system/crash-analysis.service
[Unit]
Description=Analyze pending kernel crash dumps
After=network-online.target
ConditionPathExists=/var/run/pending-crash-analysis

[Service]
Type=oneshot
ExecStart=/usr/local/bin/analyze-crash.sh /var/crash /var/log/crash-reports
ExecStartPost=/bin/rm -f /var/run/pending-crash-analysis
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

## Understanding Common Kernel Panic Causes

### NULL Pointer Dereference

```
BUG: unable to handle kernel NULL pointer dereference at (null)
```

Almost always indicates a software bug: accessing a struct member before null-checking a pointer. In crash:

```bash
crash> bt
# Look for the function that crashed

crash> dis <function>+<offset>
# Find the specific instruction - likely a mov [rax+offset], or similar
# The source address register (rax, rsi, etc.) was null

# Check recent dmesg for WARN messages before the crash
crash> log | grep "WARN\|BUG" | tail -20
```

### Kernel Stack Overflow

```
BUG: stack guard page was hit at (null) (stack is likely corrupted)
```

```bash
crash> bt
# Stack corruption may make bt unreliable
# Look for 0xdeadbeef or 0x5a5a5a5a patterns (stack canaries)

crash> rd <stack_start> 512  # Read the stack
# Look for corruption patterns
```

### Memory Corruption / Use-After-Free

```
BUG: KASAN: use-after-free in function_name+0x...
```

KASAN (Kernel Address Sanitizer) is not enabled in production kernels, but you can enable it in debug kernels. For production, look for:

```bash
crash> log | grep -i "KASAN\|slab corruption\|double free\|Object"
# If KASAN is not compiled in, look for:
crash> log | grep "corruption"

# Check object-level corruption
crash> kmem -s <slab_name>
```

### Soft Lockup / Hard Lockup

```
watchdog: BUG: soft lockup - CPU#3 stuck for 23s! [process:1234]
```

```bash
crash> bt <pid>
# Look for tight loops in kernel code

crash> runq  # Check what was running on each CPU

crash> irq   # Check for interrupt storms

# For hard lockups (NMI watchdog)
crash> bt -a  # All CPUs
# Look for CPUs that are all stuck in the same place
```

## kdump in Kubernetes Environments

For Kubernetes nodes, kdump configuration requires extra consideration:

```bash
# Ensure kdump survives containerized workloads
# The memory reservation happens at boot, not after containers start

# Verify kdump is still active on nodes
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' | \
  while read node; do
    STATUS=$(kubectl debug node/$node -it --image=busybox -- \
      cat /sys/kernel/kexec_crash_loaded 2>/dev/null)
    echo "$node: crash_loaded=$STATUS"
  done

# DaemonSet to check kdump status across all nodes
kubectl apply -f - << 'EOF'
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: kdump-monitor
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: kdump-monitor
  template:
    metadata:
      labels:
        app: kdump-monitor
    spec:
      hostPID: true
      hostNetwork: true
      containers:
      - name: kdump-check
        image: busybox:latest
        command: ["/bin/sh", "-c"]
        args:
        - |
          while true; do
            LOADED=$(cat /host/sys/kernel/kexec_crash_loaded 2>/dev/null || echo "unknown")
            echo "kdump_loaded{node=\"$(hostname)\"} $LOADED"
            sleep 60
          done
        volumeMounts:
        - name: sys
          mountPath: /host/sys
          readOnly: true
        securityContext:
          privileged: true
      volumes:
      - name: sys
        hostPath:
          path: /sys
      tolerations:
      - operator: Exists
EOF
```

## Summary

Kdump provides the critical ability to capture kernel state at the moment of failure, transforming opaque kernel panics into analyzable crash dumps. Key operational practices:

- Configure crashkernel size appropriately for your system's RAM - too small fails silently, too large wastes memory
- Use SSH targets for dump storage to ensure dumps are captured even if the local filesystem is corrupted
- Test your kdump configuration quarterly - a configuration that hasn't been tested is likely to fail when needed
- The crash tool's `bt`, `log`, and `kmem` commands cover 80% of crash investigations
- Always install matching kernel debug packages alongside the production kernel
- Automate crash analysis to extract the key information (panic message, backtrace, memory state) immediately after reboot
- For Kubernetes environments, implement a DaemonSet to continuously verify kdump readiness on all nodes
- Retain crash dumps for at least 30 days - patterns across multiple crashes often reveal systemic issues that single-crash analysis misses
