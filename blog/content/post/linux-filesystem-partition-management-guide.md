---
title: "Complete Linux Filesystem and Partition Management Guide: Advanced Storage Administration for Enterprise Environments"
date: 2025-03-25T10:00:00-05:00
draft: false
tags: ["Linux", "Filesystem", "Partitions", "Storage", "LVM", "ZFS", "Btrfs", "Enterprise", "Data Management", "ext4", "XFS"]
categories:
- Storage Management
- Linux Administration
- Enterprise Infrastructure
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Linux filesystem and partition management covering advanced resizing techniques, modern storage technologies, enterprise best practices, and automated management solutions"
more_link: "yes"
url: "/linux-filesystem-partition-management-guide/"
---

Linux filesystem and partition management represents a critical skillset for systems administrators managing enterprise storage infrastructure. This comprehensive guide covers traditional and modern storage technologies, advanced resizing techniques, enterprise-grade management practices, and automated solutions for production environments.

<!--more-->

# [Storage Architecture Fundamentals](#storage-architecture-fundamentals)

## Storage Stack Overview

Modern Linux storage systems operate through multiple abstraction layers, each providing specific functionality and management capabilities.

```
┌─────────────────┐
│   Applications  │
├─────────────────┤
│   Filesystems   │ (ext4, XFS, Btrfs, ZFS)
├─────────────────┤
│ Volume Managers │ (LVM, ZFS, Btrfs)
├─────────────────┤
│   Partitions    │ (GPT, MBR)
├─────────────────┤
│ Block Devices   │ (SATA, NVMe, SCSI)
├─────────────────┤
│   Hardware      │ (HDD, SSD, NVMe)
└─────────────────┘
```

### Storage Technology Comparison

| Technology | Use Case | Pros | Cons | Enterprise Suitability |
|------------|----------|------|------|----------------------|
| **Traditional Partitions** | Simple setups | Direct, fast | Limited flexibility | Basic environments |
| **LVM** | Dynamic storage | Flexible, snapshots | Complexity overhead | Standard enterprise |
| **ZFS** | Data integrity | Built-in RAID, compression | Memory intensive | High-end enterprise |
| **Btrfs** | Modern features | Copy-on-write, snapshots | Still maturing | Selective use cases |

# [Advanced Partition Management](#advanced-partition-management)

## Comprehensive Disk Analysis and Preparation

### Enterprise Disk Discovery Script

```bash
#!/bin/bash
# Comprehensive disk and partition analysis tool

set -euo pipefail

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging
LOG_FILE="/var/log/disk-analysis.log"

log_message() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" | tee -a "$LOG_FILE"
}

print_header() {
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}========================================${NC}"
}

print_warning() {
    echo -e "${YELLOW}WARNING: $1${NC}"
}

print_error() {
    echo -e "${RED}ERROR: $1${NC}"
}

print_success() {
    echo -e "${GREEN}SUCCESS: $1${NC}"
}

# Comprehensive disk information gathering
analyze_storage_environment() {
    print_header "COMPREHENSIVE STORAGE ANALYSIS"
    
    # System information
    echo -e "\n${BLUE}System Information:${NC}"
    echo "Hostname: $(hostname)"
    echo "Kernel: $(uname -r)"
    echo "Architecture: $(uname -m)"
    echo "Uptime: $(uptime -p)"
    
    # Block device overview
    print_header "BLOCK DEVICE OVERVIEW"
    lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,UUID,LABEL
    
    # Detailed disk information
    print_header "DETAILED DISK INFORMATION"
    for disk in /dev/sd[a-z] /dev/nvme[0-9]n[0-9] /dev/vd[a-z]; do
        if [[ -b "$disk" ]]; then
            echo -e "\n${BLUE}Disk: $disk${NC}"
            
            # Basic disk info
            if command -v smartctl >/dev/null 2>&1; then
                smartctl -i "$disk" 2>/dev/null | grep -E "(Model|Serial|Capacity|Rotation|Form Factor)" || true
            fi
            
            # Partition table type
            parted "$disk" print 2>/dev/null | head -10 || fdisk -l "$disk" 2>/dev/null | head -10
            
            # I/O statistics
            if [[ -f "/sys/block/$(basename "$disk")/stat" ]]; then
                echo "I/O Statistics: $(cat "/sys/block/$(basename "$disk")/stat")"
            fi
        fi
    done
    
    # Filesystem information
    print_header "FILESYSTEM INFORMATION"
    df -hT
    
    # Mount information
    print_header "MOUNT INFORMATION"
    mount | column -t
    
    # LVM information (if available)
    if command -v pvs >/dev/null 2>&1; then
        print_header "LVM INFORMATION"
        echo -e "\n${BLUE}Physical Volumes:${NC}"
        pvs 2>/dev/null || echo "No LVM physical volumes found"
        
        echo -e "\n${BLUE}Volume Groups:${NC}"
        vgs 2>/dev/null || echo "No LVM volume groups found"
        
        echo -e "\n${BLUE}Logical Volumes:${NC}"
        lvs 2>/dev/null || echo "No LVM logical volumes found"
    fi
    
    # ZFS information (if available)
    if command -v zpool >/dev/null 2>&1; then
        print_header "ZFS INFORMATION"
        echo -e "\n${BLUE}ZFS Pools:${NC}"
        zpool list 2>/dev/null || echo "No ZFS pools found"
        
        echo -e "\n${BLUE}ZFS Filesystems:${NC}"
        zfs list 2>/dev/null || echo "No ZFS filesystems found"
    fi
    
    # RAID information
    if [[ -f /proc/mdstat ]]; then
        print_header "SOFTWARE RAID INFORMATION"
        cat /proc/mdstat
    fi
    
    # Free space analysis
    print_header "FREE SPACE ANALYSIS"
    for disk in /dev/sd[a-z] /dev/nvme[0-9]n[0-9] /dev/vd[a-z]; do
        if [[ -b "$disk" ]]; then
            echo -e "\n${BLUE}Free space on $disk:${NC}"
            parted "$disk" print free 2>/dev/null | grep -i free || echo "No free space information available"
        fi
    done
}

# Safety checks before partition operations
perform_safety_checks() {
    local device="$1"
    local operation="$2"
    
    print_header "SAFETY CHECKS FOR $device"
    
    # Check if device exists
    if [[ ! -b "$device" ]]; then
        print_error "Device $device does not exist"
        return 1
    fi
    
    # Check if device is mounted
    if mount | grep -q "$device"; then
        print_warning "Device $device or its partitions are currently mounted"
        mount | grep "$device"
    fi
    
    # Check if device is part of LVM
    if command -v pvs >/dev/null 2>&1; then
        if pvs 2>/dev/null | grep -q "$device"; then
            print_warning "Device $device is part of LVM configuration"
            pvs | grep "$device"
        fi
    fi
    
    # Check if device is part of RAID
    if [[ -f /proc/mdstat ]] && grep -q "$(basename "$device")" /proc/mdstat; then
        print_warning "Device $device is part of software RAID"
        grep "$(basename "$device")" /proc/mdstat
    fi
    
    # Check for swap partitions
    if swapon --show=NAME | grep -q "$device"; then
        print_warning "Device $device contains active swap partition"
        swapon --show | grep "$device"
    fi
    
    # Backup partition table
    backup_partition_table "$device"
    
    print_success "Safety checks completed for $device"
}

# Backup partition table
backup_partition_table() {
    local device="$1"
    local backup_dir="/var/backups/partition-tables"
    local timestamp=$(date +%Y%m%d_%H%M%S)
    
    mkdir -p "$backup_dir"
    
    # Backup with sfdisk (for all partition types)
    sfdisk -d "$device" > "$backup_dir/$(basename "$device")_${timestamp}.sfdisk" 2>/dev/null
    
    # Backup with dd (first few sectors)
    dd if="$device" of="$backup_dir/$(basename "$device")_${timestamp}.mbr" bs=512 count=1 2>/dev/null
    
    log_message "Partition table backup created for $device in $backup_dir"
}

# Execute analysis
case "${1:-analyze}" in
    "analyze")
        analyze_storage_environment
        ;;
    "safety-check")
        if [[ -z "${2:-}" ]]; then
            print_error "Usage: $0 safety-check <device>"
            exit 1
        fi
        perform_safety_checks "$2" "${3:-resize}"
        ;;
    "backup-partition-table")
        if [[ -z "${2:-}" ]]; then
            print_error "Usage: $0 backup-partition-table <device>"
            exit 1
        fi
        backup_partition_table "$2"
        ;;
    *)
        echo "Usage: $0 {analyze|safety-check|backup-partition-table}"
        echo ""
        echo "Commands:"
        echo "  analyze                    - Comprehensive storage analysis"
        echo "  safety-check <device>      - Perform safety checks on device"
        echo "  backup-partition-table <device> - Backup partition table"
        ;;
esac
```

## Advanced Partition Resizing Framework

### Intelligent Partition Resizing Tool

```python
#!/usr/bin/env python3
"""
Enterprise Partition and Filesystem Management Tool
"""

import subprocess
import json
import logging
import time
from pathlib import Path
from dataclasses import dataclass
from typing import List, Dict, Optional, Tuple
from enum import Enum

class FilesystemType(Enum):
    EXT4 = "ext4"
    EXT3 = "ext3"
    EXT2 = "ext2"
    XFS = "xfs"
    BTRFS = "btrfs"
    ZFS = "zfs"
    NTFS = "ntfs"
    FAT32 = "vfat"

class OperationType(Enum):
    EXPAND = "expand"
    SHRINK = "shrink"
    CREATE = "create"
    DELETE = "delete"

@dataclass
class PartitionInfo:
    device: str
    partition_number: int
    start_sector: int
    end_sector: int
    size_bytes: int
    filesystem_type: Optional[FilesystemType]
    mount_point: Optional[str]
    label: Optional[str]
    uuid: Optional[str]

@dataclass
class ResizeOperation:
    device: str
    partition_number: int
    new_size: str
    operation_type: OperationType
    filesystem_type: FilesystemType
    mount_point: Optional[str]

class PartitionManager:
    def __init__(self, dry_run: bool = False):
        self.dry_run = dry_run
        self.logger = logging.getLogger(__name__)
        self.backup_dir = Path("/var/backups/partition-operations")
        self.backup_dir.mkdir(parents=True, exist_ok=True)
        
    def execute_command(self, command: List[str], timeout: int = 300) -> Tuple[bool, str, str]:
        """Execute system command with proper error handling"""
        if self.dry_run:
            self.logger.info(f"DRY RUN: Would execute: {' '.join(command)}")
            return True, "Dry run - command not executed", ""
        
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=timeout
            )
            
            success = result.returncode == 0
            return success, result.stdout, result.stderr
            
        except subprocess.TimeoutExpired:
            return False, "", f"Command timeout after {timeout} seconds"
        except Exception as e:
            return False, "", str(e)
    
    def get_device_info(self, device: str) -> Dict:
        """Get comprehensive device information"""
        info = {
            'device': device,
            'partitions': [],
            'partition_table_type': None,
            'disk_size': 0,
            'free_space': []
        }
        
        # Get partition information using parted
        success, output, error = self.execute_command(['parted', device, 'print', 'free'])
        
        if not success:
            raise RuntimeError(f"Failed to get device info for {device}: {error}")
        
        lines = output.split('\n')
        in_partition_section = False
        
        for line in lines:
            line = line.strip()
            
            if 'Partition Table:' in line:
                info['partition_table_type'] = line.split(':')[1].strip()
            elif 'Disk ' in line and device in line:
                # Extract disk size
                parts = line.split()
                for part in parts:
                    if 'B' in part and part != 'Disk':
                        info['disk_size'] = part
            elif line.startswith('Number'):
                in_partition_section = True
                continue
            elif in_partition_section and line:
                parts = line.split()
                if len(parts) >= 4:
                    try:
                        partition_info = {
                            'number': int(parts[0]),
                            'start': parts[1],
                            'end': parts[2],
                            'size': parts[3],
                            'filesystem': parts[4] if len(parts) > 4 else None
                        }
                        
                        if 'Free Space' in line:
                            info['free_space'].append(partition_info)
                        else:
                            info['partitions'].append(partition_info)
                    except (ValueError, IndexError):
                        continue
        
        return info
    
    def get_filesystem_info(self, partition: str) -> Dict:
        """Get detailed filesystem information"""
        info = {
            'filesystem_type': None,
            'mount_point': None,
            'uuid': None,
            'label': None,
            'used_space': None,
            'available_space': None,
            'total_space': None
        }
        
        # Get filesystem type
        success, output, error = self.execute_command(['blkid', partition])
        if success:
            for line in output.split('\n'):
                if partition in line:
                    # Parse blkid output
                    if 'TYPE=' in line:
                        fs_type = line.split('TYPE=')[1].split()[0].strip('"')
                        try:
                            info['filesystem_type'] = FilesystemType(fs_type)
                        except ValueError:
                            info['filesystem_type'] = fs_type
                    
                    if 'UUID=' in line:
                        info['uuid'] = line.split('UUID=')[1].split()[0].strip('"')
                    
                    if 'LABEL=' in line:
                        info['label'] = line.split('LABEL=')[1].split()[0].strip('"')
        
        # Get mount information
        success, output, error = self.execute_command(['findmnt', '-n', '-o', 'TARGET', partition])
        if success and output.strip():
            info['mount_point'] = output.strip()
            
            # Get space usage if mounted
            success, df_output, error = self.execute_command(['df', '-h', partition])
            if success:
                lines = df_output.split('\n')
                if len(lines) > 1:
                    parts = lines[1].split()
                    if len(parts) >= 4:
                        info['total_space'] = parts[1]
                        info['used_space'] = parts[2]
                        info['available_space'] = parts[3]
        
        return info
    
    def create_backup(self, device: str, operation: str) -> str:
        """Create comprehensive backup before operation"""
        timestamp = time.strftime('%Y%m%d_%H%M%S')
        backup_prefix = f"{self.backup_dir}/{Path(device).name}_{operation}_{timestamp}"
        
        # Backup partition table with sfdisk
        self.execute_command(['sfdisk', '-d', device], timeout=60)
        
        # Backup first few MB of the disk
        dd_backup = f"{backup_prefix}.dd"
        self.execute_command([
            'dd', f'if={device}', f'of={dd_backup}', 
            'bs=1M', 'count=10'
        ], timeout=120)
        
        # Create metadata file
        metadata = {
            'timestamp': timestamp,
            'device': device,
            'operation': operation,
            'device_info': self.get_device_info(device)
        }
        
        metadata_file = f"{backup_prefix}.json"
        with open(metadata_file, 'w') as f:
            json.dump(metadata, f, indent=2, default=str)
        
        self.logger.info(f"Backup created: {backup_prefix}")
        return backup_prefix
    
    def resize_partition(self, resize_op: ResizeOperation) -> bool:
        """Resize partition using parted"""
        device = resize_op.device
        partition_num = resize_op.partition_number
        new_size = resize_op.new_size
        
        self.logger.info(f"Resizing {device}{partition_num} to {new_size}")
        
        # Create backup
        backup_prefix = self.create_backup(device, f"resize_p{partition_num}")
        
        # Unmount if necessary
        partition_device = f"{device}{partition_num}"
        fs_info = self.get_filesystem_info(partition_device)
        
        was_mounted = False
        mount_point = fs_info.get('mount_point')
        
        if mount_point:
            was_mounted = True
            self.logger.info(f"Unmounting {partition_device} from {mount_point}")
            success, output, error = self.execute_command(['umount', partition_device])
            if not success:
                self.logger.error(f"Failed to unmount {partition_device}: {error}")
                return False
        
        try:
            # Resize partition
            success, output, error = self.execute_command([
                'parted', device, 'resizepart', str(partition_num), new_size
            ])
            
            if not success:
                self.logger.error(f"Failed to resize partition: {error}")
                return False
            
            # Resize filesystem
            if resize_op.filesystem_type in [FilesystemType.EXT2, FilesystemType.EXT3, FilesystemType.EXT4]:
                success, output, error = self.execute_command(['resize2fs', partition_device])
                if not success:
                    self.logger.error(f"Failed to resize ext filesystem: {error}")
                    return False
                    
            elif resize_op.filesystem_type == FilesystemType.XFS:
                if not mount_point:
                    self.logger.error("XFS filesystem must be mounted to resize")
                    return False
                
                # Remount for XFS resize
                if was_mounted:
                    self.execute_command(['mount', partition_device, mount_point])
                
                success, output, error = self.execute_command(['xfs_growfs', mount_point])
                if not success:
                    self.logger.error(f"Failed to resize XFS filesystem: {error}")
                    return False
                    
            elif resize_op.filesystem_type == FilesystemType.BTRFS:
                if not mount_point:
                    self.logger.error("Btrfs filesystem must be mounted to resize")
                    return False
                
                # Remount for Btrfs resize
                if was_mounted:
                    self.execute_command(['mount', partition_device, mount_point])
                
                success, output, error = self.execute_command([
                    'btrfs', 'filesystem', 'resize', 'max', mount_point
                ])
                if not success:
                    self.logger.error(f"Failed to resize Btrfs filesystem: {error}")
                    return False
            
            # Remount if it was originally mounted
            if was_mounted and mount_point:
                success, output, error = self.execute_command(['mount', partition_device, mount_point])
                if not success:
                    self.logger.warning(f"Failed to remount {partition_device}: {error}")
            
            self.logger.info(f"Successfully resized {partition_device}")
            return True
            
        except Exception as e:
            self.logger.error(f"Error during resize operation: {e}")
            
            # Attempt to remount if it was originally mounted
            if was_mounted and mount_point:
                self.execute_command(['mount', partition_device, mount_point])
            
            return False
    
    def validate_resize_operation(self, resize_op: ResizeOperation) -> Tuple[bool, str]:
        """Validate resize operation before execution"""
        device = resize_op.device
        partition_num = resize_op.partition_number
        
        # Check if device exists
        if not Path(device).exists():
            return False, f"Device {device} does not exist"
        
        # Get device information
        try:
            device_info = self.get_device_info(device)
        except Exception as e:
            return False, f"Failed to get device information: {e}"
        
        # Check if partition exists
        partition_exists = any(
            p['number'] == partition_num for p in device_info['partitions']
        )
        
        if not partition_exists:
            return False, f"Partition {partition_num} does not exist on {device}"
        
        # Check for free space (for expansion)
        if resize_op.operation_type == OperationType.EXPAND:
            if not device_info['free_space']:
                return False, "No free space available for expansion"
        
        # Check filesystem support
        partition_device = f"{device}{partition_num}"
        fs_info = self.get_filesystem_info(partition_device)
        
        if resize_op.filesystem_type not in [
            FilesystemType.EXT2, FilesystemType.EXT3, FilesystemType.EXT4,
            FilesystemType.XFS, FilesystemType.BTRFS
        ]:
            return False, f"Filesystem type {resize_op.filesystem_type} not supported for resize"
        
        # Additional checks for shrinking
        if resize_op.operation_type == OperationType.SHRINK:
            return False, "Shrinking operations not implemented for safety"
        
        return True, "Validation passed"
    
    def perform_batch_operations(self, operations: List[ResizeOperation]) -> Dict[str, bool]:
        """Perform multiple resize operations"""
        results = {}
        
        for operation in operations:
            operation_id = f"{operation.device}p{operation.partition_number}"
            
            # Validate operation
            is_valid, validation_msg = self.validate_resize_operation(operation)
            
            if not is_valid:
                self.logger.error(f"Validation failed for {operation_id}: {validation_msg}")
                results[operation_id] = False
                continue
            
            # Perform operation
            try:
                success = self.resize_partition(operation)
                results[operation_id] = success
                
                if success:
                    self.logger.info(f"Successfully completed operation for {operation_id}")
                else:
                    self.logger.error(f"Failed operation for {operation_id}")
                    
            except Exception as e:
                self.logger.error(f"Exception during operation for {operation_id}: {e}")
                results[operation_id] = False
        
        return results

# Command-line interface
if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description='Enterprise Partition Management Tool')
    parser.add_argument('--device', required=True, help='Target device (e.g., /dev/sda)')
    parser.add_argument('--partition', type=int, required=True, help='Partition number')
    parser.add_argument('--size', required=True, help='New size (e.g., 100GB, 50%)')
    parser.add_argument('--filesystem', choices=['ext4', 'ext3', 'ext2', 'xfs', 'btrfs'], 
                       default='ext4', help='Filesystem type')
    parser.add_argument('--dry-run', action='store_true', help='Show what would be done')
    parser.add_argument('--verbose', action='store_true', help='Verbose logging')
    
    args = parser.parse_args()
    
    # Configure logging
    log_level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(
        level=log_level,
        format='%(asctime)s - %(levelname)s - %(message)s'
    )
    
    # Create partition manager
    manager = PartitionManager(dry_run=args.dry_run)
    
    # Create resize operation
    resize_operation = ResizeOperation(
        device=args.device,
        partition_number=args.partition,
        new_size=args.size,
        operation_type=OperationType.EXPAND,
        filesystem_type=FilesystemType(args.filesystem),
        mount_point=None
    )
    
    # Validate and execute
    is_valid, validation_msg = manager.validate_resize_operation(resize_operation)
    
    if not is_valid:
        print(f"Validation failed: {validation_msg}")
        exit(1)
    
    if args.dry_run:
        print("Dry run mode - no changes will be made")
    
    success = manager.resize_partition(resize_operation)
    
    if success:
        print("Resize operation completed successfully")
        exit(0)
    else:
        print("Resize operation failed")
        exit(1)
```

# [Modern Storage Technologies](#modern-storage-technologies)

## ZFS Management

### Enterprise ZFS Configuration

```bash
#!/bin/bash
# Enterprise ZFS management and optimization

setup_enterprise_zfs() {
    local pool_name="$1"
    local devices=("${@:2}")
    
    echo "Setting up enterprise ZFS pool: $pool_name"
    echo "Devices: ${devices[*]}"
    
    # Validate devices
    for device in "${devices[@]}"; do
        if [[ ! -b "$device" ]]; then
            echo "ERROR: Device $device is not a valid block device"
            return 1
        fi
    done
    
    # Create ZFS pool with enterprise settings
    zpool create -o ashift=12 \
                 -o autoexpand=on \
                 -O compression=lz4 \
                 -O atime=off \
                 -O recordsize=128K \
                 -O primarycache=all \
                 -O secondarycache=all \
                 -O logbias=throughput \
                 -O redundant_metadata=most \
                 "$pool_name" "${devices[@]}"
    
    # Configure performance optimizations
    zfs set sync=standard "$pool_name"
    zfs set xattr=sa "$pool_name"
    zfs set dnodesize=auto "$pool_name"
    
    # Create enterprise datasets
    zfs create -o recordsize=16K "$pool_name/databases"
    zfs create -o recordsize=1M "$pool_name/backups"
    zfs create -o recordsize=64K "$pool_name/vms"
    zfs create -o recordsize=128K "$pool_name/general"
    
    # Set up quotas and reservations
    zfs set quota=500G "$pool_name/databases"
    zfs set reservation=100G "$pool_name/databases"
    
    echo "ZFS pool $pool_name created successfully"
}

# ZFS monitoring and maintenance
zfs_health_check() {
    local pool_name="$1"
    
    echo "=== ZFS Health Check for $pool_name ==="
    
    # Pool status
    echo "Pool Status:"
    zpool status "$pool_name"
    
    # Pool utilization
    echo -e "\nPool Utilization:"
    zpool list "$pool_name"
    
    # I/O statistics
    echo -e "\nI/O Statistics:"
    zpool iostat "$pool_name" 1 1
    
    # Dataset information
    echo -e "\nDataset Information:"
    zfs list -r "$pool_name"
    
    # Check for errors
    echo -e "\nError Summary:"
    zpool status "$pool_name" | grep -E "(errors|DEGRADED|FAULTED|OFFLINE)"
    
    # ARC statistics
    echo -e "\nARC Statistics:"
    cat /proc/spl/kstat/zfs/arcstats | grep -E "^(hits|misses|size|c_max)"
}

# Automated ZFS snapshot management
zfs_snapshot_management() {
    local dataset="$1"
    local retention_days="${2:-30}"
    
    echo "Managing snapshots for $dataset"
    
    # Create daily snapshot
    local snapshot_name="${dataset}@$(date +%Y%m%d_%H%M%S)"
    zfs snapshot "$snapshot_name"
    echo "Created snapshot: $snapshot_name"
    
    # Remove old snapshots
    local cutoff_date=$(date -d "$retention_days days ago" +%Y%m%d)
    
    zfs list -H -t snapshot -o name | grep "^${dataset}@" | while read snapshot; do
        local snapshot_date=$(echo "$snapshot" | grep -o '[0-9]\{8\}')
        
        if [[ "$snapshot_date" < "$cutoff_date" ]]; then
            echo "Removing old snapshot: $snapshot"
            zfs destroy "$snapshot"
        fi
    done
}

# Usage examples
case "${1:-help}" in
    "setup")
        shift
        setup_enterprise_zfs "$@"
        ;;
    "health-check")
        zfs_health_check "$2"
        ;;
    "snapshot")
        zfs_snapshot_management "$2" "$3"
        ;;
    *)
        echo "Usage: $0 {setup|health-check|snapshot}"
        echo "Examples:"
        echo "  $0 setup tank /dev/sdb /dev/sdc /dev/sdd"
        echo "  $0 health-check tank"
        echo "  $0 snapshot tank/databases 30"
        ;;
esac
```

## Btrfs Management

### Advanced Btrfs Operations

```bash
#!/bin/bash
# Advanced Btrfs filesystem management

create_btrfs_enterprise_setup() {
    local mount_point="$1"
    local devices=("${@:2}")
    
    echo "Creating enterprise Btrfs filesystem"
    echo "Mount point: $mount_point"
    echo "Devices: ${devices[*]}"
    
    # Create Btrfs filesystem with RAID1
    mkfs.btrfs -f -d raid1 -m raid1 "${devices[@]}"
    
    # Create mount point
    mkdir -p "$mount_point"
    
    # Mount with optimized options
    mount -o compress=zstd,space_cache=v2,autodefrag "${devices[0]}" "$mount_point"
    
    # Create subvolumes for different use cases
    btrfs subvolume create "$mount_point/root"
    btrfs subvolume create "$mount_point/home"
    btrfs subvolume create "$mount_point/var"
    btrfs subvolume create "$mount_point/snapshots"
    
    # Set default subvolume
    btrfs subvolume set-default "$mount_point/root"
    
    echo "Btrfs enterprise setup completed"
}

# Btrfs maintenance and optimization
btrfs_maintenance() {
    local mount_point="$1"
    
    echo "Performing Btrfs maintenance on $mount_point"
    
    # Balance filesystem
    echo "Starting balance operation..."
    btrfs balance start -dusage=75 "$mount_point"
    
    # Scrub for data integrity
    echo "Starting scrub operation..."
    btrfs scrub start "$mount_point"
    
    # Defragment if needed
    echo "Defragmenting filesystem..."
    btrfs filesystem defragment -r -v -czstd "$mount_point"
    
    # Show filesystem usage
    echo "Filesystem usage:"
    btrfs filesystem usage "$mount_point"
    
    echo "Maintenance completed"
}

# Automated snapshot management for Btrfs
btrfs_snapshot_manager() {
    local subvolume="$1"
    local snapshot_dir="$2"
    local retention_days="${3:-7}"
    
    echo "Managing Btrfs snapshots for $subvolume"
    
    # Create snapshot directory
    mkdir -p "$snapshot_dir"
    
    # Create read-only snapshot
    local timestamp=$(date +%Y%m%d_%H%M%S)
    local snapshot_name="$snapshot_dir/snapshot_$timestamp"
    
    btrfs subvolume snapshot -r "$subvolume" "$snapshot_name"
    echo "Created snapshot: $snapshot_name"
    
    # Clean up old snapshots
    find "$snapshot_dir" -name "snapshot_*" -type d -mtime +$retention_days | while read old_snapshot; do
        echo "Removing old snapshot: $old_snapshot"
        btrfs subvolume delete "$old_snapshot"
    done
}

# Btrfs RAID management
manage_btrfs_raid() {
    local mount_point="$1"
    local operation="$2"
    local device="$3"
    
    case "$operation" in
        "add")
            echo "Adding device $device to Btrfs filesystem"
            btrfs device add "$device" "$mount_point"
            btrfs balance start -dconvert=raid1 -mconvert=raid1 "$mount_point"
            ;;
        "remove")
            echo "Removing device $device from Btrfs filesystem"
            btrfs device remove "$device" "$mount_point"
            ;;
        "replace")
            local old_device="$device"
            local new_device="$4"
            echo "Replacing device $old_device with $new_device"
            btrfs replace start "$old_device" "$new_device" "$mount_point"
            ;;
        "status")
            echo "Btrfs device status:"
            btrfs filesystem show "$mount_point"
            btrfs device stats "$mount_point"
            ;;
        *)
            echo "Usage: manage_btrfs_raid <mount_point> {add|remove|replace|status} <device> [new_device]"
            ;;
    esac
}

# Execute based on command
case "${1:-help}" in
    "setup")
        shift
        create_btrfs_enterprise_setup "$@"
        ;;
    "maintenance")
        btrfs_maintenance "$2"
        ;;
    "snapshot")
        btrfs_snapshot_manager "$2" "$3" "$4"
        ;;
    "raid")
        shift
        manage_btrfs_raid "$@"
        ;;
    *)
        echo "Usage: $0 {setup|maintenance|snapshot|raid}"
        ;;
esac
```

# [LVM Advanced Management](#lvm-advanced-management)

## Enterprise LVM Configuration

### Comprehensive LVM Management System

```python
#!/usr/bin/env python3
"""
Enterprise LVM Management and Automation System
"""

import subprocess
import json
import logging
from dataclasses import dataclass
from typing import List, Dict, Optional
from pathlib import Path

@dataclass
class LVMComponent:
    name: str
    size: str
    status: str
    attributes: str

@dataclass 
class PhysicalVolume(LVMComponent):
    device: str
    volume_group: Optional[str]
    pe_size: str
    pe_total: int
    pe_free: int

@dataclass
class VolumeGroup(LVMComponent):
    pv_count: int
    lv_count: int
    pe_size: str
    pe_total: int
    pe_free: int
    physical_volumes: List[str]

@dataclass
class LogicalVolume(LVMComponent):
    volume_group: str
    mount_point: Optional[str]
    filesystem: Optional[str]
    lv_path: str

class EnterpriseL MVManager:
    def __init__(self):
        self.logger = logging.getLogger(__name__)
        
    def execute_command(self, command: List[str]) -> tuple[bool, str, str]:
        """Execute LVM command with error handling"""
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=300
            )
            
            return result.returncode == 0, result.stdout, result.stderr
            
        except subprocess.TimeoutExpired:
            return False, "", "Command timeout"
        except Exception as e:
            return False, "", str(e)
    
    def get_physical_volumes(self) -> List[PhysicalVolume]:
        """Get all physical volumes"""
        success, output, error = self.execute_command([
            'pvs', '--noheadings', '--separator=|',
            '-o', 'pv_name,vg_name,pv_size,pv_attr,pe_size,pv_pe_count,pv_pe_alloc_count'
        ])
        
        if not success:
            raise RuntimeError(f"Failed to get PV info: {error}")
        
        pvs = []
        for line in output.strip().split('\n'):
            if line.strip():
                parts = [p.strip() for p in line.split('|')]
                if len(parts) >= 7:
                    pv = PhysicalVolume(
                        name=parts[0],
                        device=parts[0],
                        volume_group=parts[1] if parts[1] else None,
                        size=parts[2],
                        status="active",
                        attributes=parts[3],
                        pe_size=parts[4],
                        pe_total=int(parts[5]),
                        pe_free=int(parts[5]) - int(parts[6])
                    )
                    pvs.append(pv)
        
        return pvs
    
    def get_volume_groups(self) -> List[VolumeGroup]:
        """Get all volume groups"""
        success, output, error = self.execute_command([
            'vgs', '--noheadings', '--separator=|',
            '-o', 'vg_name,vg_size,vg_attr,pv_count,lv_count,vg_extent_size,vg_extent_count,vg_free_count'
        ])
        
        if not success:
            raise RuntimeError(f"Failed to get VG info: {error}")
        
        vgs = []
        for line in output.strip().split('\n'):
            if line.strip():
                parts = [p.strip() for p in line.split('|')]
                if len(parts) >= 8:
                    # Get PVs for this VG
                    pv_success, pv_output, _ = self.execute_command([
                        'pvs', '--noheadings', '-o', 'pv_name',
                        '--select', f'vg_name={parts[0]}'
                    ])
                    
                    physical_volumes = []
                    if pv_success:
                        physical_volumes = [pv.strip() for pv in pv_output.split('\n') if pv.strip()]
                    
                    vg = VolumeGroup(
                        name=parts[0],
                        size=parts[1],
                        status="active",
                        attributes=parts[2],
                        pv_count=int(parts[3]),
                        lv_count=int(parts[4]),
                        pe_size=parts[5],
                        pe_total=int(parts[6]),
                        pe_free=int(parts[7]),
                        physical_volumes=physical_volumes
                    )
                    vgs.append(vg)
        
        return vgs
    
    def get_logical_volumes(self) -> List[LogicalVolume]:
        """Get all logical volumes"""
        success, output, error = self.execute_command([
            'lvs', '--noheadings', '--separator=|',
            '-o', 'lv_name,vg_name,lv_size,lv_attr,lv_path'
        ])
        
        if not success:
            raise RuntimeError(f"Failed to get LV info: {error}")
        
        lvs = []
        for line in output.strip().split('\n'):
            if line.strip():
                parts = [p.strip() for p in line.split('|')]
                if len(parts) >= 5:
                    # Get mount and filesystem info
                    mount_point = None
                    filesystem = None
                    
                    # Check if mounted
                    mount_success, mount_output, _ = self.execute_command([
                        'findmnt', '-n', '-o', 'TARGET,FSTYPE', parts[4]
                    ])
                    
                    if mount_success and mount_output.strip():
                        mount_parts = mount_output.strip().split()
                        if len(mount_parts) >= 2:
                            mount_point = mount_parts[0]
                            filesystem = mount_parts[1]
                    
                    lv = LogicalVolume(
                        name=parts[0],
                        volume_group=parts[1],
                        size=parts[2],
                        status="active",
                        attributes=parts[3],
                        lv_path=parts[4],
                        mount_point=mount_point,
                        filesystem=filesystem
                    )
                    lvs.append(lv)
        
        return lvs
    
    def create_enterprise_setup(self, devices: List[str], vg_name: str) -> bool:
        """Create enterprise LVM setup"""
        self.logger.info(f"Creating enterprise LVM setup with devices: {devices}")
        
        try:
            # Create physical volumes
            for device in devices:
                success, output, error = self.execute_command(['pvcreate', device])
                if not success:
                    raise RuntimeError(f"Failed to create PV on {device}: {error}")
                self.logger.info(f"Created PV on {device}")
            
            # Create volume group
            success, output, error = self.execute_command(['vgcreate', vg_name] + devices)
            if not success:
                raise RuntimeError(f"Failed to create VG {vg_name}: {error}")
            self.logger.info(f"Created VG {vg_name}")
            
            # Create logical volumes for different use cases
            lv_configs = [
                ('system', '20G'),
                ('var', '10G'),
                ('tmp', '5G'),
                ('home', '30G'),
                ('data', '50%FREE')
            ]
            
            for lv_name, lv_size in lv_configs:
                success, output, error = self.execute_command([
                    'lvcreate', '-L' if lv_size.endswith('G') else '-l',
                    lv_size, '-n', lv_name, vg_name
                ])
                
                if not success:
                    self.logger.warning(f"Failed to create LV {lv_name}: {error}")
                else:
                    self.logger.info(f"Created LV {lv_name} ({lv_size})")
            
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to create enterprise setup: {e}")
            return False
    
    def extend_logical_volume(self, lv_path: str, size: str, filesystem: bool = True) -> bool:
        """Extend logical volume and filesystem"""
        self.logger.info(f"Extending {lv_path} by {size}")
        
        try:
            # Extend logical volume
            success, output, error = self.execute_command([
                'lvextend', '-L', f'+{size}', lv_path
            ])
            
            if not success:
                raise RuntimeError(f"Failed to extend LV: {error}")
            
            # Extend filesystem if requested
            if filesystem:
                # Detect filesystem type
                fs_success, fs_output, _ = self.execute_command([
                    'blkid', '-s', 'TYPE', '-o', 'value', lv_path
                ])
                
                if fs_success:
                    fs_type = fs_output.strip()
                    
                    if fs_type in ['ext2', 'ext3', 'ext4']:
                        success, output, error = self.execute_command(['resize2fs', lv_path])
                    elif fs_type == 'xfs':
                        # Get mount point for XFS
                        mount_success, mount_output, _ = self.execute_command([
                            'findmnt', '-n', '-o', 'TARGET', lv_path
                        ])
                        if mount_success:
                            mount_point = mount_output.strip()
                            success, output, error = self.execute_command(['xfs_growfs', mount_point])
                    else:
                        self.logger.warning(f"Filesystem {fs_type} resize not supported")
                        success = True
                    
                    if not success:
                        raise RuntimeError(f"Failed to extend filesystem: {error}")
            
            self.logger.info(f"Successfully extended {lv_path}")
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to extend logical volume: {e}")
            return False
    
    def create_snapshot(self, lv_path: str, snapshot_name: str, size: str = '1G') -> bool:
        """Create LVM snapshot"""
        self.logger.info(f"Creating snapshot {snapshot_name} of {lv_path}")
        
        try:
            # Extract VG name from LV path
            parts = lv_path.split('/')
            if len(parts) >= 4 and parts[1] == 'dev':
                vg_name = parts[2]
            else:
                raise ValueError(f"Invalid LV path format: {lv_path}")
            
            success, output, error = self.execute_command([
                'lvcreate', '-L', size, '-s', '-n', snapshot_name, lv_path
            ])
            
            if not success:
                raise RuntimeError(f"Failed to create snapshot: {error}")
            
            self.logger.info(f"Successfully created snapshot {snapshot_name}")
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to create snapshot: {e}")
            return False
    
    def generate_report(self) -> Dict:
        """Generate comprehensive LVM report"""
        try:
            report = {
                'timestamp': subprocess.run(['date', '-Iseconds'], 
                                          capture_output=True, text=True).stdout.strip(),
                'physical_volumes': [],
                'volume_groups': [],
                'logical_volumes': [],
                'summary': {
                    'total_pvs': 0,
                    'total_vgs': 0,
                    'total_lvs': 0,
                    'total_size': '0B',
                    'free_space': '0B'
                }
            }
            
            # Get all components
            pvs = self.get_physical_volumes()
            vgs = self.get_volume_groups()
            lvs = self.get_logical_volumes()
            
            # Convert to dict format
            report['physical_volumes'] = [
                {
                    'device': pv.device,
                    'volume_group': pv.volume_group,
                    'size': pv.size,
                    'pe_size': pv.pe_size,
                    'pe_total': pv.pe_total,
                    'pe_free': pv.pe_free
                } for pv in pvs
            ]
            
            report['volume_groups'] = [
                {
                    'name': vg.name,
                    'size': vg.size,
                    'pv_count': vg.pv_count,
                    'lv_count': vg.lv_count,
                    'pe_free': vg.pe_free,
                    'physical_volumes': vg.physical_volumes
                } for vg in vgs
            ]
            
            report['logical_volumes'] = [
                {
                    'name': lv.name,
                    'volume_group': lv.volume_group,
                    'size': lv.size,
                    'lv_path': lv.lv_path,
                    'mount_point': lv.mount_point,
                    'filesystem': lv.filesystem
                } for lv in lvs
            ]
            
            # Update summary
            report['summary']['total_pvs'] = len(pvs)
            report['summary']['total_vgs'] = len(vgs)
            report['summary']['total_lvs'] = len(lvs)
            
            return report
            
        except Exception as e:
            self.logger.error(f"Failed to generate report: {e}")
            return {'error': str(e)}

# Command-line interface
if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description='Enterprise LVM Management')
    parser.add_argument('command', choices=['report', 'setup', 'extend', 'snapshot'])
    parser.add_argument('--devices', nargs='+', help='Block devices for setup')
    parser.add_argument('--vg-name', help='Volume group name')
    parser.add_argument('--lv-path', help='Logical volume path')
    parser.add_argument('--size', help='Size for operations')
    parser.add_argument('--snapshot-name', help='Snapshot name')
    parser.add_argument('--output', help='Output file for report')
    
    args = parser.parse_args()
    
    logging.basicConfig(level=logging.INFO)
    manager = EnterpriseLVMManager()
    
    if args.command == 'report':
        report = manager.generate_report()
        if args.output:
            with open(args.output, 'w') as f:
                json.dump(report, f, indent=2)
        else:
            print(json.dumps(report, indent=2))
    
    elif args.command == 'setup':
        if not args.devices or not args.vg_name:
            print("Setup requires --devices and --vg-name")
            exit(1)
        success = manager.create_enterprise_setup(args.devices, args.vg_name)
        exit(0 if success else 1)
    
    elif args.command == 'extend':
        if not args.lv_path or not args.size:
            print("Extend requires --lv-path and --size")
            exit(1)
        success = manager.extend_logical_volume(args.lv_path, args.size)
        exit(0 if success else 1)
    
    elif args.command == 'snapshot':
        if not args.lv_path or not args.snapshot_name:
            print("Snapshot requires --lv-path and --snapshot-name")
            exit(1)
        success = manager.create_snapshot(args.lv_path, args.snapshot_name, args.size or '1G')
        exit(0 if success else 1)
```

This comprehensive guide provides enterprise-grade Linux filesystem and partition management capabilities, covering traditional tools, modern storage technologies, advanced automation frameworks, and production-ready management solutions for diverse infrastructure requirements.