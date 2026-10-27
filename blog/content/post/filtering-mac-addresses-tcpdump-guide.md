---
title: "tcpdump: Filter Packets by MAC Address (ether host)"
date: 2023-10-13T10:45:00-05:00
lastmod: 2026-10-27T00:00:00-05:00
draft: false
tags: ["tcpdump", "Network Monitoring", "MAC Address", "Network Tools"]
categories:
- Monitoring
author: "Matthew Mattox - mmattox@support.tools"
description: "Filter tcpdump captures by MAC address with ether host, ether src, and ether dst. Exact commands, accepted MAC formats, and -e to print MACs."
more_link: "yes"
---

## Quick answer

Use the `ether` qualifier from the pcap filter language. Add `-e` so tcpdump prints the source and destination MAC on every line:

```bash
# Frames to or from a MAC address (either direction)
sudo tcpdump -i eth0 -e ether host d2:94:51:91:71:d7

# Only frames sent by that MAC
sudo tcpdump -i eth0 -e ether src d2:94:51:91:71:d7

# Only frames sent to that MAC
sudo tcpdump -i eth0 -e ether dst d2:94:51:91:71:d7

# Exclude a MAC, or combine it with other filters
sudo tcpdump -i eth0 -e 'not ether host d2:94:51:91:71:d7'
sudo tcpdump -i eth0 -e 'ether src d2:94:51:91:71:d7 and tcp port 443'
```

The address can be written as `xx:xx:xx:xx:xx:xx`, `xx-xx-xx-xx-xx-xx`, `xx.xx.xx.xx.xx.xx`, `xxxx.xxxx.xxxx`, or `xxxxxxxxxxxx`, or as a name from `/etc/ethers` (see `man 7 pcap-filter`).

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

In this example, replace `d2:94:51:91:71:d7` with the MAC address you want to target. On a globally unique MAC address, the first three octets are the Organizationally Unique Identifier (OUI) assigned to the manufacturer (for example, `e8:2a:ea` is an Intel prefix). The example address `d2:94:51:91:71:d7` has the locally administered bit set (`0xd2`, the second least significant bit of the first octet), so it is a randomized or virtual address and its first three octets do not identify a vendor.

Using these `tcpdump` commands with the "ether" qualifier lets you filter and capture network traffic based on MAC addresses, making it a powerful tool for network analysis and troubleshooting.
