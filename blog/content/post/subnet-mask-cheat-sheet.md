---
title: "What Is a Subnet Mask? Explanation and CIDR Cheat Sheet"
date: 2024-10-19T14:00:00-05:00
lastmod: 2026-10-27
draft: false
tags: ["Networking", "Subnetting", "IP"]
categories:
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "What a subnet mask is, how it splits an IP address into network and host parts, and a CIDR table of masks, host counts and broadcast addresses."
more_link: "yes"
url: "/subnet-mask-cheat-sheet/"
---

## What is a subnet mask?

A subnet mask is a 32-bit number that splits an IPv4 address into two parts: the **network** part, which every device on the same subnet shares, and the **host** part, which identifies one device on that subnet. Bits set to 1 in the mask mark the network part; bits set to 0 mark the host part.

Take `192.168.1.10` with the mask `255.255.255.0`:

```text
IP address    192.168.1.10    11000000.10101000.00000001.00001010
Subnet mask   255.255.255.0   11111111.11111111.11111111.00000000
Network       192.168.1.0     (IP AND mask)
Broadcast     192.168.1.255   (host bits all 1)
Usable hosts  192.168.1.1 to 192.168.1.254
```

The first 24 bits of the mask are 1, so that mask is written `/24` in CIDR notation, and `192.168.1.10/24` means the same thing as `192.168.1.10` with mask `255.255.255.0`. A device compares the network part of a destination address with its own: if they match, it delivers the packet directly on the local network; if not, it sends the packet to its default gateway.

<!--more-->

### How many hosts does a subnet hold?

A `/n` subnet has `32 - n` host bits, so it holds `2^(32 - n)` addresses. Two of them are reserved, the network address (all host bits 0) and the broadcast address (all host bits 1), which leaves `2^(32 - n) - 2` usable hosts. A `/26` has 6 host bits: 64 addresses, 62 usable.

Two exceptions: a `/31` has no network or broadcast address and both addresses are usable on point-to-point links (RFC 3021), and a `/32` identifies exactly one host, which is how loopback addresses and single-host routes are written.

### Find your subnet mask

- **Linux:** `ip -4 addr show` prints the address in CIDR form, for example `inet 192.168.1.10/24`.
- **Windows:** `ipconfig` shows a `Subnet Mask` line under each adapter.
- **macOS:** `ifconfig en0` shows the mask in hex, so `netmask 0xffffff00` is `255.255.255.0`.

## Subnet mask cheat sheet

Understanding subnet masks is crucial for anyone managing networks, especially when dealing with IP address allocation and routing. The tables below list common subnet masks, their address ranges and host counts, and how they relate to a Class C network.

### Subnet Masks Overview

The table below lists common subnet masks, the number of available hosts, and the corresponding netmask for each subnet size:

| **CIDR Notation** | **Addresses** | **Usable Hosts** | **Netmask**           | **Fraction of Class C** |
|-------------------|---------------|------------------|-----------------------|-------------------------|
| /32               | 1             | 1 (single host)  | 255.255.255.255        | 1/256                   |
| /31               | 2             | 2 (RFC 3021)     | 255.255.255.254        | 1/128                   |
| /30               | 4             | 2                | 255.255.255.252        | 1/64                    |
| /29               | 8             | 6                | 255.255.255.248        | 1/32                    |
| /28               | 16            | 14               | 255.255.255.240        | 1/16                    |
| /27               | 32            | 30               | 255.255.255.224        | 1/8                     |
| /26               | 64            | 62               | 255.255.255.192        | 1/4                     |
| /25               | 128           | 126              | 255.255.255.128        | 1/2                     |
| /24               | 256           | 254              | 255.255.255.0          | 1                       |
| /23               | 512           | 510              | 255.255.254.0          | 2                       |
| /22               | 1024          | 1022             | 255.255.252.0          | 4                       |
| /21               | 2048          | 2046             | 255.255.248.0          | 8                       |
| /20               | 4096          | 4094             | 255.255.240.0          | 16                      |
| /19               | 8192          | 8190             | 255.255.224.0          | 32                      |
| /18               | 16384         | 16382            | 255.255.192.0          | 64                      |
| /17               | 32768         | 32766            | 255.255.128.0          | 128                     |
| /16               | 65536         | 65534            | 255.255.0.0            | 256                     |
| /12               | 1048576       | 1048574          | 255.240.0.0            | 4096                    |
| /8                | 16777216      | 16777214         | 255.0.0.0              | 65536                   |

### Subclassing a Class C Network

Below are examples of how to break down a Class C network (`/24`) into smaller subnets, along with their corresponding IP ranges and broadcast addresses.

#### /25: 2 Subnets, 126 Hosts per Subnet

| **Network** | **IP Range**       | **Broadcast**  |
|-------------|--------------------|----------------|
| .0          | .1 - .126          | .127           |
| .128        | .129 - .254        | .255           |

#### /30: 64 Subnets, 2 Hosts per Subnet

| **Network** | **IP Range**       | **Broadcast**  |
|-------------|--------------------|----------------|
| .0          | .1 - .2            | .3             |
| .4          | .5 - .6            | .7             |
| .8          | .9 - .10           | .11            |
| .12         | .13 - .14          | .15            |
| ...         | ...                | ...            |
| .248        | .249 - .250        | .251           |
| .252        | .253 - .254        | .255           |

#### /26: 4 Subnets, 62 Hosts per Subnet

| **Network** | **IP Range**       | **Broadcast**  |
|-------------|--------------------|----------------|
| .0          | .1 - .62           | .63            |
| .64         | .65 - .126         | .127           |
| .128        | .129 - .190        | .191           |
| .192        | .193 - .254        | .255           |

#### /27: 8 Subnets, 30 Hosts per Subnet

| **Network** | **IP Range**       | **Broadcast**  |
|-------------|--------------------|----------------|
| .0          | .1 - .30           | .31            |
| .32         | .33 - .62          | .63            |
| .64         | .65 - .94          | .95            |
| .96         | .97 - .126         | .127           |
| .128        | .129 - .158        | .159           |
| .160        | .161 - .190        | .191           |
| .192        | .193 - .222        | .223           |
| .224        | .225 - .254        | .255           |

#### /28: 16 Subnets, 14 Hosts per Subnet

| **Network** | **IP Range**       | **Broadcast**  |
|-------------|--------------------|----------------|
| .0          | .1 - .14           | .15            |
| .16         | .17 - .30          | .31            |
| .32         | .33 - .46          | .47            |
| .48         | .49 - .62          | .63            |
| .64         | .65 - .78          | .79            |
| .80         | .81 - .94          | .95            |
| .96         | .97 - .110         | .111           |
| .112        | .113 - .126        | .127           |
| .128        | .129 - .142        | .143           |
| .144        | .145 - .158        | .159           |
| .160        | .161 - .174        | .175           |
| .176        | .177 - .190        | .191           |
| .192        | .193 - .206        | .207           |
| .208        | .209 - .222        | .223           |
| .224        | .225 - .238        | .239           |
| .240        | .241 - .254        | .255           |

#### /29: 32 Subnets, 6 Hosts per Subnet

| **Network** | **IP Range**       | **Broadcast**  |
|-------------|--------------------|----------------|
| .0          | .1 - .6            | .7             |
| .8          | .9 - .14           | .15            |
| .16         | .17 - .22          | .23            |
| .24         | .25 - .30          | .31            |
| .32         | .33 - .38          | .39            |
| .40         | .41 - .46          | .47            |
| .48         | .49 - .54          | .55            |
| .56         | .57 - .62          | .63            |
| .64         | .65 - .70          | .71            |
| .72         | .73 - .78          | .79            |
| .80         | .81 - .86          | .87            |
| .88         | .89 - .94          | .95            |
| .96         | .97 - .102         | .103           |
| .104        | .105 - .110        | .111           |
| .112        | .113 - .118        | .119           |
| .120        | .121 - .126        | .127           |

### Conclusion

Subnetting is essential for network management, allowing for better organization and security by splitting a network into smaller sub-networks. By understanding how subnet masks correspond to network size, IP ranges, and broadcast addresses, you can more efficiently plan and allocate your network’s resources. Keep this cheat sheet handy for when you need a quick reference on subnet masks and their corresponding configurations!
