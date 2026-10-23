---
title: "cachefilesd Setup: Cache NFS Mounts With FS-Cache (fsc)"
date: 2022-07-11T23:24:00-05:00
lastmod: 2026-10-23
draft: false
tags: ["Linux", "NFS", "cachefilesd", "FS-Cache", "Ubuntu"]
categories:
- Linux
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "Set up cachefilesd on Ubuntu: set RUN=yes, start the daemon, mount NFS with fsc, then confirm caching in /proc/fs/nfsfs/volumes and fscache stats."
more_link: "yes"
quick_fix: |
  cachefilesd only caches NFS mounts that use the `fsc` option. On Ubuntu and Debian:
  `sudo apt install cachefilesd`, then `sudo sed -i 's/^#RUN=yes/RUN=yes/' /etc/default/cachefilesd` (the daemon will not start without it), then `sudo systemctl enable --now cachefilesd`.
  Add `fsc` to the NFS mount options, unmount and mount again, and check that the FSC column in `cat /proc/fs/nfsfs/volumes` says `yes`.
---

cachefilesd is the userspace daemon for CacheFiles, the Linux kernel's disk cache backend for FS-Cache. With it running, NFS (and AFS) mounts that use the `fsc` mount option keep a copy of the data they read on local disk, so the second read of a file comes from the cache instead of the network. Setup is four steps: install the package, enable it (on Debian and Ubuntu that means `RUN=yes`), start the daemon, and remount the NFS share with `fsc`. This guide shows each step on Ubuntu 24.04 and 26.04, how to prove the cache is in use, and when it does not help.

<!--more-->

## Setup on Ubuntu 24.04 and 26.04

### 1. Install cachefilesd

```bash
sudo apt install cachefilesd
```

Ubuntu 24.04 ships cachefilesd 0.10.10-0.2ubuntu1 and Ubuntu 26.04 ships 0.10.10-0.6ubuntu1. Both install the same three files that matter: `/etc/cachefilesd.conf`, `/etc/default/cachefilesd` and the init script `/etc/init.d/cachefilesd`, which systemd runs through its SysV generator.

### 2. Set `RUN=yes`

This is the step most guides skip. On Debian and Ubuntu, `/etc/default/cachefilesd` ships with the switch commented out:

```text
# You must uncomment the run=yes line below for cachefilesd to start.
#RUN=yes
```

The init script exits early with `cachefilesd disabled, please set RUN=yes in /etc/default/cachefilesd` unless it is set, so `systemctl` can report the unit as started while no daemon is running. Uncomment it:

```bash
sudo sed -i 's/^#RUN=yes/RUN=yes/' /etc/default/cachefilesd
grep ^RUN /etc/default/cachefilesd
```

Expected output: `RUN=yes`.

Fedora, RHEL and Rocky do not have this file. Their package ships a native `cachefilesd.service` that loads the `cachefiles` module and starts the daemon directly.

### 3. Check `/etc/cachefilesd.conf`

The defaults are fine for most systems:

```text
dir /var/cache/fscache
tag mycache
brun 10%
bcull 7%
bstop 3%
frun 10%
fcull 7%
fstop 3%
```

- `dir` is the cache directory. The filesystem under it must support user extended attributes, which ext4, XFS and Btrfs do by default. CacheFiles stores its coherency data in xattrs.
- `tag` names the cache. It shows up in `/proc/fs/fscache/caches`.
- `brun`, `bcull` and `bstop` are thresholds on **free space** of the filesystem that holds `dir`, not on cache size. With the values above, the cache grows freely while more than 10% of the filesystem is free, starts discarding least recently used objects below 7% free, and stops adding data below 3% free. The `f` variants do the same for free inodes.
- The limits must satisfy `0 <= bstop < bcull < brun < 100` (and the same for `f`), or the cache will not come up.

Because the limits are relative to free space, a cache in `/var/cache/fscache` on the root filesystem will happily use almost all of it. For anything bigger than a laptop, mount a dedicated partition or logical volume at `/var/cache/fscache` so the cache cannot crowd out the rest of the system.

### 4. Start the daemon

```bash
sudo systemctl enable --now cachefilesd
pgrep -a cachefilesd
cat /proc/fs/fscache/caches
```

`pgrep` should print a running `/sbin/cachefilesd` (or `/usr/sbin/cachefilesd`) process, and `/proc/fs/fscache/caches` should list one cache with the name from `tag`. The kernel also logs the registration; `sudo dmesg | grep -i cachefiles` shows a line naming the cache.

### 5. Mount NFS with `fsc`

Add `fsc` to the mount options. A typical `/etc/fstab` line:

```text
nas1.support.tools:/mnt/DiskPool0/steam  /mnt/steam  nfs  defaults,hard,_netdev,fsc,vers=4.2  0  0
```

Then **unmount and mount** it. `mount -o remount` does not reliably switch caching on for a mount that already exists:

```bash
sudo umount /mnt/steam
sudo mount /mnt/steam
```

For a one-off test without fstab: `sudo mount -t nfs -o fsc,vers=4.2 server:/export /mnt/test`.

## Verify that the cache is used

### The mount has FSC enabled

```bash
cat /proc/fs/nfsfs/volumes
```

```text
NV SERVER   PORT DEV          FSID                              FSC
v3 c0a8450b  801 0:97         74c9544b:0                        yes
v4 c0a8450b  801 0:102        f8770b94:260e67de                 yes
```

The `FSC` column must say `yes` for every share you want cached. `no` means the mount was made without `fsc` (or before you added it); unmount and mount again. `grep fsc /proc/mounts` shows the same from the mount options side.

### Data is going into the cache

Read a large file twice and watch the counters:

```bash
cat /proc/fs/fscache/stats
cat /mnt/steam/some-large-file > /dev/null
cat /proc/fs/fscache/stats
sudo du -sh /var/cache/fscache
```

On current kernels the stats file starts with netfs counters and then an `FS-Cache statistics` block. This is the idle output on Ubuntu 26.04 (kernel 7.0):

```text
-- FS-Cache statistics --
Cookies: n=0 v=0 vcol=0 voom=0
Acquire: n=0 ok=0 oom=0
LRU    : n=0 exp=0 rmv=0 drp=0 at=0
Invals : n=0
Updates: n=0 rsz=0 rsn=0
Relinqs: n=0 rtr=0 drop=0
NoSpace: nwr=0 ncr=0 cull=0
IO     : rd=0 wr=0 mis=0
```

With caching working, `Cookies` and `Acquire` grow as files are opened, `IO wr=` grows on the first read (data written into the cache) and `IO rd=` grows on later reads (data served from the cache). `du` on the cache directory grows too. If every counter stays at zero after reading files, the mount does not have `fsc` or the daemon is not running.

Kernel 5.17 replaced FS-Cache and CacheFiles with a rewritten implementation, so output from older kernels and older guides looks different (lines such as `Pages  : mrk=` and `Retrvls:`). The `/proc/sys/fs/nfs/nfs_fscache_*` counters mentioned in the packaged howto are gone on current kernels; use `/proc/fs/fscache/stats` instead.

## Fix checklist when nothing is cached

1. `pgrep -a cachefilesd` prints nothing: on Debian or Ubuntu, set `RUN=yes` in `/etc/default/cachefilesd` and restart the service.
2. The daemon exits right after start: check `sudo journalctl -u cachefilesd` (or run `sudo cachefilesd -d -s -n` in the foreground to see the error). Common causes are an invalid limit order in `cachefilesd.conf`, a missing `dir`, or a cache filesystem without user xattr support.
3. `/proc/fs/fscache/caches` is empty: the `cachefiles` kernel module is not loaded or the daemon did not bind it. Check `lsmod | grep cachefiles` and `sudo modprobe cachefiles`.
4. `FSC` shows `no`: the mount lacks `fsc`, or it was remounted instead of unmounted and mounted.
5. Counters stay at zero: the files are being opened for writing or with `O_DIRECT`, both of which bypass the cache (see below).

## When cachefilesd helps, and when it does not

- **Good fit:** read-mostly data on a slow or shared link. Game libraries, build toolchains, container image layers on NFS, media, home directories over a VPN, and many clients reading the same files from one busy NFS server.
- **Writes are not cached.** When a file is opened for writing or for direct I/O, its cached copy is retired and the file is not cached until that client stops using it. CacheFiles is a read cache, not a write-back cache.
- **The cache disk must be faster than the network path.** On 10 GbE to a fast NAS with SSDs, a local spinning disk or a busy SATA SSD can be slower than the server. Measure first.
- **Coherency.** The client still checks file attributes with the server, so changes made by other clients invalidate the cached copy. It does not add offline access: if the server is unreachable, the mount still hangs.
- **SELinux.** On RHEL and Fedora in enforcing mode, moving `dir` away from `/var/cache/fscache` requires a matching SELinux file context, which is what the commented `secctx` line in the config relates to.

## FAQ

### Does cachefilesd work with NFSv4.2 and NFS-Ganesha servers?

Yes. The cache is on the client, so the server does not need to know about it. NFSv3 and all NFSv4 minor versions support `fsc`, and the share can be served by the kernel NFS server, NFS-Ganesha or a NAS appliance.

### How big will the cache get?

As big as the free space thresholds allow. There is no fixed size setting; put the cache on its own filesystem and size that filesystem to the cache you want.

### Does the cache survive a reboot?

Yes. The data in `/var/cache/fscache` is persistent, and after a reboot the client checks it against the server before using it.

### How do I clear the cache?

Stop the daemon, unmount the `fsc` mounts, delete the contents of the cache directory, then start the daemon and mount again:

```bash
sudo systemctl stop cachefilesd
sudo umount /mnt/steam
sudo rm -rf /var/cache/fscache/*
sudo systemctl start cachefilesd
sudo mount /mnt/steam
```

### Can I use it for SMB/CIFS mounts?

The CIFS client also has FS-Cache support with the `fsc` mount option, but it is less widely used than the NFS path. Test it on your kernel before relying on it.

## Related guides

- [Linux Filesystem Internals and Optimization](/linux-filesystem-internals-optimization/)
- [Linux Filesystem and Partition Management Guide](/linux-filesystem-partition-management-guide/)
- [Resize a Root ext4 Partition Online Without Reboot](/post/online-resize-of-a-root-ext4-file-system/)
- [Understanding XFS Inodes](/understanding-xfs-inodes/)
