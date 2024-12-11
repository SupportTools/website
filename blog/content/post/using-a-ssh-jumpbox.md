---
categories: ["Linux"]
tags: ["Linux", "SSH", "Jumpbox"]
date: "2020-12-11T01:27:00+00:00"
more_link: "yes"
title: "How to Access a Protected Server Using a Jumpbox"
---

Accessing servers remotely via SSH is a common practice. However, for enhanced security, it's often necessary to use a "Jumpbox." A Jumpbox is a server that acts as an intermediary, accessible from the internet or other less-trusted networks. It typically resides in a DMZ or behind special firewall rules.

## TL;DR

To SSH to a server through a Jumpbox, use the following command:

```bash
ssh -J matt@jump.support.tools root@webserver.support.tools
```

<!--more-->

## Longer Version

When setting up your Linux servers—whether in your data center, favorite cloud service provider, or even under your desk—you typically add your SSH public key to the server's `authorized_keys`. 

However, exposing SSH access to the public internet is a significant security risk. A Jumpbox helps mitigate this risk by acting as a gateway. You connect to the Jumpbox first, and then the Jumpbox connects to your secure network, reducing the attack surface.

### Using the `-J` Option

To simplify accessing a server through a Jumpbox, you can use the `-J` option in the `ssh` command. The format is as follows:

```bash
ssh -J [user@]jumpbox [user@]destination
```

For example:

```bash
ssh -J matt@jump.support.tools root@webserver.support.tools
```

### Man Page Explanation

The SSH(1) man page describes the `-J` option as follows:

```
-J [user@]host[:port]
    Connect to the target host by first making an SSH connection to the jump host and
    establishing a TCP forwarding to the ultimate destination from there. Multiple jump
    hops may be specified, separated by commas. This is a shortcut to setting a ProxyJump
    configuration directive.
```

Using a Jumpbox not only enhances security but also streamlines access to protected servers in a secure network.
