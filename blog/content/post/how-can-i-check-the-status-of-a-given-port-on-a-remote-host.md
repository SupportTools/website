---
title: "Checking Port Status on a Remote Host"
date: 2023-10-12T23:29:00-05:00
draft: false
tags: ["Networking", "Ports"]
categories:
- Networking
- Remote Host
author: "Matthew Mattox - mmattox@support.tools."
description: "A guide on how to check the status of ports on a remote host."
more_link: "yes"
---

## Checking Port Status on a Remote Host

When you need to determine the status of a port on a remote host, it usually means finding out whether the port is open (listening for connections) or closed. This process varies depending on whether you're dealing with TCP or UDP ports.

## TCP Ports

For TCP ports, you can use tools like `curl`, a versatile command-line tool for working with web-based interfaces. Here's how to check the status of TCP port 12345 on host 10.0.0.1 using `curl`:

```bash
curl 10.0.0.1:12345
```

You'll encounter one of three outcomes:

- If `curl` exits immediately with the error message:

```bash
curl: (7) Failed to connect to 10.0.0.1 port 12345: Connection refused
```

This indicates that the port is closed and no application is listening.

- If `curl` exits immediately without errors or with a message like:

```bash
curl: (52) Empty reply from server
```

It means an application accepts the connection from `curl`, and the port is open.

- If `curl` hangs for a few minutes and then exits with a message like:

```bash
curl: (7) Failed to connect to 10.0.0.1 port 12345: Connection timed out
```

The port is likely unreachable due to firewall rules or routing issues.

## UDP Ports

Checking UDP port status is similar, but there's no standard timeout mechanism for failed UDP connections. We'll use `socat`, a versatile utility for various connection types, including UDP. To check UDP port 12345 on host 10.0.0.1, use `socat`:

```bash
socat STDIO UDP-CONNECT:10.0.0.1:12345
```

Again, expect one of three outcomes:

- If `socat` exits immediately with an error message like:

```bash
socat[6431] E read(5, 0x691130, 8192): Connection refused
```

The port is closed with no application listening.

- If `socat` returns any content, it means an application on the port replied, indicating an open port.

- If there's no response within seconds, the port may not be reachable, possibly due to firewall rules or network issues.

Note that it's challenging to distinguish between an open port with an unresponsive application and a blocked port by a firewall.
