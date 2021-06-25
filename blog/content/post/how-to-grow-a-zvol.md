+++
Categories = ["zfs"]
Tags = ["zfs", "zvol"]
date = "2021-06-24T23:58:00+00:00"
more_link = "yes"
title = "How to grow a zvol in ZFS"
+++

In ZFS, there are two types of filesystems (datasets and zvol). The ZFS dataset can be grown by setting the quota and reservation properties. But zvols have to extend by setting the volsize property to a new size.

<!--more-->
# [Pre-requisites](#pre-requisites)

- SSH access to the zfs server
- sudo / root permissions

# [Resolution](#resolution)

## Verify zpool has free space
`zfs list -r DiskPool0`

```
root@a1ubnasp01:~# zfs list -r DiskPool0
NAME              USED  AVAIL     REFER  MOUNTPOINT
DiskPool0         103G   881G       24K  /DiskPool0
*DiskPool0/vol01   103G   984G       12K  -*
root@a1ubnasp01:~#
```

## Get the current size
We will see "volsize" properties for volumes only, as we can't see the same for datasets.

`zfs get volsize DiskPool0/vol01`

```
root@a1ubnasp01:~# zfs get volsize DiskPool0/vol01
NAME             PROPERTY  VALUE    SOURCE
DiskPool0/vol01  volsize   100G     local
root@a1ubnasp01:~#
```

## Set new size
*NOTE: This is critical; nothing stops you from setting the new size to be smaller than the old size. Doing so will simply cut the end of the disk off and will cause data to lose.*

In this example, we are going from a 100GB to a 200GB volume.

`zfs set volsize=200GB DiskPool0/vol01`

## Verify new size
`zfs get volsize DiskPool0/vol01`

```
root@a1ubnasp01:~# zfs get volsize DiskPool0/vol01
NAME             PROPERTY  VALUE    SOURCE
DiskPool0/vol01  volsize   200G     local
root@a1ubnasp01:~#
```