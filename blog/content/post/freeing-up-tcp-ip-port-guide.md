---
title: "How to Free Up a TCP/IP Port"
date: 2023-10-13T08:15:00-05:00
draft: false
tags: ["Networking", "TCP/IP", "Port Management"]
categories:
- Networking
- Port Management
author: "Matthew Mattox - mmattox@support.tools"
description: "A guide on freeing up a TCP/IP port for reuse."
more_link: "yes"
---

## How to Free Up a TCP/IP Port

If you need to free up a TCP/IP port your application has previously bound to, there are a few essential steps to follow. This is crucial to make the port available for reuse. However, there is a catch: when an application closes a socket, it enters what's known as the TIME_WAIT state. This is done to detect any packets that might arrive from the peer afterward and respond with resets.

By default, the system won't allow new processes to bind to a local socket with TCP connections in the TIME_WAIT state. These connections can persist for several minutes after the socket is closed. A workaround for this involves setting the socket option `SO_REUSEADDR` on both the socket that is closed down and the new socket before the call to `bind()`.

If consistent use of this socket option isn't possible, another alternative is to ensure that no connections from the socket go into TIME_WAIT. The connection on the host initiates the close that goes into TIME_WAIT, while the link on the other host goes straight to CLOSED after receiving the final ACK. Thus, if you can arrange for the clients to close any TCP connections, no connections on the server side will hang around in TIME_WAIT, and the TCP port can be reused immediately.

If neither of these options is available, then the port will be available for reuse after TIME_WAIT, which can last as long as 4 minutes, but a more typical value is 1 minute.
