---
title: "Subnet Mask Cheat Sheet"
date: 2024-10-19T14:00:00-05:00
draft: false
tags: ["Networking", "Subnetting", "IP"]
categories:
- Networking
- Subnetting
author: "Matthew Mattox - mmattox@support.tools"
description: "A detailed cheat sheet for subnet masks, IP ranges, and their broadcast addresses."
more_link: "yes"
url: "/subnet-mask-cheat-sheet/"
---

## Subnet Mask Cheat Sheet

Understanding subnet masks is crucial for anyone managing networks, especially when dealing with IP address allocation and routing. In this cheat sheet, we’ll go over various subnet masks, their corresponding address ranges, host counts, and how they relate to a Class C network. If you're working with network segmentation, this guide will serve as a handy reference.

<!--more-->

### Subnet Masks Overview

The table below lists common subnet masks, the number of available hosts, and the corresponding netmask for each subnet size:

| **CIDR Notation** | **Addresses** | **Usable Hosts** | **Netmask**           | **Fraction of Class C** |
|-------------------|---------------|------------------|-----------------------|-------------------------|
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

### Subclassing a Class C Network

Below are examples of how to break down a Class C network (`/24`) into smaller subnets, along with their corresponding IP ranges and broadcast addresses.

#### /25 — 2 Subnets, 126 Hosts per Subnet

| **Network** | **IP Range**       | **Broadcast**  |
|-------------|--------------------|----------------|
| .0          | .1 - .126          | .127           |
| .128        | .129 - .254        | .255           |

#### /30 — 64 Subnets, 2 Hosts per Subnet

| **Network** | **IP Range**       | **Broadcast**  |
|-------------|--------------------|----------------|
| .0          | .1 - .2            | .3             |
| .4          | .5 - .6            | .7             |
| .8          | .9 - .10           | .11            |
| .12         | .13 - .14          | .15            |
| ...         | ...                | ...            |
| .248        | .249 - .250        | .251           |
| .252        | .253 - .254        | .255           |

#### /26 — 4 Subnets, 62 Hosts per Subnet

| **Network** | **IP Range**       | **Broadcast**  |
|-------------|--------------------|----------------|
| .0          | .1 - .62           | .63            |
| .64         | .65 - .126         | .127           |
| .128        | .129 - .190        | .191           |
| .192        | .193 - .254        | .255           |

#### /27 — 8 Subnets, 30 Hosts per Subnet

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

#### /28 — 16 Subnets, 14 Hosts per Subnet

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

#### /29 — 32 Subnets, 6 Hosts per Subnet

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
