---
title: "Bash Exit Codes & Error Handling Guide 2025: Complete Command Status Management"
date: 2025-11-25T10:00:00-05:00
draft: false
tags: ["Bash", "Exit Codes", "Error Handling", "Shell Scripting", "Linux", "Command Line", "Script Debugging", "Automation", "DevOps", "System Administration", "Shell Programming", "Error Management", "Script Reliability", "Bash Programming"]
categories:
- Linux
- Shell Scripting
- System Administration
- Programming
author: "Matthew Mattox - mmattox@support.tools"
description: "Master Bash exit codes and error handling with comprehensive command status management. Complete guide to exit code checking, error handling patterns, script debugging, and robust automation techniques for enterprise shell scripting."
more_link: "yes"
url: "/bash-exit-codes-error-handling-guide-2025/"
---

Bash exit codes provide essential feedback about command execution success or failure, enabling robust error handling and automation. This comprehensive guide covers exit code fundamentals, advanced error handling patterns, debugging techniques, and enterprise-grade script reliability practices.

<!--more-->

# [Understanding Bash Exit Codes](#understanding-bash-exit-codes)

## Exit Code Fundamentals

### What Are Exit Codes?
Exit codes (also called return codes or exit status) are integer values returned by commands and scripts to indicate their execution status:

- **0**: Success - Command completed without errors
- **1-255**: Failure - Various error conditions
- **Non-zero**: General indication of failure or specific error type

### Basic Exit Code Checking
```bash
# Run a command and check its exit code
/etc/init.d/dnsmasq start
echo "Exit code: $?"

# Alternative using command substitution
service_status=$(systemctl start nginx; echo $?)
echo "Service start result: $service_status"

# Check exit code immediately in conditional
if /bin/true; then
    echo "Command succeeded (exit code 0)"
else
    echo "Command failed (non-zero exit code)"
fi
```

## Standard Exit Codes and Meanings

### Common Exit Code Ranges
```bash
# Standard exit codes
0    # Success
1    # General errors
2    # Misuse of shell builtins
126  # Command invoked cannot execute
127  # Command not found
128  # Invalid argument to exit
130  # Script terminated by Control-C (128 + 2)
255  # Exit status out of range
```

### System-Specific Exit Codes
```bash
#!/bin/bash
# Display common system exit codes

declare -A exit_codes=(
    [0]="Success"
    [1]="General errors"
    [2]="Misuse of shell builtins"
    [64]="Command line usage error"
    [65]="Data format error"
    [66]="Cannot open input"
    [67]="Addressee unknown"
    [68]="Host name unknown"
    [69]="Service unavailable"
    [70]="Internal software error"
    [71]="System error"
    [72]="Critical OS file missing"
    [73]="Can't create output file"
    [74]="Input/output error"
    [75]="Temp failure; user is invited to retry"
    [76]="Remote error in protocol"
    [77]="Permission denied"
    [78]="Configuration error"
    [126]="Command invoked cannot execute"
    [127]="Command not found"
    [128]="Invalid argument to exit"
    [130]="Script terminated by Control-C"
)

# Function to explain exit code
explain_exit_code() {
    local code=$1
    if [[ -n ${exit_codes[$code]} ]]; then
        echo "Exit code $code: ${exit_codes[$code]}"
    else
        echo "Exit code $code: Unknown or application-specific"
    fi
}

# Example usage
explain_exit_code 0
explain_exit_code 127
explain_exit_code 130
```

# [Advanced Exit Code Handling](#advanced-exit-code-handling)

## Immediate Exit Code Capture

### Multiple Methods to Capture Exit Codes
```bash
#!/bin/bash
# Different ways to capture and handle exit codes

# Method 1: Direct capture
command_to_run
exit_code=$?
echo "Method 1 - Exit code: $exit_code"

# Method 2: Inline capture with command substitution
exit_code=$(command_to_run > /dev/null 2>&1; echo $?)
echo "Method 2 - Exit code: $exit_code"

# Method 3: Pipeline exit codes (requires pipefail)
set -o pipefail
echo "test" | grep "nonexistent" | wc -l
pipeline_exit=${PIPESTATUS[1]}  # Exit code of grep command
echo "Method 3 - Pipeline exit code: $pipeline_exit"

# Method 4: Function with return value
check_service() {
    systemctl is-active "$1" >/dev/null 2>&1
    return $?
}

check_service "nginx"
echo "Method 4 - Function exit code: $?"
```

### Advanced Exit Code Variables
```bash
#!/bin/bash
# Understanding special exit code variables

# PIPESTATUS array - exit codes of pipeline commands
echo "hello world" | grep "world" | wc -l
echo "Pipeline exit codes: ${PIPESTATUS[@]}"
echo "First command (echo): ${PIPESTATUS[0]}"
echo "Second command (grep): ${PIPESTATUS[1]}"
echo "Third command (wc): ${PIPESTATUS[2]}"

# Last background process exit code
sleep 1 &
background_pid=$!
wait $background_pid
echo "Background process exit code: $?"

# Exit code of last command in function
test_function() {
    ls /nonexistent/directory 2>/dev/null
    local func_exit=$?
    echo "Function internal exit code: $func_exit"
    return $func_exit
}

test_function
echo "Function return code: $?"
```

## Error Handling Patterns

### Basic Error Handling with Conditionals
```bash
#!/bin/bash
# Simple error handling patterns

# Pattern 1: If-then-else
if command_that_might_fail; then
    echo "Command succeeded"
else
    echo "Command failed with exit code: $?"
    exit 1
fi

# Pattern 2: Short-circuit evaluation
command_that_might_fail && echo "Success" || echo "Failed"

# Pattern 3: Early exit on failure
command_that_might_fail || {
    echo "Command failed, exiting..."
    exit 1
}

# Pattern 4: Continue on failure with logging
if ! command_that_might_fail; then
    echo "Warning: Command failed, but continuing..."
fi
```

### Advanced Error Handling Functions
```bash
#!/bin/bash
# Advanced error handling with functions

# Global error handling configuration
set -euo pipefail  # Exit on error, undefined vars, pipe failures

# Error logging function
log_error() {
    local exit_code=$1
    local line_number=$2
    local command="$3"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    
    echo "[$timestamp] ERROR: Command '$command' failed with exit code $exit_code at line $line_number" >&2
    
    # Optional: Send to syslog
    logger -t "script-error" "Command '$command' failed with exit code $exit_code at line $line_number"
}

# Trap function for automatic error handling
error_trap() {
    local exit_code=$?
    local line_number=$1
    local command="$BASH_COMMAND"
    
    log_error $exit_code $line_number "$command"
    
    # Cleanup function call
    cleanup_on_error
    
    exit $exit_code
}

# Cleanup function
cleanup_on_error() {
    echo "Performing cleanup..."
    # Remove temporary files
    rm -f /tmp/script-temp-*
    # Kill background processes
    jobs -p | xargs -r kill
    # Restore original configurations
    # ... cleanup code here ...
}

# Set error trap
trap 'error_trap $LINENO' ERR

# Safe command execution function
safe_execute() {
    local command="$1"
    local description="$2"
    local max_retries=${3:-1}
    local retry_delay=${4:-1}
    
    for ((i=1; i<=max_retries; i++)); do
        echo "Executing: $description (attempt $i/$max_retries)"
        
        if eval "$command"; then
            echo "✓ Success: $description"
            return 0
        else
            local exit_code=$?
            echo "✗ Failed: $description (exit code: $exit_code)"
            
            if [[ $i -lt $max_retries ]]; then
                echo "Retrying in $retry_delay seconds..."
                sleep $retry_delay
            else
                echo "All retry attempts failed"
                return $exit_code
            fi
        fi
    done
}

# Usage examples
safe_execute "systemctl start nginx" "Starting Nginx service" 3 5
safe_execute "wget -q --spider https://example.com" "Checking website connectivity" 2 3
```

# [Script Reliability and Debugging](#script-reliability-and-debugging)

## Bash Script Options for Reliability

### Essential Script Headers
```bash
#!/bin/bash
# Comprehensive script reliability settings

# Exit immediately on any command failure
set -e

# Exit on undefined variable usage
set -u

# Fail on any command in pipeline
set -o pipefail

# Enable debug mode (optional)
# set -x

# Alternative: Combined settings
# set -euo pipefail

# Function to disable strict mode temporarily
disable_strict_mode() {
    set +euo pipefail
}

# Function to re-enable strict mode
enable_strict_mode() {
    set -euo pipefail
}

# Example of temporary relaxed error handling
disable_strict_mode
optional_command_that_might_fail || true
enable_strict_mode
```

### Debug and Verbose Modes
```bash
#!/bin/bash
# Script debugging and verbose output

# Parse command line arguments for debug mode
DEBUG=false
VERBOSE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        -d|--debug)
            DEBUG=true
            set -x  # Enable debug mode
            shift
            ;;
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Debug logging function
debug_log() {
    if [[ "$DEBUG" == true ]]; then
        echo "[DEBUG $(date '+%H:%M:%S')] $*" >&2
    fi
}

# Verbose logging function
verbose_log() {
    if [[ "$VERBOSE" == true ]]; then
        echo "[INFO $(date '+%H:%M:%S')] $*"
    fi
}

# Command execution with logging
execute_with_logging() {
    local command="$1"
    local description="$2"
    
    verbose_log "Executing: $description"
    debug_log "Command: $command"
    
    if eval "$command"; then
        verbose_log "Success: $description"
        debug_log "Exit code: 0"
        return 0
    else
        local exit_code=$?
        echo "Error: $description failed with exit code $exit_code" >&2
        debug_log "Failed command: $command"
        return $exit_code
    fi
}

# Usage examples
execute_with_logging "ls -la /tmp" "Listing temporary directory"
execute_with_logging "ping -c 1 google.com" "Testing internet connectivity"
```

## Comprehensive Error Handling Framework

### Enterprise-Grade Error Handler
```bash
#!/bin/bash
# Enterprise error handling framework

# Configuration
readonly SCRIPT_NAME="$(basename "$0")"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly LOG_DIR="/var/log/scripts"
readonly LOG_FILE="$LOG_DIR/${SCRIPT_NAME%.*}.log"
readonly ERROR_LOG="$LOG_DIR/${SCRIPT_NAME%.*}-error.log"
readonly LOCK_FILE="/var/run/${SCRIPT_NAME%.*}.lock"

# Ensure log directory exists
mkdir -p "$LOG_DIR"

# Logging functions
log() {
    local level="$1"
    shift
    local message="$*"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    
    echo "[$timestamp] [$level] $message" | tee -a "$LOG_FILE"
    
    if [[ "$level" == "ERROR" ]]; then
        echo "[$timestamp] [$level] $message" >> "$ERROR_LOG"
    fi
}

log_info() { log "INFO" "$@"; }
log_warn() { log "WARN" "$@"; }
log_error() { log "ERROR" "$@"; }
log_debug() { log "DEBUG" "$@"; }

# Enhanced error trap function
enhanced_error_trap() {
    local exit_code=$?
    local line_number=$1
    local command="$BASH_COMMAND"
    local function_name="${FUNCNAME[1]:-main}"
    
    log_error "Command failed in function '$function_name' at line $line_number"
    log_error "Command: $command"
    log_error "Exit code: $exit_code"
    
    # Stack trace
    log_error "Call stack:"
    for ((i=1; i<${#FUNCNAME[@]}; i++)); do
        log_error "  $i: ${FUNCNAME[i]} (${BASH_SOURCE[i]}:${BASH_LINENO[i-1]})"
    done
    
    # Cleanup
    cleanup_resources
    
    # Send notification (if configured)
    send_error_notification "$exit_code" "$line_number" "$command"
    
    exit $exit_code
}

# Cleanup function
cleanup_resources() {
    log_info "Performing cleanup..."
    
    # Remove lock file
    [[ -f "$LOCK_FILE" ]] && rm -f "$LOCK_FILE"
    
    # Kill background jobs
    local jobs_pids=$(jobs -p)
    if [[ -n "$jobs_pids" ]]; then
        log_info "Terminating background jobs: $jobs_pids"
        echo "$jobs_pids" | xargs -r kill -TERM
        sleep 2
        echo "$jobs_pids" | xargs -r kill -KILL 2>/dev/null || true
    fi
    
    # Remove temporary files
    find /tmp -name "${SCRIPT_NAME%.*}-*" -type f -mmin +60 -delete 2>/dev/null || true
    
    log_info "Cleanup completed"
}

# Error notification function
send_error_notification() {
    local exit_code="$1"
    local line_number="$2"
    local command="$3"
    
    # Email notification (if mail is configured)
    if command -v mail >/dev/null 2>&1 && [[ -n "${ADMIN_EMAIL:-}" ]]; then
        {
            echo "Script: $SCRIPT_NAME"
            echo "Host: $(hostname)"
            echo "Time: $(date)"
            echo "Exit Code: $exit_code"
            echo "Line: $line_number"
            echo "Command: $command"
            echo ""
            echo "Last 10 log entries:"
            tail -10 "$LOG_FILE"
        } | mail -s "Script Error: $SCRIPT_NAME on $(hostname)" "$ADMIN_EMAIL"
    fi
    
    # Slack notification (if webhook is configured)
    if [[ -n "${SLACK_WEBHOOK:-}" ]]; then
        local payload=$(cat <<EOF
{
    "text": "Script Error Alert",
    "attachments": [
        {
            "color": "danger",
            "fields": [
                {"title": "Script", "value": "$SCRIPT_NAME", "short": true},
                {"title": "Host", "value": "$(hostname)", "short": true},
                {"title": "Exit Code", "value": "$exit_code", "short": true},
                {"title": "Line", "value": "$line_number", "short": true},
                {"title": "Command", "value": "$command", "short": false}
            ]
        }
    ]
}
EOF
        )
        curl -X POST -H 'Content-type: application/json' \
             --data "$payload" "$SLACK_WEBHOOK" >/dev/null 2>&1 || true
    fi
}

# Set error handling
set -euo pipefail
trap 'enhanced_error_trap $LINENO' ERR
trap cleanup_resources EXIT

# Lock file management
create_lock() {
    if [[ -f "$LOCK_FILE" ]]; then
        local lock_pid=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
        if [[ -n "$lock_pid" ]] && kill -0 "$lock_pid" 2>/dev/null; then
            log_error "Script is already running (PID: $lock_pid)"
            exit 1
        else
            log_warn "Removing stale lock file"
            rm -f "$LOCK_FILE"
        fi
    fi
    
    echo $$ > "$LOCK_FILE"
    log_info "Lock file created: $LOCK_FILE"
}

# Robust command execution with retries
execute_with_retry() {
    local command="$1"
    local description="$2"
    local max_attempts="${3:-3}"
    local retry_delay="${4:-5}"
    local timeout="${5:-30}"
    
    local attempt=1
    
    while [[ $attempt -le $max_attempts ]]; do
        log_info "Executing: $description (attempt $attempt/$max_attempts)"
        
        if timeout "$timeout" bash -c "$command"; then
            log_info "Success: $description"
            return 0
        else
            local exit_code=$?
            log_warn "Attempt $attempt failed: $description (exit code: $exit_code)"
            
            if [[ $attempt -lt $max_attempts ]]; then
                log_info "Waiting $retry_delay seconds before retry..."
                sleep "$retry_delay"
                ((attempt++))
            else
                log_error "All attempts failed: $description"
                return $exit_code
            fi
        fi
    done
}

# Conditional execution based on exit codes
execute_if_success() {
    local check_command="$1"
    local exec_command="$2"
    local description="$3"
    
    if eval "$check_command" >/dev/null 2>&1; then
        log_info "Condition met, executing: $description"
        eval "$exec_command"
    else
        log_info "Condition not met, skipping: $description"
    fi
}

# Main script initialization
main() {
    log_info "Starting $SCRIPT_NAME"
    log_info "PID: $$"
    log_info "User: $(whoami)"
    log_info "Working directory: $(pwd)"
    
    # Create lock file
    create_lock
    
    # Example usage of the framework
    execute_with_retry "ping -c 1 google.com" "Testing internet connectivity" 3 2 10
    execute_if_success "systemctl is-active nginx" "systemctl reload nginx" "Reloading Nginx if active"
    
    log_info "$SCRIPT_NAME completed successfully"
}

# Run main function
main "$@"
```

# [Practical Applications and Examples](#practical-applications-and-examples)

## Service Management Scripts

### Robust Service Controller
```bash
#!/bin/bash
# Robust service management with exit code handling

# Service management functions
service_start() {
    local service_name="$1"
    local max_wait="${2:-30}"
    
    echo "Starting service: $service_name"
    
    if systemctl start "$service_name"; then
        echo "✓ Service start command issued successfully"
        
        # Wait for service to become active
        local wait_time=0
        while [[ $wait_time -lt $max_wait ]]; do
            if systemctl is-active "$service_name" >/dev/null 2>&1; then
                echo "✓ Service $service_name is now active"
                return 0
            fi
            
            sleep 1
            ((wait_time++))
            echo -n "."
        done
        
        echo "✗ Service $service_name failed to become active within $max_wait seconds"
        return 1
    else
        local exit_code=$?
        echo "✗ Failed to start service $service_name (exit code: $exit_code)"
        return $exit_code
    fi
}

service_stop() {
    local service_name="$1"
    local max_wait="${2:-30}"
    
    echo "Stopping service: $service_name"
    
    if systemctl stop "$service_name"; then
        echo "✓ Service stop command issued successfully"
        
        # Wait for service to become inactive
        local wait_time=0
        while [[ $wait_time -lt $max_wait ]]; do
            if ! systemctl is-active "$service_name" >/dev/null 2>&1; then
                echo "✓ Service $service_name is now inactive"
                return 0
            fi
            
            sleep 1
            ((wait_time++))
            echo -n "."
        done
        
        echo "✗ Service $service_name failed to stop within $max_wait seconds"
        return 1
    else
        local exit_code=$?
        echo "✗ Failed to stop service $service_name (exit code: $exit_code)"
        return $exit_code
    fi
}

service_restart() {
    local service_name="$1"
    local stop_wait="${2:-30}"
    local start_wait="${3:-30}"
    
    echo "Restarting service: $service_name"
    
    # Stop service first
    if service_stop "$service_name" "$stop_wait"; then
        # Start service
        if service_start "$service_name" "$start_wait"; then
            echo "✓ Service $service_name restarted successfully"
            return 0
        else
            echo "✗ Failed to start service $service_name after stop"
            return 1
        fi
    else
        echo "✗ Failed to stop service $service_name for restart"
        return 1
    fi
}

# Health check function
service_health_check() {
    local service_name="$1"
    local port="${2:-}"
    local url="${3:-}"
    
    echo "Performing health check for: $service_name"
    
    # Check if service is active
    if ! systemctl is-active "$service_name" >/dev/null 2>&1; then
        echo "✗ Service $service_name is not active"
        return 1
    fi
    
    # Check port if specified
    if [[ -n "$port" ]]; then
        if ! netstat -tuln | grep -q ":$port "; then
            echo "✗ Service $service_name is not listening on port $port"
            return 2
        fi
        echo "✓ Service $service_name is listening on port $port"
    fi
    
    # Check URL if specified
    if [[ -n "$url" ]]; then
        if ! curl -sf "$url" >/dev/null 2>&1; then
            echo "✗ Service $service_name health check failed for URL: $url"
            return 3
        fi
        echo "✓ Service $service_name health check passed for URL: $url"
    fi
    
    echo "✓ All health checks passed for service: $service_name"
    return 0
}

# Example usage
main() {
    local services=("nginx" "mysql" "redis-server")
    local failed_services=()
    
    for service in "${services[@]}"; do
        if ! service_restart "$service"; then
            failed_services+=("$service")
        fi
    done
    
    # Report results
    if [[ ${#failed_services[@]} -eq 0 ]]; then
        echo "✓ All services restarted successfully"
        exit 0
    else
        echo "✗ Failed to restart services: ${failed_services[*]}"
        exit 1
    fi
}

# Run if script is executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
```

## File Operations with Error Handling

### Robust File Processing
```bash
#!/bin/bash
# File operations with comprehensive error handling

# File validation function
validate_file() {
    local file_path="$1"
    local required_permissions="${2:-r}"
    
    # Check if file exists
    if [[ ! -e "$file_path" ]]; then
        echo "Error: File does not exist: $file_path" >&2
        return 1
    fi
    
    # Check if it's a regular file
    if [[ ! -f "$file_path" ]]; then
        echo "Error: Not a regular file: $file_path" >&2
        return 2
    fi
    
    # Check permissions
    case "$required_permissions" in
        "r"|"read")
            if [[ ! -r "$file_path" ]]; then
                echo "Error: File not readable: $file_path" >&2
                return 3
            fi
            ;;
        "w"|"write")
            if [[ ! -w "$file_path" ]]; then
                echo "Error: File not writable: $file_path" >&2
                return 4
            fi
            ;;
        "x"|"execute")
            if [[ ! -x "$file_path" ]]; then
                echo "Error: File not executable: $file_path" >&2
                return 5
            fi
            ;;
        "rw"|"read-write")
            if [[ ! -r "$file_path" ]] || [[ ! -w "$file_path" ]]; then
                echo "Error: File not readable/writable: $file_path" >&2
                return 6
            fi
            ;;
    esac
    
    return 0
}

# Safe file copy with verification
safe_copy() {
    local source="$1"
    local destination="$2"
    local verify_checksum="${3:-true}"
    
    echo "Copying: $source -> $destination"
    
    # Validate source file
    if ! validate_file "$source" "read"; then
        return 1
    fi
    
    # Create destination directory if needed
    local dest_dir=$(dirname "$destination")
    if [[ ! -d "$dest_dir" ]]; then
        if ! mkdir -p "$dest_dir"; then
            echo "Error: Failed to create destination directory: $dest_dir" >&2
            return 2
        fi
    fi
    
    # Get source file size and checksum
    local source_size=$(stat -f%z "$source" 2>/dev/null || stat -c%s "$source" 2>/dev/null)
    local source_checksum=""
    if [[ "$verify_checksum" == "true" ]]; then
        source_checksum=$(sha256sum "$source" | cut -d' ' -f1)
    fi
    
    # Perform copy
    if ! cp "$source" "$destination"; then
        local exit_code=$?
        echo "Error: Copy operation failed (exit code: $exit_code)" >&2
        return $exit_code
    fi
    
    # Verify copy
    local dest_size=$(stat -f%z "$destination" 2>/dev/null || stat -c%s "$destination" 2>/dev/null)
    if [[ "$source_size" != "$dest_size" ]]; then
        echo "Error: Size mismatch - Source: $source_size, Destination: $dest_size" >&2
        rm -f "$destination"  # Clean up failed copy
        return 3
    fi
    
    # Verify checksum if requested
    if [[ "$verify_checksum" == "true" ]]; then
        local dest_checksum=$(sha256sum "$destination" | cut -d' ' -f1)
        if [[ "$source_checksum" != "$dest_checksum" ]]; then
            echo "Error: Checksum mismatch" >&2
            echo "Source: $source_checksum" >&2
            echo "Destination: $dest_checksum" >&2
            rm -f "$destination"  # Clean up failed copy
            return 4
        fi
    fi
    
    echo "✓ Copy completed and verified successfully"
    return 0
}

# Batch file processing with error reporting
process_files() {
    local source_dir="$1"
    local destination_dir="$2"
    local file_pattern="${3:-*}"
    
    local processed_count=0
    local failed_count=0
    local failed_files=()
    
    echo "Processing files from $source_dir to $destination_dir"
    echo "Pattern: $file_pattern"
    
    # Find and process files
    while IFS= read -r -d '' file; do
        local filename=$(basename "$file")
        local dest_file="$destination_dir/$filename"
        
        echo "Processing: $filename"
        
        if safe_copy "$file" "$dest_file"; then
            ((processed_count++))
            echo "✓ Processed: $filename"
        else
            ((failed_count++))
            failed_files+=("$filename")
            echo "✗ Failed: $filename"
        fi
    done < <(find "$source_dir" -name "$file_pattern" -type f -print0)
    
    # Report results
    echo ""
    echo "Processing complete:"
    echo "  Successfully processed: $processed_count files"
    echo "  Failed: $failed_count files"
    
    if [[ $failed_count -gt 0 ]]; then
        echo "  Failed files: ${failed_files[*]}"
        return 1
    fi
    
    return 0
}
```

## Network Operations with Exit Code Handling

### Network Connectivity Testing
```bash
#!/bin/bash
# Network connectivity testing with detailed exit codes

# DNS resolution test
test_dns_resolution() {
    local hostname="$1"
    local dns_server="${2:-8.8.8.8}"
    
    echo "Testing DNS resolution for: $hostname"
    
    if nslookup "$hostname" "$dns_server" >/dev/null 2>&1; then
        echo "✓ DNS resolution successful"
        return 0
    else
        local exit_code=$?
        echo "✗ DNS resolution failed (exit code: $exit_code)"
        return $exit_code
    fi
}

# Network connectivity test
test_network_connectivity() {
    local target="$1"
    local port="${2:-80}"
    local timeout="${3:-10}"
    
    echo "Testing connectivity to: $target:$port"
    
    if timeout "$timeout" bash -c "echo >/dev/tcp/$target/$port" 2>/dev/null; then
        echo "✓ Network connectivity successful"
        return 0
    else
        local exit_code=$?
        echo "✗ Network connectivity failed (exit code: $exit_code)"
        
        # Try to determine the specific reason
        if ! ping -c 1 -W 5 "$target" >/dev/null 2>&1; then
            echo "  → Host unreachable"
            return 1
        elif ! nc -z -w 5 "$target" "$port" 2>/dev/null; then
            echo "  → Port $port closed or filtered"
            return 2
        else
            echo "  → Unknown connectivity issue"
            return $exit_code
        fi
    fi
}

# HTTP/HTTPS test with detailed response codes
test_http_endpoint() {
    local url="$1"
    local expected_code="${2:-200}"
    local timeout="${3:-30}"
    local max_redirects="${4:-5}"
    
    echo "Testing HTTP endpoint: $url"
    
    local response
    response=$(curl -s -w "%{http_code}|%{time_total}|%{redirect_count}" \
                   --max-time "$timeout" \
                   --max-redirs "$max_redirects" \
                   -o /dev/null \
                   "$url" 2>/dev/null)
    
    local curl_exit=$?
    
    if [[ $curl_exit -eq 0 ]]; then
        local http_code=$(echo "$response" | cut -d'|' -f1)
        local time_total=$(echo "$response" | cut -d'|' -f2)
        local redirect_count=$(echo "$response" | cut -d'|' -f3)
        
        echo "  HTTP Status: $http_code"
        echo "  Response Time: ${time_total}s"
        echo "  Redirects: $redirect_count"
        
        if [[ "$http_code" == "$expected_code" ]]; then
            echo "✓ HTTP endpoint test successful"
            return 0
        else
            echo "✗ Unexpected HTTP status code (expected: $expected_code, got: $http_code)"
            return 10
        fi
    else
        echo "✗ HTTP request failed (curl exit code: $curl_exit)"
        
        # Decode curl exit codes
        case $curl_exit in
            6) echo "  → Couldn't resolve host" ;;
            7) echo "  → Failed to connect to host" ;;
            28) echo "  → Operation timeout" ;;
            35) echo "  → SSL connect error" ;;
            *) echo "  → Curl error code: $curl_exit" ;;
        esac
        
        return $curl_exit
    fi
}

# Comprehensive network health check
network_health_check() {
    local targets=("google.com" "github.com" "stackoverflow.com")
    local failed_tests=0
    local total_tests=0
    
    echo "Starting comprehensive network health check..."
    echo "================================================"
    
    for target in "${targets[@]}"; do
        echo ""
        echo "Testing target: $target"
        echo "------------------------"
        
        # DNS test
        ((total_tests++))
        if ! test_dns_resolution "$target"; then
            ((failed_tests++))
            continue
        fi
        
        # Ping test
        ((total_tests++))
        if ! test_network_connectivity "$target" 80; then
            ((failed_tests++))
            continue
        fi
        
        # HTTP test
        ((total_tests++))
        if ! test_http_endpoint "https://$target"; then
            ((failed_tests++))
        fi
    done
    
    echo ""
    echo "Network Health Check Summary"
    echo "============================="
    echo "Total tests: $total_tests"
    echo "Passed: $((total_tests - failed_tests))"
    echo "Failed: $failed_tests"
    
    if [[ $failed_tests -eq 0 ]]; then
        echo "✓ All network tests passed"
        return 0
    else
        echo "✗ $failed_tests network tests failed"
        return 1
    fi
}

# Run network health check if script is executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    network_health_check
fi
```

This comprehensive Bash exit codes and error handling guide provides enterprise-grade techniques for building robust, reliable shell scripts with proper error detection, handling, and reporting capabilities.