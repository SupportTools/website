---
title: "Caching NFS files with cachefilesd"
date: 2022-07-11T23:24:00-05:00
draft: false
tags: ["Linux", "NFS"]
categories:
- Linux
- NFS
author: "Matthew Mattox - mmattox@support.tools."
description: "Caching NFS files with cachefilesd"
more_link: "yes"
---


The cachefilesd tool is great for caching network filesystems like NFS mounts! In addition to its ease of use, it provides a substantial amount of stats. For more information, see [https://www.kernel.org/doc/Documentation/filesystems/caching/fscache.txt](https://www.kernel.org/doc/Documentation/filesystems/caching/fscache.txt)

The following steps will help you cache an NFS mount (this will also work for NFS-Ganesha servers):

Install cachefilesd as a daemon
Make sure /etc/cachefilesd.conf is configured correctly. The file does not need to be edited in most cases! It is just a matter of checking the disk limits.
The cachefilesd daemon should be started.
Mount the network directories using the "fsc" option. If they have already been mounted, unmount and mount them all. A network mount must have the fsc option enabled to enable file caching.
Check the stats to see if file caching is working.

In most Linux distributions, it will be almost the same as the example below, which uses Ubuntu 22.04.

<!--more-->
# [Install](#install)

## Install the daemon tool cachefilesd

It's as simple as installing it through the package manager:

```bash
sudo apt install cachefilesd -y
```

## Configure cachefilesd
Check the configuration file and tune for your system.

It is usually a good idea to start with the defaults in /etc/cachefilesd.conf:

Example:
```bash
dir /var/cache/fscache
tag mycache
brun 10%
bcull 7%
bstop 3%
frun 10%
fcull 7%
fstop 3%

# Assuming you're using SELinux with the default security policy included in
# this package
# secctx system_u:system_r:cachefiles_kernel_t:s0
```

The lines with percentages indicate how much disk space is limited in the directory where the cache will be housed. As long as the disk space does not drop below 10%, the cache can run freely. In the man page (or at https://linux.die.net/man/5/cachefilesd.conf) you can find more information. "bcull 7%" - culling the cache when the free space drops below "7%"
Therefore, the configuration file should be edited if the disk free space is below 10%.

## Start the daemon
Enable cachefilesd to run automatically on boot and start the service.

```bash
sudo systemctl enable --now cachefilesd
sudo systemctl status cachefilesd
```

## Mount the NFS shares
The mount option fsc must be included in the mount options of cachefilesd cache to make it a network mount. In case remounting does not work, a full umount/mount should be performed. The following is an example of a /etc/fstab file:

```bash
nas1.support.tools:/mnt/DiskPool0/steam /mnt/steam nfs defaults,hard,intr,noexec,nosuid,_netdev,fsc,vers=4 0 0
```

Mount with the following command:
    
```bash
sudo mount /mnt/steam
```

Remount with the following command:
    
```bash
sudo mount -o remount /mnt/steam
```

If the remount fails, you can try the following command:
    
```bash
sudo umount /mnt/steam
sudo mount /mnt/steam
```

If the FS cache is used, check whether the mounts work. It must be "yes" for FSC.

```bash
mmattox@a1ubthorp01:~$ cat /proc/fs/nfsfs/volumes
NV SERVER   PORT DEV          FSID                              FSC
v3 c0a8450b  801 0:97         74c9544b:0                        yes
v4 c0a8450b  801 0:102        f8770b94:260e67de                 yes
mmattox@a1ubthorp01:~$ 
```

There is a proc file for cache statistics:

```bash
mmattox@a1ubthorp01:~$ cat /proc/fs/fscache/stats
FS-Cache statistics
Cookies: idx=17 dat=248219 spc=0
Objects: alc=11929 nal=0 avl=11929 ded=22
ChkAux : non=0 ok=0 upd=0 obs=0
Pages  : mrk=277247 unc=250180
Acquire: n=248236 nul=0 noc=0 ok=248236 nbf=0 oom=0
Lookups: n=11929 neg=11929 pos=0 crt=11929 tmo=0
Invals : n=36564 run=36564
Updates: n=0 nul=0 run=36564
Relinqs: n=24633 nul=0 wcr=0 rtr=0
AttrChg: n=0 ok=0 nbf=0 oom=0 run=0
Allocs : n=0 ok=0 wt=0 nbf=0 int=0
Allocs : ops=0 owt=0 abt=0
Retrvls: n=21958 ok=9755 wt=339 nod=12200 nbf=0 int=0 oom=0
Retrvls: ops=21955 owt=530 abt=0
Stores : n=179874 ok=179874 agn=0 nbf=0 oom=0
Stores : ops=11869 run=191743 pgs=179874 rxd=179874 olm=0
VmScan : nos=247968 gon=0 bsy=0 can=0 wt=0
Ops    : pend=667 run=70388 enq=329337 can=0 rej=0
Ops    : ini=238393 dfr=324 rel=238393 gc=324
CacheOp: alo=0 luo=0 luc=0 gro=0
CacheOp: inv=0 upo=0 dro=0 pto=0 atc=0 syn=0
CacheOp: rap=0 ras=0 alp=0 als=0 wrp=0 ucp=0 dsp=0
CacheEv: nsp=0 stl=0 rtr=0 cul=0
RdHelp : RA=0 RP=0 WB=0 WBZ=0 rr=0 sr=0
RdHelp : ZR=0 sh=0 sk=0
RdHelp : DL=0 ds=0 df=0 di=0
RdHelp : RD=0 rs=0 rf=0
RdHelp : WR=0 ws=0 wf=0
mmattox@a1ubthorp01:~$ 
```

Here is a list of the files in the cache directory. In this case, the filesystem cache is not being used, and it is likely that the mount does not have FSC mounted! The nfs mounts should be unmounted and remounted.

```bash
mmattox@a1ubthorp01:~$ sudo find /var/cache/fscache|head -n 20
/var/cache/fscache
/var/cache/fscache/graveyard
/var/cache/fscache/cache
/var/cache/fscache/cache/@4a
/var/cache/fscache/cache/@4a/I03nfs
/var/cache/fscache/cache/@4a/I03nfs/@cd
/var/cache/fscache/cache/@4a/I03nfs/@cd/Jg0M0000000000800000MEmQ2
/var/cache/fscache/cache/@4a/I03nfs/@cd/Jg0M0000000000800000MEmQ2/@e0
/var/cache/fscache/cache/@4a/I03nfs/@cd/Jg0M0000000000800000MEmQ2/@e0/J1100000000000I4l9j70000000000000000M000000w0000020wX2000oG300Mk7000CW0000000040000g000000000
/var/cache/fscache/cache/@4a/I03nfs/@cd/Jg0M0000000000800000MEmQ2/@e0/J1100000000000I4l9j70000000000000000M000000w0000020wX2000oG300Mk7000CW0000000040000g000000000/@2c
/var/cache/fscache/cache/@4a/I03nfs/@cd/Jg0M0000000000800000MEmQ2/@e0/J1100000000000I4l9j70000000000000000M000000w0000020wX2000oG300Mk7000CW0000000040000g000000000/@2c/Es0MikBctuH-OkH00a3100000vmoJ000000000000
/var/cache/fscache/cache/@4a/I03nfs/@cd/Jg0M0000000000800000MEmQ2/@e0/J1100000000000I4l9j70000000000000000M000000w0000020wX2000oG300Mk7000CW0000000040000g000000000/@2c/Es0MikBctuH-OkH00qf000000smoJ000000000000
/var/cache/fscache/cache/@4a/I03nfs/@cd/Jg0M0000000000800000MEmQ2/@e0/J1100000000000I4l9j70000000000000000M000000w0000020wX2000oG300Mk7000CW0000000040000g000000000/@2c/Es0MikBctuH-OkH0057100000zmoJ000000000000
/var/cache/fscache/cache/@4a/I03nfs/@cd/Jg0M0000000000800000MEmQ2/@e0/J1100000000000I4l9j70000000000000000M000000w0000020wX2000oG300Mk7000CW0000000040000g000000000/@2c/Es0MikBctuH-OkH00Na200000CmoJ000000000000
/var/cache/fscache/cache/@4a/I03nfs/@cd/Jg0M0000000000800000MEmQ2/@e0/J1100000000000I4l9j70000000000000000M000000w0000020wX2000oG300Mk7000CW0000000040000g000000000/@2c/Es0MikBctuH-OkH00_U600000dnoJ000000000000
/var/cache/fscache/cache/@4a/I03nfs/@cd/Jg0M0000000000800000MEmQ2/@e0/J1100000000000I4l9j70000000000000000M000000w0000020wX2000oG300Mk7000CW0000000040000g000000000/@2c/Es0MikBctuH-OkH00CG200000FmoJ000000000000
/var/cache/fscache/cache/@4a/I03nfs/@cd/Jg0M0000000000800000MEmQ2/@e0/J1100000000000I4l9j70000000000000000M000000w0000020wX2000oG300Mk7000CW0000000040000g000000000/@2c/Es0MikBctuH-OkH00IF4000003noJ000000000000
/var/cache/fscache/cache/@4a/I03nfs/@cd/Jg0M0000000000800000MEmQ2/@e0/J1100000000000I4l9j70000000000000000M000000w0000020wX2000oG300Mk7000CW0000000040000g000000000/@2c/Es0MikBctuH-OkH00rB5000005noJ000000000000
/var/cache/fscache/cache/@4a/I03nfs/@cd/Jg0M0000000000800000MEmQ2/@e0/J1100000000000I4l9j70000000000000000M000000w0000020wX2000oG300Mk7000CW0000000040000g000000000/@2c/Es0MikBctuH-OkH00uJ5000000noJ000000000000
/var/cache/fscache/cache/@4a/I03nfs/@cd/Jg0M0000000000800000MEmQ2/@e0/J1100000000000I4l9j70000000000000000M000000w0000020wX2000oG300Mk7000CW0000000040000g000000000/@2c/Es0MikBctuH-OkH00i96000005noJ000000000000
mmattox@a1ubthorp01:~$ 
```