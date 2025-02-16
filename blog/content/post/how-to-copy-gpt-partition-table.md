---
title: "How to Copy GPT Partition Table Between Disks"
date: 2025-02-16T01:30:00-05:00
draft: false
tags: ["GPT", "Partitioning", "Linux", "RAID"]
categories:
- Storage
- Linux
- Disk Management
author: "Matthew Mattox - mmattox@support.tools"
description: "A quick guide on copying a GPT partition table between disks when setting up RAID or disk cloning."
more_link: "yes"
url: "/how-to-copy-gpt-partition-table/"
---

## Why Copy GPT Partition Tables?
When configuring **RAID** or setting up identical disks, it's essential to have the **same partition tables** across all disks. While `sfdisk` worked well for **MBR (msdos) partition tables**, it does **not** support **GPT**. Fortunately, we can achieve this using `sgdisk`.

## Prerequisites and Safety Checks

### Backup Your Data
🔴 **WARNING**: Always backup important data before manipulating partition tables!
```bash
# Create a backup of the partition table
sudo sgdisk --backup=disk1_backup.gpt /dev/sd_src

# Optional: Create full disk image
sudo dd if=/dev/sd_src of=disk1_full_backup.img bs=4M status=progress
```

### Verify Disk Identification
```bash
# List all disks with their identifiers
lsblk -o NAME,SIZE,MODEL,SERIAL

# Show detailed disk information
sudo fdisk -l
```

## Install `gdisk`
Install `gdisk` based on your distribution:

### Ubuntu/Debian:
```bash
sudo apt-get install -y gdisk
```

### RHEL/CentOS/Fedora:
```bash
sudo dnf install -y gdisk
```

### Arch Linux:
```bash
sudo pacman -S gptfdisk
```

## Copy GPT Partition Table

### Basic Copy Operation
```bash
# Copy partition table
sudo sgdisk -R /dev/sd_dest /dev/sd_src

# Verify the operation succeeded
echo $?
```

### Advanced Copy Options
```bash
# Copy with progress information
sudo sgdisk --display-alignment -R /dev/sd_dest /dev/sd_src

# Copy and preserve original UUIDs (use with caution)
sudo sgdisk --backup=original.gpt /dev/sd_src
sudo sgdisk --load-backup=original.gpt /dev/sd_dest
```

### Explanation:
- `-R /dev/sd_dest /dev/sd_src` → Copies the partition table from **source disk** to **destination disk**
- `--display-alignment` → Shows alignment information during copy
- `--backup` → Creates a backup of the partition table
- `--load-backup` → Restores a partition table from backup

## Update UUIDs for Unique Identification

### Randomize UUIDs
```bash
# Generate new UUIDs
sudo sgdisk -G /dev/sd_dest

# Verify unique UUIDs
sudo blkid /dev/sd_src*
sudo blkid /dev/sd_dest*
```

### Why is this necessary?
- Prevents **duplicate partition** detection
- Avoids **boot failures** and system confusion
- Essential for **RAID** and **multi-disk** setups
- Prevents **mount conflicts** in fstab

## Verification Steps

### Check Partition Table
```bash
# Compare partition tables
sudo sgdisk -p /dev/sd_src
sudo sgdisk -p /dev/sd_dest

# Verify alignment
sudo sgdisk --verify /dev/sd_dest
```

### Validate Partitions
```bash
# List all partitions
sudo fdisk -l /dev/sd_dest

# Check partition details
sudo parted /dev/sd_dest print
```

## Troubleshooting

### Common Issues and Solutions

1. **Disk Busy Error**
   ```bash
   # Unmount all partitions
   sudo umount /dev/sd_dest*
   
   # Stop any RAID arrays
   sudo mdadm --stop /dev/md*
   ```

2. **Invalid GPT Error**
   ```bash
   # Fix GPT errors
   sudo sgdisk --verify /dev/sd_dest
   sudo sgdisk --rebuild-gpt /dev/sd_dest
   ```

3. **UUID Conflicts**
   ```bash
   # Force UUID regeneration
   sudo sgdisk --randomize-guids /dev/sd_dest
   ```

## Real-World Examples

### Setting up Software RAID
```bash
# Copy partition table to all RAID disks
for disk in /dev/sd[b-e]; do
    sudo sgdisk -R $disk /dev/sda
    sudo sgdisk -G $disk
done
```

### Preparing for Disk Migration
```bash
# Copy and preserve alignment
sudo sgdisk --display-alignment -R /dev/newdisk /dev/olddisk
sudo sgdisk -G /dev/newdisk
```

## Recovery Procedures

### Restore from Backup
```bash
# Restore partition table from backup
sudo sgdisk --load-backup=disk1_backup.gpt /dev/sd_dest

# Verify restoration
sudo sgdisk -p /dev/sd_dest
```

### Emergency Recovery
```bash
# Attempt to recover damaged GPT
sudo sgdisk --rebuild-gpt /dev/sd_dest

# Create new protective MBR
sudo sgdisk --gpttombr /dev/sd_dest
```

## Conclusion
Using `sgdisk`, you can reliably clone **GPT partition tables** between disks, ensuring consistency in **RAID setups** and **disk cloning operations**. This method provides robust support for **modern GPT-based partitions** with built-in safety features and verification options.

### Best Practices
1. **Always backup** before partition operations
2. **Verify disk identifiers** carefully
3. **Check UUIDs** after copying
4. **Test mount points** after completion
5. **Keep backup files** until verification is complete
