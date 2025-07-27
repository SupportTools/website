---
title: "How to Filter MAC Addresses Using tcpdump"
date: 2023-10-13T10:45:00-05:00
draft: false
tags: ["tcpdump", "Network Monitoring", "MAC Address"]
categories:
- Network Tools
- Network Monitoring
author: "Matthew Mattox - mmattox@support.tools"
description: "A guide on filtering MAC addresses using tcpdump."
more_link: "yes"
---

## How to Filter MAC Addresses Using `tcpdump`

Suppose you're using `tcpdump` for network monitoring and must filter traffic based on MAC addresses. In that case, you can utilize the "ether" qualifier to specify Ethernet addresses in the standard colon-separated format. Here's how you can do it:

- To capture any broadcast traffic, use the following command:

```bash
tcpdump ether dst ff:ff:ff:ff:ff:ff
```

This command will capture all packets sent to the broadcast MAC address.

- To capture traffic sent to or from a specific MAC address, use a command like this:

```bash
tcpdump ether host d2:94:51:91:71:d7
```

In this example, replace `d2:94:51:91:71:d7` with the MAC address you want to target. The first three octets of the MAC address (e8:2a:ea) indicate the Organizationally Unique Identifier (OUI), assigned to a specific manufacturer, such as Intel.

Using these `tcpdump` commands with the "ether" qualifier lets you filter and capture network traffic based on MAC addresses, making it a powerful tool for network analysis and troubleshooting.
