---
title: "Find the Correct MTU With ping on Linux (ping -M do -s)"
date: 2024-10-22T08:45:00-05:00
lastmod: 2026-10-23
draft: false
tags: ["ping", "MTU", "Linux", "Networking"]
categories:
- Networking
- Linux
author: "Matthew Mattox - mmattox@support.tools"
description: "Test MTU on Linux with ping -M do -s: use 1472 for a 1500 MTU and 8972 for 9000 jumbo frames. How to read the errors and find the real path MTU."
more_link: "yes"
url: "/ping-mtu-linux/"
quick_fix: |
  Send a non-fragmentable ping sized to the MTU minus 28 bytes of IPv4 and ICMP headers:
  `ping -M do -s 1472 -c 4 HOST` tests a 1500 MTU, `ping -M do -s 8972 -c 4 HOST` tests 9000 jumbo frames.
  If it fails, lower `-s` until replies come back, or run `tracepath HOST` to see the path MTU.
---

## Using the `ping` Command to Help Determine the Correct MTU Setting for Your Network

In network environments, ensuring that all devices, including nodes and switches, have matching **MTU (Maximum Transmission Unit)** settings is critical for optimal performance. Mismatched MTU settings can lead to packet fragmentation, which reduces efficiency and can impact application performance. This guide will show how to use the `ping` command on Linux to verify that the correct MTU is set for your network.

<!--more-->

### What is MTU and Why It’s Important

**MTU** refers to the largest size of a packet that can be transmitted over a network without needing to be fragmented. For example, a typical MTU for Ethernet is 1500 bytes, but in some environments, **jumbo frames** with larger MTU values (such as 9000) are used to enhance performance.

If there’s a mismatch in MTU settings between devices, packets may need to be fragmented, leading to performance degradation. To avoid this, you can use the `ping` command to check whether all devices support the desired MTU.

### Determining the MTU Setting on Linux

On Linux, you can use the `ping` command with several flags to test the MTU. This is particularly useful for validating if all nodes and networking devices in your environment are using the correct MTU, especially in environments like Nutanix clusters, where performance optimization is essential.

### Using `ping` to Test MTU Settings

To test the MTU, we’ll use the following options:

- `-M do`: Tells `ping` not to fragment the packets (this checks if the network supports the specified MTU).
- `-s`: Specifies the ICMP payload size (MTU minus 28 bytes: 20 bytes of IPv4 header plus 8 bytes of ICMP header).
- `-c`: Specifies the number of packets to send.

#### Step 1: Calculate the Packet Size

If you are targeting an MTU of 9000 bytes, subtract 28 from 9000 to get the packet size:

```bash
9000 - 28 = 8972
```

This packet size (8972 bytes) will be used for testing the MTU.

#### Step 2: Run the `ping` Command

Run the following command to test the MTU on Linux:

```bash
ping REMOTE_HOSTNAME -c 10 -M do -s 8972
```

In this command:

- `REMOTE_HOSTNAME` is the hostname or IP address of the remote device.
- `-c 10` sends 10 pings.
- `-M do` ensures the packets aren't fragmented.
- `-s 8972` sets the packet size to 8972 bytes, assuming an MTU of 9000.

#### Step 3: Analyze the Output

If the MTU settings match, `ping` will return normal results, similar to the following:

```bash
PING test.example.local (192.168.1.80) 8972(9000) bytes of data.
8972 bytes from test.example.local (192.168.1.80): icmp_seq=1 ttl=64 time=0.432 ms
8972 bytes from test.example.local (192.168.1.80): icmp_seq=2 ttl=64 time=0.418 ms
```

However, if the MTU is mismatched, you will see one of two errors. If a router or another host on the path has a smaller MTU, it answers with:

```bash
From test1.example.local (192.168.1.112) icmp_seq=1 Frag needed and DF set (mtu = 1500)
```

This message means a device on the path (here `192.168.1.112`) has an MTU of 1500 bytes, not 9000, and could not forward the packet because the Don't Fragment bit is set.

If your own interface has the smaller MTU, the packet never leaves the host and `ping` prints a local error instead. Newer iputils versions print the first line, older ones the second:

```bash
ping: sendmsg: Message too long
ping: local error: message too long, mtu=1500
```

In that case check the local interface first with `ip link show dev eth0` and look at the `mtu` value.

> [!NOTE]
> A silent timeout (no replies and no error) can also mean an MTU mismatch: some switches and firewalls drop oversized frames without sending "Frag needed". Retry with a small size such as `-s 1000` to prove the host is reachable at all.

### Example Output for a Mismatched MTU

```bash
ping -c 10 -M do -s 8972 test.example.local
```

Output:

```bash
PING test.example.local (192.168.1.80) 8972(9000) bytes of data.
From test1.example.local (192.168.1.112) icmp_seq=1 Frag needed and DF set (mtu = 1500)
From test1.example.local (192.168.1.112) icmp_seq=1 Frag needed and DF set (mtu = 1500)
```

This indicates that the MTU is mismatched, and the packet size is too large for the network path. The MTU on the device (1500) does not match the desired setting (9000).

### Step 4: Find the Largest Size That Works

If you do not know the path MTU, let `tracepath` discover it. It does not need root:

```bash
tracepath -n REMOTE_HOSTNAME
```

The `pmtu` value on each hop and the final `Resume: pmtu` line show the largest packet the path accepts. You can also lower `-s` by hand until replies come back; the working size plus 28 is the path MTU.

### Step 5: Adjust the MTU Setting

If a mismatch is detected, adjust the MTU settings on the network device to match the desired MTU. On Linux you can change it temporarily with `ip link set dev eth0 mtu 9000` and make it permanent in your network configuration (for example `mtu: 9000` in netplan). Every device in the layer 2 path, including switch ports, must allow the larger frame. After making changes, run the `ping` command again to verify the MTU setting.

### Quick Reference: Sizes and Other Operating Systems

| Target MTU | IPv4 `ping -s` size | IPv6 `ping -6 -s` size |
|---|---|---|
| 1500 | 1472 | 1452 |
| 1450 (common VXLAN overlay) | 1422 | 1402 |
| 9000 | 8972 | 8952 |

IPv6 uses a 40 byte header plus 8 bytes of ICMPv6, so subtract 48 instead of 28.

The same test on other systems:

- Windows: `ping -f -l 1472 HOST` (`-f` sets Don't Fragment, `-l` is the payload size)
- macOS: `ping -D -s 1472 HOST` (`-D` sets Don't Fragment)

## FAQ

### Why subtract 28 bytes?

`-s` sets the ICMP data size, not the packet size. The IPv4 header (20 bytes) and the ICMP header (8 bytes) are added on top, so a 1472 byte payload makes a 1500 byte IP packet.

### What is the difference between `-M do` and `-M probe`?

`-M do` sets the Don't Fragment bit and lets the kernel reject packets larger than the path MTU it already knows, which is why you can get a local error. `-M probe` also sets Don't Fragment but bypasses the kernel's cached PMTU, which is useful when you want to probe the path again after changing an MTU.

### Why do pods or VMs fail with large transfers but ping works?

Default `ping` sends 64 byte packets, which always fit. Overlays such as VXLAN, Geneve or WireGuard add headers, so the inner MTU must be lower than the physical one (for example 1450 for VXLAN on a 1500 network). Test with the full size from inside the pod or VM to find the problem.

### Do I need root to run these tests?

No. `ping -M do -s` and `tracepath` work as a normal user on current Linux distributions.

## Related Guides

- [Kubernetes VXLAN Networking](/training/networking/kubernetes-vxlan/)
- [Advanced Cilium Troubleshooting Guide](/post/cilium-troubleshooting-2025/)
- [How to Use tcpdump to Capture Incoming Traffic](/post/using-tcpdump-capture-incoming-traffic-guide/)
- [WireGuard vs IPSec Performance Guide](/advanced-vpn-technologies-wireguard-ipsec-performance-guide/)
