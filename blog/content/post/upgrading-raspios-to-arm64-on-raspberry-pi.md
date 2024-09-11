---
title: "Upgrading RaspiOS to arm64 on Raspberry Pi"
date: 2024-05-18T19:26:00-05:00
draft: false
tags: ["Raspberry Pi", "RaspiOS", "arm64", "Upgrade"]
categories:
- DevOps
- Raspberry Pi
author: "Matthew Mattox - mmattox@support.tools."
description: "Learn about the challenges and considerations when upgrading RaspiOS to arm64 on a Raspberry Pi 4-powered k3s cluster."
more_link: "yes"
url: "/upgrading-raspios-to-arm64-on-raspberry-pi/"
---

Can you upgrade your Raspberry Pi 4-powered k3s cluster to arm64 without rebuilding everything? The short answer is no. This guide explores the challenges and considerations for such an upgrade.

<!--more-->

# [Upgrading RaspiOS to arm64 on Raspberry Pi](#upgrading-raspios-to-arm64-on-raspberry-pi)

Can you upgrade your Raspberry Pi 4-powered k3s cluster to arm64 without rebuilding everything? The short answer is no. Here's why.

## [Current System Information](#current-system-information)

First, let's check the current system information:

```bash
uname -a
```

Example output:

```
Linux rpi405 5.10.63-v7l+ #1496 SMP Wed Dec 1 15:58:56 GMT 2021 armv7l GNU/Linux
```

## [Updating the System](#updating-the-system)

Update the system and modify the boot configuration:

```bash
sudo rpi-update
sudo vi /boot/config.txt
```

In the `[pi4]` section, add `arm_64bit=1`. Then reboot.

## [Verifying the Kernel Upgrade](#verifying-the-kernel-upgrade)

Check the system information again:

```bash
uname -a
```

Example output after reboot:

```
Linux rpi405 5.10.87-v8+ #1502 SMP PREEMPT Fri Dec 17 15:15:12 GMT 2021 aarch64 GNU/Linux
```

Check the architecture:

```bash
dpkg --print-architecture
```

Output:

```
armhf
```

This indicates a 64-bit kernel with a 32-bit userland.

## [Upgrading the Userland to 64-bit](#upgrading-the-userland-to-64-bit)

While it is technically possible to upgrade the userland to 64-bit, it is not recommended. The process is complex, time-consuming, and error-prone.

### [Why It's Not Worth the Hassle](#why-its-not-worth-the-hassle)

The process of upgrading the userland to 64-bit can be difficult and time-consuming. Although it can be done, it often results in numerous issues and is not worth the effort.

A much better approach is to perform a fresh reinstall. This method is easier, cleaner, less error-prone, and more likely to result in a working system. Use the usual `--get-selections` and `--set-selections` commands, along with a backup of `/etc`.

### [Alternative Approach](#alternative-approach)

For those interested in a 64-bit system, consider using 64-bit Ubuntu. Vladimir over at [rpi4cluster.com](https://rpi4cluster.com) opted for 64-bit Ubuntu 20.10.

In conclusion, while upgrading to a 64-bit userland on RaspiOS is technically feasible, it is not practical. A fresh reinstall or switching to a 64-bit distribution like Ubuntu is a better option.
