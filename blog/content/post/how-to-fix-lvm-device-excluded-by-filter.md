+++
Categories = ["pi", "raspberry pi", "lvm"]
Tags = ["pi", "raspberry pi", "lvm"]
date = "2021-03-21T20:10:00+00:00"
more_link = "yes"
title = "How to fix LVM Device /dev/sdb excluded by a filter."
+++

When creating a new pv device using a previously partitioned disk, you may see the following error message.

```
pi@raspberry:~/ $ sudo pvcreate /dev/sdb
  Device /dev/sda excluded by a filter.
pi@raspberry:~/
```

<!--more-->
# [Pre-requisites](#pre-requisites)

- sudo access
- In this example, we'll be using the disk sdb but this should be replaced with your disk.

# [Resolution](#resolution)

## Confirm that you have selected the right disk.

This is a saftly measure in LVM to prevent you adding a disk that already has a partition table and filesystem.

```
sudo fdisk -l /dev/sdb
```

## If you are should that you have the correct disk, we have wipe out the old partition table using `wipefs`

```
sudo wipefs -a /dev/sdb
```

## Now you should be able to create the PV device without issue.

```
root@raspberry:~#  pvcreate /dev/sdb
  Physical volume "/dev/sdb" successfully created.
root@raspberry:~# pvdisplay
  "/dev/sda" is a new physical volume of "120 GiB"
  --- NEW Physical volume ---
  PV Name               /dev/sdb
  VG Name
  PV Size               120 GiB
  Allocatable           NO
  PE Size               0
  Total PE              0
  Free PE               0
  Allocated PE          0
  PV UUID               lxtVCs-2OLD-HXMh-HAfY-ipa4-TXBe-EIamF6

root@raspberry:~#
```
