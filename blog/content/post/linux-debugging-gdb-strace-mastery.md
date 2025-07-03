---
title: "Linux Debugging Mastery: GDB, strace, and Advanced Troubleshooting Techniques"
date: 2025-07-02T22:15:00-05:00
draft: false
tags: ["Linux", "Debugging", "GDB", "strace", "Performance", "Troubleshooting", "Systems Programming"]
categories:
- Linux
- Development Tools
author: "Matthew Mattox - mmattox@support.tools"
description: "Master Linux debugging with comprehensive coverage of GDB, strace, performance analysis tools, and advanced troubleshooting techniques for complex production issues"
more_link: "yes"
url: "/linux-debugging-gdb-strace-mastery/"
---

Debugging is an art that separates good developers from great ones. In the Linux ecosystem, powerful tools like GDB and strace, combined with kernel interfaces and performance analyzers, provide unprecedented visibility into program behavior. This guide explores advanced debugging techniques used to solve complex problems in production systems.

<!--more-->

# [Linux Debugging Mastery](#linux-debugging-mastery)

## GDB: Beyond Basic Debugging

### Advanced GDB Setup and Configuration

```bash
# .gdbinit configuration for enhanced debugging
cat > ~/.gdbinit << 'EOF'
# Better formatting
set print pretty on
set print array on
set print array-indexes on
set pagination off
set confirm off

# History
set history save on
set history size 10000
set history filename ~/.gdb_history

# Enhanced backtrace
define bt
  thread apply all backtrace
end

# Print STL containers
python
import sys
sys.path.insert(0, '/usr/share/gcc/python')
from libstdcxx.v6.printers import register_libstdcxx_printers
register_libstdcxx_printers(None)
end

# Custom commands
define vars
  info locals
  info args
end

define ll
  list *$pc
end

# Breakpoint aliases
define bpl
  info breakpoints
end

define bpc
  clear $arg0
end

# Memory examination helpers
define ascii_char
  set $_c = *(unsigned char *)($arg0)
  if ($_c < 0x20 || $_c > 0x7E)
    printf "."
  else
    printf "%c", $_c
  end
end

define hex_dump
  set $_addr = $arg0
  set $_count = $arg1
  set $_i = 0
  while $_i < $_count
    printf "%08X: ", $_addr + $_i
    set $_j = 0
    while $_j < 16 && $_i + $_j < $_count
      printf "%02X ", *(unsigned char*)($_addr + $_i + $_j)
      set $_j++
    end
    while $_j < 16
      printf "   "
      set $_j++
    end
    printf " "
    set $_j = 0
    while $_j < 16 && $_i + $_j < $_count
      ascii_char $_addr + $_i + $_j
      set $_j++
    end
    printf "\n"
    set $_i = $_i + 16
  end
end
EOF
```

### Advanced Breakpoint Techniques

```c
// example_program.c for debugging demonstrations
#include <stdio.h>
#include <stdlib.h>
#include <pthread.h>
#include <signal.h>

typedef struct {
    int id;
    char* data;
    struct node* next;
} node_t;

// GDB commands for advanced breakpoints
/*
# Conditional breakpoints
(gdb) break process_node if node->id == 42

# Breakpoint with commands
(gdb) break malloc
(gdb) commands
> silent
> printf "malloc(%d) called from ", $rdi
> backtrace 1
> continue
> end

# Watchpoints on memory
(gdb) watch *(int*)0x7fffffffe130
(gdb) watch -l node->data

# Catchpoints for system events
(gdb) catch syscall open
(gdb) catch signal SIGSEGV
(gdb) catch fork
(gdb) catch throw  # C++ exceptions

# Thread-specific breakpoints
(gdb) break worker_function thread 3

# Temporary breakpoints
(gdb) tbreak main
(gdb) tb *0x400567

# Regex breakpoints
(gdb) rbreak ^process_.*
(gdb) rbreak file.c:^handler_

# Pending breakpoints for shared libraries
(gdb) set breakpoint pending on
(gdb) break libfoo.so:function_name

# Hardware breakpoints
(gdb) hbreak *0x400567

# Breakpoint conditions with function calls
(gdb) break process_data if $_streq(data->name, "target")
*/

// Function for demonstrating reverse debugging
void buggy_function(int* array, int size) {
    for (int i = 0; i <= size; i++) {  // Bug: should be i < size
        array[i] = i * 2;
    }
}

// GDB reverse debugging commands
/*
# Record execution
(gdb) target record-full
(gdb) continue

# Reverse execution
(gdb) reverse-continue
(gdb) reverse-step
(gdb) reverse-next
(gdb) reverse-finish

# Set bookmark
(gdb) bookmark my_point

# Go to bookmark
(gdb) goto-bookmark my_point

# Reverse watchpoint
(gdb) watch data->value
(gdb) reverse-continue
*/
```

### Python Scripting in GDB

```python
# gdb_scripts/heap_analyzer.py
import gdb
import re

class HeapAnalyzer(gdb.Command):
    """Analyze heap allocations"""
    
    def __init__(self):
        super(HeapAnalyzer, self).__init__("heap-analyze", 
                                          gdb.COMMAND_USER)
        self.allocations = {}
        
    def invoke(self, arg, from_tty):
        # Set breakpoints on malloc/free
        bp_malloc = gdb.Breakpoint("malloc", internal=True)
        bp_malloc.silent = True
        
        bp_free = gdb.Breakpoint("free", internal=True)
        bp_free.silent = True
        
        # Track allocations
        def on_malloc_hit(event):
            if isinstance(event, gdb.BreakpointEvent):
                size = int(gdb.parse_and_eval("$rdi"))
                gdb.execute("finish", to_string=True)
                addr = int(gdb.parse_and_eval("$rax"))
                
                # Get backtrace
                bt = gdb.execute("bt 5", to_string=True)
                
                self.allocations[addr] = {
                    'size': size,
                    'backtrace': bt
                }
                
                gdb.execute("continue")
        
        def on_free_hit(event):
            if isinstance(event, gdb.BreakpointEvent):
                addr = int(gdb.parse_and_eval("$rdi"))
                if addr in self.allocations:
                    del self.allocations[addr]
                gdb.execute("continue")
        
        # Connect events
        gdb.events.stop.connect(on_malloc_hit)
        gdb.events.stop.connect(on_free_hit)
        
        print("Heap analysis started. Run program and call 'heap-report'")

class HeapReport(gdb.Command):
    """Show heap allocation report"""
    
    def __init__(self):
        super(HeapReport, self).__init__("heap-report", 
                                        gdb.COMMAND_USER)
    
    def invoke(self, arg, from_tty):
        analyzer = gdb.parse_and_eval("heap_analyzer")
        
        total_size = 0
        print("\nOutstanding Allocations:")
        print("=" * 60)
        
        for addr, info in sorted(analyzer.allocations.items()):
            print(f"Address: 0x{addr:x}")
            print(f"Size: {info['size']} bytes")
            print(f"Backtrace:\n{info['backtrace']}")
            print("-" * 60)
            total_size += info['size']
        
        print(f"\nTotal leaked: {total_size} bytes")
        print(f"Leak count: {len(analyzer.allocations)}")

# Register commands
HeapAnalyzer()
HeapReport()

# Custom pretty printer
class LinkedListPrinter:
    """Pretty printer for linked list nodes"""
    
    def __init__(self, val):
        self.val = val
    
    def to_string(self):
        return f"Node(id={self.val['id']}, data='{self.val['data'].string()}')"
    
    def children(self):
        yield ('id', self.val['id'])
        yield ('data', self.val['data'])
        yield ('next', self.val['next'])

def build_pretty_printer():
    pp = gdb.printing.RegexpCollectionPrettyPrinter("my_library")
    pp.add_printer('node', '^node_t$', LinkedListPrinter)
    return pp

gdb.printing.register_pretty_printer(
    gdb.current_objfile(),
    build_pretty_printer()
)
```

### Core Dump Analysis

```bash
#!/bin/bash
# analyze_core.sh - Comprehensive core dump analysis

analyze_core() {
    local core_file=$1
    local binary=$2
    
    echo "Core Dump Analysis Report"
    echo "========================="
    echo "Core file: $core_file"
    echo "Binary: $binary"
    echo ""
    
    # Basic information
    file $core_file
    
    # Extract key information with GDB
    gdb -batch \
        -ex "set pagination off" \
        -ex "set print thread-events off" \
        -ex "file $binary" \
        -ex "core $core_file" \
        -ex "echo \n=== CRASH INFORMATION ===\n" \
        -ex "info signal" \
        -ex "echo \n=== REGISTERS ===\n" \
        -ex "info registers" \
        -ex "echo \n=== BACKTRACE ===\n" \
        -ex "thread apply all bt full" \
        -ex "echo \n=== DISASSEMBLY ===\n" \
        -ex "disassemble $pc-32,$pc+32" \
        -ex "echo \n=== LOCAL VARIABLES ===\n" \
        -ex "info locals" \
        -ex "echo \n=== THREADS ===\n" \
        -ex "info threads" \
        -ex "echo \n=== SHARED LIBRARIES ===\n" \
        -ex "info sharedlibrary" \
        -ex "echo \n=== MEMORY MAPPINGS ===\n" \
        -ex "info proc mappings" \
        -ex "quit"
}

# Automated core pattern setup
setup_core_dumps() {
    # Set core pattern
    echo "/tmp/cores/core.%e.%p.%t" | sudo tee /proc/sys/kernel/core_pattern
    
    # Enable core dumps
    ulimit -c unlimited
    
    # Create core directory
    sudo mkdir -p /tmp/cores
    sudo chmod 1777 /tmp/cores
    
    # Configure systemd-coredump if available
    if command -v coredumpctl &> /dev/null; then
        sudo mkdir -p /etc/systemd/coredump.conf.d
        cat << EOF | sudo tee /etc/systemd/coredump.conf.d/custom.conf
[Coredump]
Storage=external
Compress=yes
ProcessSizeMax=8G
ExternalSizeMax=8G
JournalSizeMax=1G
MaxUse=10G
KeepFree=1G
EOF
        sudo systemctl daemon-reload
    fi
}
```

## strace: System Call Tracing Mastery

### Advanced strace Techniques

```bash
#!/bin/bash
# strace_advanced.sh - Advanced strace usage patterns

# Comprehensive system call analysis
strace_analyze() {
    local pid=$1
    local output_dir="strace_analysis_$$"
    mkdir -p $output_dir
    
    # Trace with timing and syscall statistics
    strace -p $pid \
           -f \
           -tt \
           -T \
           -e trace=all \
           -e abbrev=none \
           -e verbose=all \
           -e raw=all \
           -e signal=all \
           -o $output_dir/full_trace.log &
    
    local strace_pid=$!
    
    # Let it run for a while
    sleep 10
    kill $strace_pid
    
    # Analyze the trace
    echo "=== System Call Summary ==="
    strace -p $pid -c -f -o /dev/null &
    sleep 5
    kill $!
    
    # Extract specific patterns
    echo -e "\n=== File Operations ==="
    grep -E "open|close|read|write" $output_dir/full_trace.log | \
        awk '{print $2, $3}' | sort | uniq -c | sort -rn | head -20
    
    echo -e "\n=== Network Operations ==="
    grep -E "socket|connect|send|recv" $output_dir/full_trace.log | \
        awk '{print $2, $3}' | sort | uniq -c | sort -rn | head -20
    
    echo -e "\n=== Failed System Calls ==="
    grep -E "= -[0-9]+ E" $output_dir/full_trace.log | \
        awk '{print $2, $NF}' | sort | uniq -c | sort -rn | head -20
}

# Trace specific aspects
trace_file_access() {
    local command="$1"
    
    echo "=== File Access Trace ==="
    strace -e trace=file \
           -e fault=open:error=ENOENT:when=3 \
           -y \
           -P /etc/passwd \
           -o file_trace.log \
           $command
    
    # Show accessed files
    grep -o '"[^"]*"' file_trace.log | sort -u
}

trace_network_activity() {
    local pid=$1
    
    echo "=== Network Activity Trace ==="
    strace -p $pid \
           -e trace=network \
           -e read=all \
           -e write=all \
           -f \
           -s 1024 \
           -o network_trace.log
    
    # Extract IP addresses and ports
    grep -E "connect|accept|bind" network_trace.log | \
        grep -oE "sin_addr=inet_addr\(\"[0-9.]+\"\)" | \
        cut -d'"' -f2 | sort -u
}

# Performance profiling with strace
profile_syscalls() {
    local command="$1"
    
    echo "=== System Call Performance Profile ==="
    
    # Run with timing
    strace -c -f -S time -o /dev/null $command 2>&1 | \
        awk '/^%/ {p=1; next} p && NF' | \
        sort -k2 -rn | \
        head -20
}

# Inject faults for testing
test_fault_injection() {
    local command="$1"
    
    echo "=== Fault Injection Testing ==="
    
    # Fail every 3rd open() call
    strace -e fault=open:error=EACCES:when=3+ $command
    
    # Fail memory allocation
    strace -e fault=mmap:error=ENOMEM:when=5 $command
    
    # Delay network calls
    strace -e delay=connect:delay_enter=1s $command
}
```

### System Call Analysis Scripts

```python
#!/usr/bin/env python3
# strace_analyzer.py - Analyze strace output

import sys
import re
from collections import defaultdict, Counter
import matplotlib.pyplot as plt

class StraceAnalyzer:
    def __init__(self, trace_file):
        self.trace_file = trace_file
        self.syscalls = defaultdict(list)
        self.errors = Counter()
        self.file_access = defaultdict(set)
        self.network_connections = []
        
    def parse(self):
        syscall_pattern = re.compile(
            r'(\d+\.\d+)\s+(\w+)\((.*?)\)\s*=\s*(-?\d+|0x[0-9a-f]+)(.*)?'
        )
        
        with open(self.trace_file, 'r') as f:
            for line in f:
                match = syscall_pattern.match(line.strip())
                if match:
                    timestamp, syscall, args, result, extra = match.groups()
                    
                    self.syscalls[syscall].append({
                        'timestamp': float(timestamp),
                        'args': args,
                        'result': result,
                        'duration': self._extract_duration(extra)
                    })
                    
                    # Track errors
                    if result.startswith('-'):
                        self.errors[f"{syscall}:{result}"] += 1
                    
                    # Track file access
                    if syscall in ['open', 'openat', 'stat', 'lstat']:
                        filename = self._extract_filename(args)
                        if filename:
                            self.file_access[syscall].add(filename)
                    
                    # Track network connections
                    if syscall == 'connect':
                        addr = self._extract_address(args)
                        if addr:
                            self.network_connections.append(addr)
    
    def _extract_duration(self, extra):
        if extra:
            match = re.search(r'<(\d+\.\d+)>', extra)
            if match:
                return float(match.group(1))
        return 0.0
    
    def _extract_filename(self, args):
        match = re.search(r'"([^"]+)"', args)
        return match.group(1) if match else None
    
    def _extract_address(self, args):
        match = re.search(r'sin_addr=inet_addr\("([^"]+)"\).*sin_port=htons\((\d+)\)', args)
        if match:
            return (match.group(1), int(match.group(2)))
        return None
    
    def report(self):
        print("=== System Call Summary ===")
        for syscall, calls in sorted(self.syscalls.items(), 
                                   key=lambda x: len(x[1]), 
                                   reverse=True)[:20]:
            total_time = sum(c['duration'] for c in calls)
            print(f"{syscall:20} {len(calls):6d} calls, {total_time:.3f}s total")
        
        print("\n=== Most Common Errors ===")
        for error, count in self.errors.most_common(10):
            print(f"{error:30} {count:6d} times")
        
        print("\n=== File Access Patterns ===")
        for syscall, files in self.file_access.items():
            print(f"{syscall}: {len(files)} unique files")
            for f in list(files)[:5]:
                print(f"  - {f}")
        
        print("\n=== Network Connections ===")
        for addr, port in self.network_connections[:10]:
            print(f"  - {addr}:{port}")
    
    def plot_timeline(self):
        plt.figure(figsize=(12, 6))
        
        for i, (syscall, calls) in enumerate(
            sorted(self.syscalls.items(), 
                   key=lambda x: len(x[1]), 
                   reverse=True)[:10]
        ):
            timestamps = [c['timestamp'] for c in calls]
            plt.scatter(timestamps, [i]*len(timestamps), 
                       label=syscall, alpha=0.6, s=10)
        
        plt.yticks(range(10), 
                  [s for s, _ in sorted(self.syscalls.items(), 
                                       key=lambda x: len(x[1]), 
                                       reverse=True)[:10]])
        plt.xlabel('Time (seconds)')
        plt.title('System Call Timeline')
        plt.legend(bbox_to_anchor=(1.05, 1), loc='upper left')
        plt.tight_layout()
        plt.savefig('syscall_timeline.png')
        plt.close()

if __name__ == '__main__':
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <strace_output_file>")
        sys.exit(1)
    
    analyzer = StraceAnalyzer(sys.argv[1])
    analyzer.parse()
    analyzer.report()
    analyzer.plot_timeline()
```

## Performance Debugging

### perf: Linux Performance Analysis

```bash
#!/bin/bash
# perf_analysis.sh - Comprehensive performance analysis

# CPU profiling
profile_cpu() {
    local command="$1"
    local duration="${2:-10}"
    
    echo "=== CPU Profiling ==="
    
    # Record profile
    perf record -F 99 -a -g -- sleep $duration
    
    # Generate flame graph
    perf script | stackcollapse-perf.pl | flamegraph.pl > cpu_flame.svg
    
    # Top functions
    perf report --stdio --no-children | head -50
    
    # Annotated assembly
    perf annotate --stdio --no-source
}

# Cache analysis
analyze_cache() {
    local command="$1"
    
    echo "=== Cache Performance ==="
    
    perf stat -e cache-references,cache-misses,\
               L1-dcache-loads,L1-dcache-load-misses,\
               L1-icache-load-misses,\
               LLC-loads,LLC-load-misses \
               $command
    
    # Detailed cache events
    perf record -e cache-misses:pp $command
    perf report --stdio
}

# Branch prediction analysis
analyze_branches() {
    local command="$1"
    
    echo "=== Branch Prediction ==="
    
    perf stat -e branches,branch-misses,\
               branch-loads,branch-load-misses \
               $command
    
    # Find mispredicted branches
    perf record -e branch-misses:pp $command
    perf annotate --stdio | grep -B2 -A2 "branch"
}

# Memory bandwidth analysis
analyze_memory() {
    local pid=$1
    
    echo "=== Memory Bandwidth ==="
    
    # Monitor memory events
    perf stat -e memory-loads,memory-stores -p $pid sleep 5
    
    # Memory access patterns
    perf mem record -p $pid sleep 5
    perf mem report --stdio
}

# Custom performance counters
custom_counters() {
    local command="$1"
    
    # Define custom events
    perf stat -e cycles,instructions,\
              r0151,\  # L1D cache hw prefetch misses
              r0851,\  # L1D cache prefetch misses
              r4f2e,\  # LLC misses
              r412e \  # LLC references
              $command
}
```

### Memory Leak Detection

```c
// memleak_detector.c - Runtime memory leak detection
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <dlfcn.h>
#include <pthread.h>
#include <backtrace.h>

typedef struct allocation {
    void* ptr;
    size_t size;
    void* backtrace[32];
    int backtrace_size;
    struct allocation* next;
} allocation_t;

static allocation_t* allocations = NULL;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static void* (*real_malloc)(size_t) = NULL;
static void (*real_free)(void*) = NULL;

static void init_hooks() {
    if (!real_malloc) {
        real_malloc = dlsym(RTLD_NEXT, "malloc");
        real_free = dlsym(RTLD_NEXT, "free");
    }
}

void* malloc(size_t size) {
    init_hooks();
    void* ptr = real_malloc(size);
    
    if (ptr && size > 0) {
        allocation_t* alloc = real_malloc(sizeof(allocation_t));
        alloc->ptr = ptr;
        alloc->size = size;
        alloc->backtrace_size = backtrace(alloc->backtrace, 32);
        
        pthread_mutex_lock(&lock);
        alloc->next = allocations;
        allocations = alloc;
        pthread_mutex_unlock(&lock);
    }
    
    return ptr;
}

void free(void* ptr) {
    init_hooks();
    
    if (ptr) {
        pthread_mutex_lock(&lock);
        allocation_t** current = &allocations;
        
        while (*current) {
            if ((*current)->ptr == ptr) {
                allocation_t* to_free = *current;
                *current = (*current)->next;
                real_free(to_free);
                break;
            }
            current = &(*current)->next;
        }
        pthread_mutex_unlock(&lock);
    }
    
    real_free(ptr);
}

void report_leaks() {
    pthread_mutex_lock(&lock);
    
    FILE* report = fopen("memleak_report.txt", "w");
    size_t total_leaked = 0;
    int leak_count = 0;
    
    allocation_t* current = allocations;
    while (current) {
        fprintf(report, "Leak #%d: %zu bytes at %p\n", 
                ++leak_count, current->size, current->ptr);
        
        // Print backtrace
        char** symbols = backtrace_symbols(current->backtrace, 
                                         current->backtrace_size);
        for (int i = 0; i < current->backtrace_size; i++) {
            fprintf(report, "  %s\n", symbols[i]);
        }
        free(symbols);
        
        fprintf(report, "\n");
        total_leaked += current->size;
        current = current->next;
    }
    
    fprintf(report, "Total leaked: %zu bytes in %d allocations\n", 
            total_leaked, leak_count);
    fclose(report);
    
    pthread_mutex_unlock(&lock);
}

__attribute__((destructor))
void cleanup() {
    report_leaks();
}
```

## Advanced Debugging Techniques

### Dynamic Binary Instrumentation

```c
// dbi_trace.c - Dynamic instrumentation example
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ptrace.h>
#include <sys/wait.h>
#include <sys/user.h>
#include <unistd.h>

typedef struct {
    void* addr;
    uint8_t original_byte;
    void (*handler)(struct user_regs_struct*);
} breakpoint_t;

static breakpoint_t breakpoints[100];
static int bp_count = 0;

void set_breakpoint(pid_t pid, void* addr, 
                   void (*handler)(struct user_regs_struct*)) {
    // Read original instruction
    long data = ptrace(PTRACE_PEEKTEXT, pid, addr, NULL);
    
    // Save original byte
    breakpoints[bp_count].addr = addr;
    breakpoints[bp_count].original_byte = data & 0xFF;
    breakpoints[bp_count].handler = handler;
    
    // Write int3 instruction (0xCC)
    long new_data = (data & ~0xFF) | 0xCC;
    ptrace(PTRACE_POKETEXT, pid, addr, new_data);
    
    bp_count++;
}

void handle_breakpoint(pid_t pid, struct user_regs_struct* regs) {
    void* bp_addr = (void*)(regs->rip - 1);
    
    // Find breakpoint
    for (int i = 0; i < bp_count; i++) {
        if (breakpoints[i].addr == bp_addr) {
            // Call handler
            if (breakpoints[i].handler) {
                breakpoints[i].handler(regs);
            }
            
            // Restore original instruction
            long data = ptrace(PTRACE_PEEKTEXT, pid, bp_addr, NULL);
            data = (data & ~0xFF) | breakpoints[i].original_byte;
            ptrace(PTRACE_POKETEXT, pid, bp_addr, data);
            
            // Step back one instruction
            regs->rip--;
            ptrace(PTRACE_SETREGS, pid, NULL, regs);
            
            // Single step
            ptrace(PTRACE_SINGLESTEP, pid, NULL, NULL);
            wait(NULL);
            
            // Restore breakpoint
            data = (data & ~0xFF) | 0xCC;
            ptrace(PTRACE_POKETEXT, pid, bp_addr, data);
            
            break;
        }
    }
}

// Function call tracer
void trace_calls(pid_t pid) {
    ptrace(PTRACE_ATTACH, pid, NULL, NULL);
    wait(NULL);
    
    // Set breakpoints on interesting functions
    set_breakpoint(pid, (void*)0x400500, NULL);  // main
    set_breakpoint(pid, (void*)0x400600, NULL);  // target_function
    
    ptrace(PTRACE_CONT, pid, NULL, NULL);
    
    while (1) {
        int status;
        wait(&status);
        
        if (WIFEXITED(status)) break;
        
        if (WIFSTOPPED(status) && WSTOPSIG(status) == SIGTRAP) {
            struct user_regs_struct regs;
            ptrace(PTRACE_GETREGS, pid, NULL, &regs);
            
            handle_breakpoint(pid, &regs);
        }
        
        ptrace(PTRACE_CONT, pid, NULL, NULL);
    }
}
```

### Production Debugging Tools

```bash
#!/bin/bash
# production_debug.sh - Safe production debugging

# Live process debugging without stopping
debug_live_process() {
    local pid=$1
    
    # Get process info
    echo "=== Process Information ==="
    ps -p $pid -o pid,ppid,user,pcpu,pmem,vsz,rss,tty,stat,start,time,cmd
    
    # Memory maps
    echo -e "\n=== Memory Maps ==="
    cat /proc/$pid/maps | head -20
    
    # Open files
    echo -e "\n=== Open Files ==="
    lsof -p $pid | head -20
    
    # Network connections
    echo -e "\n=== Network Connections ==="
    ss -tanp | grep "pid=$pid"
    
    # Stack traces (if available)
    if [ -r /proc/$pid/stack ]; then
        echo -e "\n=== Kernel Stack ==="
        cat /proc/$pid/stack
    fi
    
    # Sample stack with GDB (minimal impact)
    echo -e "\n=== User Stack Sample ==="
    timeout 1 gdb -batch -p $pid \
        -ex "set pagination off" \
        -ex "thread apply all bt" \
        -ex "detach" \
        -ex "quit" 2>/dev/null || echo "GDB sampling failed"
}

# SystemTap script for dynamic analysis
create_systemtap_script() {
    cat > trace_malloc.stp << 'EOF'
#!/usr/bin/stap

global allocations

probe process("*").function("malloc").return {
    allocations[pid(), $return] = $size
    printf("%d: malloc(%d) = %p\n", pid(), $size, $return)
}

probe process("*").function("free") {
    if ([pid(), $ptr] in allocations) {
        printf("%d: free(%p) [%d bytes]\n", 
               pid(), $ptr, allocations[pid(), $ptr])
        delete allocations[pid(), $ptr]
    }
}

probe end {
    printf("\n=== Leaked Memory ===\n")
    foreach ([pid, ptr] in allocations) {
        printf("PID %d: %p (%d bytes)\n", 
               pid, ptr, allocations[pid, ptr])
    }
}
EOF
}

# eBPF-based tracing
create_bpf_trace() {
    cat > trace_syscalls.py << 'EOF'
#!/usr/bin/python3
from bcc import BPF

prog = """
#include <uapi/linux/ptrace.h>

BPF_HASH(syscall_count, u32);
BPF_HASH(syscall_time, u32);

TRACEPOINT_PROBE(raw_syscalls, sys_enter) {
    u32 key = args->id;
    u64 *count = syscall_count.lookup(&key);
    if (count) {
        (*count)++;
    } else {
        u64 one = 1;
        syscall_count.update(&key, &one);
    }
    
    u64 ts = bpf_ktime_get_ns();
    syscall_time.update(&key, &ts);
    
    return 0;
}

TRACEPOINT_PROBE(raw_syscalls, sys_exit) {
    u32 key = args->id;
    u64 *start = syscall_time.lookup(&key);
    if (start) {
        u64 delta = bpf_ktime_get_ns() - *start;
        // Process timing
    }
    return 0;
}
"""

b = BPF(text=prog)
print("Tracing syscalls... Ctrl-C to end")

try:
    b.sleep(99999999)
except KeyboardInterrupt:
    print("\n=== System Call Statistics ===")
    for k, v in sorted(b["syscall_count"].items(), 
                      key=lambda x: x[1].value, 
                      reverse=True)[:20]:
        print(f"Syscall {k.value}: {v.value} calls")
EOF
}
```

## Debugging Best Practices

### Debugging Checklist

```bash
#!/bin/bash
# debug_checklist.sh - Systematic debugging approach

debug_checklist() {
    local problem_description="$1"
    
    echo "=== Debugging Checklist ==="
    echo "Problem: $problem_description"
    echo ""
    
    # 1. Reproduce the issue
    echo "[ ] Can reproduce the issue consistently"
    echo "[ ] Have minimal test case"
    echo "[ ] Documented steps to reproduce"
    echo ""
    
    # 2. Gather information
    echo "[ ] Collected error messages/logs"
    echo "[ ] Noted system configuration"
    echo "[ ] Checked resource usage (CPU/memory/disk)"
    echo "[ ] Verified software versions"
    echo ""
    
    # 3. Initial analysis
    echo "[ ] Reviewed relevant source code"
    echo "[ ] Checked recent changes (git log)"
    echo "[ ] Searched for similar issues"
    echo "[ ] Reviewed documentation"
    echo ""
    
    # 4. Debugging tools
    echo "[ ] Used appropriate debugger (GDB)"
    echo "[ ] Traced system calls (strace)"
    echo "[ ] Profiled performance (perf)"
    echo "[ ] Checked for memory issues (valgrind)"
    echo ""
    
    # 5. Root cause
    echo "[ ] Identified root cause"
    echo "[ ] Understood why it happens"
    echo "[ ] Found all affected code paths"
    echo "[ ] Considered edge cases"
    echo ""
    
    # 6. Solution
    echo "[ ] Developed fix"
    echo "[ ] Tested fix thoroughly"
    echo "[ ] No regressions introduced"
    echo "[ ] Code reviewed"
    echo ""
    
    # 7. Prevention
    echo "[ ] Added test cases"
    echo "[ ] Updated documentation"
    echo "[ ] Shared knowledge with team"
    echo "[ ] Improved monitoring/alerting"
}

# Automated debugging data collection
collect_debug_data() {
    local output_dir="debug_data_$(date +%Y%m%d_%H%M%S)"
    mkdir -p $output_dir
    
    echo "Collecting debugging data in $output_dir..."
    
    # System information
    uname -a > $output_dir/uname.txt
    cat /etc/os-release > $output_dir/os_release.txt
    lscpu > $output_dir/cpu_info.txt
    free -h > $output_dir/memory.txt
    df -h > $output_dir/disk.txt
    
    # Process information
    ps auxf > $output_dir/processes.txt
    top -b -n 1 > $output_dir/top.txt
    
    # Network state
    ss -tanp > $output_dir/network.txt
    ip addr > $output_dir/ip_addresses.txt
    
    # System logs
    journalctl -n 1000 > $output_dir/journal.txt
    dmesg > $output_dir/dmesg.txt
    
    # Package versions
    if command -v dpkg &> /dev/null; then
        dpkg -l > $output_dir/packages_dpkg.txt
    fi
    if command -v rpm &> /dev/null; then
        rpm -qa > $output_dir/packages_rpm.txt
    fi
    
    tar czf debug_data.tar.gz $output_dir
    echo "Debug data collected in debug_data.tar.gz"
}
```

## Conclusion

Mastering Linux debugging requires proficiency with multiple tools and techniques. From GDB's powerful scripting capabilities to strace's system call visibility, from performance profiling with perf to dynamic instrumentation, each tool serves a specific purpose in the debugging arsenal.

The key to effective debugging is systematic approach: reproduce reliably, gather comprehensive data, analyze methodically, and verify thoroughly. By combining these tools with proper debugging methodology, you can solve even the most elusive bugs in complex production systems.

Remember that debugging is not just about fixing problems—it's about understanding systems deeply, preventing future issues, and building more robust software. The techniques covered here provide the foundation for becoming an expert troubleshooter in the Linux environment.