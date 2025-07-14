---
title: "Linux Performance Profiling and Optimization: Advanced Techniques for System Analysis"
date: 2025-03-05T10:00:00-05:00
draft: false
tags: ["Linux", "Performance", "Profiling", "Optimization", "perf", "CPU", "Memory", "I/O"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Master advanced Linux performance profiling and optimization techniques using perf, flame graphs, CPU profiling, memory analysis, and system-wide performance tuning"
more_link: "yes"
url: "/linux-performance-profiling-optimization/"
---

Performance optimization is a critical skill for systems programmers and administrators. Linux provides powerful tools for analyzing CPU usage, memory patterns, I/O bottlenecks, and system behavior. This comprehensive guide explores advanced profiling techniques, performance analysis methodologies, and optimization strategies for high-performance Linux systems.

<!--more-->

# [Linux Performance Profiling and Optimization](#linux-performance-profiling)

## CPU Profiling with perf

### Advanced perf Usage

```bash
#!/bin/bash
# perf_profiling.sh - Advanced CPU profiling with perf

# Install perf tools
install_perf_tools() {
    echo "=== Installing perf tools ==="
    
    # Install perf
    apt-get update
    apt-get install -y linux-perf
    
    # Install debug symbols
    apt-get install -y linux-image-$(uname -r)-dbg
    
    # Install flamegraph tools
    if [ ! -d "/opt/FlameGraph" ]; then
        git clone https://github.com/brendangregg/FlameGraph.git /opt/FlameGraph
    fi
    
    echo "perf tools installation complete"
}

# CPU profiling with call graphs
cpu_profile_with_callgraph() {
    local duration=${1:-30}
    local frequency=${2:-99}
    local output_prefix=${3:-"cpu_profile"}
    
    echo "=== CPU profiling with call graphs ==="
    echo "Duration: ${duration}s, Frequency: ${frequency}Hz"
    
    # Record with call graphs
    perf record -F $frequency -g --call-graph dwarf -a sleep $duration
    
    # Generate reports
    echo "Generating perf reports..."
    
    # Basic report
    perf report --stdio > "${output_prefix}_report.txt"
    
    # Call graph report
    perf report -g --stdio > "${output_prefix}_callgraph.txt"
    
    # Annotated assembly
    perf annotate --stdio > "${output_prefix}_annotate.txt"
    
    # Flame graph
    if [ -x "/opt/FlameGraph/stackcollapse-perf.pl" ]; then
        perf script | /opt/FlameGraph/stackcollapse-perf.pl | \
        /opt/FlameGraph/flamegraph.pl > "${output_prefix}_flamegraph.svg"
        echo "Flame graph saved as ${output_prefix}_flamegraph.svg"
    fi
    
    echo "CPU profiling complete"
}

# Hardware counter analysis
hardware_counter_analysis() {
    local duration=${1:-10}
    local program=${2:-""}
    
    echo "=== Hardware counter analysis ==="
    
    # List available events
    echo "Available hardware events:"
    perf list hardware cache tracepoint | head -30
    echo
    
    # Basic hardware counters
    if [ -n "$program" ]; then
        echo "Profiling program: $program"
        perf stat -e cycles,instructions,cache-references,cache-misses,branches,branch-misses,page-faults $program
    else
        echo "System-wide profiling for ${duration}s"
        perf stat -a -e cycles,instructions,cache-references,cache-misses,branches,branch-misses,page-faults sleep $duration
    fi
    
    # Detailed cache analysis
    echo
    echo "=== Cache performance analysis ==="
    if [ -n "$program" ]; then
        perf stat -e L1-dcache-loads,L1-dcache-load-misses,LLC-loads,LLC-load-misses $program
    else
        perf stat -a -e L1-dcache-loads,L1-dcache-load-misses,LLC-loads,LLC-load-misses sleep $duration
    fi
    
    # Memory bandwidth analysis
    echo
    echo "=== Memory bandwidth analysis ==="
    if [ -n "$program" ]; then
        perf stat -e cpu/event=0xd0,umask=0x81/,cpu/event=0xd0,umask=0x82/ $program 2>/dev/null || \
        echo "Memory bandwidth events not available on this CPU"
    else
        perf stat -a -e cpu/event=0xd0,umask=0x81/,cpu/event=0xd0,umask=0x82/ sleep $duration 2>/dev/null || \
        echo "Memory bandwidth events not available on this CPU"
    fi
}

# Function-level profiling
function_level_profiling() {
    local program=$1
    local duration=${2:-30}
    
    if [ -z "$program" ]; then
        echo "Usage: function_level_profiling <program> [duration]"
        return 1
    fi
    
    echo "=== Function-level profiling: $program ==="
    
    # Start program in background if it's a long-running service
    if pgrep "$program" >/dev/null; then
        local pid=$(pgrep "$program" | head -1)
        echo "Attaching to existing process: $pid"
        
        # Profile specific process
        perf record -F 99 -g -p $pid sleep $duration
    else
        echo "Starting and profiling: $program"
        perf record -F 99 -g $program
    fi
    
    # Function-level analysis
    echo "Top functions by CPU usage:"
    perf report --stdio -n --sort=overhead,symbol | head -30
    
    echo
    echo "Call graph for top function:"
    local top_func=$(perf report --stdio -n --sort=overhead,symbol | \
                     awk '/^#/ {next} NF>0 {print $3; exit}')
    if [ -n "$top_func" ]; then
        perf report --stdio -g --symbol="$top_func"
    fi
}

# Live CPU profiling
live_cpu_profiling() {
    local interval=${1:-1}
    
    echo "=== Live CPU profiling (Ctrl+C to stop) ==="
    echo "Update interval: ${interval}s"
    
    # Use perf top for live monitoring
    perf top -F 99 -d $interval --call-graph dwarf
}

# Micro-benchmark analysis
microbenchmark_analysis() {
    local benchmark_cmd=$1
    
    if [ -z "$benchmark_cmd" ]; then
        echo "Usage: microbenchmark_analysis <benchmark_command>"
        return 1
    fi
    
    echo "=== Micro-benchmark analysis ==="
    echo "Command: $benchmark_cmd"
    
    # Run multiple iterations with detailed stats
    echo "Running 10 iterations..."
    for i in {1..10}; do
        echo "Iteration $i:"
        perf stat -r 1 -e cycles,instructions,cache-references,cache-misses,branches,branch-misses \
                  $benchmark_cmd 2>&1 | grep -E "(cycles|instructions|cache|branches)" | \
                  awk '{printf "  %s\n", $0}'
    done
    
    # Detailed single run with recording
    echo
    echo "Detailed analysis run:"
    perf record -g $benchmark_cmd
    perf report --stdio -n | head -20
}

# Performance comparison
performance_comparison() {
    local cmd1="$1"
    local cmd2="$2"
    local iterations=${3:-5}
    
    if [ -z "$cmd1" ] || [ -z "$cmd2" ]; then
        echo "Usage: performance_comparison <command1> <command2> [iterations]"
        return 1
    fi
    
    echo "=== Performance comparison ==="
    echo "Command 1: $cmd1"
    echo "Command 2: $cmd2"
    echo "Iterations: $iterations"
    echo
    
    # Create temporary files for results
    local results1="/tmp/perf_results1_$$"
    local results2="/tmp/perf_results2_$$"
    
    # Benchmark first command
    echo "Benchmarking command 1..."
    for i in $(seq 1 $iterations); do
        perf stat $cmd1 2>&1 | grep "seconds time elapsed" | \
        awk '{print $1}' >> $results1
    done
    
    # Benchmark second command
    echo "Benchmarking command 2..."
    for i in $(seq 1 $iterations); do
        perf stat $cmd2 2>&1 | grep "seconds time elapsed" | \
        awk '{print $1}' >> $results2
    done
    
    # Calculate statistics
    echo
    echo "Results:"
    echo "Command 1 times (seconds):"
    cat $results1 | awk '{sum+=$1; sumsq+=$1*$1} END {
        avg=sum/NR; 
        stddev=sqrt(sumsq/NR - avg*avg); 
        printf "  Average: %.4f ± %.4f (n=%d)\n", avg, stddev, NR
    }'
    
    echo "Command 2 times (seconds):"
    cat $results2 | awk '{sum+=$1; sumsq+=$1*$1} END {
        avg=sum/NR; 
        stddev=sqrt(sumsq/NR - avg*avg); 
        printf "  Average: %.4f ± %.4f (n=%d)\n", avg, stddev, NR
    }'
    
    # Cleanup
    rm -f $results1 $results2
}
```

### Advanced perf Analysis

```c
// perf_analysis.c - Custom performance analysis tools
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <string.h>
#include <time.h>
#include <sys/time.h>
#include <sys/resource.h>
#include <errno.h>

// High-resolution timer
typedef struct {
    struct timespec start;
    struct timespec end;
} hr_timer_t;

static inline void hr_timer_start(hr_timer_t *timer) {
    clock_gettime(CLOCK_MONOTONIC, &timer->start);
}

static inline double hr_timer_end(hr_timer_t *timer) {
    clock_gettime(CLOCK_MONOTONIC, &timer->end);
    return (timer->end.tv_sec - timer->start.tv_sec) + 
           (timer->end.tv_nsec - timer->start.tv_nsec) / 1e9;
}

// CPU cache analysis
void analyze_cache_performance(void) {
    const size_t sizes[] = {
        1024,        // L1 cache size
        32768,       // L1 cache size
        262144,      // L2 cache size
        8388608,     // L3 cache size
        134217728    // Beyond cache
    };
    const int num_sizes = sizeof(sizes) / sizeof(sizes[0]);
    
    printf("=== Cache Performance Analysis ===\n");
    printf("Size (KB)    Access Time (ns)\n");
    
    for (int i = 0; i < num_sizes; i++) {
        size_t size = sizes[i];
        char *buffer = malloc(size);
        if (!buffer) {
            perror("malloc");
            continue;
        }
        
        // Initialize buffer
        memset(buffer, 0, size);
        
        // Warm up
        for (int j = 0; j < 1000; j++) {
            volatile char dummy = buffer[j % size];
            (void)dummy;
        }
        
        // Measure access time
        hr_timer_t timer;
        const int iterations = 10000000;
        
        hr_timer_start(&timer);
        for (int j = 0; j < iterations; j++) {
            volatile char dummy = buffer[j % size];
            (void)dummy;
        }
        double elapsed = hr_timer_end(&timer);
        
        double ns_per_access = (elapsed * 1e9) / iterations;
        printf("%-9zu    %.2f\n", size / 1024, ns_per_access);
        
        free(buffer);
    }
}

// Memory bandwidth measurement
void measure_memory_bandwidth(void) {
    const size_t size = 64 * 1024 * 1024; // 64MB
    const int iterations = 100;
    
    char *src = malloc(size);
    char *dst = malloc(size);
    
    if (!src || !dst) {
        perror("malloc");
        return;
    }
    
    // Initialize source
    memset(src, 0xAA, size);
    
    printf("\n=== Memory Bandwidth Analysis ===\n");
    
    // Sequential read
    hr_timer_t timer;
    hr_timer_start(&timer);
    for (int i = 0; i < iterations; i++) {
        for (size_t j = 0; j < size; j += 64) {
            volatile char dummy = src[j];
            (void)dummy;
        }
    }
    double read_time = hr_timer_end(&timer);
    double read_bandwidth = (size * iterations) / (read_time * 1024 * 1024 * 1024);
    
    // Sequential write
    hr_timer_start(&timer);
    for (int i = 0; i < iterations; i++) {
        for (size_t j = 0; j < size; j += 64) {
            dst[j] = 0xBB;
        }
    }
    double write_time = hr_timer_end(&timer);
    double write_bandwidth = (size * iterations) / (write_time * 1024 * 1024 * 1024);
    
    // Memory copy
    hr_timer_start(&timer);
    for (int i = 0; i < iterations; i++) {
        memcpy(dst, src, size);
    }
    double copy_time = hr_timer_end(&timer);
    double copy_bandwidth = (size * iterations) / (copy_time * 1024 * 1024 * 1024);
    
    printf("Sequential Read:  %.2f GB/s\n", read_bandwidth);
    printf("Sequential Write: %.2f GB/s\n", write_bandwidth);
    printf("Memory Copy:      %.2f GB/s\n", copy_bandwidth);
    
    free(src);
    free(dst);
}

// CPU instruction analysis
void analyze_cpu_instructions(void) {
    const int iterations = 100000000;
    hr_timer_t timer;
    
    printf("\n=== CPU Instruction Performance ===\n");
    
    // Integer operations
    volatile int a = 1, b = 2, c;
    hr_timer_start(&timer);
    for (int i = 0; i < iterations; i++) {
        c = a + b;
    }
    double add_time = hr_timer_end(&timer);
    
    hr_timer_start(&timer);
    for (int i = 0; i < iterations; i++) {
        c = a * b;
    }
    double mul_time = hr_timer_end(&timer);
    
    hr_timer_start(&timer);
    for (int i = 0; i < iterations; i++) {
        c = a / b;
    }
    double div_time = hr_timer_end(&timer);
    
    // Floating point operations
    volatile float fa = 1.5f, fb = 2.5f, fc;
    hr_timer_start(&timer);
    for (int i = 0; i < iterations; i++) {
        fc = fa + fb;
    }
    double fadd_time = hr_timer_end(&timer);
    
    hr_timer_start(&timer);
    for (int i = 0; i < iterations; i++) {
        fc = fa * fb;
    }
    double fmul_time = hr_timer_end(&timer);
    
    printf("Integer ADD:  %.2f ns/op\n", (add_time * 1e9) / iterations);
    printf("Integer MUL:  %.2f ns/op\n", (mul_time * 1e9) / iterations);
    printf("Integer DIV:  %.2f ns/op\n", (div_time * 1e9) / iterations);
    printf("Float ADD:    %.2f ns/op\n", (fadd_time * 1e9) / iterations);
    printf("Float MUL:    %.2f ns/op\n", (fmul_time * 1e9) / iterations);
    
    (void)c; (void)fc; // Prevent optimization
}

// Branch prediction analysis
void analyze_branch_prediction(void) {
    const int iterations = 10000000;
    const int array_size = 1000;
    int *array = malloc(array_size * sizeof(int));
    
    printf("\n=== Branch Prediction Analysis ===\n");
    
    // Predictable branches (sorted array)
    for (int i = 0; i < array_size; i++) {
        array[i] = i;
    }
    
    hr_timer_t timer;
    int sum = 0;
    hr_timer_start(&timer);
    for (int i = 0; i < iterations; i++) {
        if (array[i % array_size] > array_size / 2) {
            sum++;
        }
    }
    double predictable_time = hr_timer_end(&timer);
    
    // Unpredictable branches (random array)
    srand(42);
    for (int i = 0; i < array_size; i++) {
        array[i] = rand() % array_size;
    }
    
    sum = 0;
    hr_timer_start(&timer);
    for (int i = 0; i < iterations; i++) {
        if (array[i % array_size] > array_size / 2) {
            sum++;
        }
    }
    double unpredictable_time = hr_timer_end(&timer);
    
    printf("Predictable branches:   %.2f ns/op\n", 
           (predictable_time * 1e9) / iterations);
    printf("Unpredictable branches: %.2f ns/op\n", 
           (unpredictable_time * 1e9) / iterations);
    printf("Branch prediction penalty: %.2fx\n", 
           unpredictable_time / predictable_time);
    
    free(array);
}

int main(void) {
    printf("Performance Analysis Suite\n");
    printf("==========================\n");
    
    analyze_cache_performance();
    measure_memory_bandwidth();
    analyze_cpu_instructions();
    analyze_branch_prediction();
    
    return 0;
}
```

## Memory Profiling and Analysis

### Memory Usage Analysis Tools

```bash
#!/bin/bash
# memory_analysis.sh - Comprehensive memory analysis

# Memory usage overview
memory_usage_overview() {
    echo "=== Memory Usage Overview ==="
    
    # Basic memory info
    echo "System memory information:"
    free -h
    echo
    
    # Detailed memory breakdown
    echo "Detailed memory breakdown:"
    cat /proc/meminfo | grep -E "(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree|Dirty|Writeback|Slab)"
    echo
    
    # Memory usage by process
    echo "Top 10 memory consumers:"
    ps aux --sort=-%mem | head -11
    echo
    
    # Memory mapping analysis
    echo "Memory mapping summary:"
    cat /proc/meminfo | awk '
    /MemTotal/ { total = $2 }
    /MemFree/ { free = $2 }
    /Buffers/ { buffers = $2 }
    /Cached/ { cached = $2 }
    /Slab/ { slab = $2 }
    END {
        used = total - free - buffers - cached
        printf "Total:    %8d KB (100.0%%)\n", total
        printf "Used:     %8d KB (%5.1f%%)\n", used, used*100/total
        printf "Free:     %8d KB (%5.1f%%)\n", free, free*100/total
        printf "Buffers:  %8d KB (%5.1f%%)\n", buffers, buffers*100/total
        printf "Cached:   %8d KB (%5.1f%%)\n", cached, cached*100/total
        printf "Slab:     %8d KB (%5.1f%%)\n", slab, slab*100/total
    }'
}

# Process memory analysis
analyze_process_memory() {
    local pid=$1
    
    if [ -z "$pid" ]; then
        echo "Usage: analyze_process_memory <pid>"
        return 1
    fi
    
    if [ ! -d "/proc/$pid" ]; then
        echo "Process $pid not found"
        return 1
    fi
    
    echo "=== Process Memory Analysis: PID $pid ==="
    
    # Basic process info
    local cmd=$(cat /proc/$pid/comm)
    local cmdline=$(cat /proc/$pid/cmdline | tr '\0' ' ')
    echo "Command: $cmd"
    echo "Command line: $cmdline"
    echo
    
    # Memory status
    echo "Memory status:"
    cat /proc/$pid/status | grep -E "(VmPeak|VmSize|VmLck|VmPin|VmHWM|VmRSS|VmData|VmStk|VmExe|VmLib|VmPTE|VmSwap)"
    echo
    
    # Memory mappings
    echo "Memory mappings summary:"
    awk '
    BEGIN { 
        total_size = 0
        rss_total = 0
        private_total = 0
        shared_total = 0
    }
    /^[0-9a-f]/ {
        # Parse address range
        split($1, addr, "-")
        size = strtonum("0x" addr[2]) - strtonum("0x" addr[1])
        total_size += size
        
        # Parse permissions and type
        perms = $2
        type = $6
        
        if (type ~ /\.so/ || type ~ /lib/) {
            lib_size += size
        } else if (type ~ /heap/) {
            heap_size += size
        } else if (type ~ /stack/) {
            stack_size += size
        } else if (type == "[vvar]" || type == "[vdso]") {
            vdso_size += size
        } else if (type == "") {
            anon_size += size
        }
    }
    END {
        printf "Total virtual memory: %8d KB\n", total_size/1024
        printf "Anonymous memory:     %8d KB\n", anon_size/1024
        printf "Heap memory:          %8d KB\n", heap_size/1024
        printf "Stack memory:         %8d KB\n", stack_size/1024
        printf "Library memory:       %8d KB\n", lib_size/1024
        printf "VDSO memory:          %8d KB\n", vdso_size/1024
    }' /proc/$pid/maps
    echo
    
    # Shared memory
    if [ -f "/proc/$pid/smaps" ]; then
        echo "Shared memory analysis:"
        awk '
        /^Size:/ { total_size += $2 }
        /^Rss:/ { rss_total += $2 }
        /^Pss:/ { pss_total += $2 }
        /^Private_Clean:/ { priv_clean += $2 }
        /^Private_Dirty:/ { priv_dirty += $2 }
        /^Shared_Clean:/ { shared_clean += $2 }
        /^Shared_Dirty:/ { shared_dirty += $2 }
        END {
            printf "Total RSS:        %8d KB\n", rss_total
            printf "Total PSS:        %8d KB\n", pss_total
            printf "Private clean:    %8d KB\n", priv_clean
            printf "Private dirty:    %8d KB\n", priv_dirty
            printf "Shared clean:     %8d KB\n", shared_clean
            printf "Shared dirty:     %8d KB\n", shared_dirty
        }' /proc/$pid/smaps
    fi
}

# Memory leak detection
detect_memory_leaks() {
    local pid=$1
    local interval=${2:-5}
    local duration=${3:-60}
    
    if [ -z "$pid" ]; then
        echo "Usage: detect_memory_leaks <pid> [interval] [duration]"
        return 1
    fi
    
    echo "=== Memory Leak Detection: PID $pid ==="
    echo "Monitoring for ${duration}s with ${interval}s intervals"
    
    local start_time=$(date +%s)
    local end_time=$((start_time + duration))
    local log_file="/tmp/memory_monitor_${pid}.log"
    
    echo "# Time VmRSS VmSize VmData Heap" > $log_file
    
    while [ $(date +%s) -lt $end_time ]; do
        if [ ! -d "/proc/$pid" ]; then
            echo "Process $pid terminated"
            break
        fi
        
        local timestamp=$(date +%s)
        local vmrss=$(awk '/VmRSS/ {print $2}' /proc/$pid/status)
        local vmsize=$(awk '/VmSize/ {print $2}' /proc/$pid/status)
        local vmdata=$(awk '/VmData/ {print $2}' /proc/$pid/status)
        
        # Extract heap size from maps
        local heap_size=$(awk '/heap/ {
            split($1, addr, "-")
            size = strtonum("0x" addr[2]) - strtonum("0x" addr[1])
            total += size
        } END { print total/1024 }' /proc/$pid/maps)
        
        echo "$timestamp $vmrss $vmsize $vmdata $heap_size" >> $log_file
        
        printf "Time: %d, RSS: %d KB, Size: %d KB, Data: %d KB, Heap: %d KB\n" \
               $timestamp $vmrss $vmsize $vmdata $heap_size
        
        sleep $interval
    done
    
    # Analyze trend
    echo
    echo "Memory trend analysis:"
    awk 'NR>1 {
        if (NR==2) {
            start_rss = $2
            start_size = $3
            start_data = $4
            start_heap = $5
        }
        end_rss = $2
        end_size = $3
        end_data = $4
        end_heap = $5
    } END {
        rss_growth = end_rss - start_rss
        size_growth = end_size - start_size
        data_growth = end_data - start_data
        heap_growth = end_heap - start_heap
        
        printf "RSS growth:   %+d KB\n", rss_growth
        printf "Size growth:  %+d KB\n", size_growth
        printf "Data growth:  %+d KB\n", data_growth
        printf "Heap growth:  %+d KB\n", heap_growth
        
        if (rss_growth > 1000) {
            print "WARNING: Potential memory leak detected (RSS growth > 1MB)"
        }
    }' $log_file
    
    echo "Detailed log saved to: $log_file"
}

# Valgrind memory analysis
run_valgrind_analysis() {
    local program="$1"
    local args="$2"
    
    if [ -z "$program" ]; then
        echo "Usage: run_valgrind_analysis <program> [args]"
        return 1
    fi
    
    if ! command -v valgrind >/dev/null; then
        echo "Installing valgrind..."
        apt-get update && apt-get install -y valgrind
    fi
    
    echo "=== Valgrind Memory Analysis ==="
    echo "Program: $program $args"
    
    local output_prefix="/tmp/valgrind_$$"
    
    # Memory error detection
    echo "Running memory error detection..."
    valgrind --tool=memcheck \
             --leak-check=full \
             --show-leak-kinds=all \
             --track-origins=yes \
             --verbose \
             --log-file="${output_prefix}_memcheck.log" \
             $program $args
    
    # Memory profiling
    echo "Running memory profiling..."
    valgrind --tool=massif \
             --massif-out-file="${output_prefix}_massif.out" \
             $program $args
    
    # Cache profiling
    echo "Running cache profiling..."
    valgrind --tool=cachegrind \
             --cachegrind-out-file="${output_prefix}_cachegrind.out" \
             $program $args
    
    echo "Analysis complete. Output files:"
    echo "  Memory check: ${output_prefix}_memcheck.log"
    echo "  Memory usage: ${output_prefix}_massif.out"
    echo "  Cache usage:  ${output_prefix}_cachegrind.out"
    
    # Basic summary
    echo
    echo "Memory check summary:"
    if grep -q "ERROR SUMMARY: 0 errors" "${output_prefix}_memcheck.log"; then
        echo "✓ No memory errors detected"
    else
        echo "⚠ Memory errors detected:"
        grep "ERROR SUMMARY" "${output_prefix}_memcheck.log"
    fi
    
    if grep -q "definitely lost: 0 bytes" "${output_prefix}_memcheck.log"; then
        echo "✓ No definite memory leaks"
    else
        echo "⚠ Memory leaks detected:"
        grep "definitely lost" "${output_prefix}_memcheck.log"
    fi
}

# System memory pressure analysis
analyze_memory_pressure() {
    echo "=== Memory Pressure Analysis ==="
    
    # Check for OOM killer activity
    echo "OOM killer activity:"
    dmesg | grep -i "killed process" | tail -10
    echo
    
    # Check swap usage
    echo "Swap usage:"
    cat /proc/swaps
    swapon --show
    echo
    
    # Memory pressure indicators
    echo "Memory pressure indicators:"
    echo "Page faults:"
    awk '/pgfault/ {print "  Page faults: " $2}' /proc/vmstat
    awk '/pgmajfault/ {print "  Major faults: " $2}' /proc/vmstat
    echo
    
    echo "Memory reclaim activity:"
    awk '/pgscan/ {print "  " $1 ": " $2}' /proc/vmstat
    awk '/pgsteal/ {print "  " $1 ": " $2}' /proc/vmstat
    echo
    
    echo "Slab memory usage:"
    echo "  Total slab: $(awk '/^Slab:/ {print $2}' /proc/meminfo) KB"
    echo "  Reclaimable: $(awk '/^SReclaimable:/ {print $2}' /proc/meminfo) KB"
    echo "  Unreclaimable: $(awk '/^SUnreclaim:/ {print $2}' /proc/meminfo) KB"
    echo
    
    # Top slab users
    echo "Top slab memory users:"
    if [ -r /proc/slabinfo ]; then
        awk 'NR>2 {
            obj_size = $4
            num_objs = $3
            total_size = obj_size * num_objs
            if (total_size > 1024) {
                printf "  %-20s: %8d KB\n", $1, total_size/1024
            }
        }' /proc/slabinfo | sort -k3 -nr | head -10
    else
        echo "  /proc/slabinfo not accessible"
    fi
}
```

## I/O Performance Analysis

### I/O Monitoring Tools

```bash
#!/bin/bash
# io_performance.sh - I/O performance analysis tools

# Install I/O analysis tools
install_io_tools() {
    echo "=== Installing I/O analysis tools ==="
    
    apt-get update
    apt-get install -y \
        iotop \
        atop \
        blktrace \
        fio \
        hdparm \
        smartmontools \
        sysstat
    
    echo "I/O tools installation complete"
}

# Disk performance benchmarking
benchmark_disk_performance() {
    local device=${1:-"/dev/sda"}
    local test_file=${2:-"/tmp/disk_test"}
    
    echo "=== Disk Performance Benchmark ==="
    echo "Device: $device"
    echo "Test file: $test_file"
    echo
    
    # Basic disk info
    echo "Disk information:"
    if command -v hdparm >/dev/null; then
        hdparm -I $device 2>/dev/null | grep -E "(Model|Serial|Capacity)" || echo "Device info not available"
    fi
    echo
    
    # Sequential read test
    echo "Sequential read test (1GB)..."
    if command -v fio >/dev/null; then
        fio --name=seqread --rw=read --bs=1M --size=1G --numjobs=1 \
            --filename=$test_file --direct=1 --runtime=60 --time_based=0 \
            --output-format=normal | grep -E "(READ:|iops|BW)"
    else
        dd if=$test_file of=/dev/null bs=1M count=1024 2>&1 | tail -1
    fi
    echo
    
    # Sequential write test
    echo "Sequential write test (1GB)..."
    if command -v fio >/dev/null; then
        fio --name=seqwrite --rw=write --bs=1M --size=1G --numjobs=1 \
            --filename=$test_file --direct=1 --runtime=60 --time_based=0 \
            --output-format=normal | grep -E "(WRITE:|iops|BW)"
    else
        dd if=/dev/zero of=$test_file bs=1M count=1024 2>&1 | tail -1
    fi
    echo
    
    # Random read test
    echo "Random read test (4KB blocks)..."
    if command -v fio >/dev/null; then
        fio --name=randread --rw=randread --bs=4K --size=1G --numjobs=1 \
            --filename=$test_file --direct=1 --runtime=30 --time_based=1 \
            --output-format=normal | grep -E "(READ:|iops|BW)"
    fi
    echo
    
    # Random write test
    echo "Random write test (4KB blocks)..."
    if command -v fio >/dev/null; then
        fio --name=randwrite --rw=randwrite --bs=4K --size=1G --numjobs=1 \
            --filename=$test_file --direct=1 --runtime=30 --time_based=1 \
            --output-format=normal | grep -E "(WRITE:|iops|BW)"
    fi
    
    # Cleanup
    rm -f $test_file
}

# Real-time I/O monitoring
monitor_io_realtime() {
    local duration=${1:-60}
    local interval=${2:-1}
    
    echo "=== Real-time I/O Monitoring ==="
    echo "Duration: ${duration}s, Interval: ${interval}s"
    echo
    
    # Use iostat for detailed I/O statistics
    if command -v iostat >/dev/null; then
        echo "Starting iostat monitoring..."
        iostat -x $interval $((duration / interval))
    else
        echo "iostat not available, using basic monitoring..."
        
        local start_time=$(date +%s)
        local end_time=$((start_time + duration))
        
        while [ $(date +%s) -lt $end_time ]; do
            echo "=== $(date) ==="
            
            # Per-device I/O stats
            for device in /sys/block/sd*; do
                local dev_name=$(basename $device)
                if [ -f "$device/stat" ]; then
                    local stats=($(cat $device/stat))
                    local reads=${stats[0]}
                    local writes=${stats[4]}
                    local read_sectors=${stats[2]}
                    local write_sectors=${stats[6]}
                    
                    printf "%-8s: reads=%8d writes=%8d read_sectors=%10d write_sectors=%10d\n" \
                           $dev_name $reads $writes $read_sectors $write_sectors
                fi
            done
            
            echo
            sleep $interval
        done
    fi
}

# Process I/O analysis
analyze_process_io() {
    local pid=$1
    
    if [ -z "$pid" ]; then
        echo "Usage: analyze_process_io <pid>"
        return 1
    fi
    
    if [ ! -d "/proc/$pid" ]; then
        echo "Process $pid not found"
        return 1
    fi
    
    echo "=== Process I/O Analysis: PID $pid ==="
    
    # Basic process info
    local cmd=$(cat /proc/$pid/comm 2>/dev/null)
    echo "Command: $cmd"
    echo
    
    # I/O statistics
    if [ -f "/proc/$pid/io" ]; then
        echo "I/O statistics:"
        cat /proc/$pid/io | while read line; do
            echo "  $line"
        done
        echo
    fi
    
    # Open files
    echo "Open files (first 20):"
    lsof -p $pid 2>/dev/null | head -21 | tail -20
    echo
    
    # File descriptor usage
    if [ -d "/proc/$pid/fd" ]; then
        local fd_count=$(ls /proc/$pid/fd | wc -l)
        echo "File descriptors: $fd_count open"
        
        echo "File descriptor breakdown:"
        ls -la /proc/$pid/fd 2>/dev/null | \
        awk 'NR>1 {
            if ($11 ~ /socket:/) socket++
            else if ($11 ~ /pipe:/) pipe++
            else if ($11 ~ /dev/) device++
            else if ($11 ~ /\//) file++
            else other++
        } END {
            printf "  Regular files: %d\n", file+0
            printf "  Sockets:       %d\n", socket+0
            printf "  Pipes:         %d\n", pipe+0
            printf "  Devices:       %d\n", device+0
            printf "  Other:         %d\n", other+0
        }'
    fi
}

# I/O latency analysis
analyze_io_latency() {
    local device=${1:-"sda"}
    local duration=${2:-30}
    
    echo "=== I/O Latency Analysis ==="
    echo "Device: $device, Duration: ${duration}s"
    
    # Use blktrace if available
    if command -v blktrace >/dev/null; then
        echo "Starting blktrace analysis..."
        
        # Start tracing
        blktrace -d /dev/$device -o /tmp/blktrace_$device &
        local blktrace_pid=$!
        
        sleep $duration
        
        # Stop tracing
        kill $blktrace_pid 2>/dev/null
        wait $blktrace_pid 2>/dev/null
        
        # Analyze results
        if [ -f "/tmp/blktrace_${device}.blktrace.0" ]; then
            echo "Analyzing trace data..."
            blkparse -i /tmp/blktrace_$device -o /tmp/blkparse_$device.out
            
            # Extract latency information
            echo "I/O latency statistics:"
            awk '/Complete/ {
                # Parse completion events for latency analysis
                print $0
            }' /tmp/blkparse_$device.out | head -20
            
            # Cleanup
            rm -f /tmp/blktrace_${device}.*
            rm -f /tmp/blkparse_$device.out
        fi
    else
        echo "blktrace not available, using basic latency monitoring..."
        
        # Monitor using /proc/diskstats
        local stats_file="/tmp/diskstats_$$"
        
        # Collect baseline
        grep $device /proc/diskstats > $stats_file.before
        sleep $duration
        grep $device /proc/diskstats > $stats_file.after
        
        # Calculate average I/O time
        awk -v before_file="$stats_file.before" '
        BEGIN {
            getline before < before_file
            split(before, b_fields)
            b_io_time = b_fields[13]  # Field 13 is I/O time in ms
            b_ios = b_fields[4] + b_fields[8]  # reads + writes
        }
        {
            a_io_time = $13
            a_ios = $4 + $8
            
            if (a_ios > b_ios) {
                avg_latency = (a_io_time - b_io_time) / (a_ios - b_ios)
                printf "Average I/O latency: %.2f ms\n", avg_latency
            }
        }' $stats_file.after
        
        rm -f $stats_file.*
    fi
}

# Storage device health check
check_storage_health() {
    echo "=== Storage Device Health Check ==="
    
    # List all block devices
    echo "Block devices:"
    lsblk -o NAME,SIZE,TYPE,MOUNTPOINT,FSTYPE
    echo
    
    # Check SMART status for each drive
    for device in /dev/sd?; do
        if [ -b "$device" ]; then
            local dev_name=$(basename $device)
            echo "Checking $device..."
            
            if command -v smartctl >/dev/null; then
                # SMART overall health
                local health=$(smartctl -H $device 2>/dev/null | grep "SMART overall-health" | awk '{print $NF}')
                echo "  SMART health: $health"
                
                # Critical SMART attributes
                smartctl -A $device 2>/dev/null | \
                awk '/Raw_Read_Error_Rate|Reallocated_Sector_Ct|Spin_Retry_Count|End-to-End_Error|Reported_Uncorrect|Command_Timeout|Current_Pending_Sector|Offline_Uncorrectable/ {
                    printf "  %-25s: %s\n", $2, $10
                }'
            else
                echo "  smartctl not available"
            fi
            
            # Basic device info
            if command -v hdparm >/dev/null; then
                hdparm -I $device 2>/dev/null | grep -E "(Model|Serial)" | \
                sed 's/^/  /'
            fi
            
            echo
        fi
    done
    
    # File system usage
    echo "File system usage:"
    df -h | grep -E "^/dev/"
    echo
    
    # Check for file system errors in dmesg
    echo "Recent file system errors:"
    dmesg | grep -i -E "(error|fail|corrupt)" | grep -E "(ext4|xfs|btrfs)" | tail -10
}

# I/O scheduler analysis
analyze_io_scheduler() {
    echo "=== I/O Scheduler Analysis ==="
    
    for device in /sys/block/sd*; do
        if [ -d "$device" ]; then
            local dev_name=$(basename $device)
            local scheduler_file="$device/queue/scheduler"
            
            if [ -f "$scheduler_file" ]; then
                echo "Device: $dev_name"
                echo "  Current scheduler: $(cat $scheduler_file)"
                echo "  Queue depth: $(cat $device/queue/nr_requests)"
                echo "  Read ahead: $(cat $device/queue/read_ahead_kb) KB"
                echo "  Rotational: $(cat $device/queue/rotational)"
                echo
            fi
        fi
    done
    
    # Scheduler recommendations
    echo "Scheduler recommendations:"
    echo "  SSDs: Use 'none' or 'mq-deadline' for lowest latency"
    echo "  HDDs: Use 'mq-deadline' or 'bfq' for better throughput"
    echo "  Virtual machines: Use 'noop' or 'none'"
    echo
    echo "To change scheduler: echo 'scheduler_name' > /sys/block/sdX/queue/scheduler"
}
```

## Best Practices

1. **Baseline Measurements**: Always establish performance baselines before optimization
2. **Systematic Approach**: Profile first, then optimize the biggest bottlenecks
3. **Real Workloads**: Use realistic workloads for performance testing
4. **Multiple Metrics**: Consider CPU, memory, I/O, and network simultaneously
5. **Automation**: Script common profiling tasks for consistent results

## Conclusion

Effective performance optimization requires understanding system behavior at multiple levels. The tools and techniques covered here—from perf CPU profiling to memory analysis and I/O monitoring—provide comprehensive coverage for identifying and resolving performance bottlenecks.

Success in performance optimization comes from methodical analysis, understanding the underlying hardware and software interactions, and applying the right tools for each specific performance challenge. Whether optimizing application performance or system-wide throughput, these advanced profiling techniques are essential for high-performance Linux systems.