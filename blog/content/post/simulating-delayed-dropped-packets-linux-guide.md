---
title: "Simulating Delayed and Dropped Packets in Linux"
date: 2023-10-12T23:59:00-05:00
draft: false
tags: ["Linux", "Networking", "Packet Simulation"]
categories:
- Linux
- Networking
- Packet Manipulation
author: "Matthew Mattox - mmattox@support.tools"
description: "A guide on simulating delayed and dropped packets in Linux."
more_link: "yes"
---

## Simulating Delayed and Dropped Packets in Linux

If you're wondering how to simulate delayed and dropped packets in Linux, the standard method involves using the `netem` scheduling policy. This can be applied to any network device, whether a network interface or a bridge, using the `tc` command from the `iproute2` suite of tools.

You can find more information about `iproute2` here: [iproute2 Documentation](https://wiki.linuxfoundation.org/networking/iproute2)

Here are a few examples of how to achieve this:

- Adding a 10ms delay to every packet transmitted on `eth0`:

```bash
tc qdisc add dev eth0 root netem delay 10ms
```

- Adding a 10ms delay and 20ms jitter to every packet bridged by `br0`:

```bash
tc qdisc add dev br0 root netem delay 10ms 20ms
```

- Randomly dropping approximately one percent of packets transmitted on `eth1`:

```bash
tc qdisc add dev eth1 root netem loss 1%
```

The `netem` scheduler has evolved into a highly sophisticated emulator with various possible behaviors. For more detailed information, refer to the `tc-netem.8` man page from `iproute2`. For the definitive documentation, you can explore the source code at `linux-4.XX.X/net/sched/sch_netem.c`. This source code provides a detailed explanation of the Markov model used and references for further reading.
