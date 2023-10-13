---
title: "How to Use tcpdump to Capture Incoming Traffic"
date: 2023-10-13T11:30:00-05:00
draft: false
tags: ["tcpdump", "Network Monitoring", "Traffic Capture"]
categories:
- Network Tools
- Network Monitoring
author: "Matthew Mattox - mmattox@support.tools."
description: "A guide on using tcpdump to capture incoming network traffic."
more_link: "yes"
---

## How to Use tcpdump to Capture Incoming Traffic

If you need to capture incoming network traffic using `tcpdump`, the most reliable option is to use the `-Q` option as follows:

```bash
tcpdump -Qin other filter logic
```

The `-Q` option may not be supported on all platforms, and an alternative is to use equivalent logic in BPF (Berkeley Packet Filter) syntax in the form of the `inbound` predicate:

```bash
tcpdump inbound and other filter logic
```

However, this typically requires a couple of packets to be processed to determine the directionality, and `tcpdump` may not capture those initial packets; the `-Q` option does not suffer from this drawback.

Please note that both these options treat all packets on the loopback interface as inbound, as there is no clear directionality for loopback packets. Therefore, whether to view them as inbound, outbound, both, or neither is somewhat arbitrary. Both these options are consistent in viewing loopback packets as inbound only; in particular, neither `tcpdump -ilo -Qout` nor `tcpdump -ilo outbound` will capture any packets.
