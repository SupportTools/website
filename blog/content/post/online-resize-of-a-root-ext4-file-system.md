---
title: "Resize a Root ext4 Partition Online Without Reboot"
date: 2022-07-14T14:05:00-05:00
lastmod: 2026-10-23
draft: false
tags: ["Ubuntu", "Linux", "ext4", "resize"]
categories:
- Ubuntu
- Linux
author: "Matthew Mattox - mmattox@support.tools"
description: "Grow a mounted root ext4 file system after enlarging the disk: rescan, extend the partition with growpart or parted, then run resize2fs. No reboot."
more_link: "yes"
quick_fix: |
  After enlarging the virtual disk, rescan it, grow the partition and grow the file system while it stays mounted:
  `echo 1 > /sys/class/block/sda/device/rescan`, then `growpart /dev/sda 3` (or `parted /dev/sda resizepart 3 100%`), then `resize2fs /dev/sda3`.
  ext4 can only grow online; shrinking requires unmounting.
---

The following is a guide to resizing your root ext4 file system online. After the operation, your partition will have more free space. There will be no shrinkage of the root file system. The root partition could have been any partition, not exactly the root one, but in most cases, such operations on the root are more complex and dangerous, so ALWAYS back up (or snapshot the VM) before performing such operations!

During the resize operation, none of the services need to be shut down, rebooted, or unmounted.

Even so, we rebooted the server once as a precaution, since it was possible and the server was not in production. Rebooting the server after this kind of resizing is not necessary.
The method was tested on Ubuntu 22.04 with kernel 5.15 on a VMware virtual disk. Any distribution with a recent kernel, parted (or growpart) and e2fsprogs works the same way.

Summary:
- Make the kernel see the larger disk (rescan the SCSI device).
- Grow the partition with `growpart` (package `cloud-guest-utils` on Debian and Ubuntu, `cloud-utils-growpart` on RHEL) or with `resizepart` in `parted`.
- Grow the file system using `resize2fs` from [E2fsprogs](https://git.kernel.org/pub/scm/fs/ext2/e2fsprogs.git). There is a version of this package included in most Linux distributions with the same name.

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

We now need to tell the OS to scan the disk for changes. For a single SCSI or virtual disk, write to its `rescan` file:

```bash
echo 1 > /sys/class/block/sda/device/rescan
```

To rescan every disk, I use a script I created called [DiskScan](https://github.com/mattmattox/DiskScan). It walks through all SCSI hosts and disks and looks for changes. Read the script before piping it to `bash`.

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
...

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

Note: `-1` is the new end of the partition, not a size. A negative value counts back from the end of the disk, so `-1` tells parted to use the remaining space. `100%` does the same thing.

If `cloud-guest-utils` is installed, `growpart` does the same in one non-interactive command and also fixes the backup GPT header:

```bash
growpart /dev/sda 3
```

Note the space: `growpart` takes the disk and the partition number as two arguments.

## Resize the file system
At this point, we have expanded the root partition to the new size. We can now resize the file system.

```bash
root@a1ublabl01:~# resize2fs /dev/sda3
resize2fs 1.46.5 (30-Dec-2021)
Filesystem at /dev/sda3 is mounted on /; on-line resizing required
old_desc_blocks = 2, new_desc_blocks = 13
The filesystem on /dev/sda3 is now 51428620 (4k) blocks long.
```

Confirm the new size with `df -h /`.

## Optional: force a filesystem check on next reboot
A check is not required after an online grow. If you want one anyway, note that `touch /forcefsck` is a SysV init convention that systemd-based releases such as Ubuntu 22.04 do not document. On systemd, add `fsck.mode=force` to the kernel command line for one boot (for example by editing the entry in the GRUB menu), or set a check on next mount with `tune2fs -c 1 -C 2 /dev/sda3` (maximum mount count 1, current count 2), then run `tune2fs -c -1 /dev/sda3` after the check to turn count-based checks off again.

## FAQ

### Can I shrink a mounted ext4 file system?
No. `resize2fs` can grow a mounted ext4 file system, but shrinking requires the file system to be unmounted, which for `/` means booting from rescue media.

### My root file system is on LVM. What changes?
Grow the partition that holds the physical volume as above, then run `pvresize /dev/sda3` and `lvextend -r -l +100%FREE /dev/ubuntu-vg/ubuntu-lv`. The `-r` flag runs `resize2fs` for you. Check your volume group and logical volume names with `lvs`.

### resize2fs says "The filesystem is already N blocks long. Nothing to do!"
The partition was not grown, or the kernel still sees the old partition size. Check `lsblk /dev/sda` and, if the partition is still small, run `partprobe /dev/sda` or `partx -u /dev/sda` after resizing it.

### What about XFS?
XFS also grows online, but with `xfs_growfs /` (it takes the mount point) instead of `resize2fs`. XFS cannot be shrunk at all.

## Related Guides

- [Complete Linux LVM Management Guide](/linux-lvm-advanced-management-guide/)
- [Linux Filesystem and Partition Management Guide](/linux-filesystem-partition-management-guide/)
- [How to Copy GPT Partition Table Between Disks](/how-to-copy-gpt-partition-table/)
- [Understanding XFS Inodes](/understanding-xfs-inodes/)
