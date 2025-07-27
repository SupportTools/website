---
title: "Using Rsync Over SSH Port Forward for Faster Connections"
date: 2024-05-18T19:26:00-05:00
draft: false
tags: ["Rsync", "SSH", "Port Forwarding", "Data Transfer"]
categories:
- DevOps
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to run rsync over an SSH port forward to optimize your connection speed, especially when using a bastion."
more_link: "yes"
---

Optimize your data transfers by running rsync over an SSH port forward. This method is beneficial when using a bastion host, which can be slow in establishing connections.

<!--more-->

# [Using Rsync Over SSH Port Forward](#using-rsync-over-ssh-port-forward)

This guide will configure rsync to run over an SSH port forward, allowing you to utilize an existing SSH connection for faster and more efficient data transfers.

## [Why Use Rsync Over SSH Port Forward?](#why-use-rsync-over-ssh-port-forward)

Using a bastion host can often lead to slow connection establishments. We can bypass this delay by leveraging an SSH connection and making our rsync operations more efficient.

## [What You'll Need](#what-youll-need)

We will use rsync without the implied `-e ssh` and tunnel it over an existing SSH connection. This involves setting up an SSH connection, configuring a port forward, running rsync as a daemon, and minimizing the terminal window.

## [How to Set It Up](#how-to-set-it-up)

### [Configuration](#configuration)

First, create an `rsyncd.conf` file with the following content:

```ini
[foo]
  path = .
  use chroot = no
  read only = no
```

### [Starting the Daemon](#starting-the-daemon)

Establish the SSH connection and set up the port forward with:

```bash
ssh -L8873:localhost:8873 REMOTE_HOST
```

Next, run rsync as a daemon:

```bash
rsync --daemon --no-detach --config=$PWD/rsyncd.conf --log-file=$PWD/rsyncd.log &
tail -f $PWD/rsyncd.log
```

### [Running Rsync](#running-rsync)

Now, you can run rsync using the following command:

```bash
rsync SOURCE rsync://localhost:8873/foo/
```

Following these steps can achieve faster and more reliable rsync operations, especially when dealing with slow bastion hosts.
