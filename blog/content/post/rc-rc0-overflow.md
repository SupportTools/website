---
title: "kernel: rc rc0: receive overflow"
date: 2022-06-23T23:52:00-05:00
draft: false
tags: ["ubuntu", "rke2"]
categories:
- Ubuntu
- RKE2
author: "Matthew Mattox - mmattox@support.tools"
description: "kernel: rc rc0: receive overflow spamming syslog on Intel NUC nodes"
more_link: "yes"
---

After upgrade my build nodes from Ubuntu 20.04 to Ubuntu 22.04, I got a lot of spamming syslog messages on my Intel NUC nodes, model NUC5i5RYB. Both these nodes are running RKE2 `v1.24.1+rke2r2`. I have them tainted so that they are only used by Drone CI to run Kubernetes runners.

Error message
```
Jun 24 04:35:27 a0ubnucp02 kernel: [ 2025.557663] rc rc0: receive overflow
Jun 24 04:35:27 a0ubnucp02 kernel: [ 2025.561258] rc rc0: receive overflow
Jun 24 04:35:27 a0ubnucp02 kernel: [ 2025.566120] rc rc0: receive overflow
Jun 24 04:35:27 a0ubnucp02 kernel: [ 2025.569739] rc rc0: receive overflow
Jun 24 04:35:27 a0ubnucp02 kernel: [ 2025.618179] rc rc0: receive overflow
Jun 24 04:35:27 a0ubnucp02 kernel: [ 2025.637622] rc rc0: receive overflow
Jun 24 04:35:27 a0ubnucp02 kernel: [ 2025.645784] rc rc0: receive overflow
Jun 24 04:35:27 a0ubnucp02 kernel: [ 2025.649311] rc rc0: receive overflow
Jun 24 04:35:27 a0ubnucp02 kernel: [ 2025.656808] rc rc0: receive overflow
Jun 24 04:35:27 a0ubnucp02 kernel: [ 2025.660897] rc rc0: receive overflow
```

<!--more-->
# [Fix](#fix)

This error is cause by the built-in IR receiver on the Intel NUC. I didn't even know that they had one. But because they are being used as Kubernetes nodes there is no need for this. So we are going to disable this module.

## Temprary disable IR receiver
Run command: `sudo modprobe -r ite_cir`

You should see this message in the logs and the `receive overflow` messages should stop.
```
Jun 24 04:35:27 a0ubnucp02 kernel: [ 2025.728175] ite-cir 00:01: disabled
```

Note: This is a temporary fix and reboot will undo this change. 

To make this permanent we need to blacklist this module by adding the following line to the `/etc/modprobe.d/blacklist.conf` file:
```
blacklist ite_cir
```

Then we need update initramfs to include the new blacklist. Run command: `sudo update-initramfs -u`

Note: A reboot is not required to make this change.