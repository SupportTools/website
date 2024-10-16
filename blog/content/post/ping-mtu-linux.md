---
title: "Using the ping Command to Help Determine the Correct MTU Setting for Your Network"
date: 2024-10-22T08:45:00-05:00
draft: false
tags: ["ping", "MTU", "Linux", "Networking"]
categories:
- Networking
- Linux
author: "Matthew Mattox - mmattox@support.tools"
description: "A guide on using the Linux ping command to identify and verify correct MTU settings for your network."
more_link: "yes"
url: "/ping-mtu-linux/"
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
- `-s`: Specifies the packet size (MTU minus 28 bytes, since 28 bytes are used for headers).
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

However, if the MTU is mismatched, you will see the following error message:

```bash
From test1.example.local (192.168.1.112) icmp_seq=1 Frag needed and DF set (mtu = 1500)
```

This message indicates that the network is trying to fragment the packet because the device is set to an MTU of 1500 bytes, not 9000.

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

### Step 4: Adjust the MTU Setting

If a mismatch is detected, adjust the MTU settings on the network device to match the desired MTU. After making changes, run the `ping` command again to verify the MTU setting.

### Conclusion

By using the `ping` command with the `-M do` and `-s` flags, you can easily verify if the MTU settings in your network are correct and consistent across all devices. This helps ensure optimal performance, especially in environments where jumbo frames are enabled. Regularly checking MTU settings can prevent packet fragmentation and improve overall network efficiency.
