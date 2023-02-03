---
title: "Harbor Redis Crashlooping"
date: 2022-07-12T18:21:00-05:00
draft: false
tags: ["Kubernetes", "RKE2", "Harbor", "Redis"]
categories:
- Kubernetes
- RKE2
- Harbor
- Redis
author: "Matthew Mattox - mmattox@support.tools."
description: "Harbor Redis Crashlooping"
more_link: "yes"
---

My Harbor server went offline when I patched one of my RKE2 clusters, which caused pods to go into ImagePullBackoff. Within a few minutes, I noticed that Redis was crashlooping with the following error:

```bash
mmattox@a1ubthorp01:~/$ kubectl -n harbor logs -f harbor-redis-0
1:C 12 Jul 2022 23:15:36.208 # oO0OoO0OoO0Oo Redis is starting oO0OoO0OoO0Oo
1:C 12 Jul 2022 23:15:36.208 # Redis version=6.0.16, bits=64, commit=00000000, modified=0, pid=1, just started
1:C 12 Jul 2022 23:15:36.208 # Configuration loaded
                _._                                                  
           _.-``__ ''-._                                             
      _.-``    `.  `_.  ''-._           Redis 6.0.16 (00000000/0) 64 bit
  .-`` .-```.  ```\/    _.,_ ''-._                                   
 (    '      ,       .-`  | `,    )     Running in standalone mode
 |`-._`-...-` __...-.``-._|'` _.-'|     Port: 6379
 |    `-._   `._    /     _.-'    |     PID: 1
  `-._    `-._  `-./  _.-'    _.-'                                   
 |`-._`-._    `-.__.-'    _.-'_.-'|                                  
 |    `-._`-._        _.-'_.-'    |           http://redis.io        
  `-._    `-._`-.__.-'_.-'    _.-'                                   
 |`-._`-._    `-.__.-'    _.-'_.-'|                                  
 |    `-._`-._        _.-'_.-'    |                                  
  `-._    `-._`-.__.-'_.-'    _.-'                                   
      `-._    `-.__.-'    _.-'                                       
          `-._        _.-'                                           
              `-.__.-'                                               

1:M 12 Jul 2022 23:15:36.210 # Server initialized
1:M 12 Jul 2022 23:15:36.210 # Can't handle RDB format version 10
1:M 12 Jul 2022 23:15:36.210 # Fatal error loading the DB: Invalid argument. Exiting.
mmattox@a1ubthorp01:~/$
```

<!--more-->
# [Fix](#fix)

The Redis server is crashing, as you can see. However, the error message is not very helpful. However, after a quick Google search, I found that this error is due to GitHub issue [GH-6032](https://github.com/redis/redis/issues/6032), which suggests that the server is failing to start, resulting in the crash. The Redis data directory contains a dump file.

The dump file needs to be removed in order to fix this issue. As a result of the pod not staying up long enough, a shell cannot be opened. In the end, I accessed the PVC directly by SSHing into the node where the pod is running.

The PVC in my case is merely an iSCSI volume since I'm running Longhorn. To remove the dump file, I am using the following command:

```bash
df -h /dev/longhorn/pvc-e1641911-c7fd-4ade-9dd0-b8d2d36d6cf4
```

Output:

```bash
root@a1ubdevopswp05:~# df -h /dev/longhorn/pvc-e1641911-c7fd-4ade-9dd0-b8d2d36d6cf4
Filesystem                                              Size  Used Avail Use% Mounted on
/dev/longhorn/pvc-e1641911-c7fd-4ade-9dd0-b8d2d36d6cf4  976M  4.0M  956M   1% /var/lib/kubelet/pods/2f2a3dff-aa35-48d8-904a-8eee68d818eb/volumes/kubernetes.io~csi/pvc-e1641911-c7fd-4ade-9dd0-b8d2d36d6cf4/mount
root@a1ubdevopswp05:~#
```

PVC is mounted just like any other ext4 filesystem, as you can see in the text above. Hence, I can delete the dump file by cd'ing into the directory.

```bash
root@a1ubdevopswp05:~# cd /var/lib/kubelet/pods/2f2a3dff-aa35-48d8-904a-8eee68d818eb/volumes/kubernetes.io~csi/pvc-e1641911-c7fd-4ade-9dd0-b8d2d36d6cf4/mount
root@a1ubdevopswp05:/var/lib/kubelet/pods/2f2a3dff-aa35-48d8-904a-8eee68d818eb/volumes/kubernetes.io~csi/pvc-e1641911-c7fd-4ade-9dd0-b8d2d36d6cf4/mount# ls -lh
total 1.5M
-rw-rw-r-- 1 lxd  999 1.5M Jul 12 09:55 dump.rdb
drwxrws--- 2 root 999  16K Jul  5 16:00 lost+found
-rw-rw-r-- 1 root 999    0 Jul  7 05:21 test
root@a1ubdevopswp05:/var/lib/kubelet/pods/2f2a3dff-aa35-48d8-904a-8eee68d818eb/volumes/kubernetes.io~csi/pvc-e1641911-c7fd-4ade-9dd0-b8d2d36d6cf4/mount# mv dump.rdb dump.rdb_old
root@a1ubdevopswp05:/var/lib/kubelet/pods/2f2a3dff-aa35-48d8-904a-8eee68d818eb/volumes/kubernetes.io~csi/pvc-e1641911-c7fd-4ade-9dd0-b8d2d36d6cf4/mount# cd ~
```

It is important to leave the directory so that Kubelet can unmount the filesystem. Since it's a stateful set, it's essentially static, but it's a good habit not to stay inside a mounted PVC.