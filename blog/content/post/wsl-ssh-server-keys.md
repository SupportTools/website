---
title: "sshd: no hostkeys available -- exiting"
date: 2024-06-30T23:18:00-05:00
draft: false
tags: ["wsl", "ssh"]
categories:
- wsl
author: "Matthew Mattox - mmattox@support.tools."
description: "How to setup ssh server keys for WSL."
more_link: "yes"
---

While setting up WSL on my Thinkpad T480, I know I don't normally Windows but I keep running into firmware and drivers. So I decided to switch back to Windows for a bit. While setting up WSL, I wanted to able to SSH into my laptop and run commands on it. I was able to do this by installing the WSL SSH server but I ran into a problem when trying to start the SSH server.

Error:
```
mmattox@a0wnhammerp01:~$ sudo /usr/sbin/service ssh start
 * Starting OpenBSD Secure Shell server sshd
 sshd: no hostkeys available -- exiting. [fail]
mmattox@a0wnhammerp01:
```

<!--more-->
# [Fix](#fix)
This error is caused by the fact that the SSH server is missing the host keys.

```
sudo ssh-keygen -A
sudo /usr/sbin/service ssh start
```

This command will generate the host keys and restart the SSH server.
