---
title: "Re-adding Failed Drives in mdadm: A Complete Recovery Guide"
date: 2025-10-15T09:00:00-06:00
draft: false
tags: ["Linux", "RAID", "mdadm", "Storage", "System Administration", "Data Recovery"]
categories:
- Linux Administration
- Storage
- Data Recovery
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to safely re-add failed drives to your mdadm RAID array. A comprehensive guide to recovery procedures, testing, and best practices for Linux software RAID management."
more_link: "yes"
url: "/readding-failed-drive-mdadm/"
---

Master the process of recovering and re-adding failed drives to your mdadm RAID array while ensuring data integrity and optimal performance.

<!--more-->

# Re-adding Failed Drives in mdadm

## Understanding RAID Failures

When a drive fails in an mdadm RAID array:
- Array enters degraded mode
- Hot spare may be activated
- Performance may be impacted
- Data redundancy is reduced

## Initial Assessment

### 1. Check Array Status

```bash
# View array status
mdadm --detail /dev/md0

# Check drive status
cat /proc/mdstat

# View detailed drive information
smartctl -a /dev/sda
```

### 2. Identify Failed Drive

```bash
# List all drives in array
mdadm --examine /dev/sd[a-z]

# Check specific drive
mdadm --examine /dev/sdb1
```

## Recovery Process

### 1. Testing Failed Drive

```bash
# Check for bad blocks
badblocks -v /dev/sdb > badblocks.txt

# Run SMART tests
smartctl -t long /dev/sdb
smartctl -l selftest /dev/sdb

# Check drive health
smartctl -H /dev/sdb
```

### 2. Re-adding the Drive

```bash
# Mark drive as failed (if needed)
mdadm /dev/md0 -f /dev/sdb1

# Remove the failed drive
mdadm /dev/md0 -r /dev/sdb1

# Add the drive back
mdadm /dev/md0 -a /dev/sdb1
```

### 3. Monitor Rebuild Process

```bash
# Watch rebuild progress
watch cat /proc/mdstat

# Check detailed status
mdadm --detail /dev/md0
```

## Advanced Recovery Scenarios

### 1. Forced Assembly

```bash
# Force array assembly
mdadm --assemble --force /dev/md0 /dev/sd[b-e]1

# Run array check after force
mdadm --detail --scan >> /etc/mdadm/mdadm.conf
mdadm --assemble --scan
```

### 2. Partial Array Recovery

```bash
# Start array with missing drive
mdadm --run /dev/md0

# Add replacement drive
mdadm --add /dev/md0 /dev/sdb1
```

## Performance Optimization

### 1. Rebuild Speed Control

```bash
# View current speed
cat /proc/sys/dev/raid/speed_limit_min
cat /proc/sys/dev/raid/speed_limit_max

# Adjust rebuild speed
echo 50000 > /proc/sys/dev/raid/speed_limit_min
echo 100000 > /proc/sys/dev/raid/speed_limit_max
```

### 2. Stripe Cache Size

```bash
# Check current cache size
cat /sys/block/md0/md/stripe_cache_size

# Optimize cache size
echo 8192 > /sys/block/md0/md/stripe_cache_size
```

## Preventive Maintenance

### 1. Regular Health Checks

```bash
#!/bin/bash
# raid-health-check.sh

check_raid() {
    local array=$1
    
    # Check array status
    status=$(mdadm --detail $array | grep "State" | awk '{print $3}')
    
    if [ "$status" != "clean" ]; then
        echo "Warning: Array $array is in $status state"
        mdadm --detail $array
    fi
    
    # Check individual drives
    mdadm --detail $array | grep "active" | while read line; do
        drive=$(echo $line | awk '{print $7}')
        smart_status=$(smartctl -H $drive | grep "overall-health" | awk '{print $6}')
        
        if [ "$smart_status" != "PASSED" ]; then
            echo "Warning: Drive $drive failed SMART check"
        fi
    done
}

# Check all arrays
for md in /dev/md*; do
    check_raid $md
done
```

### 2. Automated Monitoring

```bash
# /etc/monit/conf.d/raid-monitor
check program raid-status with path "/usr/local/bin/raid-health-check.sh"
    if status != 0 then alert
```

## Best Practices

### 1. Documentation

```bash
#!/bin/bash
# document-raid.sh

echo "RAID Configuration Documentation" > raid-doc.txt
echo "Generated on $(date)" >> raid-doc.txt
echo "------------------------" >> raid-doc.txt

# Document array configuration
mdadm --detail --scan >> raid-doc.txt

# Document drive details
for drive in $(ls /dev/sd[a-z]); do
    echo -e "\nDrive: $drive" >> raid-doc.txt
    smartctl -i $drive >> raid-doc.txt
done
```

### 2. Backup Strategy

```bash
# Backup array configuration
cp /etc/mdadm/mdadm.conf /etc/mdadm/mdadm.conf.backup

# Save array details
mdadm --detail /dev/md0 > array_details.txt
mdadm --examine /dev/sd[a-z]1 > drive_details.txt
```

## Troubleshooting Guide

### 1. Common Issues

```bash
# Check system logs
journalctl -f | grep md0

# View detailed errors
dmesg | grep raid

# Check drive errors
smartctl -l error /dev/sdb
```

### 2. Recovery Verification

```bash
# Check array consistency
echo check > /sys/block/md0/md/sync_action

# Monitor check progress
watch cat /proc/mdstat

# Verify data integrity
md5sum -c checksum.txt
```

Remember to always maintain backups and document your RAID configuration. Regular monitoring and proactive maintenance can help prevent drive failures and ensure quick recovery when issues occur.
