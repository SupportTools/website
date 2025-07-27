---
title: "Online resize of a root ext4 file system"
date: 2022-07-14T14:05:00-05:00
draft: false
tags: ["Ubuntu", "Linux", "ext4", "resize"]
categories:
- Ubuntu
- Linux
author: "Matthew Mattox - mmattox@support.tools"
description: "Online resize of a root ext4 file system"
more_link: "yes"
---

The following is a guide to resizing your root ext4 file system online. After the operation, your partition will have more free space. There will be no shrinkage of the root file system. The root partition could have been any partition, not exactly the root one, but in most cases, such operations on the root are more complex and dangerous - ALWAYS back up before performing such operations!

During the resize operation, none of the services need to be shut down, rebooted, or unmounted.

Even so, we rebooted the server once as a precaution, since it was possible and the server was not in production. Rebooting the server after this kind of resizing is not necessary.
Using kernel 5.15, the following method was tested on Ubuntu 22.04. As a result, we can assume that if your system is newer than ours, you won't have any problems.

Summary:
- To resize a partition, use the resizepart command in the parted command. This package is available in most Linux distributions and has the same name as the needed command "parted"
- Resize the file system using resize2fs from [E2fsprogs](https://git.kernel.org/pub/scm/fs/ext2/e2fsprogs.git). There is a version of this package included in most Linux distributions with the same name.

<!--more-->
# [Steps](#steps)

## Detect disk size change
Before we can resize the root file system, we need the OS to detect the new size of the disk.

In this case, we use the `fdisk` command to show the current disk size. Which in this case is 120GB. (I know a 120GB root file system is not a good idea, but this is a lab.)
    
```bash
root@a1ublabl01:~# fdisk -l /dev/sda
Disk /dev/sda: 120 GiB, 128849018880 bytes, 251658240 sectors
Disk model: Virtual disk    
Units: sectors of 1 * 512 = 512 bytes
Sector size (logical/physical): 512 bytes / 512 bytes
I/O size (minimum/optimal): 512 bytes / 512 bytes
Disklabel type: gpt
Disk identifier: DDC91865-B329-443D-AFFF-0898C341D65C

Device       Start       End   Sectors  Size Type
/dev/sda1     2048      4095      2048    1M BIOS boot
/dev/sda2     4096   4198399   4194304    2G Linux filesystem
/dev/sda3  4198400 251656191 247457792  118G Linux filesystem
root@a1ublabl01:~#
```

We now need to tell the OS to scan all the disks for changes. We do this by running a script I created called [DiskScan](https://github.com/mattmattox/DiskScan). This script walks through all the disks and looks for changes.

One-liner:
```bash
curl https://raw.githubusercontent.com/mattmattox/DiskScan/master/rescan_disks.sh | bash
```

Output:
```bash
root@a1ublabl01:~# curl https://raw.githubusercontent.com/mattmattox/DiskScan/master/rescan_disks.sh | bash
  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current
                                 Dload  Upload   Total   Spent    Left  Speed
100   363  100   363    0     0   1553      0 --:--:-- --:--:-- --:--:--  1551
Scan for new disk(s)...
host0
host1
host10
host11
host12
host13
host14
host15
host16
host17
host18
host19
host2
host20
host21
host22
host23
host24
host25
host26
host27
host28
host29
host3
host30
host31
host32
host4
host5
host6
host7
host8
host9

Scan for disk size change...
sda
root@a1ublabl01:~# 
```

We can now see that the disk size has changed. Note, we can ignore the GPT error as we'll be fixing it as part of the next step.

```bash
root@a1ublabl01:~# fdisk -l /dev/sda
GPT PMBR size mismatch (251658239 != 419430399) will be corrected by write.
The backup GPT table is not on the end of the device.
Disk /dev/sda: 200 GiB, 214748364800 bytes, 419430400 sectors
Disk model: Virtual disk    
Units: sectors of 1 * 512 = 512 bytes
Sector size (logical/physical): 512 bytes / 512 bytes
I/O size (minimum/optimal): 512 bytes / 512 bytes
Disklabel type: gpt
Disk identifier: DDC91865-B329-443D-AFFF-0898C341D65C

Device       Start       End   Sectors  Size Type
/dev/sda1     2048      4095      2048    1M BIOS boot
/dev/sda2     4096   4198399   4194304    2G Linux filesystem
/dev/sda3  4198400 251656191 247457792  118G Linux filesystem
root@a1ublabl01:~# 
```

## Resize the root partition
At this point, the disk has the available space we need. We can now resize the root partition.

```bash
root@a1ublabl01:~# parted /dev/sda
GNU Parted 3.4
Using /dev/sda
Welcome to GNU Parted! Type 'help' to view a list of commands.
(parted) p                                                                
Warning: Not all of the space available to /dev/sda appears to be used, you can fix the GPT to use all of the space (an extra 167772160 blocks) or continue with the current setting? 
Fix/Ignore? Fix                                                           
Model: VMware Virtual disk (scsi)
Disk /dev/sda: 215GB
Sector size (logical/physical): 512B/512B
Partition Table: gpt
Disk Flags: 

Number  Start   End     Size    File system  Name  Flags
 1      1049kB  2097kB  1049kB                     bios_grub
 2      2097kB  2150MB  2147MB  ext4
 3      2150MB  129GB   127GB

(parted) resizepart 3 -1                                                 
(parted) p                                                                
Model: VMware Virtual disk (scsi)
Disk /dev/sda: 215GB
Sector size (logical/physical): 512B/512B
Partition Table: gpt
Disk Flags: 

Number  Start   End     Size    File system  Name  Flags
 1      1049kB  2097kB  1049kB                     bios_grub
 2      2097kB  2150MB  2147MB  ext4
 3      2150MB  215GB   213GB

(parted) q                                                                
Information: You may need to update /etc/fstab.

root@a1ublabl01:~#
```

Note: The `-1` is the size of the partition. This tell parted to use the remaining space on the disk.

## Resize the file system
At this point, we have expanded the root partition to the new size. We can now resize the file system.

```bash
root@a1ublabl01:~# resize2fs /dev/sda3
resize2fs 1.46.5 (30-Dec-2021)
Filesystem at /dev/sda3 is mounted on /; on-line resizing required
old_desc_blocks = 2, new_desc_blocks = 13
The filesystem on /dev/sda3 is now 51428620 (4k) blocks long.
```

## Force a filesystem check on next reboot
At this point, we have expanded the file system to the new size. We can now force a filesystem check on the next reboot.

```bash
root@a1ublabl01:~# touch /forcefsck
```

Note: This step is optional but is recommended.