---
title: "RACADM BIOS Configuration & Automation Guide 2025: Complete Dell Server Management"
date: 2025-12-26T10:00:00-05:00
draft: false
tags: ["RACADM", "Dell iDRAC", "BIOS Configuration", "Server Management", "PowerEdge", "Dell Servers", "Remote Management", "Automation", "Server BIOS", "Configuration Jobs", "Enterprise Hardware", "Data Center", "System Administration", "Out-of-Band Management"]
categories:
- Server Management
- Hardware Configuration
- System Administration
- Enterprise IT
author: "Matthew Mattox - mmattox@support.tools"
description: "Master RACADM BIOS configuration and automation for Dell PowerEdge servers. Complete guide to remote BIOS management, job queue automation, boot order configuration, and enterprise-scale server deployment strategies."
more_link: "yes"
url: "/racadm-bios-configuration-automation-guide-2025/"
---

RACADM provides powerful remote BIOS configuration capabilities for Dell PowerEdge servers, enabling automated deployment and management at scale. This comprehensive guide covers advanced BIOS settings management, job queue automation, enterprise deployment strategies, and troubleshooting techniques for modern data center operations.

<!--more-->

# [RACADM BIOS Management Overview](#racadm-bios-management-overview)

## Understanding Dell Server BIOS Architecture

### BIOS Configuration Hierarchy
Dell PowerEdge servers organize BIOS settings in a structured hierarchy:

- **BIOS.Setup**: Main BIOS configuration tree
- **BiosBootSettings**: Boot sequence and boot mode settings
- **SysProfileSettings**: System performance profiles
- **ProcSettings**: Processor configuration
- **MemSettings**: Memory configuration
- **NetworkDeviceSettings**: Network boot and PXE settings
- **IntegratedDevices**: Onboard device settings

### Job Queue System
RACADM uses a job queue system for BIOS changes:
1. **Pending State**: Changes are staged but not applied
2. **Job Creation**: Configuration job commits pending changes
3. **Reboot Required**: Server reboot applies committed changes
4. **Job Completion**: BIOS settings become active

# [Advanced BIOS Configuration Management](#advanced-bios-configuration-management)

## Comprehensive BIOS Settings Script

```bash
#!/bin/bash
# Advanced RACADM BIOS Configuration Management Script

# Configuration
IDRAC_IP="10.6.26.241"
IDRAC_USER="root"
IDRAC_PASS="calvin"
LOG_FILE="/var/log/racadm_bios_config.log"

# Logging function
log_message() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# RACADM command wrapper with error handling
racadm_exec() {
    local command="$1"
    local description="$2"
    
    log_message "Executing: $description"
    
    result=$(racadm -r "$IDRAC_IP" -u "$IDRAC_USER" -p "$IDRAC_PASS" $command 2>&1)
    exit_code=$?
    
    if [ $exit_code -eq 0 ]; then
        log_message "✓ Success: $description"
        echo "$result"
        return 0
    else
        log_message "✗ Failed: $description (Exit code: $exit_code)"
        log_message "Error output: $result"
        return $exit_code
    fi
}

# Get current BIOS version and settings
get_bios_inventory() {
    log_message "=== BIOS Inventory Report ==="
    
    # Get BIOS version
    racadm_exec "getversion -b" "Getting BIOS version"
    
    # Get system information
    racadm_exec "getsysinfo" "Getting system information"
    
    # Get current boot settings
    racadm_exec "get BIOS.BiosBootSettings.BootMode" "Getting boot mode"
    racadm_exec "get BIOS.BiosBootSettings.HddSeq" "Getting HDD boot sequence"
    racadm_exec "get BIOS.BiosBootSettings.UefiBootSeq" "Getting UEFI boot sequence"
    
    # Get system profile
    racadm_exec "get BIOS.SysProfileSettings.SysProfile" "Getting system profile"
}

# Configure boot settings
configure_boot_settings() {
    local boot_mode="$1"  # Bios or Uefi
    local boot_sequence="$2"
    
    log_message "=== Configuring Boot Settings ==="
    
    # Set boot mode
    if [[ -n "$boot_mode" ]]; then
        racadm_exec "set BIOS.BiosBootSettings.BootMode $boot_mode" "Setting boot mode to $boot_mode"
    fi
    
    # Set boot sequence based on mode
    if [[ "$boot_mode" == "Bios" ]] && [[ -n "$boot_sequence" ]]; then
        racadm_exec "set BIOS.BiosBootSettings.HddSeq $boot_sequence" "Setting BIOS boot sequence"
    elif [[ "$boot_mode" == "Uefi" ]] && [[ -n "$boot_sequence" ]]; then
        racadm_exec "set BIOS.BiosBootSettings.UefiBootSeq $boot_sequence" "Setting UEFI boot sequence"
    fi
    
    # Enable PXE on first NIC
    racadm_exec "set BIOS.NetworkDeviceSettings.PxeDev1EnDis Enabled" "Enabling PXE on NIC1"
}

# Configure performance settings
configure_performance_profile() {
    local profile="$1"  # PerfOptimized, PerfPerWattOptimized, Custom, etc.
    
    log_message "=== Configuring Performance Profile ==="
    
    # Set system profile
    racadm_exec "set BIOS.SysProfileSettings.SysProfile $profile" "Setting system profile to $profile"
    
    # Configure processor settings for performance
    if [[ "$profile" == "PerfOptimized" ]]; then
        racadm_exec "set BIOS.ProcSettings.LogicalProc Enabled" "Enabling Hyper-Threading"
        racadm_exec "set BIOS.ProcSettings.ProcVirtualization Enabled" "Enabling CPU virtualization"
        racadm_exec "set BIOS.ProcSettings.ProcTurboMode Enabled" "Enabling Turbo Boost"
        racadm_exec "set BIOS.ProcSettings.ProcCStates Disabled" "Disabling C-States for performance"
        racadm_exec "set BIOS.ProcSettings.ProcC1E Disabled" "Disabling C1E for performance"
    fi
}

# Configure memory settings
configure_memory_settings() {
    log_message "=== Configuring Memory Settings ==="
    
    # Set memory operating mode
    racadm_exec "set BIOS.MemSettings.MemOpMode OptimizerMode" "Setting memory optimizer mode"
    
    # Enable node interleaving
    racadm_exec "set BIOS.MemSettings.NodeInterleave Enabled" "Enabling node interleaving"
    
    # Set memory patrol scrub
    racadm_exec "set BIOS.MemSettings.MemPatrolScrub Standard" "Setting memory patrol scrub"
}

# Create and manage configuration jobs
create_bios_config_job() {
    local job_name="${1:-BIOS.Setup.1-1}"
    local reboot_type="${2:-PowerCycle}"  # PowerCycle, GracefulReboot, GracefulRebootForce
    
    log_message "=== Creating BIOS Configuration Job ==="
    
    # Create configuration job
    result=$(racadm_exec "jobqueue create $job_name" "Creating BIOS configuration job")
    
    # Extract job ID
    job_id=$(echo "$result" | grep -oP 'JID_\d+' | head -1)
    
    if [[ -n "$job_id" ]]; then
        log_message "Job created successfully: $job_id"
        
        # Check job status
        check_job_status "$job_id"
        
        # Schedule reboot if requested
        if [[ "$reboot_type" != "none" ]]; then
            schedule_reboot "$reboot_type" "$job_id"
        fi
        
        return 0
    else
        log_message "Failed to create configuration job"
        return 1
    fi
}

# Check job status with timeout
check_job_status() {
    local job_id="$1"
    local timeout="${2:-300}"  # 5 minutes default
    local interval=10
    local elapsed=0
    
    log_message "Monitoring job status: $job_id"
    
    while [ $elapsed -lt $timeout ]; do
        result=$(racadm_exec "jobqueue view -i $job_id" "Checking job $job_id status" 2>/dev/null)
        
        # Parse job status
        status=$(echo "$result" | grep -oP 'Status=\K[^\s]+' | head -1)
        percent=$(echo "$result" | grep -oP 'Percent Complete=\K[^\s]+' | head -1)
        
        log_message "Job $job_id: Status=$status, Progress=$percent%"
        
        case "$status" in
            "Completed")
                log_message "✓ Job $job_id completed successfully"
                return 0
                ;;
            "Failed"|"Aborted")
                log_message "✗ Job $job_id failed with status: $status"
                return 1
                ;;
            "Scheduled"|"Running"|"New")
                sleep $interval
                elapsed=$((elapsed + interval))
                ;;
            *)
                log_message "Unknown job status: $status"
                sleep $interval
                elapsed=$((elapsed + interval))
                ;;
        esac
    done
    
    log_message "Job monitoring timeout reached"
    return 2
}

# Schedule server reboot
schedule_reboot() {
    local reboot_type="$1"
    local wait_for_job="$2"
    
    log_message "=== Scheduling Server Reboot ==="
    
    # Wait for job to be ready if specified
    if [[ -n "$wait_for_job" ]]; then
        log_message "Waiting for job $wait_for_job to be ready for reboot..."
        sleep 10
    fi
    
    case "$reboot_type" in
        "PowerCycle")
            racadm_exec "serveraction powercycle" "Initiating power cycle"
            ;;
        "GracefulReboot")
            racadm_exec "serveraction graceshutdown" "Initiating graceful shutdown"
            sleep 30
            racadm_exec "serveraction powerup" "Powering up server"
            ;;
        "HardReset")
            racadm_exec "serveraction hardreset" "Initiating hard reset"
            ;;
        *)
            log_message "Unknown reboot type: $reboot_type"
            return 1
            ;;
    esac
    
    log_message "Reboot initiated, waiting for server to come back online..."
    wait_for_server_online
}

# Wait for server to come back online
wait_for_server_online() {
    local timeout=600  # 10 minutes
    local interval=30
    local elapsed=0
    
    # Wait initial period for shutdown
    sleep 60
    
    while [ $elapsed -lt $timeout ]; do
        if racadm -r "$IDRAC_IP" -u "$IDRAC_USER" -p "$IDRAC_PASS" getsysinfo >/dev/null 2>&1; then
            log_message "✓ Server is back online"
            
            # Check server power state
            power_state=$(racadm_exec "serveraction powerstatus" "Checking power status" | grep -oP 'Server Power Status: \K.*')
            log_message "Server power status: $power_state"
            
            if [[ "$power_state" == "ON" ]]; then
                return 0
            fi
        fi
        
        log_message "Waiting for server to come online... ($elapsed/$timeout seconds)"
        sleep $interval
        elapsed=$((elapsed + interval))
    done
    
    log_message "✗ Timeout waiting for server to come online"
    return 1
}

# Backup current BIOS settings
backup_bios_settings() {
    local backup_file="${1:-bios_backup_$(date +%Y%m%d_%H%M%S).xml}"
    
    log_message "=== Backing up BIOS Settings ==="
    
    # Export system configuration
    racadm_exec "get -t xml -f $backup_file" "Exporting BIOS configuration"
    
    if [[ -f "$backup_file" ]]; then
        log_message "✓ BIOS settings backed up to: $backup_file"
        
        # Compress backup
        gzip "$backup_file"
        log_message "Compressed backup: ${backup_file}.gz"
    else
        log_message "✗ Failed to create backup file"
        return 1
    fi
}

# Restore BIOS settings from backup
restore_bios_settings() {
    local backup_file="$1"
    
    log_message "=== Restoring BIOS Settings ==="
    
    # Decompress if needed
    if [[ "$backup_file" == *.gz ]]; then
        gunzip "$backup_file"
        backup_file="${backup_file%.gz}"
    fi
    
    # Import configuration
    racadm_exec "set -f $backup_file" "Importing BIOS configuration"
    
    # Create job to apply settings
    create_bios_config_job "BIOS.Setup.1-1" "PowerCycle"
}
```

## Enterprise BIOS Deployment Automation

```bash
#!/bin/bash
# Enterprise-scale BIOS deployment script

# Server inventory file format: IP,User,Password,Profile,BootMode
SERVER_INVENTORY="servers.csv"
PARALLEL_JOBS=5
RESULTS_DIR="./bios_deployment_results"

# Create results directory
mkdir -p "$RESULTS_DIR"

# Process server function
configure_server_bios() {
    local server_info="$1"
    IFS=',' read -r ip user pass profile boot_mode <<< "$server_info"
    
    local log_file="$RESULTS_DIR/${ip}_bios_config.log"
    local start_time=$(date +%s)
    
    echo "[$(date)] Starting BIOS configuration for $ip" > "$log_file"
    
    # Set RACADM connection parameters
    export IDRAC_IP="$ip"
    export IDRAC_USER="$user"
    export IDRAC_PASS="$pass"
    
    # Execute BIOS configuration steps
    {
        echo "=== Phase 1: Backup Current Settings ==="
        ./racadm_bios_config.sh backup "bios_backup_${ip}.xml"
        
        echo "=== Phase 2: Configure Performance Profile ==="
        ./racadm_bios_config.sh set_profile "$profile"
        
        echo "=== Phase 3: Configure Boot Settings ==="
        ./racadm_bios_config.sh set_boot "$boot_mode"
        
        echo "=== Phase 4: Create and Execute Job ==="
        ./racadm_bios_config.sh create_job_and_reboot
        
        echo "=== Phase 5: Verify Configuration ==="
        ./racadm_bios_config.sh verify_settings
        
    } >> "$log_file" 2>&1
    
    local end_time=$(date +%s)
    local duration=$((end_time - start_time))
    
    echo "[$(date)] Completed BIOS configuration for $ip (Duration: ${duration}s)" >> "$log_file"
    
    # Return status
    if grep -q "✓ Verification passed" "$log_file"; then
        echo "$ip,SUCCESS,$duration" >> "$RESULTS_DIR/summary.csv"
        return 0
    else
        echo "$ip,FAILED,$duration" >> "$RESULTS_DIR/summary.csv"
        return 1
    fi
}

# Main deployment loop
deploy_bios_configs() {
    echo "Starting enterprise BIOS deployment"
    echo "Server inventory: $SERVER_INVENTORY"
    echo "Parallel jobs: $PARALLEL_JOBS"
    
    # Initialize summary
    echo "IP,Status,Duration" > "$RESULTS_DIR/summary.csv"
    
    # Process servers in parallel
    cat "$SERVER_INVENTORY" | grep -v "^#" | while IFS= read -r server_info; do
        # Wait if too many background jobs
        while [ $(jobs -r | wc -l) -ge $PARALLEL_JOBS ]; do
            sleep 1
        done
        
        # Launch background job
        configure_server_bios "$server_info" &
    done
    
    # Wait for all jobs to complete
    wait
    
    # Generate summary report
    generate_deployment_report
}

# Generate deployment report
generate_deployment_report() {
    local report_file="$RESULTS_DIR/deployment_report_$(date +%Y%m%d_%H%M%S).txt"
    
    {
        echo "Enterprise BIOS Deployment Report"
        echo "================================="
        echo "Date: $(date)"
        echo ""
        
        echo "Summary Statistics:"
        echo "------------------"
        local total=$(tail -n +2 "$RESULTS_DIR/summary.csv" | wc -l)
        local success=$(grep ",SUCCESS," "$RESULTS_DIR/summary.csv" | wc -l)
        local failed=$(grep ",FAILED," "$RESULTS_DIR/summary.csv" | wc -l)
        
        echo "Total servers: $total"
        echo "Successful: $success"
        echo "Failed: $failed"
        echo "Success rate: $(( success * 100 / total ))%"
        echo ""
        
        echo "Failed Servers:"
        echo "--------------"
        grep ",FAILED," "$RESULTS_DIR/summary.csv" | cut -d',' -f1
        echo ""
        
        echo "Average deployment time: $(tail -n +2 "$RESULTS_DIR/summary.csv" | cut -d',' -f3 | awk '{sum+=$1} END {print sum/NR}') seconds"
        
    } > "$report_file"
    
    echo "Report generated: $report_file"
}

# Execute deployment
deploy_bios_configs
```

# [Common BIOS Configuration Scenarios](#common-bios-configuration-scenarios)

## Virtualization Host Configuration

```bash
#!/bin/bash
# Configure BIOS for virtualization hosts (ESXi, Hyper-V, KVM)

configure_virtualization_host() {
    local idrac_ip="$1"
    
    echo "Configuring BIOS for virtualization host: $idrac_ip"
    
    # Set performance profile
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.SysProfileSettings.SysProfile PerfOptimized
    
    # Enable virtualization features
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.ProcSettings.ProcVirtualization Enabled
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.ProcSettings.ProcAdjCacheLine Enabled
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.ProcSettings.ProcHwPrefetcher Enabled
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.ProcSettings.ProcSwPrefetcher Enabled
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.ProcSettings.DCUStreamerPrefetcher Enabled
    
    # Enable Intel VT-d / AMD-Vi for device passthrough
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.IntegratedDevices.IntelVtForDirectIo Enabled
    
    # Configure memory for virtualization
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.MemSettings.MemOpMode OptimizerMode
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.MemSettings.NodeInterleave Disabled
    
    # Disable unnecessary features
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.IntegratedDevices.InternalUsb Off
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.IntegratedDevices.InternalSdCard Off
    
    # Configure power management
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.SysProfileSettings.CpuInterconnectBusSpeed MaxDataRate
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.SysProfileSettings.MemFrequency MaxPerf
    
    # Enable SR-IOV for network performance
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.IntegratedDevices.SriovGlobalEnable Enabled
    
    # Create and execute job
    job_id=$(racadm -r "$idrac_ip" -u root -p calvin jobqueue create BIOS.Setup.1-1 | grep -oP 'JID_\d+')
    echo "Configuration job created: $job_id"
    
    # Reboot to apply
    racadm -r "$idrac_ip" -u root -p calvin serveraction powercycle
}
```

## Database Server Optimization

```bash
#!/bin/bash
# Optimize BIOS for database workloads

configure_database_server() {
    local idrac_ip="$1"
    local numa_enabled="${2:-true}"
    
    echo "Configuring BIOS for database server: $idrac_ip"
    
    # Set custom performance profile
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.SysProfileSettings.SysProfile Custom
    
    # CPU optimization for databases
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.ProcSettings.LogicalProc Enabled
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.ProcSettings.ProcTurboMode Enabled
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.ProcSettings.ProcCStates Disabled
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.ProcSettings.ProcC1E Disabled
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.ProcSettings.ProcPwrPerf MaxPerf
    
    # Memory optimization
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.MemSettings.MemOpMode OptimizerMode
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.MemSettings.MemPatrolScrub Disabled
    
    # NUMA configuration
    if [[ "$numa_enabled" == "true" ]]; then
        racadm -r "$idrac_ip" -u root -p calvin set BIOS.MemSettings.NodeInterleave Disabled
        racadm -r "$idrac_ip" -u root -p calvin set BIOS.ProcSettings.ProcX2Apic Enabled
    else
        racadm -r "$idrac_ip" -u root -p calvin set BIOS.MemSettings.NodeInterleave Enabled
    fi
    
    # I/O optimization
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.IntegratedDevices.IoatEngine Enabled
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.ProcSettings.QpiSpeed MaxDataRate
    
    # Disable unused devices
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.IntegratedDevices.InternalUsb Off
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.IntegratedDevices.EmbVideo Disabled
    
    # Apply configuration
    create_and_apply_job "$idrac_ip"
}
```

## GPU/AI Workload Configuration

```bash
#!/bin/bash
# Configure BIOS for GPU/AI workloads

configure_gpu_server() {
    local idrac_ip="$1"
    
    echo "Configuring BIOS for GPU/AI workloads: $idrac_ip"
    
    # Performance optimization
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.SysProfileSettings.SysProfile PerfOptimized
    
    # PCIe optimization for GPUs
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.PciSettings.MmioAbove4Gb Enabled
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.PciSettings.AspmPolicy Disabled
    
    # Enable large BAR support
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.MiscSettings.MmioSize 56TB
    
    # CPU settings for GPU workloads
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.ProcSettings.LogicalProc Enabled
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.ProcSettings.ProcTurboMode Enabled
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.ProcSettings.ProcVirtualization Disabled
    
    # Memory settings
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.MemSettings.MemOpMode OptimizerMode
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.MemSettings.NodeInterleave Disabled
    
    # Power settings for maximum performance
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.SysProfileSettings.CpuInterconnectBusSpeed MaxDataRate
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.SysProfileSettings.MemFrequency MaxPerf
    racadm -r "$idrac_ip" -u root -p calvin set BIOS.SysProfileSettings.TurboBoost Enabled
    
    # Apply configuration
    create_and_apply_job "$idrac_ip"
}
```

# [Advanced Job Queue Management](#advanced-job-queue-management)

## Job Queue Automation Framework

```bash
#!/bin/bash
# Advanced job queue management system

# Job queue manager class
manage_job_queue() {
    local action="$1"
    local idrac_ip="$2"
    shift 2
    
    case "$action" in
        "list")
            list_all_jobs "$idrac_ip"
            ;;
        "monitor")
            monitor_job_progress "$idrac_ip" "$@"
            ;;
        "cancel")
            cancel_jobs "$idrac_ip" "$@"
            ;;
        "cleanup")
            cleanup_completed_jobs "$idrac_ip"
            ;;
        "wait")
            wait_for_jobs "$idrac_ip" "$@"
            ;;
        *)
            echo "Unknown action: $action"
            return 1
            ;;
    esac
}

# List all jobs with detailed status
list_all_jobs() {
    local idrac_ip="$1"
    
    echo "Job Queue Status for $idrac_ip"
    echo "================================"
    
    # Get all jobs
    jobs=$(racadm -r "$idrac_ip" -u root -p calvin jobqueue view)
    
    # Parse and format job information
    echo "$jobs" | awk '
        /^JID_/ {
            job_id = $1
            getline
            status = $3
            getline
            message = substr($0, index($0, "=") + 1)
            getline
            percent = $3
            getline
            start_time = substr($0, index($0, "=") + 1)
            getline
            end_time = substr($0, index($0, "=") + 1)
            
            printf "%-20s %-15s %3s%% %s\n", job_id, status, percent, message
        }
    '
}

# Monitor job progress in real-time
monitor_job_progress() {
    local idrac_ip="$1"
    local job_id="$2"
    local update_interval="${3:-5}"
    
    echo "Monitoring job: $job_id"
    echo "Press Ctrl+C to stop monitoring"
    echo ""
    
    while true; do
        # Clear screen for update
        clear
        
        # Get job details
        job_info=$(racadm -r "$idrac_ip" -u root -p calvin jobqueue view -i "$job_id")
        
        # Display formatted information
        echo "Job Monitor - $(date)"
        echo "=================="
        echo "$job_info" | grep -E "(Job ID|Name|Status|Message|Percent|Start Time|End Time)"
        
        # Check if job is complete
        if echo "$job_info" | grep -q "Status=Completed\|Status=Failed"; then
            echo ""
            echo "Job has finished!"
            break
        fi
        
        sleep "$update_interval"
    done
}

# Wait for multiple jobs to complete
wait_for_jobs() {
    local idrac_ip="$1"
    shift
    local job_ids=("$@")
    local all_complete=false
    local timeout=3600  # 1 hour
    local elapsed=0
    
    echo "Waiting for jobs to complete: ${job_ids[*]}"
    
    while [[ "$all_complete" == false ]] && [[ $elapsed -lt $timeout ]]; do
        all_complete=true
        
        for job_id in "${job_ids[@]}"; do
            status=$(racadm -r "$idrac_ip" -u root -p calvin jobqueue view -i "$job_id" | grep -oP 'Status=\K[^\s]+')
            
            case "$status" in
                "Completed")
                    echo "✓ $job_id: Completed"
                    ;;
                "Failed"|"Aborted")
                    echo "✗ $job_id: $status"
                    ;;
                *)
                    echo "⋯ $job_id: $status"
                    all_complete=false
                    ;;
            esac
        done
        
        if [[ "$all_complete" == false ]]; then
            sleep 10
            elapsed=$((elapsed + 10))
            echo ""
        fi
    done
    
    if [[ $elapsed -ge $timeout ]]; then
        echo "Timeout waiting for jobs to complete"
        return 1
    fi
}

# Cancel pending or running jobs
cancel_jobs() {
    local idrac_ip="$1"
    shift
    local job_ids=("$@")
    
    for job_id in "${job_ids[@]}"; do
        echo "Cancelling job: $job_id"
        
        result=$(racadm -r "$idrac_ip" -u root -p calvin jobqueue delete -i "$job_id" 2>&1)
        
        if echo "$result" | grep -q "Successfully"; then
            echo "✓ Successfully cancelled $job_id"
        else
            echo "✗ Failed to cancel $job_id: $result"
        fi
    done
}

# Clean up completed jobs
cleanup_completed_jobs() {
    local idrac_ip="$1"
    local days_old="${2:-7}"
    
    echo "Cleaning up completed jobs older than $days_old days"
    
    # Get all completed jobs
    completed_jobs=$(racadm -r "$idrac_ip" -u root -p calvin jobqueue view | \
        awk '/Status=Completed/ {print prev} {prev=$1}' | grep "JID_")
    
    local count=0
    for job_id in $completed_jobs; do
        # Note: Dell doesn't allow deletion of completed jobs in most cases
        # This is mainly for demonstration
        echo "Job: $job_id (completed)"
        ((count++))
    done
    
    echo "Found $count completed jobs"
}
```

# [BIOS Settings Templates](#bios-settings-templates)

## Template Management System

```bash
#!/bin/bash
# BIOS template management system

# Template directory
TEMPLATE_DIR="/etc/racadm/bios_templates"
mkdir -p "$TEMPLATE_DIR"

# Create BIOS template
create_bios_template() {
    local template_name="$1"
    local description="$2"
    local template_file="$TEMPLATE_DIR/${template_name}.json"
    
    cat > "$template_file" << EOF
{
    "name": "$template_name",
    "description": "$description",
    "created": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "version": "1.0",
    "settings": {
        "BootSettings": {
            "BootMode": "Uefi",
            "HddSeq": "",
            "UefiBootSeq": "NIC.Integrated.1-1-1,RAID.Integrated.1-1"
        },
        "SysProfileSettings": {
            "SysProfile": "PerfOptimized",
            "CpuInterconnectBusSpeed": "MaxDataRate",
            "MemFrequency": "MaxPerf"
        },
        "ProcSettings": {
            "LogicalProc": "Enabled",
            "ProcVirtualization": "Enabled",
            "ProcTurboMode": "Enabled",
            "ProcCStates": "Disabled",
            "ProcC1E": "Disabled"
        },
        "MemSettings": {
            "MemOpMode": "OptimizerMode",
            "NodeInterleave": "Disabled",
            "MemPatrolScrub": "Standard"
        },
        "NetworkDeviceSettings": {
            "PxeDev1EnDis": "Enabled",
            "PxeDev1Protocol": "IPv4",
            "PxeDev1VlanEnDis": "Disabled"
        }
    }
}
EOF
    
    echo "Template created: $template_file"
}

# Apply template to server
apply_bios_template() {
    local idrac_ip="$1"
    local template_name="$2"
    local template_file="$TEMPLATE_DIR/${template_name}.json"
    
    if [[ ! -f "$template_file" ]]; then
        echo "Template not found: $template_name"
        return 1
    fi
    
    echo "Applying template: $template_name to $idrac_ip"
    
    # Parse JSON and apply settings
    while IFS= read -r line; do
        if [[ "$line" =~ \"([^\"]+)\":\ \"([^\"]+)\" ]]; then
            key="${BASH_REMATCH[1]}"
            value="${BASH_REMATCH[2]}"
            
            # Skip metadata fields
            if [[ "$key" =~ ^(name|description|created|version)$ ]]; then
                continue
            fi
            
            # Convert JSON path to RACADM path
            racadm_path=$(echo "$key" | sed 's/\./\n/g' | tail -1)
            
            # Apply setting
            echo "Setting $racadm_path = $value"
            racadm -r "$idrac_ip" -u root -p calvin set "BIOS.$key" "$value"
        fi
    done < "$template_file"
    
    # Create job to apply settings
    create_bios_config_job "$idrac_ip" "BIOS.Setup.1-1" "PowerCycle"
}

# List available templates
list_templates() {
    echo "Available BIOS Templates:"
    echo "========================"
    
    for template in "$TEMPLATE_DIR"/*.json; do
        if [[ -f "$template" ]]; then
            name=$(basename "$template" .json)
            description=$(grep '"description"' "$template" | cut -d'"' -f4)
            created=$(grep '"created"' "$template" | cut -d'"' -f4)
            
            echo "- $name"
            echo "  Description: $description"
            echo "  Created: $created"
            echo ""
        fi
    done
}

# Compare server settings with template
compare_with_template() {
    local idrac_ip="$1"
    local template_name="$2"
    local template_file="$TEMPLATE_DIR/${template_name}.json"
    
    echo "Comparing $idrac_ip with template: $template_name"
    echo "================================================"
    
    # Extract settings from template and compare
    # This is a simplified version - real implementation would be more complex
    
    local differences=0
    
    # Get current settings
    current_boot_mode=$(racadm -r "$idrac_ip" -u root -p calvin get BIOS.BiosBootSettings.BootMode | grep "BootMode=" | cut -d'=' -f2)
    template_boot_mode=$(grep '"BootMode"' "$template_file" | cut -d'"' -f4)
    
    if [[ "$current_boot_mode" != "$template_boot_mode" ]]; then
        echo "✗ BootMode: Current=$current_boot_mode, Template=$template_boot_mode"
        ((differences++))
    else
        echo "✓ BootMode: $current_boot_mode"
    fi
    
    # Add more comparisons...
    
    echo ""
    echo "Total differences: $differences"
}
```

# [Troubleshooting and Best Practices](#troubleshooting-and-best-practices)

## Common Issues and Solutions

### Job Creation Failures
```bash
#!/bin/bash
# Troubleshoot job creation issues

diagnose_job_failure() {
    local idrac_ip="$1"
    
    echo "Diagnosing job creation failures on $idrac_ip"
    
    # Check for pending changes
    echo "1. Checking for pending BIOS changes..."
    pending=$(racadm -r "$idrac_ip" -u root -p calvin get BIOS.BiosBootSettings | grep "Pending Value")
    
    if [[ -z "$pending" ]]; then
        echo "✗ No pending changes found. Make changes before creating job."
        return 1
    else
        echo "✓ Pending changes found:"
        echo "$pending"
    fi
    
    # Check for existing jobs
    echo -e "\n2. Checking for blocking jobs..."
    active_jobs=$(racadm -r "$idrac_ip" -u root -p calvin jobqueue view | grep -E "Status=(Running|Scheduled|New)")
    
    if [[ -n "$active_jobs" ]]; then
        echo "✗ Active jobs found that may block new job creation:"
        echo "$active_jobs"
        echo "Consider cancelling or waiting for completion."
    else
        echo "✓ No blocking jobs found"
    fi
    
    # Check system state
    echo -e "\n3. Checking system state..."
    power_state=$(racadm -r "$idrac_ip" -u root -p calvin serveraction powerstatus)
    
    echo "Power state: $power_state"
    
    # Check iDRAC readiness
    echo -e "\n4. Checking iDRAC readiness..."
    idrac_ready=$(racadm -r "$idrac_ip" -u root -p calvin getsysinfo | grep "System Model")
    
    if [[ -n "$idrac_ready" ]]; then
        echo "✓ iDRAC is responsive"
    else
        echo "✗ iDRAC may not be ready or accessible"
    fi
}

# Clear stuck jobs
clear_stuck_jobs() {
    local idrac_ip="$1"
    
    echo "Attempting to clear stuck jobs on $idrac_ip"
    
    # Reset job queue (use with caution)
    racadm -r "$idrac_ip" -u root -p calvin jobqueue delete --all
    
    # If that fails, try individual deletion
    stuck_jobs=$(racadm -r "$idrac_ip" -u root -p calvin jobqueue view | grep "JID_" | awk '{print $1}')
    
    for job in $stuck_jobs; do
        echo "Attempting to delete: $job"
        racadm -r "$idrac_ip" -u root -p calvin jobqueue delete -i "$job"
    done
}
```

### BIOS Recovery Procedures
```bash
#!/bin/bash
# BIOS recovery and safe mode procedures

recovery_mode_bios_reset() {
    local idrac_ip="$1"
    
    echo "Initiating BIOS recovery mode reset"
    echo "WARNING: This will reset BIOS to factory defaults"
    
    read -p "Are you sure? (yes/no): " confirm
    
    if [[ "$confirm" != "yes" ]]; then
        echo "Aborted"
        return 1
    fi
    
    # Reset to factory defaults
    racadm -r "$idrac_ip" -u root -p calvin systemerase biosdefaults
    
    # Wait for completion
    sleep 30
    
    # Power cycle
    racadm -r "$idrac_ip" -u root -p calvin serveraction powercycle
    
    echo "BIOS reset initiated. Server will reboot with factory settings."
}
```

## Best Practices Summary

### Pre-Change Checklist
1. **Backup Current Settings**: Always export current configuration
2. **Verify Compatibility**: Check BIOS version and server model
3. **Plan Maintenance Window**: BIOS changes require reboot
4. **Test in Lab**: Validate changes on non-production systems
5. **Document Changes**: Maintain change log for audit trail

### Change Management Process
```bash
#!/bin/bash
# BIOS change management workflow

bios_change_workflow() {
    local idrac_ip="$1"
    local change_ticket="$2"
    local approver="$3"
    
    echo "BIOS Change Management Workflow"
    echo "=============================="
    echo "Server: $idrac_ip"
    echo "Change Ticket: $change_ticket"
    echo "Approver: $approver"
    echo "Date: $(date)"
    
    # Step 1: Pre-change backup
    echo -e "\n[Step 1] Creating pre-change backup..."
    backup_file="bios_backup_${idrac_ip}_${change_ticket}_pre.xml"
    racadm -r "$idrac_ip" -u root -p calvin get -t xml -f "$backup_file"
    
    # Step 2: Apply changes
    echo -e "\n[Step 2] Applying BIOS changes..."
    # Apply specific changes here
    
    # Step 3: Create job
    echo -e "\n[Step 3] Creating configuration job..."
    job_id=$(racadm -r "$idrac_ip" -u root -p calvin jobqueue create BIOS.Setup.1-1 | grep -oP 'JID_\d+')
    
    # Step 4: Document
    echo -e "\n[Step 4] Documenting change..."
    cat >> "bios_changes_log.txt" << EOF
Date: $(date)
Server: $idrac_ip
Change Ticket: $change_ticket
Approver: $approver
Job ID: $job_id
Pre-change Backup: $backup_file
Changes Applied: [List specific changes]
---
EOF
    
    # Step 5: Schedule reboot
    echo -e "\n[Step 5] Ready to reboot"
    echo "Execute: racadm -r $idrac_ip -u root -p calvin serveraction powercycle"
    echo "To apply changes with job: $job_id"
}
```

This comprehensive RACADM BIOS configuration guide provides enterprise-grade automation capabilities for Dell PowerEdge server management, enabling efficient deployment and maintenance of server configurations at scale.