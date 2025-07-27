---
title: "Advanced Unix Signals and Process Management: Complete Guide to Linux Process Control and Automation"
date: 2025-04-01T10:00:00-05:00
draft: false
tags: ["Unix Signals", "Process Management", "Linux", "System Administration", "Process Control", "Signal Handling", "Automation", "Enterprise", "Kill", "Jobs"]
categories:
- Process Management
- Linux Administration
- System Programming
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Unix signals, advanced process management techniques, signal handling strategies, enterprise automation frameworks, and production-grade process control for Linux systems"
more_link: "yes"
url: "/unix-signals-advanced-process-management-guide/"
---

Unix signals represent the fundamental inter-process communication mechanism in Linux and Unix systems, providing precise process control, graceful shutdown procedures, and advanced automation capabilities. This comprehensive guide covers signal fundamentals, advanced handling techniques, enterprise automation frameworks, and production-grade process management strategies for critical systems.

<!--more-->

# [Unix Signals Fundamentals](#unix-signals-fundamentals)

## Signal Architecture and Communication Model

Unix signals provide asynchronous event notification between processes, the kernel, and user space applications, enabling sophisticated process lifecycle management and system coordination.

### Signal Classification Matrix

| Signal Type | Purpose | Catchable | Blockable | Default Action | Enterprise Use |
|-------------|---------|-----------|-----------|----------------|----------------|
| **Termination** | Process shutdown | Yes | Yes | Terminate | Graceful shutdowns |
| **Hardware** | Hardware exceptions | Yes | No | Core dump | System diagnostics |
| **Alarm** | Timer events | Yes | Yes | Terminate | Scheduled operations |
| **Job Control** | Shell management | Yes | Yes | Stop/Continue | Process orchestration |
| **User Defined** | Custom signaling | Yes | Yes | Terminate | Application coordination |

### Standard Signal Reference

```bash
# Critical system signals overview
SIGHUP  (1)   - Hangup detected, configuration reload
SIGINT  (2)   - Interrupt from keyboard (Ctrl+C)
SIGQUIT (3)   - Quit from keyboard (Ctrl+\)
SIGKILL (9)   - Kill signal (uncatchable)
SIGTERM (15)  - Termination request (default kill)
SIGSTOP (19)  - Stop process (uncatchable)
SIGCONT (18)  - Continue stopped process
SIGUSR1 (10)  - User-defined signal 1
SIGUSR2 (12)  - User-defined signal 2
SIGCHLD (17)  - Child process terminated
```

## Signal Handling Strategies

### Comprehensive Signal Management Framework

```bash
#!/bin/bash
# Advanced Signal Handling and Process Management Framework

set -euo pipefail

# Global configuration
SCRIPT_NAME="$(basename "$0")"
PID_FILE="/var/run/${SCRIPT_NAME}.pid"
LOG_FILE="/var/log/${SCRIPT_NAME}.log"
CONFIG_FILE="/etc/${SCRIPT_NAME}.conf"

# Color output for logging
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Logging framework
log_message() {
    local level="$1"
    local message="$2"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo -e "${timestamp} [${level}] ${message}" | tee -a "$LOG_FILE"
}

log_info() { log_message "${BLUE}INFO${NC}" "$1"; }
log_warn() { log_message "${YELLOW}WARN${NC}" "$1"; }
log_error() { log_message "${RED}ERROR${NC}" "$1"; }
log_success() { log_message "${GREEN}SUCCESS${NC}" "$1"; }

# Signal handler functions
cleanup_and_exit() {
    log_info "Received termination signal, performing cleanup..."
    
    # Stop child processes gracefully
    if [[ -n "${CHILD_PIDS:-}" ]]; then
        for pid in $CHILD_PIDS; do
            if kill -0 "$pid" 2>/dev/null; then
                log_info "Terminating child process $pid"
                kill -TERM "$pid"
                
                # Wait for graceful shutdown with timeout
                for i in {1..10}; do
                    if ! kill -0 "$pid" 2>/dev/null; then
                        break
                    fi
                    sleep 1
                done
                
                # Force kill if still running
                if kill -0 "$pid" 2>/dev/null; then
                    log_warn "Force killing unresponsive process $pid"
                    kill -KILL "$pid"
                fi
            fi
        done
    fi
    
    # Cleanup resources
    [[ -f "$PID_FILE" ]] && rm -f "$PID_FILE"
    
    log_success "Cleanup completed successfully"
    exit 0
}

reload_configuration() {
    log_info "Received SIGHUP, reloading configuration..."
    
    if [[ -f "$CONFIG_FILE" ]]; then
        # Validate configuration before reloading
        if validate_config "$CONFIG_FILE"; then
            source "$CONFIG_FILE"
            log_success "Configuration reloaded successfully"
        else
            log_error "Configuration validation failed, keeping current settings"
        fi
    else
        log_warn "Configuration file not found: $CONFIG_FILE"
    fi
}

handle_user_signal() {
    local signal="$1"
    log_info "Received user signal: $signal"
    
    case "$signal" in
        "USR1")
            # Custom action 1 - Status report
            generate_status_report
            ;;
        "USR2")
            # Custom action 2 - Debug toggle
            toggle_debug_mode
            ;;
        *)
            log_warn "Unknown user signal: $signal"
            ;;
    esac
}

# Register signal handlers
trap 'cleanup_and_exit' SIGTERM SIGINT
trap 'reload_configuration' SIGHUP
trap 'handle_user_signal USR1' SIGUSR1
trap 'handle_user_signal USR2' SIGUSR2

# Configuration validation
validate_config() {
    local config_file="$1"
    
    # Implement configuration validation logic
    if [[ ! -r "$config_file" ]]; then
        log_error "Configuration file not readable: $config_file"
        return 1
    fi
    
    # Add specific validation rules
    log_info "Configuration validation passed"
    return 0
}

# Status reporting
generate_status_report() {
    log_info "Generating status report..."
    
    local report_file="/tmp/${SCRIPT_NAME}_status_$(date +%Y%m%d_%H%M%S).log"
    
    {
        echo "=== Process Status Report ==="
        echo "Timestamp: $(date)"
        echo "PID: $$"
        echo "PPID: $PPID"
        echo "User: $(whoami)"
        echo "Memory Usage: $(ps -o rss= -p $$) KB"
        echo "CPU Time: $(ps -o cputime= -p $$)"
        echo "Open Files: $(lsof -p $$ 2>/dev/null | wc -l)"
        echo "Children: ${CHILD_PIDS:-none}"
        echo "=== End Report ==="
    } > "$report_file"
    
    log_success "Status report generated: $report_file"
}

# Debug mode toggle
toggle_debug_mode() {
    if [[ "${DEBUG:-false}" == "true" ]]; then
        DEBUG="false"
        log_info "Debug mode disabled"
    else
        DEBUG="true"
        log_info "Debug mode enabled"
    fi
}
```

# [Process Discovery and Analysis](#process-discovery-analysis)

## Enterprise Process Management Tools

### Advanced Process Discovery Framework

```python
#!/usr/bin/env python3
"""
Enterprise Process Management and Signal Control Framework
"""

import os
import signal
import subprocess
import time
import json
import psutil
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass
from pathlib import Path
import logging

@dataclass
class ProcessInfo:
    pid: int
    ppid: int
    name: str
    cmdline: List[str]
    status: str
    cpu_percent: float
    memory_percent: float
    memory_rss: int
    create_time: float
    username: str
    connections: List[Dict]
    open_files: List[str]
    threads: int

class ProcessManager:
    def __init__(self, log_level: str = "INFO"):
        self.logger = self._setup_logging(log_level)
        self.signal_names = {
            1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 9: 'SIGKILL',
            15: 'SIGTERM', 18: 'SIGCONT', 19: 'SIGSTOP', 10: 'SIGUSR1',
            12: 'SIGUSR2', 14: 'SIGALRM', 17: 'SIGCHLD'
        }
    
    def _setup_logging(self, level: str) -> logging.Logger:
        """Configure comprehensive logging system"""
        logger = logging.getLogger(__name__)
        logger.setLevel(getattr(logging, level.upper()))
        
        # File handler
        file_handler = logging.FileHandler('/var/log/process_manager.log')
        file_formatter = logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
        )
        file_handler.setFormatter(file_formatter)
        
        # Console handler
        console_handler = logging.StreamHandler()
        console_formatter = logging.Formatter(
            '%(levelname)s: %(message)s'
        )
        console_handler.setFormatter(console_formatter)
        
        logger.addHandler(file_handler)
        logger.addHandler(console_handler)
        
        return logger
    
    def discover_processes(self, pattern: Optional[str] = None) -> List[ProcessInfo]:
        """Comprehensive process discovery with filtering"""
        processes = []
        
        for proc in psutil.process_iter(['pid', 'ppid', 'name', 'cmdline', 'status']):
            try:
                # Filter by pattern if provided
                if pattern:
                    proc_info = proc.info
                    if pattern not in proc_info['name'] and \
                       pattern not in ' '.join(proc_info['cmdline'] or []):
                        continue
                
                # Get detailed process information
                process_info = self._get_process_details(proc)
                if process_info:
                    processes.append(process_info)
                    
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                continue
        
        return processes
    
    def _get_process_details(self, proc: psutil.Process) -> Optional[ProcessInfo]:
        """Extract comprehensive process information"""
        try:
            # Get network connections
            connections = []
            try:
                for conn in proc.connections():
                    connections.append({
                        'fd': conn.fd,
                        'family': conn.family.name,
                        'type': conn.type.name,
                        'laddr': f"{conn.laddr.ip}:{conn.laddr.port}" if conn.laddr else None,
                        'raddr': f"{conn.raddr.ip}:{conn.raddr.port}" if conn.raddr else None,
                        'status': conn.status
                    })
            except (psutil.AccessDenied, OSError):
                pass
            
            # Get open files
            open_files = []
            try:
                for file_obj in proc.open_files():
                    open_files.append(file_obj.path)
            except (psutil.AccessDenied, OSError):
                pass
            
            return ProcessInfo(
                pid=proc.pid,
                ppid=proc.ppid(),
                name=proc.name(),
                cmdline=proc.cmdline(),
                status=proc.status(),
                cpu_percent=proc.cpu_percent(),
                memory_percent=proc.memory_percent(),
                memory_rss=proc.memory_info().rss,
                create_time=proc.create_time(),
                username=proc.username(),
                connections=connections,
                open_files=open_files,
                threads=proc.num_threads()
            )
            
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            return None
    
    def send_signal_safe(self, pid: int, sig: int, timeout: int = 10) -> bool:
        """Send signal with safety checks and timeout"""
        try:
            # Verify process exists
            proc = psutil.Process(pid)
            self.logger.info(f"Sending {self.signal_names.get(sig, sig)} to PID {pid} ({proc.name()})")
            
            # Send signal
            proc.send_signal(sig)
            
            # Wait for signal to take effect (for termination signals)
            if sig in [signal.SIGTERM, signal.SIGKILL, signal.SIGQUIT]:
                start_time = time.time()
                while proc.is_running() and (time.time() - start_time) < timeout:
                    time.sleep(0.1)
                
                if proc.is_running():
                    self.logger.warning(f"Process {pid} did not respond to signal within {timeout}s")
                    return False
                else:
                    self.logger.info(f"Process {pid} terminated successfully")
                    return True
            
            return True
            
        except psutil.NoSuchProcess:
            self.logger.error(f"Process {pid} not found")
            return False
        except psutil.AccessDenied:
            self.logger.error(f"Access denied sending signal to PID {pid}")
            return False
        except Exception as e:
            self.logger.error(f"Error sending signal to PID {pid}: {e}")
            return False
    
    def graceful_terminate(self, pid: int, escalation_timeout: int = 30) -> bool:
        """Implement graceful termination with escalation"""
        try:
            proc = psutil.Process(pid)
            self.logger.info(f"Starting graceful termination of PID {pid} ({proc.name()})")
            
            # Step 1: Send SIGTERM
            if not self.send_signal_safe(pid, signal.SIGTERM, escalation_timeout // 3):
                # Step 2: Send SIGQUIT if SIGTERM failed
                self.logger.warning(f"SIGTERM failed, escalating to SIGQUIT for PID {pid}")
                if not self.send_signal_safe(pid, signal.SIGQUIT, escalation_timeout // 3):
                    # Step 3: Send SIGKILL as last resort
                    self.logger.warning(f"SIGQUIT failed, escalating to SIGKILL for PID {pid}")
                    return self.send_signal_safe(pid, signal.SIGKILL, escalation_timeout // 3)
            
            return True
            
        except psutil.NoSuchProcess:
            self.logger.info(f"Process {pid} already terminated")
            return True
        except Exception as e:
            self.logger.error(f"Error during graceful termination of PID {pid}: {e}")
            return False
    
    def monitor_process_tree(self, root_pid: int, interval: int = 5) -> None:
        """Monitor process tree with real-time updates"""
        try:
            root_proc = psutil.Process(root_pid)
            self.logger.info(f"Monitoring process tree for PID {root_pid} ({root_proc.name()})")
            
            while True:
                try:
                    # Get all children (recursive)
                    children = root_proc.children(recursive=True)
                    
                    print(f"\n=== Process Tree Monitor (Root: {root_pid}) ===")
                    print(f"Root: {root_proc.name()} (PID: {root_pid})")
                    print(f"Children: {len(children)}")
                    
                    for child in children:
                        try:
                            print(f"  ├─ {child.name()} (PID: {child.pid}, Status: {child.status()})")
                        except (psutil.NoSuchProcess, psutil.AccessDenied):
                            continue
                    
                    time.sleep(interval)
                    
                except psutil.NoSuchProcess:
                    self.logger.info(f"Root process {root_pid} terminated, stopping monitor")
                    break
                except KeyboardInterrupt:
                    self.logger.info("Process monitoring stopped by user")
                    break
                    
        except psutil.NoSuchProcess:
            self.logger.error(f"Process {root_pid} not found")
        except Exception as e:
            self.logger.error(f"Error monitoring process tree: {e}")
    
    def export_process_report(self, output_file: str, pattern: Optional[str] = None) -> None:
        """Generate comprehensive process report"""
        processes = self.discover_processes(pattern)
        
        report = {
            'timestamp': time.time(),
            'hostname': os.uname().nodename,
            'total_processes': len(processes),
            'filter_pattern': pattern,
            'processes': []
        }
        
        for proc in processes:
            report['processes'].append({
                'pid': proc.pid,
                'ppid': proc.ppid,
                'name': proc.name,
                'cmdline': proc.cmdline,
                'status': proc.status,
                'cpu_percent': proc.cpu_percent,
                'memory_percent': proc.memory_percent,
                'memory_rss_mb': proc.memory_rss // (1024 * 1024),
                'username': proc.username,
                'connections_count': len(proc.connections),
                'open_files_count': len(proc.open_files),
                'threads': proc.threads
            })
        
        with open(output_file, 'w') as f:
            json.dump(report, f, indent=2)
        
        self.logger.info(f"Process report exported to {output_file}")

# Example usage and CLI interface
def main():
    import argparse
    
    parser = argparse.ArgumentParser(description='Enterprise Process Management Tool')
    parser.add_argument('--action', choices=['list', 'kill', 'monitor', 'report'], 
                       required=True, help='Action to perform')
    parser.add_argument('--pid', type=int, help='Process ID for kill/monitor actions')
    parser.add_argument('--signal', type=int, default=15, help='Signal number (default: 15/SIGTERM)')
    parser.add_argument('--pattern', help='Filter processes by name/command pattern')
    parser.add_argument('--output', help='Output file for reports')
    parser.add_argument('--interval', type=int, default=5, help='Monitor interval in seconds')
    parser.add_argument('--log-level', choices=['DEBUG', 'INFO', 'WARNING', 'ERROR'], 
                       default='INFO', help='Logging level')
    
    args = parser.parse_args()
    
    pm = ProcessManager(args.log_level)
    
    if args.action == 'list':
        processes = pm.discover_processes(args.pattern)
        print(f"{'PID':<8} {'PPID':<8} {'Status':<12} {'CPU%':<8} {'Memory%':<8} {'Name'}")
        print("-" * 80)
        for proc in processes:
            print(f"{proc.pid:<8} {proc.ppid:<8} {proc.status:<12} "
                  f"{proc.cpu_percent:<8.1f} {proc.memory_percent:<8.1f} {proc.name}")
    
    elif args.action == 'kill':
        if not args.pid:
            print("ERROR: --pid required for kill action")
            return 1
        
        success = pm.graceful_terminate(args.pid)
        return 0 if success else 1
    
    elif args.action == 'monitor':
        if not args.pid:
            print("ERROR: --pid required for monitor action")
            return 1
        
        pm.monitor_process_tree(args.pid, args.interval)
    
    elif args.action == 'report':
        output_file = args.output or f"process_report_{int(time.time())}.json"
        pm.export_process_report(output_file, args.pattern)

if __name__ == '__main__':
    exit(main())
```

# [Advanced Signal Handling Patterns](#advanced-signal-handling-patterns)

## Production Signal Management

### Enterprise Service Control Framework

```bash
#!/bin/bash
# Production Service Control and Signal Management System

# Service configuration
SERVICE_NAME="${1:-myservice}"
SERVICE_USER="${SERVICE_USER:-service}"
SERVICE_GROUP="${SERVICE_GROUP:-service}"
SERVICE_HOME="/opt/${SERVICE_NAME}"
PID_FILE="/var/run/${SERVICE_NAME}.pid"
LOG_DIR="/var/log/${SERVICE_NAME}"
CONFIG_DIR="/etc/${SERVICE_NAME}"

# Signal handling configuration
GRACEFUL_TIMEOUT=30
FORCE_TIMEOUT=10
RELOAD_TIMEOUT=15

# Service management functions
service_start() {
    if service_is_running; then
        echo "Service ${SERVICE_NAME} is already running (PID: $(cat "$PID_FILE"))"
        return 1
    fi
    
    echo "Starting ${SERVICE_NAME}..."
    
    # Create necessary directories
    mkdir -p "$LOG_DIR" "$CONFIG_DIR"
    chown "$SERVICE_USER:$SERVICE_GROUP" "$LOG_DIR"
    
    # Start service as dedicated user
    sudo -u "$SERVICE_USER" nohup \
        "${SERVICE_HOME}/bin/${SERVICE_NAME}" \
        --config="${CONFIG_DIR}/${SERVICE_NAME}.conf" \
        --log-dir="$LOG_DIR" \
        --pid-file="$PID_FILE" \
        > "${LOG_DIR}/startup.log" 2>&1 &
    
    # Wait for PID file creation
    local timeout=10
    while [[ $timeout -gt 0 && ! -f "$PID_FILE" ]]; do
        sleep 1
        ((timeout--))
    done
    
    if service_is_running; then
        echo "Service ${SERVICE_NAME} started successfully (PID: $(cat "$PID_FILE"))"
        return 0
    else
        echo "Failed to start service ${SERVICE_NAME}"
        return 1
    fi
}

service_stop() {
    if ! service_is_running; then
        echo "Service ${SERVICE_NAME} is not running"
        return 0
    fi
    
    local pid=$(cat "$PID_FILE")
    echo "Stopping ${SERVICE_NAME} (PID: $pid)..."
    
    # Send SIGTERM for graceful shutdown
    kill -TERM "$pid" 2>/dev/null || {
        echo "Process $pid not found, cleaning up PID file"
        rm -f "$PID_FILE"
        return 0
    }
    
    # Wait for graceful shutdown
    local timeout=$GRACEFUL_TIMEOUT
    while [[ $timeout -gt 0 ]] && kill -0 "$pid" 2>/dev/null; do
        echo "Waiting for graceful shutdown... ($timeout seconds remaining)"
        sleep 1
        ((timeout--))
    done
    
    # Force kill if still running
    if kill -0 "$pid" 2>/dev/null; then
        echo "Graceful shutdown timeout, forcing termination..."
        kill -KILL "$pid" 2>/dev/null
        
        # Wait for force kill to complete
        timeout=$FORCE_TIMEOUT
        while [[ $timeout -gt 0 ]] && kill -0 "$pid" 2>/dev/null; do
            sleep 1
            ((timeout--))
        done
        
        if kill -0 "$pid" 2>/dev/null; then
            echo "ERROR: Unable to terminate process $pid"
            return 1
        fi
    fi
    
    # Cleanup
    rm -f "$PID_FILE"
    echo "Service ${SERVICE_NAME} stopped successfully"
    return 0
}

service_reload() {
    if ! service_is_running; then
        echo "Service ${SERVICE_NAME} is not running"
        return 1
    fi
    
    local pid=$(cat "$PID_FILE")
    echo "Reloading ${SERVICE_NAME} configuration (PID: $pid)..."
    
    # Send SIGHUP for configuration reload
    kill -HUP "$pid" 2>/dev/null || {
        echo "Process $pid not found"
        return 1
    }
    
    echo "Configuration reload signal sent successfully"
    return 0
}

service_status() {
    if service_is_running; then
        local pid=$(cat "$PID_FILE")
        echo "Service ${SERVICE_NAME} is running (PID: $pid)"
        
        # Additional status information
        if command -v ps >/dev/null; then
            ps -p "$pid" -o pid,ppid,user,time,command 2>/dev/null || true
        fi
        
        return 0
    else
        echo "Service ${SERVICE_NAME} is not running"
        return 1
    fi
}

service_is_running() {
    [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

# Signal testing and validation
test_signal_handling() {
    if ! service_is_running; then
        echo "Service must be running to test signal handling"
        return 1
    fi
    
    local pid=$(cat "$PID_FILE")
    echo "Testing signal handling for PID $pid..."
    
    # Test SIGUSR1 (custom signal 1)
    echo "Testing SIGUSR1 (status report)..."
    kill -USR1 "$pid"
    sleep 2
    
    # Test SIGUSR2 (custom signal 2)
    echo "Testing SIGUSR2 (debug toggle)..."
    kill -USR2 "$pid"
    sleep 2
    
    # Test SIGHUP (configuration reload)
    echo "Testing SIGHUP (configuration reload)..."
    kill -HUP "$pid"
    sleep 2
    
    echo "Signal testing completed. Check service logs for responses."
}

# Main service control logic
case "${2:-status}" in
    start)
        service_start
        ;;
    stop)
        service_stop
        ;;
    restart)
        service_stop && sleep 2 && service_start
        ;;
    reload)
        service_reload
        ;;
    status)
        service_status
        ;;
    test-signals)
        test_signal_handling
        ;;
    *)
        echo "Usage: $0 <service_name> {start|stop|restart|reload|status|test-signals}"
        exit 1
        ;;
esac
```

# [Automated Process Orchestration](#automated-process-orchestration)

## Enterprise Automation Framework

### Process Lifecycle Management System

```python
#!/usr/bin/env python3
"""
Enterprise Process Lifecycle Management and Orchestration System
"""

import asyncio
import signal
import subprocess
import json
import time
import logging
from typing import Dict, List, Optional, Callable, Any
from dataclasses import dataclass, field
from pathlib import Path
from enum import Enum
import yaml

class ProcessState(Enum):
    STOPPED = "stopped"
    STARTING = "starting"
    RUNNING = "running"
    STOPPING = "stopping"
    FAILED = "failed"
    RESTARTING = "restarting"

@dataclass
class ProcessConfig:
    name: str
    command: List[str]
    working_dir: str = "/"
    environment: Dict[str, str] = field(default_factory=dict)
    user: Optional[str] = None
    group: Optional[str] = None
    restart_policy: str = "on-failure"  # always, on-failure, never
    max_restarts: int = 5
    restart_delay: int = 5
    health_check: Optional[Dict[str, Any]] = None
    dependencies: List[str] = field(default_factory=list)
    signals: Dict[str, str] = field(default_factory=dict)

class ProcessOrchestrator:
    def __init__(self, config_file: str):
        self.config_file = Path(config_file)
        self.processes: Dict[str, ProcessConfig] = {}
        self.process_states: Dict[str, ProcessState] = {}
        self.process_handles: Dict[str, subprocess.Popen] = {}
        self.restart_counts: Dict[str, int] = {}
        
        self.logger = self._setup_logging()
        self._load_configuration()
        self._setup_signal_handlers()
    
    def _setup_logging(self) -> logging.Logger:
        """Configure comprehensive logging"""
        logger = logging.getLogger(__name__)
        logger.setLevel(logging.INFO)
        
        formatter = logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
        )
        
        # File handler
        file_handler = logging.FileHandler('/var/log/process_orchestrator.log')
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)
        
        # Console handler
        console_handler = logging.StreamHandler()
        console_handler.setFormatter(formatter)
        logger.addHandler(console_handler)
        
        return logger
    
    def _load_configuration(self) -> None:
        """Load process configuration from YAML file"""
        try:
            with open(self.config_file, 'r') as f:
                config_data = yaml.safe_load(f)
            
            for proc_name, proc_config in config_data.get('processes', {}).items():
                self.processes[proc_name] = ProcessConfig(
                    name=proc_name,
                    **proc_config
                )
                self.process_states[proc_name] = ProcessState.STOPPED
                self.restart_counts[proc_name] = 0
            
            self.logger.info(f"Loaded configuration for {len(self.processes)} processes")
            
        except Exception as e:
            self.logger.error(f"Failed to load configuration: {e}")
            raise
    
    def _setup_signal_handlers(self) -> None:
        """Setup signal handlers for orchestrator control"""
        signal.signal(signal.SIGTERM, self._handle_shutdown)
        signal.signal(signal.SIGINT, self._handle_shutdown)
        signal.signal(signal.SIGHUP, self._handle_reload)
        signal.signal(signal.SIGUSR1, self._handle_status_report)
    
    def _handle_shutdown(self, signum: int, frame) -> None:
        """Handle orchestrator shutdown signals"""
        self.logger.info(f"Received signal {signum}, initiating graceful shutdown...")
        asyncio.create_task(self.shutdown_all())
    
    def _handle_reload(self, signum: int, frame) -> None:
        """Handle configuration reload signal"""
        self.logger.info("Received SIGHUP, reloading configuration...")
        self._load_configuration()
    
    def _handle_status_report(self, signum: int, frame) -> None:
        """Handle status report signal"""
        self.logger.info("Generating status report...")
        self.generate_status_report()
    
    async def start_process(self, name: str) -> bool:
        """Start a specific process with dependency resolution"""
        if name not in self.processes:
            self.logger.error(f"Process {name} not found in configuration")
            return False
        
        config = self.processes[name]
        
        # Check dependencies
        for dep in config.dependencies:
            if dep not in self.process_states or self.process_states[dep] != ProcessState.RUNNING:
                self.logger.info(f"Starting dependency {dep} for process {name}")
                if not await self.start_process(dep):
                    self.logger.error(f"Failed to start dependency {dep}")
                    return False
        
        if self.process_states[name] == ProcessState.RUNNING:
            self.logger.info(f"Process {name} is already running")
            return True
        
        self.logger.info(f"Starting process: {name}")
        self.process_states[name] = ProcessState.STARTING
        
        try:
            # Prepare environment
            env = {**os.environ, **config.environment}
            
            # Start process
            proc = subprocess.Popen(
                config.command,
                cwd=config.working_dir,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                preexec_fn=self._get_preexec_fn(config.user, config.group)
            )
            
            self.process_handles[name] = proc
            self.process_states[name] = ProcessState.RUNNING
            
            # Start monitoring task
            asyncio.create_task(self._monitor_process(name))
            
            self.logger.info(f"Process {name} started successfully (PID: {proc.pid})")
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to start process {name}: {e}")
            self.process_states[name] = ProcessState.FAILED
            return False
    
    async def stop_process(self, name: str, timeout: int = 30) -> bool:
        """Stop a specific process gracefully"""
        if name not in self.process_handles:
            self.logger.info(f"Process {name} is not running")
            return True
        
        self.logger.info(f"Stopping process: {name}")
        self.process_states[name] = ProcessState.STOPPING
        
        proc = self.process_handles[name]
        
        try:
            # Send SIGTERM
            proc.terminate()
            
            # Wait for graceful shutdown
            try:
                await asyncio.wait_for(
                    asyncio.create_task(self._wait_for_process(proc)),
                    timeout=timeout
                )
            except asyncio.TimeoutError:
                self.logger.warning(f"Process {name} did not stop gracefully, sending SIGKILL")
                proc.kill()
                await self._wait_for_process(proc)
            
            del self.process_handles[name]
            self.process_states[name] = ProcessState.STOPPED
            
            self.logger.info(f"Process {name} stopped successfully")
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to stop process {name}: {e}")
            return False
    
    async def restart_process(self, name: str) -> bool:
        """Restart a specific process"""
        self.logger.info(f"Restarting process: {name}")
        
        if name in self.process_handles:
            await self.stop_process(name)
        
        # Wait for restart delay
        config = self.processes[name]
        await asyncio.sleep(config.restart_delay)
        
        return await self.start_process(name)
    
    async def _monitor_process(self, name: str) -> None:
        """Monitor process health and handle restarts"""
        config = self.processes[name]
        
        while name in self.process_handles:
            proc = self.process_handles[name]
            
            # Check if process is still running
            if proc.poll() is not None:
                self.logger.warning(f"Process {name} exited with code {proc.returncode}")
                
                # Handle restart policy
                if config.restart_policy == "always" or \
                   (config.restart_policy == "on-failure" and proc.returncode != 0):
                    
                    if self.restart_counts[name] < config.max_restarts:
                        self.restart_counts[name] += 1
                        self.logger.info(f"Restarting {name} (attempt {self.restart_counts[name]})")
                        
                        del self.process_handles[name]
                        self.process_states[name] = ProcessState.RESTARTING
                        
                        await asyncio.sleep(config.restart_delay)
                        await self.start_process(name)
                        break
                    else:
                        self.logger.error(f"Max restarts exceeded for process {name}")
                        self.process_states[name] = ProcessState.FAILED
                        del self.process_handles[name]
                        break
                else:
                    self.process_states[name] = ProcessState.STOPPED
                    del self.process_handles[name]
                    break
            
            # Perform health check if configured
            if config.health_check:
                if not await self._perform_health_check(name, config.health_check):
                    self.logger.warning(f"Health check failed for process {name}")
                    # Optionally restart on health check failure
            
            await asyncio.sleep(5)  # Monitor interval
    
    async def _perform_health_check(self, name: str, health_config: Dict) -> bool:
        """Perform health check on process"""
        check_type = health_config.get('type', 'tcp')
        
        if check_type == 'tcp':
            # TCP port check
            host = health_config.get('host', 'localhost')
            port = health_config.get('port')
            timeout = health_config.get('timeout', 5)
            
            try:
                reader, writer = await asyncio.wait_for(
                    asyncio.open_connection(host, port),
                    timeout=timeout
                )
                writer.close()
                await writer.wait_closed()
                return True
            except:
                return False
        
        elif check_type == 'http':
            # HTTP health check (implementation omitted for brevity)
            pass
        
        elif check_type == 'command':
            # Command-based health check
            command = health_config.get('command')
            timeout = health_config.get('timeout', 10)
            
            try:
                proc = await asyncio.create_subprocess_shell(
                    command,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                
                await asyncio.wait_for(proc.wait(), timeout=timeout)
                return proc.returncode == 0
            except:
                return False
        
        return True
    
    def generate_status_report(self) -> None:
        """Generate comprehensive status report"""
        report = {
            'timestamp': time.time(),
            'orchestrator_pid': os.getpid(),
            'total_processes': len(self.processes),
            'processes': {}
        }
        
        for name, state in self.process_states.items():
            proc_info = {
                'state': state.value,
                'restart_count': self.restart_counts[name]
            }
            
            if name in self.process_handles:
                proc = self.process_handles[name]
                proc_info.update({
                    'pid': proc.pid,
                    'running': proc.poll() is None
                })
            
            report['processes'][name] = proc_info
        
        # Write report to file
        report_file = f"/tmp/orchestrator_status_{int(time.time())}.json"
        with open(report_file, 'w') as f:
            json.dump(report, f, indent=2)
        
        self.logger.info(f"Status report written to {report_file}")
    
    async def run(self) -> None:
        """Main orchestrator run loop"""
        self.logger.info("Starting Process Orchestrator")
        
        # Start all configured processes
        for name in self.processes:
            await self.start_process(name)
        
        # Keep orchestrator running
        try:
            while True:
                await asyncio.sleep(10)
        except KeyboardInterrupt:
            self.logger.info("Orchestrator interrupted, shutting down...")
        finally:
            await self.shutdown_all()
    
    async def shutdown_all(self) -> None:
        """Shutdown all managed processes"""
        self.logger.info("Shutting down all processes...")
        
        # Stop processes in reverse dependency order
        for name in reversed(list(self.processes.keys())):
            if name in self.process_handles:
                await self.stop_process(name)
        
        self.logger.info("All processes stopped")

# Example configuration file format (orchestrator.yaml)
EXAMPLE_CONFIG = """
processes:
  database:
    command: ["/usr/bin/mysqld", "--defaults-file=/etc/mysql/my.cnf"]
    working_dir: "/var/lib/mysql"
    user: "mysql"
    group: "mysql"
    restart_policy: "always"
    max_restarts: 3
    restart_delay: 10
    health_check:
      type: "tcp"
      host: "localhost"
      port: 3306
      timeout: 5
    environment:
      MYSQL_ROOT_PASSWORD: "secure_password"
  
  web_server:
    command: ["/usr/sbin/nginx", "-g", "daemon off;"]
    working_dir: "/etc/nginx"
    user: "www-data"
    group: "www-data"
    restart_policy: "on-failure"
    max_restarts: 5
    restart_delay: 5
    dependencies: ["database"]
    health_check:
      type: "http"
      url: "http://localhost/health"
      timeout: 10
    signals:
      reload: "HUP"
      graceful_stop: "QUIT"
  
  application:
    command: ["/opt/app/bin/app", "--config", "/etc/app/config.json"]
    working_dir: "/opt/app"
    user: "app"
    group: "app"
    restart_policy: "always"
    max_restarts: 10
    restart_delay: 5
    dependencies: ["database", "web_server"]
    environment:
      NODE_ENV: "production"
      LOG_LEVEL: "info"
"""

def main():
    import argparse
    
    parser = argparse.ArgumentParser(description='Process Orchestration System')
    parser.add_argument('--config', required=True, help='Configuration file path')
    parser.add_argument('--action', choices=['start', 'stop', 'restart', 'status'], 
                       default='start', help='Action to perform')
    parser.add_argument('--process', help='Specific process name (optional)')
    
    args = parser.parse_args()
    
    orchestrator = ProcessOrchestrator(args.config)
    
    if args.action == 'start':
        if args.process:
            asyncio.run(orchestrator.start_process(args.process))
        else:
            asyncio.run(orchestrator.run())
    elif args.action == 'stop':
        if args.process:
            asyncio.run(orchestrator.stop_process(args.process))
        else:
            asyncio.run(orchestrator.shutdown_all())
    elif args.action == 'restart':
        if args.process:
            asyncio.run(orchestrator.restart_process(args.process))
    elif args.action == 'status':
        orchestrator.generate_status_report()

if __name__ == '__main__':
    main()
```

# [Enterprise Monitoring and Alerting](#enterprise-monitoring-alerting)

## Signal-Based Process Monitoring

### Prometheus Integration Framework

```python
#!/usr/bin/env python3
"""
Enterprise Process Monitoring with Prometheus Integration
"""

import time
import signal
import psutil
import subprocess
from typing import Dict, List, Optional
from prometheus_client import start_http_server, Gauge, Counter, Histogram, Info
import logging

class ProcessMonitor:
    def __init__(self, port: int = 9090):
        self.port = port
        self.logger = self._setup_logging()
        
        # Prometheus metrics
        self.process_cpu_usage = Gauge('process_cpu_usage_percent', 
                                     'CPU usage percentage', ['pid', 'name', 'user'])
        self.process_memory_usage = Gauge('process_memory_usage_bytes', 
                                        'Memory usage in bytes', ['pid', 'name', 'user'])
        self.process_open_files = Gauge('process_open_files_total', 
                                      'Number of open files', ['pid', 'name', 'user'])
        self.process_threads = Gauge('process_threads_total', 
                                   'Number of threads', ['pid', 'name', 'user'])
        self.signal_events = Counter('signal_events_total', 
                                   'Total signal events', ['signal', 'pid', 'result'])
        self.process_uptime = Gauge('process_uptime_seconds', 
                                  'Process uptime in seconds', ['pid', 'name', 'user'])
        
        # System metrics
        self.system_load = Gauge('system_load_average', 'System load average', ['period'])
        self.system_processes = Gauge('system_processes_total', 'Total system processes')
        
        self._setup_signal_handlers()
        
    def _setup_logging(self) -> logging.Logger:
        logger = logging.getLogger(__name__)
        logger.setLevel(logging.INFO)
        
        handler = logging.StreamHandler()
        formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
        handler.setFormatter(formatter)
        logger.addHandler(handler)
        
        return logger
    
    def _setup_signal_handlers(self) -> None:
        """Setup signal handlers for monitoring control"""
        signal.signal(signal.SIGUSR1, self._dump_metrics)
        signal.signal(signal.SIGUSR2, self._reset_metrics)
    
    def _dump_metrics(self, signum: int, frame) -> None:
        """Dump current metrics to log"""
        self.logger.info("Dumping current metrics...")
        # Implementation for metrics dump
    
    def _reset_metrics(self, signum: int, frame) -> None:
        """Reset collected metrics"""
        self.logger.info("Resetting metrics...")
        # Implementation for metrics reset
    
    def start_monitoring(self) -> None:
        """Start the monitoring server"""
        start_http_server(self.port)
        self.logger.info(f"Process monitor started on port {self.port}")
        
        while True:
            try:
                self._collect_metrics()
                time.sleep(10)  # Collection interval
            except KeyboardInterrupt:
                self.logger.info("Monitoring stopped")
                break
            except Exception as e:
                self.logger.error(f"Error during monitoring: {e}")
                time.sleep(5)
    
    def _collect_metrics(self) -> None:
        """Collect process and system metrics"""
        current_time = time.time()
        
        # Collect process metrics
        for proc in psutil.process_iter(['pid', 'name', 'username', 'create_time']):
            try:
                pid = proc.info['pid']
                name = proc.info['name'] or 'unknown'
                user = proc.info['username'] or 'unknown'
                
                # CPU usage
                cpu_percent = proc.cpu_percent()
                self.process_cpu_usage.labels(pid=pid, name=name, user=user).set(cpu_percent)
                
                # Memory usage
                memory_info = proc.memory_info()
                self.process_memory_usage.labels(pid=pid, name=name, user=user).set(memory_info.rss)
                
                # Open files
                try:
                    open_files = len(proc.open_files())
                    self.process_open_files.labels(pid=pid, name=name, user=user).set(open_files)
                except (psutil.AccessDenied, OSError):
                    pass
                
                # Threads
                num_threads = proc.num_threads()
                self.process_threads.labels(pid=pid, name=name, user=user).set(num_threads)
                
                # Uptime
                uptime = current_time - proc.info['create_time']
                self.process_uptime.labels(pid=pid, name=name, user=user).set(uptime)
                
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        
        # Collect system metrics
        load_avg = psutil.getloadavg()
        self.system_load.labels(period='1min').set(load_avg[0])
        self.system_load.labels(period='5min').set(load_avg[1])
        self.system_load.labels(period='15min').set(load_avg[2])
        
        # Total processes
        total_procs = len(psutil.pids())
        self.system_processes.set(total_procs)

# Example usage
if __name__ == '__main__':
    monitor = ProcessMonitor()
    monitor.start_monitoring()
```

This comprehensive Unix signals and process management guide provides enterprise-grade tools and techniques for production Linux environments. The frameworks support graceful shutdowns, automated process orchestration, advanced monitoring, and robust signal handling patterns essential for reliable system operations.

The included Python and Bash scripts offer immediate practical value for systems administrators managing complex process hierarchies, implementing automated failover procedures, and maintaining high-availability services in enterprise data center environments.