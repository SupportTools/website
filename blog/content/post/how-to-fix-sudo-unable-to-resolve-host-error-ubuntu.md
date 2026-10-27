---
title: "Fix 'sudo: unable to resolve host' on Ubuntu (/etc/hosts)"
date: 2024-05-14T02:24:00-05:00
lastmod: 2026-10-27T00:00:00-05:00
draft: false
tags: ["Ubuntu", "Linux", "sudo error", "host resolution"]
categories:
- Ubuntu
- Linux
author: "Matthew Mattox - mmattox@support.tools"
description: "Fix 'sudo: unable to resolve host' and 'Name or service not known' on Ubuntu: add a 127.0.1.1 hostname line to /etc/hosts and check hostnamectl."
more_link: "yes"
---

Learn how to quickly fix the common 'sudo: unable to resolve host' error in Ubuntu by properly configuring your /etc/hosts file. This guide provides a detailed step-by-step solution.

<!--more-->
# [How to Fix 'sudo: unable to resolve host' Error in Ubuntu](#how-to-fix-sudo-unable-to-resolve-host-error-in-ubuntu)

Encountering the `sudo: unable to resolve host` error in Ubuntu can be frustrating. This error typically occurs because the hostname is not correctly mapped in the `/etc/hosts` file. Here’s how you can resolve this issue with a simple edit.

## Quick answer

`sudo` looks up the machine's own hostname. When that name is missing from `/etc/hosts` (often after a hostname change), the lookup fails. Add the hostname to `/etc/hosts`:

```bash
# 1. See which hostname sudo is trying to resolve
hostname

# 2. Map it on the 127.0.1.1 line (the Debian/Ubuntu convention)
echo "127.0.1.1 $(hostname)" | sudo tee -a /etc/hosts

# 3. Confirm it now resolves; sudo should run without the warning
getent hosts "$(hostname)"
```

Step 2 prints the warning one last time, but it still writes the file. If the hostname itself is wrong, set it with `sudo hostnamectl hostname new-name` (`sudo hostnamectl set-hostname new-name` on Ubuntu 20.04 and older) and update the `/etc/hosts` line to match. On cloud instances where cloud-init has `manage_etc_hosts: true`, `/etc/hosts` is regenerated at boot, so edit `/etc/cloud/templates/hosts.debian.tmpl` instead.

## Error Message

When you try to use `sudo`, you might see an error message like this:

```bash
ubuntu@ip-172-27-99-13:~$ sudo bash
sudo: unable to resolve host ip-172-27-99-13
```

Depending on the sudo version, the line may end with the resolver's reason, such as `: Name or service not known` or `: Temporary failure in name resolution`. The cause and the fix are the same.

## Why This Happens

This error occurs because the system cannot map the IP address to the hostname specified. This mapping is usually defined in the `/etc/hosts` file. Without the correct entry, `sudo` commands fail to resolve the hostname, resulting in the error.

## Solution

To fix this, you need to add the correct hostname entry to your `/etc/hosts` file. Follow these steps:

### Step 1: Open the /etc/hosts File

First, open the `/etc/hosts` file in a text editor with root permissions. You can use `nano`, `vim`, or any editor of your choice. Here’s how to open it with `nano`:

```bash
sudo nano /etc/hosts
```

### Step 2: Add the Hostname Entry

Look for the following line:

```bash
127.0.0.1 localhost
```

Below this line, add your IP address and hostname. For example:

```bash
127.0.0.1 localhost
172.27.99.13 ip-172-27-99-13
```

Replace `172.27.99.13` with your actual IP address and `ip-172-27-99-13` with your hostname. Using the machine's permanent IP address is correct for a server with a static address; on a machine whose IP can change (DHCP), use `127.0.1.1 ip-172-27-99-13` instead, which is what the Debian and Ubuntu installers write.

### Step 3: Save and Close the File

After making the changes, save the file and exit the editor. In `nano`, you can do this by pressing `Ctrl + X`, then `Y`, and `Enter`.

### Step 4: Verify the Changes

To ensure the changes have taken effect, you can open the `/etc/hosts` file again and check if the new entry is there. You can also try running the `sudo` command again to see if the error is resolved.

```bash
ubuntu@ip-172-27-99-13:~$ sudo bash
root@ip-172-27-99-13:~#
```

If the error message no longer appears, you have successfully resolved the issue.

## Conclusion

By correctly configuring the `/etc/hosts` file, you can resolve the `sudo: unable to resolve host` error in Ubuntu. This simple fix ensures your system can map the hostname to the IP address, allowing `sudo` commands to function correctly.

For more tips and troubleshooting guides on Ubuntu and Linux, stay tuned to my blog!
