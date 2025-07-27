---
title: "Complete Linux Performance Monitoring and Optimization: Advanced Techniques for Enterprise System Tuning"
date: 2025-04-08T10:00:00-05:00
draft: false
tags: ["Linux Performance", "System Monitoring", "Performance Tuning", "Enterprise", "Optimization", "CPU", "Memory", "I/O", "Network", "Benchmarking"]
categories:
- Performance Optimization
- System Monitoring
- Linux Administration
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Linux performance monitoring, analysis, and optimization techniques covering CPU, memory, I/O, and network performance with enterprise automation tools and best practices"
more_link: "yes"
url: "/linux-performance-monitoring-optimization-guide/"
---

Linux performance monitoring and optimization require deep understanding of system resources, bottleneck identification, and strategic tuning approaches. This comprehensive guide covers advanced monitoring techniques, performance analysis methodologies, enterprise optimization strategies, and automated tuning frameworks for production Linux environments.

<!--more-->

# [Performance Monitoring Fundamentals](#performance-monitoring-fundamentals)

## System Performance Architecture

Linux system performance encompasses multiple interconnected subsystems, each with distinct monitoring requirements and optimization strategies.

### Performance Monitoring Stack

```
┌─────────────────────────────────────────────────────────────┐
│                    Application Layer                        │
├─────────────────────────────────────────────────────────────┤
│                   System Libraries                          │
├─────────────────────────────────────────────────────────────┤
│                     User Space                             │
├─────────────────────────────────────────────────────────────┤
│                    System Calls                            │
├─────────────────────────────────────────────────────────────┤
│                   Kernel Space                             │
├─────────────────┬─────────────┬─────────────┬─────────────┤
│   CPU Scheduler │   Memory    │   I/O       │   Network   │
│                 │   Manager   │   Subsystem │   Stack     │
├─────────────────┼─────────────┼─────────────┼─────────────┤
│      Hardware   │   Memory    │   Storage   │   Network   │
│      (CPU)      │   (RAM)     │   (Disk)    │   (NIC)     │
└─────────────────┴─────────────┴─────────────┴─────────────┘
```

### Key Performance Metrics Categories

| Category | Primary Metrics | Monitoring Tools | Optimization Focus |
|----------|----------------|------------------|-------------------|
| **CPU** | Utilization, Load Average, Context Switches | top, htop, vmstat, sar | Process scheduling, CPU affinity |
| **Memory** | Usage, Buffers, Cache, Swap | free, vmstat, /proc/meminfo | Memory allocation, swap tuning |
| **I/O** | IOPS, Throughput, Latency, Queue Depth | iostat, iotop, blktrace | Filesystem, storage optimization |
| **Network** | Bandwidth, Packets, Connections, Errors | netstat, ss, iftop, nload | Network stack, protocol tuning |
| **Process** | CPU Time, Memory RSS, File Descriptors | ps, pidstat, pmap | Resource limits, scheduling |

## Comprehensive Monitoring Framework

### Enterprise Performance Monitoring Script

```bash
#!/bin/bash
# Enterprise Linux Performance Monitoring and Analysis Framework

set -euo pipefail

# Configuration
MONITOR_INTERVAL=5
LOG_DIR="/var/log/performance"
REPORT_DIR="/opt/performance/reports"
ALERT_THRESHOLD_CPU=80
ALERT_THRESHOLD_MEMORY=85
ALERT_THRESHOLD_DISK=90
RETENTION_DAYS=30

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
NC='\033[0m'

# Logging functions
log_info() { echo -e "${BLUE}[INFO]${NC} $1" | tee -a "$LOG_DIR/monitor.log"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1" | tee -a "$LOG_DIR/monitor.log"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1" | tee -a "$LOG_DIR/monitor.log"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1" | tee -a "$LOG_DIR/monitor.log"; }

# Create necessary directories
setup_monitoring_environment() {
    log_info "Setting up performance monitoring environment..."
    
    mkdir -p "$LOG_DIR" "$REPORT_DIR"
    chmod 755 "$LOG_DIR" "$REPORT_DIR"
    
    # Install required tools if missing
    local tools=("sysstat" "iotop" "htop" "nload" "ncdu" "dstat" "atop")
    
    for tool in "${tools[@]}"; do
        if ! command -v "$tool" >/dev/null 2>&1; then
            log_info "Installing missing tool: $tool"
            
            if command -v apt >/dev/null 2>&1; then
                apt update && apt install -y "$tool"
            elif command -v yum >/dev/null 2>&1; then
                yum install -y "$tool"
            elif command -v dnf >/dev/null 2>&1; then
                dnf install -y "$tool"
            fi
        fi
    done
    
    log_success "Monitoring environment setup completed"
}

# CPU monitoring and analysis
monitor_cpu_performance() {
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    local output_file="$LOG_DIR/cpu_$(date +%Y%m%d).log"
    
    {
        echo "=== CPU Performance Report - $timestamp ==="
        
        # CPU utilization and load average
        echo "--- Load Average ---"
        cat /proc/loadavg
        
        echo -e "\n--- CPU Usage (vmstat) ---"
        vmstat 1 5 | tail -n +3
        
        echo -e "\n--- CPU Information ---"
        lscpu | grep -E "(CPU\(s\)|Thread|Core|Socket|Model|MHz)"
        
        echo -e "\n--- Top CPU Consumers ---"
        ps aux --sort=-%cpu | head -20
        
        echo -e "\n--- CPU Frequency Scaling ---"
        for cpu in /sys/devices/system/cpu/cpu[0-9]*; do
            if [[ -f "$cpu/cpufreq/scaling_cur_freq" ]]; then
                cpu_num=$(basename "$cpu")
                freq=$(cat "$cpu/cpufreq/scaling_cur_freq")
                gov=$(cat "$cpu/cpufreq/scaling_governor" 2>/dev/null || echo "unknown")
                echo "$cpu_num: ${freq}kHz (governor: $gov)"
            fi
        done
        
        echo -e "\n--- Context Switches and Interrupts ---"
        grep -E "(ctxt|intr)" /proc/stat
        
        echo "================================="
        echo ""
    } >> "$output_file"
    
    # Check CPU alerts
    local cpu_usage=$(vmstat 1 2 | tail -1 | awk '{print 100-$15}')
    if (( $(echo "$cpu_usage > $ALERT_THRESHOLD_CPU" | bc -l) )); then
        log_warn "High CPU usage detected: ${cpu_usage}%"
        send_alert "CPU" "High CPU usage: ${cpu_usage}%"
    fi
}

# Memory monitoring and analysis
monitor_memory_performance() {
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    local output_file="$LOG_DIR/memory_$(date +%Y%m%d).log"
    
    {
        echo "=== Memory Performance Report - $timestamp ==="
        
        echo "--- Memory Summary ---"
        free -h
        
        echo -e "\n--- Detailed Memory Information ---"
        cat /proc/meminfo | grep -E "(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree|Dirty|Writeback|Slab)"
        
        echo -e "\n--- Memory Usage by Process ---"
        ps aux --sort=-%mem | head -20
        
        echo -e "\n--- Virtual Memory Statistics ---"
        vmstat -s | grep -E "(memory|swap|cache|buffer)"
        
        echo -e "\n--- Swap Usage ---"
        swapon --show
        
        echo -e "\n--- Memory Pressure (if available) ---"
        if [[ -f /proc/pressure/memory ]]; then
            cat /proc/pressure/memory
        fi
        
        echo -e "\n--- Huge Pages ---"
        grep -E "(HugePages|Hugepagesize)" /proc/meminfo
        
        echo "================================="
        echo ""
    } >> "$output_file"
    
    # Check memory alerts
    local mem_usage=$(free | awk 'NR==2{printf "%.0f", $3*100/$2}')
    if (( mem_usage > ALERT_THRESHOLD_MEMORY )); then
        log_warn "High memory usage detected: ${mem_usage}%"
        send_alert "Memory" "High memory usage: ${mem_usage}%"
    fi
}

# I/O monitoring and analysis
monitor_io_performance() {
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    local output_file="$LOG_DIR/io_$(date +%Y%m%d).log"
    
    {
        echo "=== I/O Performance Report - $timestamp ==="
        
        echo "--- I/O Statistics (iostat) ---"
        iostat -x 1 3 | grep -v "^$"
        
        echo -e "\n--- Disk Usage ---"
        df -h | grep -v tmpfs
        
        echo -e "\n--- I/O Pressure (if available) ---"
        if [[ -f /proc/pressure/io ]]; then
            cat /proc/pressure/io
        fi
        
        echo -e "\n--- Block Device Information ---"
        lsblk -o NAME,SIZE,TYPE,MOUNTPOINT,FSTYPE,UUID
        
        echo -e "\n--- Mount Points and Options ---"
        mount | grep -E "(ext[234]|xfs|btrfs|zfs)" | column -t
        
        echo -e "\n--- Top I/O Processes ---"
        if command -v iotop >/dev/null 2>&1; then
            iotop -b -n 1 -o | head -20
        fi
        
        echo -e "\n--- Filesystem Statistics ---"
        for fs in $(df --output=target | tail -n +2 | grep -v tmpfs); do
            if [[ -d "$fs" ]]; then
                echo "Filesystem: $fs"
                find "$fs" -mount -type f -exec ls -l {} \; 2>/dev/null | \
                    awk '{sum+=$5} END {printf "Total size: %.2f GB\n", sum/1024/1024/1024}' || true
            fi
        done
        
        echo "================================="
        echo ""
    } >> "$output_file"
    
    # Check disk usage alerts
    while read -r line; do
        usage=$(echo "$line" | awk '{print $5}' | tr -d '%')
        mount=$(echo "$line" | awk '{print $6}')
        
        if [[ "$usage" =~ ^[0-9]+$ ]] && (( usage > ALERT_THRESHOLD_DISK )); then
            log_warn "High disk usage detected: ${usage}% on $mount"
            send_alert "Disk" "High disk usage: ${usage}% on $mount"
        fi
    done < <(df | grep -v tmpfs | tail -n +2)
}

# Network monitoring and analysis
monitor_network_performance() {
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    local output_file="$LOG_DIR/network_$(date +%Y%m%d).log"
    
    {
        echo "=== Network Performance Report - $timestamp ==="
        
        echo "--- Network Interface Statistics ---"
        cat /proc/net/dev | column -t
        
        echo -e "\n--- Network Connections ---"
        ss -tuln | head -20
        
        echo -e "\n--- Network Configuration ---"
        ip addr show | grep -E "(inet|link/ether|state)"
        
        echo -e "\n--- Routing Table ---"
        ip route show
        
        echo -e "\n--- Network Traffic (5 second sample) ---"
        if command -v nload >/dev/null 2>&1; then
            timeout 5 nload -t 1000 2>/dev/null || echo "Network traffic monitoring skipped"
        fi
        
        echo -e "\n--- TCP Connection States ---"
        ss -tan | awk 'NR>1 {print $1}' | sort | uniq -c | sort -nr
        
        echo -e "\n--- Network Errors ---"
        grep -E "(drop|error)" /proc/net/dev | grep -v "0.*0"
        
        echo -e "\n--- Firewall Status ---"
        if command -v ufw >/dev/null 2>&1; then
            ufw status verbose 2>/dev/null || echo "UFW not configured"
        elif command -v iptables >/dev/null 2>&1; then
            iptables -L -n | head -20
        fi
        
        echo "================================="
        echo ""
    } >> "$output_file"
}

# Process and system monitoring
monitor_system_processes() {
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    local output_file="$LOG_DIR/processes_$(date +%Y%m%d).log"
    
    {
        echo "=== Process Performance Report - $timestamp ==="
        
        echo "--- System Overview ---"
        uptime
        who
        
        echo -e "\n--- Process Summary ---"
        ps aux | awk 'NR==1 {print $0} NR>1 {cpu+=$3; mem+=$4; processes++} END {
            printf "Total Processes: %d\n", processes
            printf "Total CPU Usage: %.2f%%\n", cpu
            printf "Total Memory Usage: %.2f%%\n", mem
        }'
        
        echo -e "\n--- Top Processes by Resource Usage ---"
        echo "--- CPU ---"
        ps aux --sort=-%cpu | head -10
        
        echo -e "\n--- Memory ---"
        ps aux --sort=-%mem | head -10
        
        echo -e "\n--- Process Tree (top level) ---"
        pstree -a | head -20
        
        echo -e "\n--- System Services Status ---"
        systemctl list-units --type=service --state=running | head -20
        
        echo -e "\n--- Resource Limits ---"
        ulimit -a
        
        echo -e "\n--- Open File Descriptors ---"
        echo "System limit: $(cat /proc/sys/fs/file-max)"
        echo "Currently open: $(cat /proc/sys/fs/file-nr | awk '{print $1}')"
        
        echo "================================="
        echo ""
    } >> "$output_file"
}

# Performance benchmarking
run_performance_benchmark() {
    local benchmark_dir="$REPORT_DIR/benchmarks/$(date +%Y%m%d_%H%M%S)"
    mkdir -p "$benchmark_dir"
    
    log_info "Running performance benchmarks..."
    
    # CPU benchmark
    {
        echo "=== CPU Benchmark ==="
        echo "Running CPU stress test for 30 seconds..."
        
        if command -v stress >/dev/null 2>&1; then
            timeout 30 stress --cpu $(nproc) --timeout 30s 2>/dev/null &
            stress_pid=$!
            
            # Monitor during stress test
            for i in {1..6}; do
                echo "Sample $i:"
                vmstat 1 1 | tail -1
                sleep 5
            done
            
            wait $stress_pid 2>/dev/null || true
        else
            echo "stress tool not available, skipping CPU benchmark"
        fi
        
        echo "CPU benchmark completed"
        echo ""
    } > "$benchmark_dir/cpu_benchmark.log"
    
    # Memory benchmark
    {
        echo "=== Memory Benchmark ==="
        echo "Running memory allocation test..."
        
        # Simple memory allocation test
        python3 -c "
import time
import gc
data = []
start_time = time.time()
for i in range(100000):
    data.append('x' * 1000)
    if i % 10000 == 0:
        print(f'Allocated {i//1000}MB')
end_time = time.time()
print(f'Memory allocation test completed in {end_time - start_time:.2f} seconds')
del data
gc.collect()
" 2>/dev/null || echo "Python not available for memory benchmark"
        
        echo "Memory benchmark completed"
        echo ""
    } > "$benchmark_dir/memory_benchmark.log"
    
    # Disk I/O benchmark
    {
        echo "=== Disk I/O Benchmark ==="
        echo "Running disk I/O tests..."
        
        local test_file="/tmp/benchmark_test_$$"
        
        # Write test
        echo "Write test (1GB):"
        dd if=/dev/zero of="$test_file" bs=1M count=1024 oflag=direct 2>&1 | \
            grep -E "(copied|MB/s|GB/s)"
        
        # Read test
        echo "Read test (1GB):"
        dd if="$test_file" of=/dev/null bs=1M iflag=direct 2>&1 | \
            grep -E "(copied|MB/s|GB/s)"
        
        # Cleanup
        rm -f "$test_file"
        
        echo "Disk I/O benchmark completed"
        echo ""
    } > "$benchmark_dir/io_benchmark.log"
    
    log_success "Benchmarks completed and saved to $benchmark_dir"
}

# Alert system
send_alert() {
    local alert_type="$1"
    local message="$2"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    
    # Log alert
    echo "$timestamp - ALERT: [$alert_type] $message" >> "$LOG_DIR/alerts.log"
    
    # Send notification (customize as needed)
    if command -v mail >/dev/null 2>&1; then
        echo "$message" | mail -s "Performance Alert: $alert_type" root
    fi
    
    # System notification
    if [[ -n "${DISPLAY:-}" ]] && command -v notify-send >/dev/null 2>&1; then
        notify-send "Performance Alert" "$alert_type: $message"
    fi
    
    # Webhook notification (example)
    if [[ -n "${WEBHOOK_URL:-}" ]]; then
        curl -X POST "$WEBHOOK_URL" \
            -H "Content-Type: application/json" \
            -d "{\"alert\":\"$alert_type\",\"message\":\"$message\",\"timestamp\":\"$timestamp\"}" \
            2>/dev/null || true
    fi
}

# Report generation
generate_performance_report() {
    local report_file="$REPORT_DIR/performance_report_$(date +%Y%m%d_%H%M%S).html"
    
    log_info "Generating comprehensive performance report..."
    
    cat > "$report_file" << 'EOF'
<!DOCTYPE html>
<html>
<head>
    <title>Linux Performance Report</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .header { background-color: #f0f0f0; padding: 10px; border-radius: 5px; }
        .section { margin: 20px 0; padding: 10px; border-left: 3px solid #007acc; }
        .metric { background-color: #f9f9f9; padding: 5px; margin: 5px 0; }
        .alert { background-color: #ffeeee; border-left: 3px solid #ff0000; }
        .warning { background-color: #fff9ee; border-left: 3px solid #ff9900; }
        .good { background-color: #eeffee; border-left: 3px solid #00aa00; }
        pre { background-color: #f5f5f5; padding: 10px; overflow-x: auto; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
        th { background-color: #f2f2f2; }
    </style>
</head>
<body>
    <div class="header">
        <h1>Linux Performance Report</h1>
        <p>Generated: $(date)</p>
        <p>Hostname: $(hostname)</p>
        <p>Kernel: $(uname -r)</p>
    </div>
EOF
    
    # Add system overview
    {
        echo '<div class="section">'
        echo '<h2>System Overview</h2>'
        echo '<pre>'
        uptime
        echo '</pre>'
        echo '</div>'
        
        echo '<div class="section">'
        echo '<h2>Resource Summary</h2>'
        echo '<table>'
        echo '<tr><th>Resource</th><th>Usage</th><th>Status</th></tr>'
        
        # CPU usage
        local cpu_usage=$(vmstat 1 2 | tail -1 | awk '{print 100-$15}')
        local cpu_status="good"
        if (( $(echo "$cpu_usage > 80" | bc -l) )); then
            cpu_status="alert"
        elif (( $(echo "$cpu_usage > 60" | bc -l) )); then
            cpu_status="warning"
        fi
        echo "<tr class=\"$cpu_status\"><td>CPU</td><td>${cpu_usage}%</td><td>${cpu_status}</td></tr>"
        
        # Memory usage
        local mem_usage=$(free | awk 'NR==2{printf "%.0f", $3*100/$2}')
        local mem_status="good"
        if (( mem_usage > 85 )); then
            mem_status="alert"
        elif (( mem_usage > 70 )); then
            mem_status="warning"
        fi
        echo "<tr class=\"$mem_status\"><td>Memory</td><td>${mem_usage}%</td><td>${mem_status}</td></tr>"
        
        # Disk usage (root filesystem)
        local disk_usage=$(df / | awk 'NR==2 {print $5}' | tr -d '%')
        local disk_status="good"
        if (( disk_usage > 90 )); then
            disk_status="alert"
        elif (( disk_usage > 80 )); then
            disk_status="warning"
        fi
        echo "<tr class=\"$disk_status\"><td>Disk (/)</td><td>${disk_usage}%</td><td>${disk_status}</td></tr>"
        
        echo '</table>'
        echo '</div>'
    } >> "$report_file"
    
    # Add recent alerts
    if [[ -f "$LOG_DIR/alerts.log" ]]; then
        echo '<div class="section alert">' >> "$report_file"
        echo '<h2>Recent Alerts (Last 24 Hours)</h2>' >> "$report_file"
        echo '<pre>' >> "$report_file"
        tail -n 50 "$LOG_DIR/alerts.log" | grep "$(date -d '1 day ago' '+%Y-%m-%d')\|$(date '+%Y-%m-%d')" >> "$report_file"
        echo '</pre>' >> "$report_file"
        echo '</div>' >> "$report_file"
    fi
    
    echo '</body></html>' >> "$report_file"
    
    log_success "Performance report generated: $report_file"
}

# Cleanup old logs
cleanup_old_logs() {
    log_info "Cleaning up logs older than $RETENTION_DAYS days..."
    
    find "$LOG_DIR" -name "*.log" -type f -mtime +"$RETENTION_DAYS" -delete
    find "$REPORT_DIR" -name "*.html" -type f -mtime +"$RETENTION_DAYS" -delete
    find "$REPORT_DIR/benchmarks" -type d -mtime +"$RETENTION_DAYS" -exec rm -rf {} + 2>/dev/null || true
    
    log_success "Log cleanup completed"
}

# Main monitoring loop
run_continuous_monitoring() {
    log_info "Starting continuous performance monitoring..."
    
    while true; do
        local start_time=$(date +%s)
        
        # Run all monitoring functions
        monitor_cpu_performance
        monitor_memory_performance
        monitor_io_performance
        monitor_network_performance
        monitor_system_processes
        
        # Generate report every hour
        local current_minute=$(date +%M)
        if [[ "$current_minute" == "00" ]]; then
            generate_performance_report
        fi
        
        # Cleanup every day at midnight
        local current_hour=$(date +%H)
        if [[ "$current_hour" == "00" && "$current_minute" == "00" ]]; then
            cleanup_old_logs
        fi
        
        # Calculate sleep time to maintain interval
        local end_time=$(date +%s)
        local elapsed=$((end_time - start_time))
        local sleep_time=$((MONITOR_INTERVAL - elapsed))
        
        if (( sleep_time > 0 )); then
            sleep "$sleep_time"
        fi
    done
}

# Command line interface
main() {
    case "${1:-monitor}" in
        "setup")
            setup_monitoring_environment
            ;;
        "monitor")
            setup_monitoring_environment
            run_continuous_monitoring
            ;;
        "benchmark")
            setup_monitoring_environment
            run_performance_benchmark
            ;;
        "report")
            generate_performance_report
            ;;
        "cleanup")
            cleanup_old_logs
            ;;
        *)
            echo "Usage: $0 {setup|monitor|benchmark|report|cleanup}"
            echo ""
            echo "Commands:"
            echo "  setup     - Initialize monitoring environment"
            echo "  monitor   - Start continuous monitoring (default)"
            echo "  benchmark - Run performance benchmarks"
            echo "  report    - Generate performance report"
            echo "  cleanup   - Clean up old log files"
            exit 1
            ;;
    esac
}

# Script execution
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
```

# [Advanced Performance Analysis](#advanced-performance-analysis)

## System Bottleneck Identification

### Performance Analysis Toolkit

```python
#!/usr/bin/env python3
"""
Advanced Linux Performance Analysis and Bottleneck Detection
"""

import subprocess
import time
import json
import statistics
import psutil
import re
from typing import Dict, List, Tuple, Optional
from dataclasses import dataclass
from pathlib import Path
import matplotlib.pyplot as plt
import pandas as pd

@dataclass
class PerformanceMetrics:
    timestamp: float
    cpu_usage: float
    memory_usage: float
    io_wait: float
    load_average: Tuple[float, float, float]
    disk_io: Dict[str, Dict[str, float]]
    network_io: Dict[str, Dict[str, int]]
    context_switches: int
    interrupts: int

class PerformanceAnalyzer:
    def __init__(self, analysis_duration: int = 300):
        self.analysis_duration = analysis_duration
        self.metrics_history: List[PerformanceMetrics] = []
        self.bottlenecks: List[str] = []
        
    def collect_metrics(self) -> PerformanceMetrics:
        """Collect comprehensive system metrics"""
        timestamp = time.time()
        
        # CPU metrics
        cpu_usage = psutil.cpu_percent(interval=1)
        load_avg = psutil.getloadavg()
        
        # Memory metrics
        memory = psutil.virtual_memory()
        memory_usage = memory.percent
        
        # I/O wait from vmstat
        vmstat_output = subprocess.run(['vmstat', '1', '2'], 
                                     capture_output=True, text=True)
        lines = vmstat_output.stdout.strip().split('\n')
        if len(lines) >= 4:
            io_wait = float(lines[-1].split()[15])  # wa column
        else:
            io_wait = 0.0
        
        # Disk I/O metrics
        disk_io = {}
        for device, stats in psutil.disk_io_counters(perdisk=True).items():
            disk_io[device] = {
                'read_bytes': stats.read_bytes,
                'write_bytes': stats.write_bytes,
                'read_count': stats.read_count,
                'write_count': stats.write_count,
                'read_time': stats.read_time,
                'write_time': stats.write_time
            }
        
        # Network I/O metrics
        network_io = {}
        for interface, stats in psutil.net_io_counters(pernic=True).items():
            network_io[interface] = {
                'bytes_sent': stats.bytes_sent,
                'bytes_recv': stats.bytes_recv,
                'packets_sent': stats.packets_sent,
                'packets_recv': stats.packets_recv,
                'errin': stats.errin,
                'errout': stats.errout,
                'dropin': stats.dropin,
                'dropout': stats.dropout
            }
        
        # System activity metrics
        with open('/proc/stat', 'r') as f:
            stat_content = f.read()
        
        context_switches = 0
        interrupts = 0
        for line in stat_content.split('\n'):
            if line.startswith('ctxt'):
                context_switches = int(line.split()[1])
            elif line.startswith('intr'):
                interrupts = int(line.split()[1])
        
        return PerformanceMetrics(
            timestamp=timestamp,
            cpu_usage=cpu_usage,
            memory_usage=memory_usage,
            io_wait=io_wait,
            load_average=load_avg,
            disk_io=disk_io,
            network_io=network_io,
            context_switches=context_switches,
            interrupts=interrupts
        )
    
    def analyze_performance(self) -> Dict[str, any]:
        """Perform comprehensive performance analysis"""
        print("Starting performance analysis...")
        
        # Collect metrics over analysis duration
        start_time = time.time()
        sample_interval = 5
        
        while time.time() - start_time < self.analysis_duration:
            metrics = self.collect_metrics()
            self.metrics_history.append(metrics)
            print(f"Collected sample {len(self.metrics_history)}")
            time.sleep(sample_interval)
        
        # Analyze collected data
        analysis_results = {
            'duration': self.analysis_duration,
            'samples': len(self.metrics_history),
            'cpu_analysis': self._analyze_cpu(),
            'memory_analysis': self._analyze_memory(),
            'io_analysis': self._analyze_io(),
            'network_analysis': self._analyze_network(),
            'system_analysis': self._analyze_system(),
            'bottlenecks': self._identify_bottlenecks(),
            'recommendations': self._generate_recommendations()
        }
        
        return analysis_results
    
    def _analyze_cpu(self) -> Dict[str, any]:
        """Analyze CPU performance patterns"""
        cpu_values = [m.cpu_usage for m in self.metrics_history]
        load_values = [m.load_average[0] for m in self.metrics_history]
        
        return {
            'average_usage': statistics.mean(cpu_values),
            'max_usage': max(cpu_values),
            'min_usage': min(cpu_values),
            'usage_variance': statistics.variance(cpu_values) if len(cpu_values) > 1 else 0,
            'average_load_1min': statistics.mean(load_values),
            'max_load_1min': max(load_values),
            'high_usage_periods': len([x for x in cpu_values if x > 80]),
            'cpu_cores': psutil.cpu_count(),
            'load_per_core': statistics.mean(load_values) / psutil.cpu_count()
        }
    
    def _analyze_memory(self) -> Dict[str, any]:
        """Analyze memory usage patterns"""
        memory_values = [m.memory_usage for m in self.metrics_history]
        
        # Get detailed memory information
        memory_info = psutil.virtual_memory()
        swap_info = psutil.swap_memory()
        
        return {
            'average_usage': statistics.mean(memory_values),
            'max_usage': max(memory_values),
            'min_usage': min(memory_values),
            'usage_variance': statistics.variance(memory_values) if len(memory_values) > 1 else 0,
            'total_memory_gb': memory_info.total / (1024**3),
            'available_memory_gb': memory_info.available / (1024**3),
            'swap_total_gb': swap_info.total / (1024**3),
            'swap_used_percent': swap_info.percent,
            'high_usage_periods': len([x for x in memory_values if x > 85])
        }
    
    def _analyze_io(self) -> Dict[str, any]:
        """Analyze I/O performance patterns"""
        io_wait_values = [m.io_wait for m in self.metrics_history]
        
        # Calculate I/O rates
        io_analysis = {
            'average_io_wait': statistics.mean(io_wait_values),
            'max_io_wait': max(io_wait_values),
            'high_io_wait_periods': len([x for x in io_wait_values if x > 10]),
            'disk_analysis': {}
        }
        
        # Analyze per-disk metrics
        if self.metrics_history:
            first_sample = self.metrics_history[0]
            last_sample = self.metrics_history[-1]
            duration = last_sample.timestamp - first_sample.timestamp
            
            for device in first_sample.disk_io.keys():
                if device in last_sample.disk_io:
                    first_stats = first_sample.disk_io[device]
                    last_stats = last_sample.disk_io[device]
                    
                    read_rate = (last_stats['read_bytes'] - first_stats['read_bytes']) / duration
                    write_rate = (last_stats['write_bytes'] - first_stats['write_bytes']) / duration
                    
                    io_analysis['disk_analysis'][device] = {
                        'read_rate_mb_s': read_rate / (1024*1024),
                        'write_rate_mb_s': write_rate / (1024*1024),
                        'total_io_rate_mb_s': (read_rate + write_rate) / (1024*1024)
                    }
        
        return io_analysis
    
    def _analyze_network(self) -> Dict[str, any]:
        """Analyze network performance patterns"""
        network_analysis = {
            'interface_analysis': {}
        }
        
        if self.metrics_history:
            first_sample = self.metrics_history[0]
            last_sample = self.metrics_history[-1]
            duration = last_sample.timestamp - first_sample.timestamp
            
            for interface in first_sample.network_io.keys():
                if interface in last_sample.network_io and interface != 'lo':
                    first_stats = first_sample.network_io[interface]
                    last_stats = last_sample.network_io[interface]
                    
                    rx_rate = (last_stats['bytes_recv'] - first_stats['bytes_recv']) / duration
                    tx_rate = (last_stats['bytes_sent'] - first_stats['bytes_sent']) / duration
                    
                    error_rate = (
                        (last_stats['errin'] - first_stats['errin']) +
                        (last_stats['errout'] - first_stats['errout'])
                    ) / duration
                    
                    network_analysis['interface_analysis'][interface] = {
                        'rx_rate_mb_s': rx_rate / (1024*1024),
                        'tx_rate_mb_s': tx_rate / (1024*1024),
                        'total_rate_mb_s': (rx_rate + tx_rate) / (1024*1024),
                        'error_rate_per_s': error_rate
                    }
        
        return network_analysis
    
    def _analyze_system(self) -> Dict[str, any]:
        """Analyze system-level metrics"""
        if len(self.metrics_history) < 2:
            return {}
        
        first_sample = self.metrics_history[0]
        last_sample = self.metrics_history[-1]
        duration = last_sample.timestamp - first_sample.timestamp
        
        context_switch_rate = (
            last_sample.context_switches - first_sample.context_switches
        ) / duration
        
        interrupt_rate = (
            last_sample.interrupts - first_sample.interrupts
        ) / duration
        
        return {
            'context_switch_rate': context_switch_rate,
            'interrupt_rate': interrupt_rate,
            'high_context_switching': context_switch_rate > 100000,
            'system_uptime': time.time() - psutil.boot_time()
        }
    
    def _identify_bottlenecks(self) -> List[str]:
        """Identify system bottlenecks"""
        bottlenecks = []
        
        if not self.metrics_history:
            return bottlenecks
        
        # CPU bottleneck detection
        avg_cpu = statistics.mean([m.cpu_usage for m in self.metrics_history])
        avg_load = statistics.mean([m.load_average[0] for m in self.metrics_history])
        
        if avg_cpu > 80:
            bottlenecks.append("High CPU usage detected (average: {:.1f}%)".format(avg_cpu))
        
        if avg_load > psutil.cpu_count() * 0.8:
            bottlenecks.append("High system load detected (average: {:.2f})".format(avg_load))
        
        # Memory bottleneck detection
        avg_memory = statistics.mean([m.memory_usage for m in self.metrics_history])
        if avg_memory > 85:
            bottlenecks.append("High memory usage detected (average: {:.1f}%)".format(avg_memory))
        
        # I/O bottleneck detection
        avg_io_wait = statistics.mean([m.io_wait for m in self.metrics_history])
        if avg_io_wait > 10:
            bottlenecks.append("High I/O wait detected (average: {:.1f}%)".format(avg_io_wait))
        
        # Network error detection
        if self.metrics_history:
            first_sample = self.metrics_history[0]
            last_sample = self.metrics_history[-1]
            
            for interface in first_sample.network_io.keys():
                if interface in last_sample.network_io and interface != 'lo':
                    first_stats = first_sample.network_io[interface]
                    last_stats = last_sample.network_io[interface]
                    
                    total_errors = (
                        (last_stats['errin'] - first_stats['errin']) +
                        (last_stats['errout'] - first_stats['errout'])
                    )
                    
                    if total_errors > 100:
                        bottlenecks.append(f"Network errors detected on {interface}: {total_errors}")
        
        return bottlenecks
    
    def _generate_recommendations(self) -> List[str]:
        """Generate optimization recommendations"""
        recommendations = []
        
        if not self.metrics_history:
            return recommendations
        
        # CPU recommendations
        avg_cpu = statistics.mean([m.cpu_usage for m in self.metrics_history])
        if avg_cpu > 80:
            recommendations.extend([
                "Consider CPU optimization: identify high-CPU processes with 'top' or 'htop'",
                "Review process priorities and consider nice/ionice adjustments",
                "Evaluate CPU affinity for critical processes",
                "Consider adding more CPU cores if consistently high usage"
            ])
        
        # Memory recommendations
        avg_memory = statistics.mean([m.memory_usage for m in self.metrics_history])
        if avg_memory > 85:
            recommendations.extend([
                "Consider memory optimization: identify memory-hungry processes",
                "Review swap configuration and usage patterns",
                "Consider adding more RAM if consistently high usage",
                "Optimize application memory allocation patterns"
            ])
        
        # I/O recommendations
        avg_io_wait = statistics.mean([m.io_wait for m in self.metrics_history])
        if avg_io_wait > 10:
            recommendations.extend([
                "Consider I/O optimization: check disk health and performance",
                "Review filesystem mount options (noatime, etc.)",
                "Consider SSD upgrade for high I/O workloads",
                "Optimize database query patterns if applicable",
                "Consider I/O scheduler tuning (deadline, noop, etc.)"
            ])
        
        # General system recommendations
        recommendations.extend([
            "Regular system monitoring and log analysis",
            "Keep system and applications updated",
            "Monitor system resource trends over time",
            "Implement automated alerting for resource thresholds"
        ])
        
        return recommendations
    
    def export_results(self, output_file: str, analysis_results: Dict) -> None:
        """Export analysis results to JSON file"""
        with open(output_file, 'w') as f:
            json.dump(analysis_results, f, indent=2, default=str)
        
        print(f"Analysis results exported to {output_file}")
    
    def generate_report(self, analysis_results: Dict) -> str:
        """Generate a human-readable performance report"""
        report = []
        report.append("=" * 60)
        report.append("LINUX PERFORMANCE ANALYSIS REPORT")
        report.append("=" * 60)
        report.append(f"Analysis Duration: {analysis_results['duration']} seconds")
        report.append(f"Samples Collected: {analysis_results['samples']}")
        report.append("")
        
        # CPU Analysis
        cpu = analysis_results['cpu_analysis']
        report.append("CPU ANALYSIS:")
        report.append("-" * 20)
        report.append(f"Average Usage: {cpu['average_usage']:.1f}%")
        report.append(f"Maximum Usage: {cpu['max_usage']:.1f}%")
        report.append(f"Average Load (1min): {cpu['average_load_1min']:.2f}")
        report.append(f"Load per Core: {cpu['load_per_core']:.2f}")
        report.append(f"High Usage Periods: {cpu['high_usage_periods']}")
        report.append("")
        
        # Memory Analysis
        memory = analysis_results['memory_analysis']
        report.append("MEMORY ANALYSIS:")
        report.append("-" * 20)
        report.append(f"Average Usage: {memory['average_usage']:.1f}%")
        report.append(f"Maximum Usage: {memory['max_usage']:.1f}%")
        report.append(f"Total Memory: {memory['total_memory_gb']:.1f} GB")
        report.append(f"Available Memory: {memory['available_memory_gb']:.1f} GB")
        report.append(f"Swap Usage: {memory['swap_used_percent']:.1f}%")
        report.append("")
        
        # I/O Analysis
        io = analysis_results['io_analysis']
        report.append("I/O ANALYSIS:")
        report.append("-" * 20)
        report.append(f"Average I/O Wait: {io['average_io_wait']:.1f}%")
        report.append(f"Maximum I/O Wait: {io['max_io_wait']:.1f}%")
        report.append(f"High I/O Wait Periods: {io['high_io_wait_periods']}")
        
        for device, stats in io['disk_analysis'].items():
            report.append(f"Device {device}:")
            report.append(f"  Read Rate: {stats['read_rate_mb_s']:.2f} MB/s")
            report.append(f"  Write Rate: {stats['write_rate_mb_s']:.2f} MB/s")
        report.append("")
        
        # Bottlenecks
        bottlenecks = analysis_results['bottlenecks']
        if bottlenecks:
            report.append("IDENTIFIED BOTTLENECKS:")
            report.append("-" * 25)
            for bottleneck in bottlenecks:
                report.append(f"• {bottleneck}")
            report.append("")
        
        # Recommendations
        recommendations = analysis_results['recommendations']
        if recommendations:
            report.append("OPTIMIZATION RECOMMENDATIONS:")
            report.append("-" * 30)
            for i, rec in enumerate(recommendations, 1):
                report.append(f"{i}. {rec}")
        
        report.append("")
        report.append("=" * 60)
        
        return "\n".join(report)

def main():
    import argparse
    
    parser = argparse.ArgumentParser(description='Linux Performance Analysis Tool')
    parser.add_argument('--duration', type=int, default=300, 
                       help='Analysis duration in seconds (default: 300)')
    parser.add_argument('--output', help='Output file for results (JSON format)')
    parser.add_argument('--report', help='Output file for human-readable report')
    
    args = parser.parse_args()
    
    analyzer = PerformanceAnalyzer(args.duration)
    
    try:
        results = analyzer.analyze_performance()
        
        # Generate and display report
        report = analyzer.generate_report(results)
        print(report)
        
        # Save results if requested
        if args.output:
            analyzer.export_results(args.output, results)
        
        if args.report:
            with open(args.report, 'w') as f:
                f.write(report)
            print(f"Report saved to {args.report}")
            
    except KeyboardInterrupt:
        print("\nAnalysis interrupted by user")
    except Exception as e:
        print(f"Error during analysis: {e}")
        return 1
    
    return 0

if __name__ == '__main__':
    exit(main())
```

# [Performance Optimization Strategies](#performance-optimization-strategies)

## System Tuning Framework

### Comprehensive Optimization Script

```bash
#!/bin/bash
# Enterprise Linux Performance Optimization Framework

set -euo pipefail

# Configuration
BACKUP_DIR="/opt/performance/backups/$(date +%Y%m%d_%H%M%S)"
LOG_FILE="/var/log/performance_optimization.log"
REBOOT_REQUIRED=false

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Logging
log() { echo -e "${BLUE}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} $1" | tee -a "$LOG_FILE"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1" | tee -a "$LOG_FILE"; }
error() { echo -e "${RED}[ERROR]${NC} $1" | tee -a "$LOG_FILE"; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $1" | tee -a "$LOG_FILE"; }

# Backup configuration function
backup_config() {
    local file="$1"
    local backup_name="$(basename "$file")"
    
    mkdir -p "$BACKUP_DIR"
    
    if [[ -f "$file" ]]; then
        cp "$file" "$BACKUP_DIR/$backup_name"
        log "Backed up $file to $BACKUP_DIR/$backup_name"
    fi
}

# CPU optimization
optimize_cpu() {
    log "Starting CPU optimization..."
    
    # CPU governor optimization
    backup_config "/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor"
    
    for cpu in /sys/devices/system/cpu/cpu[0-9]*; do
        if [[ -f "$cpu/cpufreq/scaling_governor" ]]; then
            echo "performance" > "$cpu/cpufreq/scaling_governor" 2>/dev/null || {
                warn "Could not set performance governor for $(basename "$cpu")"
            }
        fi
    done
    
    # IRQ affinity optimization
    log "Optimizing IRQ affinity..."
    
    # Distribute IRQs across CPUs
    local cpu_count=$(nproc)
    local irq_count=0
    
    for irq in /proc/irq/[0-9]*; do
        if [[ -f "$irq/smp_affinity" ]]; then
            local irq_num=$(basename "$irq")
            local target_cpu=$((irq_count % cpu_count))
            local affinity_mask=$((1 << target_cpu))
            
            printf "%x" "$affinity_mask" > "$irq/smp_affinity" 2>/dev/null || true
            ((irq_count++))
        fi
    done
    
    # Process scheduler optimization
    backup_config "/proc/sys/kernel/sched_migration_cost_ns"
    echo "500000" > /proc/sys/kernel/sched_migration_cost_ns
    
    backup_config "/proc/sys/kernel/sched_autogroup_enabled"
    echo "0" > /proc/sys/kernel/sched_autogroup_enabled
    
    success "CPU optimization completed"
}

# Memory optimization
optimize_memory() {
    log "Starting memory optimization..."
    
    # Swap optimization
    backup_config "/proc/sys/vm/swappiness"
    echo "10" > /proc/sys/vm/swappiness
    
    backup_config "/proc/sys/vm/vfs_cache_pressure"
    echo "50" > /proc/sys/vm/vfs_cache_pressure
    
    # Memory overcommit optimization
    backup_config "/proc/sys/vm/overcommit_memory"
    echo "1" > /proc/sys/vm/overcommit_memory
    
    backup_config "/proc/sys/vm/overcommit_ratio"
    echo "80" > /proc/sys/vm/overcommit_ratio
    
    # Dirty page optimization
    backup_config "/proc/sys/vm/dirty_ratio"
    echo "15" > /proc/sys/vm/dirty_ratio
    
    backup_config "/proc/sys/vm/dirty_background_ratio"
    echo "5" > /proc/sys/vm/dirty_background_ratio
    
    backup_config "/proc/sys/vm/dirty_expire_centisecs"
    echo "1500" > /proc/sys/vm/dirty_expire_centisecs
    
    backup_config "/proc/sys/vm/dirty_writeback_centisecs"
    echo "500" > /proc/sys/vm/dirty_writeback_centisecs
    
    # Transparent Huge Pages optimization
    if [[ -f /sys/kernel/mm/transparent_hugepage/enabled ]]; then
        backup_config "/sys/kernel/mm/transparent_hugepage/enabled"
        echo "madvise" > /sys/kernel/mm/transparent_hugepage/enabled
        
        backup_config "/sys/kernel/mm/transparent_hugepage/defrag"
        echo "defer+madvise" > /sys/kernel/mm/transparent_hugepage/defrag
    fi
    
    success "Memory optimization completed"
}

# I/O optimization
optimize_io() {
    log "Starting I/O optimization..."
    
    # I/O scheduler optimization
    for device in /sys/block/sd* /sys/block/nvme*; do
        if [[ -d "$device" && -f "$device/queue/scheduler" ]]; then
            local device_name=$(basename "$device")
            backup_config "$device/queue/scheduler"
            
            # Use mq-deadline for SSDs, deadline for HDDs
            if [[ -f "/sys/block/$device_name/queue/rotational" ]]; then
                local rotational=$(cat "/sys/block/$device_name/queue/rotational")
                if [[ "$rotational" == "0" ]]; then
                    # SSD - use mq-deadline or none
                    echo "mq-deadline" > "$device/queue/scheduler" 2>/dev/null || \
                    echo "none" > "$device/queue/scheduler" 2>/dev/null || true
                else
                    # HDD - use deadline
                    echo "deadline" > "$device/queue/scheduler" 2>/dev/null || true
                fi
            fi
        fi
    done
    
    # I/O queue optimization
    for device in /sys/block/sd* /sys/block/nvme*; do
        if [[ -d "$device" ]]; then
            local device_name=$(basename "$device")
            
            # Queue depth optimization
            if [[ -f "$device/queue/nr_requests" ]]; then
                backup_config "$device/queue/nr_requests"
                echo "256" > "$device/queue/nr_requests"
            fi
            
            # Read-ahead optimization
            if [[ -f "$device/queue/read_ahead_kb" ]]; then
                backup_config "$device/queue/read_ahead_kb"
                echo "512" > "$device/queue/read_ahead_kb"
            fi
        fi
    done
    
    # Filesystem optimization
    backup_config "/proc/sys/fs/file-max"
    echo "2097152" > /proc/sys/fs/file-max
    
    backup_config "/proc/sys/fs/inotify/max_user_watches"
    echo "524288" > /proc/sys/fs/inotify/max_user_watches
    
    success "I/O optimization completed"
}

# Network optimization
optimize_network() {
    log "Starting network optimization..."
    
    # TCP optimization
    backup_config "/proc/sys/net/core/rmem_default"
    echo "262144" > /proc/sys/net/core/rmem_default
    
    backup_config "/proc/sys/net/core/rmem_max"
    echo "16777216" > /proc/sys/net/core/rmem_max
    
    backup_config "/proc/sys/net/core/wmem_default"
    echo "262144" > /proc/sys/net/core/wmem_default
    
    backup_config "/proc/sys/net/core/wmem_max"
    echo "16777216" > /proc/sys/net/core/wmem_max
    
    backup_config "/proc/sys/net/core/netdev_max_backlog"
    echo "30000" > /proc/sys/net/core/netdev_max_backlog
    
    # TCP window scaling
    backup_config "/proc/sys/net/ipv4/tcp_window_scaling"
    echo "1" > /proc/sys/net/ipv4/tcp_window_scaling
    
    # TCP congestion control
    backup_config "/proc/sys/net/ipv4/tcp_congestion_control"
    echo "bbr" > /proc/sys/net/ipv4/tcp_congestion_control 2>/dev/null || \
    echo "cubic" > /proc/sys/net/ipv4/tcp_congestion_control
    
    # TCP buffer optimization
    backup_config "/proc/sys/net/ipv4/tcp_rmem"
    echo "4096 65536 16777216" > /proc/sys/net/ipv4/tcp_rmem
    
    backup_config "/proc/sys/net/ipv4/tcp_wmem"
    echo "4096 65536 16777216" > /proc/sys/net/ipv4/tcp_wmem
    
    # TCP fast open
    backup_config "/proc/sys/net/ipv4/tcp_fastopen"
    echo "3" > /proc/sys/net/ipv4/tcp_fastopen
    
    success "Network optimization completed"
}

# Security-related optimizations
optimize_security() {
    log "Starting security-related optimizations..."
    
    # Kernel security
    backup_config "/proc/sys/kernel/dmesg_restrict"
    echo "1" > /proc/sys/kernel/dmesg_restrict
    
    backup_config "/proc/sys/kernel/kptr_restrict"
    echo "2" > /proc/sys/kernel/kptr_restrict
    
    backup_config "/proc/sys/kernel/yama/ptrace_scope"
    echo "1" > /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || true
    
    # Network security
    backup_config "/proc/sys/net/ipv4/conf/all/send_redirects"
    echo "0" > /proc/sys/net/ipv4/conf/all/send_redirects
    
    backup_config "/proc/sys/net/ipv4/conf/default/send_redirects"
    echo "0" > /proc/sys/net/ipv4/conf/default/send_redirects
    
    backup_config "/proc/sys/net/ipv4/conf/all/accept_redirects"
    echo "0" > /proc/sys/net/ipv4/conf/all/accept_redirects
    
    backup_config "/proc/sys/net/ipv4/conf/default/accept_redirects"
    echo "0" > /proc/sys/net/ipv4/conf/default/accept_redirects
    
    success "Security optimization completed"
}

# Generate persistence script
generate_persistence_script() {
    local persist_script="/etc/rc.local.performance"
    
    log "Generating persistence script: $persist_script"
    
    cat > "$persist_script" << 'EOF'
#!/bin/bash
# Performance optimization persistence script
# Generated automatically - do not edit manually

# CPU optimizations
for cpu in /sys/devices/system/cpu/cpu[0-9]*; do
    if [[ -f "$cpu/cpufreq/scaling_governor" ]]; then
        echo "performance" > "$cpu/cpufreq/scaling_governor" 2>/dev/null || true
    fi
done

# Memory optimizations
echo "10" > /proc/sys/vm/swappiness
echo "50" > /proc/sys/vm/vfs_cache_pressure
echo "1" > /proc/sys/vm/overcommit_memory
echo "80" > /proc/sys/vm/overcommit_ratio
echo "15" > /proc/sys/vm/dirty_ratio
echo "5" > /proc/sys/vm/dirty_background_ratio
echo "1500" > /proc/sys/vm/dirty_expire_centisecs
echo "500" > /proc/sys/vm/dirty_writeback_centisecs

# I/O optimizations
echo "2097152" > /proc/sys/fs/file-max
echo "524288" > /proc/sys/fs/inotify/max_user_watches

# Network optimizations
echo "262144" > /proc/sys/net/core/rmem_default
echo "16777216" > /proc/sys/net/core/rmem_max
echo "262144" > /proc/sys/net/core/wmem_default
echo "16777216" > /proc/sys/net/core/wmem_max
echo "30000" > /proc/sys/net/core/netdev_max_backlog
echo "1" > /proc/sys/net/ipv4/tcp_window_scaling
echo "4096 65536 16777216" > /proc/sys/net/ipv4/tcp_rmem
echo "4096 65536 16777216" > /proc/sys/net/ipv4/tcp_wmem
echo "3" > /proc/sys/net/ipv4/tcp_fastopen

# Security optimizations
echo "1" > /proc/sys/kernel/dmesg_restrict
echo "2" > /proc/sys/kernel/kptr_restrict
echo "0" > /proc/sys/net/ipv4/conf/all/send_redirects
echo "0" > /proc/sys/net/ipv4/conf/default/send_redirects
echo "0" > /proc/sys/net/ipv4/conf/all/accept_redirects
echo "0" > /proc/sys/net/ipv4/conf/default/accept_redirects
EOF

    chmod +x "$persist_script"
    
    # Add to system startup
    if [[ -f /etc/rc.local ]]; then
        if ! grep -q "$persist_script" /etc/rc.local; then
            sed -i '/^exit 0/i '"$persist_script"'' /etc/rc.local
        fi
    else
        # Create rc.local if it doesn't exist
        cat > /etc/rc.local << EOF
#!/bin/bash
$persist_script
exit 0
EOF
        chmod +x /etc/rc.local
    fi
    
    success "Persistence script created and configured"
}

# Performance validation
validate_optimizations() {
    log "Validating performance optimizations..."
    
    local validation_results="$BACKUP_DIR/validation_results.txt"
    
    {
        echo "Performance Optimization Validation Results"
        echo "==========================================="
        echo "Timestamp: $(date)"
        echo ""
        
        echo "CPU Configuration:"
        echo "- Governor: $(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null || echo 'N/A')"
        echo "- Scheduler migration cost: $(cat /proc/sys/kernel/sched_migration_cost_ns)"
        echo ""
        
        echo "Memory Configuration:"
        echo "- Swappiness: $(cat /proc/sys/vm/swappiness)"
        echo "- VFS cache pressure: $(cat /proc/sys/vm/vfs_cache_pressure)"
        echo "- Dirty ratio: $(cat /proc/sys/vm/dirty_ratio)"
        echo "- Dirty background ratio: $(cat /proc/sys/vm/dirty_background_ratio)"
        echo ""
        
        echo "I/O Configuration:"
        echo "- File max: $(cat /proc/sys/fs/file-max)"
        echo "- Inotify watches: $(cat /proc/sys/fs/inotify/max_user_watches)"
        echo ""
        
        echo "Network Configuration:"
        echo "- TCP rmem max: $(cat /proc/sys/net/core/rmem_max)"
        echo "- TCP wmem max: $(cat /proc/sys/net/core/wmem_max)"
        echo "- TCP congestion control: $(cat /proc/sys/net/ipv4/tcp_congestion_control)"
        echo ""
        
        echo "Storage Devices:"
        for device in /sys/block/sd* /sys/block/nvme*; do
            if [[ -d "$device" ]]; then
                local device_name=$(basename "$device")
                echo "- $device_name:"
                echo "  Scheduler: $(cat "$device/queue/scheduler" 2>/dev/null | grep -o '\[.*\]' | tr -d '[]' || echo 'N/A')"
                echo "  Queue depth: $(cat "$device/queue/nr_requests" 2>/dev/null || echo 'N/A')"
                echo "  Read-ahead: $(cat "$device/queue/read_ahead_kb" 2>/dev/null || echo 'N/A') KB"
            fi
        done
        
    } > "$validation_results"
    
    cat "$validation_results"
    success "Validation results saved to $validation_results"
}

# Main optimization function
main() {
    local action="${1:-all}"
    
    case "$action" in
        "cpu")
            optimize_cpu
            ;;
        "memory")
            optimize_memory
            ;;
        "io")
            optimize_io
            ;;
        "network")
            optimize_network
            ;;
        "security")
            optimize_security
            ;;
        "validate")
            validate_optimizations
            ;;
        "all")
            log "Starting comprehensive performance optimization..."
            optimize_cpu
            optimize_memory
            optimize_io
            optimize_network
            optimize_security
            generate_persistence_script
            validate_optimizations
            
            if [[ "$REBOOT_REQUIRED" == "true" ]]; then
                warn "Reboot required for some optimizations to take full effect"
            fi
            
            success "Performance optimization completed successfully!"
            ;;
        *)
            echo "Usage: $0 {cpu|memory|io|network|security|validate|all}"
            echo ""
            echo "Options:"
            echo "  cpu      - Optimize CPU settings"
            echo "  memory   - Optimize memory settings"
            echo "  io       - Optimize I/O settings"
            echo "  network  - Optimize network settings"
            echo "  security - Apply security-related optimizations"
            echo "  validate - Validate current optimization settings"
            echo "  all      - Apply all optimizations (default)"
            exit 1
            ;;
    esac
}

# Ensure script is run as root
if [[ $EUID -ne 0 ]]; then
    error "This script must be run as root"
    exit 1
fi

# Create log directory
mkdir -p "$(dirname "$LOG_FILE")"

# Execute main function
main "$@"
```

This comprehensive Linux performance monitoring and optimization guide provides enterprise-grade tools for system analysis, bottleneck identification, and strategic performance tuning. The included frameworks support automated monitoring, advanced analysis, and systematic optimization approaches essential for maintaining high-performance Linux environments in production data centers.