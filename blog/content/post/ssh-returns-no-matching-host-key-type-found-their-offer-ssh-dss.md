---
title: "SSH returns: no matching host key type found. Their offer: ssh-dss"
date: 2022-07-15T00:16:00-05:00
draft: false
tags: ["SSH", "Cisco Nk5k"]
categories:
- SSH
- Cisco Nk5k
author: "Matthew Mattox - mmattox@support.tools"
description: "SSH returns: no matching host key type found. Their offer: ssh-dss"
more_link: "yes"
---

While setting up a new Cisco Nexus N5K-C5596UP switch, I was getting the following error:

```bash
mmattox@a1ubthorp01:~$ ssh root@192.168.69.99
Unable to negotiate with 192.168.69.99 port 22: no matching host key type found. Their offer: ssh-rsa,ssh-dss
mmattox@a1ubthorp01:~$ 
```

<!--more-->
# [Fix](#fix)
This error is caused by the fact that the switch is using an outdated key algorithm in this case it is ssh-dss.

To properly fix this issue, I would need to update the switch to a newer release but the highest version that I have access to is `n5000-uk9.7.3.7.N1.1b.bin`.

So to workaround this issue we simply need to tell the OpenSSH client to use the ssh-dss key algorithm.

```bash
ssh -oHostKeyAlgorithms=+ssh-dss root@192.168.69.99
```

This will work as a one off fix but to make this a more permanent solution I would need to add the following to the `~/.ssh/config` file:

```bash
Host san_switch
  HostName 192.168.69.99
  HostKeyAlgorithms=+ssh-dss
```