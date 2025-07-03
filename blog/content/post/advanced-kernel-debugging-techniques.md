---
title: "Advanced Kernel Debugging Techniques: From Kernel Oops to Live System Analysis"
date: 2025-03-02T10:00:00-05:00
draft: false
tags: ["Linux", "Kernel Debugging", "KGDB", "Kernel Development", "Crash Analysis", "SystemTap", "eBPF"]
categories:
- Linux
- Kernel Development
author: "Matthew Mattox - mmattox@support.tools"
description: "Master advanced kernel debugging techniques including KGDB, crash dump analysis, live kernel probing with SystemTap and eBPF, and building custom debugging tools"
more_link: "yes"
url: "/advanced-kernel-debugging-techniques/"
---

Kernel debugging represents one of the most challenging aspects of systems programming. Unlike userspace debugging, kernel issues require specialized tools and techniques. This comprehensive guide explores advanced kernel debugging methodologies, from analyzing kernel crashes to live system tracing and performance analysis.

<!--more-->

# [Advanced Kernel Debugging](#advanced-kernel-debugging)

## Kernel Crash Analysis and Core Dumps

### Understanding Kernel Oops and Panics

```c
// crash_analysis.c - Kernel crash analysis tools
#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/init.h>
#include <linux/proc_fs.h>
#include <linux/seq_file.h>
#include <linux/uaccess.h>
#include <linux/slab.h>
#include <linux/stacktrace.h>
#include <linux/kallsyms.h>

// Custom crash handler for demonstration
static void analyze_crash_context(void) {
    unsigned long stack_entries[16];
    unsigned int nr_entries;
    int i;
    
    printk(KERN_ALERT "=== Crash Context Analysis ===\n");
    
    // Capture stack trace
    nr_entries = stack_trace_save(stack_entries, ARRAY_SIZE(stack_entries), 0);
    
    printk(KERN_ALERT "Stack trace:\n");
    for (i = 0; i < nr_entries; i++) {
        printk(KERN_ALERT "  [<%px>] %pS\n", 
               (void *)stack_entries[i], (void *)stack_entries[i]);
    }
    
    // CPU context
    printk(KERN_ALERT "CPU: %d, PID: %d, Process: %s\n",
           smp_processor_id(), current->pid, current->comm);
    
    // Memory context
    printk(KERN_ALERT "Memory usage: RSS=%lu KB, VM=%lu KB\n",
           get_mm_rss(current->mm) << (PAGE_SHIFT - 10),
           current->mm->total_vm << (PAGE_SHIFT - 10));
    
    // IRQ context
    printk(KERN_ALERT "IRQ context: %s, softirq: %s\n",
           in_irq() ? "yes" : "no",
           in_softirq() ? "yes" : "no");
}

// Advanced memory corruption detector
struct debug_memory_block {
    unsigned long magic_start;
    size_t size;
    unsigned long alloc_time;
    unsigned long stack_trace[8];
    unsigned int stack_entries;
    unsigned long magic_end;
};

#define MEMORY_MAGIC_START 0xDEADBEEF12345678UL
#define MEMORY_MAGIC_END   0x87654321FEEDFACEUL

static void* debug_kmalloc(size_t size, gfp_t flags) {
    struct debug_memory_block *block;
    void *user_ptr;
    
    // Allocate extra space for debugging info
    block = kmalloc(sizeof(*block) + size + sizeof(unsigned long), flags);
    if (!block)
        return NULL;
    
    block->magic_start = MEMORY_MAGIC_START;
    block->size = size;
    block->alloc_time = jiffies;
    block->stack_entries = stack_trace_save(block->stack_trace, 
                                           ARRAY_SIZE(block->stack_trace), 0);
    block->magic_end = MEMORY_MAGIC_END;
    
    user_ptr = (char *)block + sizeof(*block);
    
    // Add magic at end of user allocation
    *(unsigned long *)((char *)user_ptr + size) = MEMORY_MAGIC_END;
    
    return user_ptr;
}

static void debug_kfree(void *ptr) {
    struct debug_memory_block *block;
    unsigned long *end_magic;
    
    if (!ptr)
        return;
    
    block = (struct debug_memory_block *)((char *)ptr - sizeof(*block));
    end_magic = (unsigned long *)((char *)ptr + block->size);
    
    // Verify memory integrity
    if (block->magic_start != MEMORY_MAGIC_START) {
        printk(KERN_ALERT "Memory corruption: start magic corrupted at %p\n", ptr);
        analyze_crash_context();
        return;
    }
    
    if (block->magic_end != MEMORY_MAGIC_END) {
        printk(KERN_ALERT "Memory corruption: block magic corrupted at %p\n", ptr);
        analyze_crash_context();
        return;
    }
    
    if (*end_magic != MEMORY_MAGIC_END) {
        printk(KERN_ALERT "Buffer overflow detected at %p, size=%zu\n", 
               ptr, block->size);
        analyze_crash_context();
        return;
    }
    
    // Clear magic to detect use-after-free
    block->magic_start = 0xDEADDEADDEADDEADUL;
    block->magic_end = 0xFEEDFEEDFEEDFEEDUL;
    *end_magic = 0xFREEFREEFREEFREEUL;
    
    kfree(block);
}
```

### Crash Dump Analysis Tools

```bash
#!/bin/bash
# crash_dump_analysis.sh - Comprehensive crash dump analysis

# Setup crash analysis environment
setup_crash_environment() {
    echo "=== Setting up crash analysis environment ==="
    
    # Install crash utility
    if ! command -v crash >/dev/null; then
        echo "Installing crash utility..."
        apt-get update && apt-get install -y crash
    fi
    
    # Install debug symbols
    echo "Installing debug symbols..."
    apt-get install -y linux-image-$(uname -r)-dbg
    
    # Configure kdump
    echo "Configuring kdump..."
    apt-get install -y kdump-tools
    
    # Set crash kernel memory
    if ! grep -q "crashkernel=" /proc/cmdline; then
        echo "Add 'crashkernel=512M' to GRUB_CMDLINE_LINUX in /etc/default/grub"
        echo "Then run: update-grub && reboot"
    fi
}

# Analyze kernel crash dump
analyze_crash_dump() {
    local vmcore=$1
    local vmlinux=${2:-"/usr/lib/debug/boot/vmlinux-$(uname -r)"}
    
    if [ ! -f "$vmcore" ]; then
        echo "Crash dump not found: $vmcore"
        return 1
    fi
    
    echo "=== Analyzing crash dump: $vmcore ==="
    
    # Create crash analysis script
    cat > /tmp/crash_analysis.cmd << 'EOF'
# Basic system information
sys
bt
ps
mount
files
net
mod
log
kmem -i

# CPU and stack analysis
foreach bt
foreach task

# Memory analysis
vm
swap
kmem -s

# Lock analysis
waitq
mutex
rwlock

# Process analysis
task
files
vm

# Network state
net -s
net -n

# File system state
mount
super
files -d

# Exit crash
quit
EOF

    echo "Running crash analysis..."
    crash $vmlinux $vmcore < /tmp/crash_analysis.cmd > crash_analysis_$(date +%Y%m%d_%H%M%S).txt
    
    echo "Analysis complete. Results saved to crash_analysis_*.txt"
}

# Live crash analysis using /proc/kcore
live_kernel_analysis() {
    local vmlinux="/usr/lib/debug/boot/vmlinux-$(uname -r)"
    
    echo "=== Live kernel analysis using /proc/kcore ==="
    
    cat > /tmp/live_analysis.cmd << 'EOF'
# System overview
sys
ps
mount
net
mod
log | tail -50

# Memory statistics
kmem -i
kmem -s
vm

# Process analysis
foreach task -x

# Network state
net -s
net -n

quit
EOF

    if [ -f "$vmlinux" ]; then
        crash $vmlinux /proc/kcore < /tmp/live_analysis.cmd
    else
        echo "Debug symbols not found. Install linux-image-$(uname -r)-dbg"
    fi
}

# Extract information from dmesg
analyze_dmesg_crash() {
    echo "=== Analyzing dmesg for crash information ==="
    
    # Look for oops/panic messages
    echo "Kernel oops/panic messages:"
    dmesg | grep -i -A 20 -B 5 "oops\|panic\|bug\|unable to handle\|segfault"
    echo
    
    # Look for memory issues
    echo "Memory-related errors:"
    dmesg | grep -i "out of memory\|oom\|killed\|memory"
    echo
    
    # Look for hardware issues
    echo "Hardware errors:"
    dmesg | grep -i "error\|failed\|timeout\|i/o error"
    echo
    
    # Look for filesystem issues
    echo "Filesystem errors:"
    dmesg | grep -i "ext4\|xfs\|filesystem\|journal"
    echo
    
    # Extract stack traces
    echo "Recent stack traces:"
    dmesg | grep -A 30 "Call Trace:\|Backtrace:"
}

# Decode kernel oops
decode_kernel_oops() {
    local oops_file=$1
    
    if [ ! -f "$oops_file" ]; then
        echo "Usage: decode_kernel_oops <oops_file>"
        return 1
    fi
    
    echo "=== Decoding kernel oops ==="
    
    # Extract RIP address
    local rip=$(grep -o "RIP: [0-9a-f:]*" "$oops_file" | cut -d' ' -f2)
    if [ -n "$rip" ]; then
        echo "Fault address: $rip"
        
        # Try to resolve symbol
        if command -v addr2line >/dev/null; then
            local vmlinux="/usr/lib/debug/boot/vmlinux-$(uname -r)"
            if [ -f "$vmlinux" ]; then
                echo "Source location:"
                addr2line -e "$vmlinux" "$rip"
            fi
        fi
    fi
    
    # Extract and decode call trace
    echo "Decoding call trace:"
    grep -A 20 "Call Trace:" "$oops_file" | \
    grep -o "\[<[0-9a-f]*>\]" | \
    tr -d '[]<>' | \
    while read addr; do
        if [ -n "$addr" ]; then
            echo -n "$addr: "
            # Try to resolve with kallsyms
            if [ -f /proc/kallsyms ]; then
                grep " $addr " /proc/kallsyms | head -1 | awk '{print $3}' || echo "unknown"
            else
                echo "unknown"
            fi
        fi
    done
}
```

## KGDB and Kernel Debugging

### KGDB Configuration and Usage

```bash
#!/bin/bash
# kgdb_setup.sh - KGDB kernel debugging setup

# Configure KGDB in kernel
setup_kgdb_kernel() {
    echo "=== KGDB Kernel Configuration ==="
    echo "Required kernel config options:"
    echo "CONFIG_KGDB=y"
    echo "CONFIG_KGDB_SERIAL_CONSOLE=y" 
    echo "CONFIG_KGDB_KDB=y"
    echo "CONFIG_KGDB_LOW_LEVEL_TRAP=y"
    echo "CONFIG_DEBUG_INFO=y"
    echo "CONFIG_FRAME_POINTER=y"
    echo
    
    echo "Kernel command line parameters:"
    echo "kgdbwait kgdboc=ttyS0,115200"
    echo "or for KDB console:"
    echo "kgdbwait kgdboc=kbd"
}

# KGDB over serial setup
setup_kgdb_serial() {
    local target_ip=$1
    local host_ip=${2:-"192.168.1.100"}
    
    echo "=== Setting up KGDB over serial ==="
    
    # Setup target system
    echo "On target system:"
    echo "1. Configure kernel with KGDB support"
    echo "2. Add to kernel command line: kgdbwait kgdboc=ttyS0,115200"
    echo "3. Connect serial cable to host"
    echo
    
    # Setup host system
    echo "On host system:"
    echo "1. Connect to target via serial:"
    echo "   screen /dev/ttyUSB0 115200"
    echo "   or"
    echo "   minicom -D /dev/ttyUSB0 -b 115200"
    echo
    echo "2. Start GDB with kernel symbols:"
    echo "   gdb vmlinux"
    echo "   (gdb) set remotebaud 115200"
    echo "   (gdb) target remote /dev/ttyUSB0"
}

# KGDB over network (using netconsole)
setup_kgdb_network() {
    local target_ip=$1
    local host_ip=$2
    local port=${3:-6666}
    
    echo "=== Setting up KGDB over network ==="
    
    # Load netconsole module on target
    echo "On target system:"
    echo "modprobe netconsole netconsole=@${target_ip}/,@${host_ip}/"
    echo "echo ttyS0 > /sys/module/kgdboc/parameters/kgdboc"
    echo "echo g > /proc/sysrq-trigger  # Enter KGDB"
    echo
    
    # Setup host
    echo "On host system:"
    echo "1. Start netcat listener:"
    echo "   nc -l -u $port"
    echo
    echo "2. Connect with GDB:"
    echo "   gdb vmlinux"
    echo "   (gdb) target remote $target_ip:$port"
}

# KGDB debugging session
run_kgdb_session() {
    cat << 'EOF'
=== KGDB Debugging Commands ===

Basic GDB commands in KGDB context:

1. Breakpoints:
   (gdb) break function_name
   (gdb) break file.c:line_number
   (gdb) break *0xaddress

2. Execution control:
   (gdb) continue      # Continue execution
   (gdb) step          # Step into functions
   (gdb) next          # Step over functions
   (gdb) finish        # Run until return

3. Stack examination:
   (gdb) bt            # Backtrace
   (gdb) frame N       # Switch to frame N
   (gdb) info registers # Show CPU registers
   (gdb) info locals   # Show local variables

4. Memory examination:
   (gdb) x/10x address # Examine memory in hex
   (gdb) x/10i address # Examine as instructions
   (gdb) x/s address   # Examine as string

5. Kernel-specific commands:
   (gdb) info threads  # Show all CPUs
   (gdb) thread N      # Switch to CPU N
   (gdb) maintenance info sections # Show memory sections

6. Advanced debugging:
   (gdb) watch variable        # Hardware watchpoint
   (gdb) rwatch variable       # Read watchpoint
   (gdb) awatch variable       # Access watchpoint

7. Kernel data structures:
   (gdb) print task_struct     # Print structure definition
   (gdb) print current         # Current task
   (gdb) print *current        # Dereference current task

8. Module debugging:
   (gdb) add-symbol-file module.ko address
   (gdb) info shared          # Show loaded modules

Sample debugging session:
1. Set breakpoint: (gdb) break sys_read
2. Continue: (gdb) continue
3. When hit, examine: (gdb) print filename
4. Step through: (gdb) next
5. Examine stack: (gdb) bt
EOF
}
```

### Advanced KGDB Techniques

```c
// kgdb_helpers.c - KGDB debugging helpers
#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/kgdb.h>
#include <linux/delay.h>
#include <linux/sched.h>
#include <linux/mm.h>

// Force KGDB break from code
static void force_kgdb_break(void) {
    printk(KERN_ALERT "Forcing KGDB breakpoint\n");
    kgdb_breakpoint();
}

// Debug helper: dump task information
static void debug_dump_task(struct task_struct *task) {
    if (!task) {
        printk(KERN_DEBUG "Task is NULL\n");
        return;
    }
    
    printk(KERN_DEBUG "Task Debug Info:\n");
    printk(KERN_DEBUG "  PID: %d\n", task->pid);
    printk(KERN_DEBUG "  TGID: %d\n", task->tgid);
    printk(KERN_DEBUG "  Command: %s\n", task->comm);
    printk(KERN_DEBUG "  State: %ld\n", task->state);
    printk(KERN_DEBUG "  Priority: %d\n", task->prio);
    printk(KERN_DEBUG "  Nice: %d\n", task_nice(task));
    
    if (task->mm) {
        printk(KERN_DEBUG "  Memory stats:\n");
        printk(KERN_DEBUG "    RSS: %lu KB\n", 
               get_mm_rss(task->mm) << (PAGE_SHIFT - 10));
        printk(KERN_DEBUG "    VM: %lu KB\n",
               task->mm->total_vm << (PAGE_SHIFT - 10));
    }
}

// Debug helper: conditional breakpoint
static void conditional_break(const char *condition, int value, int expected) {
    if (value != expected) {
        printk(KERN_ALERT "Condition failed: %s (got %d, expected %d)\n",
               condition, value, expected);
        debug_dump_task(current);
        kgdb_breakpoint();
    }
}

// Debug helper: memory range dump
static void debug_dump_memory(void *addr, size_t size) {
    unsigned char *ptr = (unsigned char *)addr;
    size_t i;
    
    printk(KERN_DEBUG "Memory dump at %p (%zu bytes):\n", addr, size);
    
    for (i = 0; i < size; i += 16) {
        size_t j;
        size_t remaining = min(size - i, (size_t)16);
        
        printk(KERN_DEBUG "%p: ", ptr + i);
        
        // Hex dump
        for (j = 0; j < remaining; j++) {
            printk(KERN_CONT "%02x ", ptr[i + j]);
        }
        
        // Padding
        for (j = remaining; j < 16; j++) {
            printk(KERN_CONT "   ");
        }
        
        // ASCII dump
        printk(KERN_CONT " |");
        for (j = 0; j < remaining; j++) {
            char c = ptr[i + j];
            printk(KERN_CONT "%c", (c >= 32 && c <= 126) ? c : '.');
        }
        printk(KERN_CONT "|\n");
    }
}

// Stack tracer for KGDB
static void debug_stack_trace(void) {
    unsigned long stack_entries[16];
    unsigned int nr_entries;
    int i;
    
    nr_entries = stack_trace_save(stack_entries, ARRAY_SIZE(stack_entries), 0);
    
    printk(KERN_DEBUG "Stack trace (%u entries):\n", nr_entries);
    for (i = 0; i < nr_entries; i++) {
        printk(KERN_DEBUG "  [<%pK>] %pS\n", 
               (void *)stack_entries[i], (void *)stack_entries[i]);
    }
}

// Example usage in module
static int __init kgdb_helpers_init(void) {
    printk(KERN_INFO "KGDB helpers loaded\n");
    
    // Example: break on specific condition
    conditional_break("module initialization", 1, 1);
    
    return 0;
}

static void __exit kgdb_helpers_exit(void) {
    printk(KERN_INFO "KGDB helpers unloaded\n");
}

MODULE_LICENSE("GPL");
MODULE_DESCRIPTION("KGDB debugging helpers");
module_init(kgdb_helpers_init);
module_exit(kgdb_helpers_exit);
```

## SystemTap and Dynamic Tracing

### SystemTap Scripts for Kernel Analysis

```bash
#!/bin/bash
# systemtap_debugging.sh - SystemTap kernel debugging scripts

# Install SystemTap
install_systemtap() {
    echo "=== Installing SystemTap ==="
    
    # Install packages
    apt-get update
    apt-get install -y systemtap systemtap-runtime
    
    # Install kernel debug info
    apt-get install -y linux-headers-$(uname -r)
    apt-get install -y linux-image-$(uname -r)-dbg
    
    # Add user to stapdev group
    usermod -a -G stapdev $USER
    
    echo "SystemTap installation complete"
    echo "Logout and login again for group changes to take effect"
}

# System call tracer
create_syscall_tracer() {
    cat > syscall_tracer.stp << 'EOF'
#!/usr/bin/env stap

# System call tracer with timing and filtering

global syscall_times, syscall_counts
global start_times

probe syscall.* {
    if (target() == 0 || pid() == target()) {
        start_times[pid(), ppfunc()] = gettimeofday_us()
        printf("[%d] %s(%s) -> entering\n", pid(), ppfunc(), argstr)
    }
}

probe syscall.*.return {
    if (target() == 0 || pid() == target()) {
        elapsed = 0
        if ([pid(), ppfunc()] in start_times) {
            elapsed = gettimeofday_us() - start_times[pid(), ppfunc()]
            delete start_times[pid(), ppfunc()]
        }
        
        syscall_times[ppfunc()] += elapsed
        syscall_counts[ppfunc()]++
        
        printf("[%d] %s -> %s (elapsed: %d us)\n", 
               pid(), ppfunc(), retstr, elapsed)
    }
}

probe timer.s(10) {
    printf("\n=== Top system calls by time ===\n")
    foreach (syscall in syscall_times- limit 10) {
        printf("%-20s: %8d calls, %10d us total, %6d us avg\n",
               syscall, syscall_counts[syscall], syscall_times[syscall],
               syscall_times[syscall] / syscall_counts[syscall])
    }
    printf("\n")
}

probe end {
    printf("\n=== Final statistics ===\n")
    foreach (syscall in syscall_times-) {
        printf("%-20s: %8d calls, %10d us total\n",
               syscall, syscall_counts[syscall], syscall_times[syscall])
    }
}
EOF
    chmod +x syscall_tracer.stp
    echo "SystemTap syscall tracer created: syscall_tracer.stp"
}

# Memory allocation tracer
create_memory_tracer() {
    cat > memory_tracer.stp << 'EOF'
#!/usr/bin/env stap

# Kernel memory allocation tracer

global allocs, frees, net_allocs
global alloc_stacks, large_allocs

probe kernel.function("__kmalloc") {
    size = $size
    allocs[execname()]++
    net_allocs[execname()] += size
    
    if (size > 4096) {  # Track large allocations
        large_allocs[execname(), size]++
        alloc_stacks[execname(), size] = sprint_backtrace()
    }
}

probe kernel.function("kfree") {
    frees[execname()]++
}

probe kernel.function("vmalloc") {
    size = $size
    allocs[execname()]++
    net_allocs[execname()] += size
    printf("vmalloc: %s allocated %d bytes\n", execname(), size)
}

probe timer.s(5) {
    printf("\n=== Memory allocation statistics ===\n")
    printf("%-20s %8s %8s %12s\n", "Process", "Allocs", "Frees", "Net (KB)")
    
    foreach (proc in net_allocs- limit 15) {
        printf("%-20s %8d %8d %12d\n", 
               proc, allocs[proc], frees[proc], net_allocs[proc] / 1024)
    }
    
    if (@count(large_allocs)) {
        printf("\n=== Large allocations (>4KB) ===\n")
        foreach ([proc, size] in large_allocs- limit 10) {
            printf("%s: %d bytes (%d times)\n", 
                   proc, size, large_allocs[proc, size])
        }
    }
    printf("\n")
}
EOF
    chmod +x memory_tracer.stp
    echo "SystemTap memory tracer created: memory_tracer.stp"
}

# Process scheduler tracer
create_scheduler_tracer() {
    cat > scheduler_tracer.stp << 'EOF'
#!/usr/bin/env stap

# Process scheduler analysis

global context_switches, run_times, wait_times
global last_switch_time, last_run_start

probe scheduler.ctxswitch {
    now = gettimeofday_us()
    
    # Track context switches
    context_switches[prev_task_name]++
    context_switches[next_task_name]++
    
    # Calculate run time for previous task
    if (prev_pid in last_run_start) {
        run_time = now - last_run_start[prev_pid]
        run_times[prev_task_name] += run_time
        delete last_run_start[prev_pid]
    }
    
    # Start timing for next task
    last_run_start[next_pid] = now
    
    printf("%d: %s[%d] -> %s[%d] (cpu %d)\n",
           now, prev_task_name, prev_pid, next_task_name, next_pid, cpu())
}

probe scheduler.wakeup {
    printf("WAKEUP: %s[%d] woken up (cpu %d)\n", task_name, pid, cpu())
}

probe timer.s(10) {
    printf("\n=== Scheduler statistics ===\n")
    printf("%-20s %10s %15s\n", "Process", "Switches", "Runtime (ms)")
    
    foreach (proc in context_switches- limit 15) {
        runtime_ms = run_times[proc] / 1000
        printf("%-20s %10d %15d\n", 
               proc, context_switches[proc], runtime_ms)
    }
    printf("\n")
}
EOF
    chmod +x scheduler_tracer.stp
    echo "SystemTap scheduler tracer created: scheduler_tracer.stp"
}

# File I/O tracer
create_io_tracer() {
    cat > io_tracer.stp << 'EOF'
#!/usr/bin/env stap

# File I/O performance tracer

global read_bytes, write_bytes, io_times
global file_ops

probe vfs.read {
    start_time = gettimeofday_us()
    file_ops[pid(), "read", devname, filename] = start_time
}

probe vfs.read.return {
    if ([pid(), "read", devname, filename] in file_ops) {
        elapsed = gettimeofday_us() - file_ops[pid(), "read", devname, filename]
        delete file_ops[pid(), "read", devname, filename]
        
        if (ret > 0) {
            read_bytes[execname()] += ret
            io_times[execname(), "read"] += elapsed
            
            if (elapsed > 10000) {  # Slow I/O (>10ms)
                printf("SLOW READ: %s read %d bytes from %s in %d us\n",
                       execname(), ret, filename, elapsed)
            }
        }
    }
}

probe vfs.write {
    start_time = gettimeofday_us()
    file_ops[pid(), "write", devname, filename] = start_time
}

probe vfs.write.return {
    if ([pid(), "write", devname, filename] in file_ops) {
        elapsed = gettimeofday_us() - file_ops[pid(), "write", devname, filename]
        delete file_ops[pid(), "write", devname, filename]
        
        if (ret > 0) {
            write_bytes[execname()] += ret
            io_times[execname(), "write"] += elapsed
            
            if (elapsed > 10000) {  # Slow I/O (>10ms)
                printf("SLOW WRITE: %s wrote %d bytes to %s in %d us\n",
                       execname(), ret, filename, elapsed)
            }
        }
    }
}

probe timer.s(5) {
    printf("\n=== I/O Statistics ===\n")
    printf("%-20s %12s %12s %10s %10s\n", 
           "Process", "Read (KB)", "Write (KB)", "Read (ms)", "Write (ms)")
    
    foreach (proc in read_bytes) {
        read_kb = read_bytes[proc] / 1024
        write_kb = write_bytes[proc] / 1024
        read_ms = io_times[proc, "read"] / 1000
        write_ms = io_times[proc, "write"] / 1000
        
        printf("%-20s %12d %12d %10d %10d\n",
               proc, read_kb, write_kb, read_ms, write_ms)
    }
    printf("\n")
}
EOF
    chmod +x io_tracer.stp
    echo "SystemTap I/O tracer created: io_tracer.stp"
}

# Run SystemTap scripts
run_systemtap_analysis() {
    local script=$1
    local target_pid=${2:-0}
    local duration=${3:-60}
    
    echo "=== Running SystemTap analysis ==="
    echo "Script: $script"
    echo "Target PID: $target_pid (0 = all processes)"
    echo "Duration: $duration seconds"
    echo
    
    if [ ! -f "$script" ]; then
        echo "Script not found: $script"
        return 1
    fi
    
    if [ "$target_pid" -eq 0 ]; then
        timeout $duration stap $script
    else
        timeout $duration stap $script -x $target_pid
    fi
}
```

## eBPF-based Kernel Debugging

### eBPF Tracing Tools

```python
#!/usr/bin/env python3
# ebpf_kernel_debug.py - eBPF-based kernel debugging tools

import os
import sys
import time
import signal
from bcc import BPF

class KernelDebugger:
    def __init__(self):
        self.programs = {}
        self.running = True
        signal.signal(signal.SIGINT, self.signal_handler)
    
    def signal_handler(self, sig, frame):
        print("\nShutting down...")
        self.running = False
    
    def create_syscall_tracer(self):
        """Create eBPF program for system call tracing"""
        program = """
        #include <uapi/linux/ptrace.h>
        #include <linux/sched.h>
        
        struct syscall_data_t {
            u32 pid;
            u32 tid;
            u64 ts;
            u64 delta;
            u32 syscall_nr;
            char comm[TASK_COMM_LEN];
        };
        
        BPF_HASH(start_times, u32, u64);
        BPF_PERF_OUTPUT(events);
        
        TRACEPOINT_PROBE(raw_syscalls, sys_enter) {
            u32 pid = bpf_get_current_pid_tgid() >> 32;
            u64 ts = bpf_ktime_get_ns();
            start_times.update(&pid, &ts);
            return 0;
        }
        
        TRACEPOINT_PROBE(raw_syscalls, sys_exit) {
            u32 pid = bpf_get_current_pid_tgid() >> 32;
            u64 *start_ts = start_times.lookup(&pid);
            
            if (start_ts) {
                u64 now = bpf_ktime_get_ns();
                u64 delta = now - *start_ts;
                
                struct syscall_data_t data = {};
                data.pid = pid;
                data.tid = bpf_get_current_pid_tgid() & 0xffffffff;
                data.ts = now;
                data.delta = delta;
                data.syscall_nr = args->id;
                bpf_get_current_comm(&data.comm, sizeof(data.comm));
                
                events.perf_submit(ctx, &data, sizeof(data));
                start_times.delete(&pid);
            }
            return 0;
        }
        """
        return BPF(text=program)
    
    def create_memory_tracer(self):
        """Create eBPF program for memory allocation tracing"""
        program = """
        #include <uapi/linux/ptrace.h>
        #include <linux/sched.h>
        #include <linux/mm.h>
        
        struct alloc_data_t {
            u32 pid;
            u64 size;
            u64 addr;
            u64 ts;
            char comm[TASK_COMM_LEN];
            int stack_id;
        };
        
        BPF_HASH(sizes, u64, u64);
        BPF_STACK_TRACE(stack_traces, 1024);
        BPF_PERF_OUTPUT(alloc_events);
        BPF_PERF_OUTPUT(free_events);
        
        int trace_kmalloc(struct pt_regs *ctx, size_t size) {
            u32 pid = bpf_get_current_pid_tgid() >> 32;
            
            struct alloc_data_t data = {};
            data.pid = pid;
            data.size = size;
            data.ts = bpf_ktime_get_ns();
            data.stack_id = stack_traces.get_stackid(ctx, BPF_F_REUSE_STACKID);
            bpf_get_current_comm(&data.comm, sizeof(data.comm));
            
            alloc_events.perf_submit(ctx, &data, sizeof(data));
            return 0;
        }
        
        int trace_kmalloc_ret(struct pt_regs *ctx) {
            u64 addr = PT_REGS_RC(ctx);
            u32 pid = bpf_get_current_pid_tgid() >> 32;
            
            if (addr != 0) {
                // Store allocation info for later free tracking
                u64 size = 0;  // We'd need to pass this from entry probe
                sizes.update(&addr, &size);
            }
            return 0;
        }
        
        int trace_kfree(struct pt_regs *ctx, void *ptr) {
            u64 addr = (u64)ptr;
            u64 *size = sizes.lookup(&addr);
            
            if (size) {
                struct alloc_data_t data = {};
                data.pid = bpf_get_current_pid_tgid() >> 32;
                data.addr = addr;
                data.size = *size;
                data.ts = bpf_ktime_get_ns();
                bpf_get_current_comm(&data.comm, sizeof(data.comm));
                
                free_events.perf_submit(ctx, &data, sizeof(data));
                sizes.delete(&addr);
            }
            return 0;
        }
        """
        
        b = BPF(text=program)
        b.attach_kprobe(event="__kmalloc", fn_name="trace_kmalloc")
        b.attach_kretprobe(event="__kmalloc", fn_name="trace_kmalloc_ret")
        b.attach_kprobe(event="kfree", fn_name="trace_kfree")
        return b
    
    def create_block_io_tracer(self):
        """Create eBPF program for block I/O tracing"""
        program = """
        #include <uapi/linux/ptrace.h>
        #include <linux/blkdev.h>
        #include <linux/blk_types.h>
        
        struct io_data_t {
            u32 pid;
            u64 ts;
            u64 sector;
            u32 len;
            u32 cmd_flags;
            char comm[TASK_COMM_LEN];
            char disk[32];
        };
        
        BPF_HASH(start_times, struct request *, u64);
        BPF_PERF_OUTPUT(events);
        
        int trace_block_rq_insert(struct pt_regs *ctx, struct request_queue *q, 
                                  struct request *rq) {
            u64 ts = bpf_ktime_get_ns();
            start_times.update(&rq, &ts);
            return 0;
        }
        
        int trace_block_rq_complete(struct pt_regs *ctx, struct request *rq, 
                                    int error, unsigned int nr_bytes) {
            u64 *start_ts = start_times.lookup(&rq);
            
            if (start_ts) {
                u64 delta = bpf_ktime_get_ns() - *start_ts;
                
                struct io_data_t data = {};
                data.pid = bpf_get_current_pid_tgid() >> 32;
                data.ts = delta;
                data.sector = rq->__sector;
                data.len = rq->__data_len;
                data.cmd_flags = rq->cmd_flags;
                bpf_get_current_comm(&data.comm, sizeof(data.comm));
                
                // Get disk name
                struct gendisk *disk = rq->rq_disk;
                if (disk) {
                    bpf_probe_read_str(&data.disk, sizeof(data.disk), disk->disk_name);
                }
                
                events.perf_submit(ctx, &data, sizeof(data));
                start_times.delete(&rq);
            }
            return 0;
        }
        """
        
        b = BPF(text=program)
        b.attach_kprobe(event="blk_mq_insert_request", fn_name="trace_block_rq_insert")
        b.attach_kprobe(event="blk_mq_end_request", fn_name="trace_block_rq_complete")
        return b
    
    def run_syscall_tracer(self):
        """Run system call tracer"""
        print("Starting syscall tracer...")
        b = self.create_syscall_tracer()
        
        syscall_counts = {}
        syscall_times = {}
        
        def print_event(cpu, data, size):
            event = b["events"].event(data)
            syscall_name = f"syscall_{event.syscall_nr}"
            
            if syscall_name not in syscall_counts:
                syscall_counts[syscall_name] = 0
                syscall_times[syscall_name] = 0
            
            syscall_counts[syscall_name] += 1
            syscall_times[syscall_name] += event.delta
            
            if event.delta > 10000000:  # > 10ms
                print(f"SLOW: {event.comm.decode('utf-8', 'replace')} "
                      f"[{event.pid}] {syscall_name} took {event.delta/1000000:.2f}ms")
        
        b["events"].open_perf_buffer(print_event)
        
        start_time = time.time()
        while self.running and (time.time() - start_time) < 60:
            try:
                b.perf_buffer_poll(timeout=1000)
            except KeyboardInterrupt:
                break
        
        # Print summary
        print("\n=== Syscall Summary ===")
        for syscall in sorted(syscall_counts.keys(), 
                             key=lambda x: syscall_times[x], reverse=True)[:10]:
            avg_time = syscall_times[syscall] / syscall_counts[syscall] / 1000000
            print(f"{syscall:20s}: {syscall_counts[syscall]:8d} calls, "
                  f"{avg_time:8.2f}ms avg")
    
    def run_memory_tracer(self):
        """Run memory allocation tracer"""
        print("Starting memory tracer...")
        b = self.create_memory_tracer()
        
        allocations = {}
        total_allocated = 0
        total_freed = 0
        
        def print_alloc_event(cpu, data, size):
            nonlocal total_allocated
            event = b["alloc_events"].event(data)
            total_allocated += event.size
            
            comm = event.comm.decode('utf-8', 'replace')
            if event.size > 4096:  # Large allocation
                print(f"LARGE ALLOC: {comm} [{event.pid}] allocated {event.size} bytes")
                
                # Print stack trace
                if event.stack_id >= 0:
                    stack = list(b["stack_traces"].walk(event.stack_id))
                    for addr in stack[:5]:  # Top 5 frames
                        print(f"  {b.ksym(addr)}")
        
        def print_free_event(cpu, data, size):
            nonlocal total_freed
            event = b["free_events"].event(data)
            total_freed += event.size
        
        b["alloc_events"].open_perf_buffer(print_alloc_event)
        b["free_events"].open_perf_buffer(print_free_event)
        
        start_time = time.time()
        while self.running and (time.time() - start_time) < 60:
            try:
                b.perf_buffer_poll(timeout=1000)
            except KeyboardInterrupt:
                break
        
        print(f"\n=== Memory Summary ===")
        print(f"Total allocated: {total_allocated/1024/1024:.2f} MB")
        print(f"Total freed: {total_freed/1024/1024:.2f} MB")
        print(f"Net allocation: {(total_allocated-total_freed)/1024/1024:.2f} MB")

def main():
    if os.geteuid() != 0:
        print("This program requires root privileges")
        sys.exit(1)
    
    debugger = KernelDebugger()
    
    if len(sys.argv) < 2:
        print("Usage: ebpf_kernel_debug.py <syscall|memory|blockio>")
        sys.exit(1)
    
    mode = sys.argv[1]
    
    if mode == "syscall":
        debugger.run_syscall_tracer()
    elif mode == "memory":
        debugger.run_memory_tracer()
    else:
        print(f"Unknown mode: {mode}")
        sys.exit(1)

if __name__ == "__main__":
    main()
```

## Best Practices

1. **Preparation**: Always have debug symbols and crash tools ready
2. **Documentation**: Keep detailed logs of debugging sessions
3. **Reproduction**: Create minimal test cases for consistent debugging
4. **Safety**: Use separate test systems for invasive debugging techniques
5. **Automation**: Script common debugging workflows for efficiency

## Conclusion

Advanced kernel debugging requires mastering multiple tools and techniques, from traditional crash analysis to modern eBPF tracing. Understanding kernel internals, using appropriate debugging tools, and following systematic approaches are essential for effective kernel development and troubleshooting.

The techniques covered here—crash analysis, KGDB debugging, SystemTap scripting, and eBPF programming—provide comprehensive coverage for investigating kernel issues. Whether debugging kernel crashes, analyzing performance bottlenecks, or developing kernel modules, these advanced debugging techniques are invaluable for systems programmers and kernel developers.