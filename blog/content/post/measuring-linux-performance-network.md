---
title: "Measuring Linux Network Performance Correctly: Bandwidth, Latency, Packets, and the Mistakes That Hide Real Problems"
date: 2032-05-03T09:00:00-05:00
draft: false
tags: ["Linux", "Networking", "Performance", "Kubernetes", "ss", "ethtool", "iperf3", "sar", "conntrack", "TCP", "Observability", "DevOps"]
categories:
- Performance
- Networking
- Linux
author: "Matthew Mattox - mmattox@support.tools"
description: "A practical guide to measuring Linux network performance correctly: bandwidth vs latency vs packet rate, throughput vs goodput, retransmits and drops, NIC and ring-buffer stats, socket states, and Kubernetes CNI concerns."
more_link: "yes"
url: "/measuring-linux-performance-network/"
---

A server with a "10 Gigabit" NIC can still feel slow, drop connections under load, and miss its latency targets while every dashboard you own shows the link sitting at twenty percent utilization. The reason is that "network performance" is not one number. It is at least four independent properties -- **bandwidth**, **latency**, **packet rate**, and **loss** -- and a workload can be perfectly healthy on three of them while one is on fire. The most common mistake teams make is collapsing all four into a single "Mbps" graph, watching that graph stay green, and concluding the network is fine while the actual bottleneck goes unmeasured.

This is part four of the **Measuring Linux Performance** series. The earlier posts covered CPU, memory, and storage; the same theme runs through all of them: the default tools answer the question you asked, not the question you needed to ask. This post focuses on the network -- what to measure, which counters actually mean something, how to test throughput without fooling yourself, and the specific failure modes that show up in Kubernetes clusters where every packet crosses a CNI overlay, a `conntrack` table, and a pile of `iptables` rules before it reaches your application.

<!--more-->

## Note on This Series

This article is one part of a five-part series on measuring Linux performance correctly and avoiding the most common measurement mistakes. If you arrived here looking for CPU, memory, or storage, the full set is linked at the end. Each post stands alone, but the recap post ties the recurring mistakes together.

## The Four Properties of a Network, and Why You Cannot Average Them

Before touching a single command, you need a mental model. A network link has four measurable properties that move independently:

- **Bandwidth** is capacity: how many bits per second the path can carry. This is what NIC speeds advertise (`1000baseT`, `10000baseT`) and what your provider sells you. It is a ceiling, not a measurement of what you are using.
- **Throughput** is how many bits per second you are actually moving, on the wire, right now. It is bounded by bandwidth but is usually far below it.
- **Latency** is the time for a packet to travel from source to destination (one-way) or there and back (round-trip time, or **RTT**). It is governed by distance, queueing, and processing -- not by how fast the link is.
- **Packet rate** is **packets per second (pps)**: how many discrete packets the system handles, regardless of their size.

The trap is averaging. A 10 Gbit/s link carrying 2 Gbit/s of large file-transfer traffic is barely working. The same link carrying 2 Gbit/s of tiny 64-byte packets -- think a DNS resolver, a metrics scraper, or a high-frequency RPC service -- may be completely saturated on the **packet-per-second** dimension while the bandwidth graph still reads twenty percent. Modern NICs and the kernel network stack run out of *per-packet processing budget* long before they run out of *bits-per-second capacity* on small-packet workloads. If your only graph is utilization in Mbps, this failure is invisible.

The corollary is that you must always know which property is your constraint before you start optimizing. Tuning TCP window sizes does nothing for a packet-rate problem. Adding bandwidth does nothing for a latency problem. The whole point of measuring correctly is to identify which of the four properties is actually limiting you.

### Throughput Versus Goodput

There is a fifth number worth naming because people quote it wrong constantly: **goodput**. Throughput counts every bit on the wire, including TCP/IP headers, retransmitted segments, and protocol overhead. Goodput counts only the application-layer bytes that were actually delivered and used. On a clean link the gap is the fixed header tax (roughly 5-8% for typical MTUs). On a lossy link, retransmits inflate throughput while goodput collapses -- you are moving bits, just not *useful* bits. When a user says "the transfer is slow" and your throughput graph looks healthy, the missing variable is almost always goodput eroded by retransmissions.

The header tax is not abstract; it is arithmetic you should be able to do in your head. A standard 1500-byte Ethernet frame carrying TCP over IPv4 spends 20 bytes on the IP header and 20 on the TCP header (more with timestamps and other options), leaving roughly 1460 bytes of payload. That is a best-case efficiency of about 97% *for full-size frames*. Now shrink the payload: a 64-byte packet carrying a few bytes of application data spends most of its frame on headers and framing overhead, so goodput as a fraction of throughput craters even though the link is perfectly healthy. This is the same effect that makes small-packet workloads a packet-rate problem rather than a bandwidth problem -- the overhead is per-packet, so the more packets you send to move a fixed amount of data, the more of your bandwidth and CPU budget evaporates into headers.

### Why Packet Rate Is a CPU Problem in Disguise

The reason packet rate matters so much is that every packet costs the host a roughly fixed amount of CPU work regardless of its size: an interrupt or poll cycle, a trip through the network stack, a `conntrack` lookup, an `iptables`/`nftables` traversal, a socket-buffer copy, and a wakeup of the receiving process. A host that comfortably moves 9 Gbit/s of 1500-byte frames can fall over at a fraction of that bandwidth when the same bits arrive as 64-byte packets, because the *number of packets* -- and therefore the number of times the kernel runs that per-packet path -- is twenty-plus times higher.

This is why packet-rate ceilings frequently show up first as a **softirq** CPU problem, not a network alarm. The kernel processes received packets in software interrupt context, and on a busy host you will see one or more CPUs pinned in `%soft` (or a `ksoftirqd` kernel thread saturating a core) while bandwidth utilization looks modest. Watch it directly:

```bash
# %soft is the softirq time per CPU; a single core pinned here under a small-packet
# flood is the signature of a packet-rate (not bandwidth) ceiling. -P ALL: per-CPU.
mpstat -P ALL 2 3
```

```text
09:18:04  CPU   %usr  %sys  %soft  %idle
09:18:06    0   2.01  3.52  41.71  52.10
09:18:06    1   1.50  2.00   0.50  95.50
09:18:06    2   1.75  2.25   0.75  94.75
```

CPU 0 is spending 41% of its time in softirq while the other cores idle. That is a single-queue NIC funneling all receive processing onto one core -- a classic packet-rate bottleneck that more bandwidth cannot fix. The remedy lives in the NIC's multi-queue and RSS (Receive Side Scaling) configuration, which spreads receive processing across cores; you can see how many queues exist with `ethtool -l eth0` and which CPUs they map to in `/proc/interrupts`. The measurement discipline is the point: a bandwidth dashboard would show this host as nearly idle while one CPU drowns.

## Latency First: ping, RTT, and the Application-Level Truth

Latency is where most "the network is slow" complaints actually live, and it is the property people measure most carelessly. The reflex is to run `ping`, see a low number, and declare the network healthy. That conclusion is wrong more often than it is right.

Start with `ping` anyway, because it establishes a floor:

```bash
# -c 20: send 20 probes, -i 0.2: 200ms apart, -q: quiet (summary only)
ping -c 20 -i 0.2 -q 10.0.4.31
```

```text
--- 10.0.4.31 ping statistics ---
20 packets transmitted, 20 received, 0% packet loss, time 3804ms
rtt min/avg/max/mdev = 0.182/0.241/0.498/0.071 ms
```

Read all four numbers in that last line, not just the average. The value that matters most for user-facing latency is `mdev` -- the mean deviation, a proxy for **jitter**. An average of 0.241 ms looks great, but if `max` were 40 ms with a high `mdev`, you would have a tail-latency problem that the average hides completely. Averages lie about latency because latency distributions are not symmetric; a few slow packets among many fast ones barely move the mean while ruining the p99 your users actually experience.

`ping` measures ICMP echo, which the kernel often handles on a fast path that has nothing to do with your application's socket. The most accurate latency measurement is always at the application layer -- the time your service measures between sending a request and receiving a response. ICMP can be fast while your TCP service is slow because of accept-queue backlog, TLS handshakes, or application-thread starvation. Treat `ping` as a lower bound on what is possible, never as the latency your users see.

### mtr: Per-Hop Latency and Loss

When latency is high and you need to know *where*, `mtr` combines `traceroute` and `ping` to show loss and latency at every hop:

```bash
# --report: run a fixed batch and print a table, -c 50: 50 cycles, -w: wide output
mtr --report --report-wide -c 50 cache-01.internal.example.com
```

```text
Start: 2032-05-03T09:02:11-0500
HOST: ingress-node-7              Loss%   Snt   Last   Avg  Best  Wrst StDev
  1.|-- 10.0.0.1                   0.0%    50    0.3   0.4   0.2   1.1   0.1
  2.|-- 10.0.8.2                   0.0%    50    0.5   0.6   0.4   2.3   0.3
  3.|-- 100.64.3.9                12.0%    50    8.4   9.1   7.9  41.2   5.6
  4.|-- cache-01.internal          0.0%    50    1.2   1.3   1.0   3.4   0.4
```

The critical skill here is reading loss correctly. Loss at hop 3 that *does not persist* to hop 4 is usually a router rate-limiting its own ICMP responses, not real packet loss -- routers deprioritize generating ICMP for their own address while happily forwarding your traffic. Real loss shows up at a hop *and every hop after it*. In the output above, the 12% at hop 3 vanishes at hop 4, so the destination is fine; that hop is just deprioritizing ICMP. Misreading this single line sends teams chasing phantom loss on transit links they do not even own.

`mtr` defaults to ICMP probes, which some firewalls and load balancers handle differently from real traffic. When you need the path your *application* actually takes, switch `mtr` to TCP probes against the real service port so the measurement traverses the same firewall rules and ECMP hashing as production traffic:

```bash
# -T: TCP SYN probes, -P 443: target port 443 -- follows the same path as HTTPS
# traffic rather than an ICMP path that firewalls may route differently.
mtr --report -T -P 443 -c 50 cache-01.internal.example.com
```

The difference is not academic. ECMP (equal-cost multipath) routers hash flows across multiple parallel links, and ICMP and TCP can hash to different physical paths. An ICMP `mtr` that looks clean while TCP `mtr` shows loss is telling you one member of an ECMP bundle is degraded -- a real, production-affecting fault that the ICMP-only view would have declared healthy.

### Measuring Latency at the Application Layer

Because ICMP and even TCP-probe `mtr` measure the network path and not your service, the most truthful latency number is one your own request path produces. For a quick connection-establishment measurement that includes the TCP handshake and TLS, `curl` exposes per-phase timing:

```bash
# Print the time spent in DNS, TCP connect, TLS, and time-to-first-byte. This
# decomposes "the request is slow" into which layer actually added the delay.
curl -o /dev/null -s -w \
  'dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total}\n' \
  https://cache-01.internal.example.com/healthz
```

```text
dns=0.004 connect=0.006 tls=0.041 ttfb=0.058 total=0.061
```

Reading the deltas between phases isolates the cost: `connect - dns` is the TCP round trip, `tls - connect` is the handshake cost, and `ttfb - tls` is the server's think time. If `ttfb` dominates while `connect` is tiny, the network is fine and the application is slow -- the exact distinction that "the network is slow" tickets usually get wrong. This is the application-level truth that no `ping` can provide, and it is the number to trend in production via synthetic probes.

## Socket State and Retransmits: ss and the TCP Truth

Once latency is understood, the next question is whether TCP itself is healthy. The single best tool for this on a modern Linux host is `ss`, which has replaced `netstat` for almost everything. The `-i` flag exposes per-socket TCP internals that no bandwidth graph can show you.

```bash
# -t TCP, -i internal info, -n numeric, -p process, state connected
ss -tinp state established
```

```text
ESTAB 0  0  10.0.4.12:443  10.0.9.55:54012  users:(("nginx",pid=2210,fd=31))
     cubic wscale:7,7 rto:204 rtt:1.8/0.9 ato:40 mss:1448 pmtu:1500
     cwnd:42 ssthresh:21 bytes_sent:18204412 bytes_retrans:148320
     retrans:0/213 dsack_dups:11 delivered:12894 rcv_rtt:2.1 rcv_space:64080
```

Three fields in that block tell you most of what you need:

- `rtt:1.8/0.9` is the smoothed RTT and its variance, measured by the kernel *for this specific connection*. This is far more honest than `ping` because it reflects the real TCP path including any application-induced delay.
- `retrans:0/213` means 0 currently-outstanding retransmits out of 213 total over the connection's life. The total matters: 213 retransmits on a connection that delivered 12,894 segments is a retransmit rate worth investigating.
- `bytes_retrans:148320` against `bytes_sent:18204412` is the byte-level retransmission ratio -- here about 0.8%. Anything above roughly 1-2% on a LAN is a red flag; it directly destroys goodput.

To get a cluster-wide retransmit number instead of per-socket detail, `nstat` reads the kernel's SNMP counters and, unlike `netstat -s`, can show the *delta* since last run:

```bash
# nstat with no args prints counters that changed since the last invocation
nstat -z TcpRetransSegs TcpExtTCPLostRetransmit TcpExtTCPSynRetrans
```

```text
#kernel
TcpRetransSegs                  1842               0.0
TcpExtTCPSynRetrans             36                 0.0
TcpExtTCPLostRetransmit         4                  0.0
```

`TcpExtTCPSynRetrans` deserves special attention: SYN retransmissions mean *new* connections are being dropped or delayed during the handshake. A growing SYN-retransmit count under load almost always points at an undersized accept queue (`net.core.somaxconn`, the listen backlog) or SYN-flood protection kicking in -- both of which manifest to users as "the site randomly hangs for a few seconds when I click."

The full `/proc/net/snmp` and `/proc/net/netstat` files are where these counters live, and `nstat` is simply a friendlier delta-aware reader of them. When you want the raw, unfiltered view -- for example to script a check or to see a counter `nstat` does not know by name -- read them directly:

```bash
# /proc/net/snmp holds the base IP/TCP/UDP MIB counters; /proc/net/netstat holds
# the Linux-specific TcpExt and IpExt extensions. These are the source of truth.
grep -E '^Tcp:' /proc/net/snmp
grep -E 'TCPSynRetrans|TCPTimeouts|TCPLostRetransmit|TCPSpuriousRTOs' /proc/net/netstat
```

```text
Tcp: RtoAlgorithm RtoMin RtoMax MaxConn ActiveOpens PassiveOpens AttemptFails ...
Tcp: 1 200 120000 -1 482113 1240887 1842 ...
TcpExt: ... TCPSynRetrans 36 TCPTimeouts 211 TCPLostRetransmit 4 TCPSpuriousRTOs 7
```

`TCPSpuriousRTOs` is a subtle but valuable counter: a *spurious* retransmission timeout means the kernel retransmitted because an ACK was late, then discovered the original was fine. A rising spurious-RTO count points at latency spikes or reordering rather than true loss, which changes the fix entirely -- you tune timers or chase a jittery path, not a lossy one.

### Reading Congestion Control and Socket Memory

The `ss -i` output earlier opened with `cubic` -- the congestion-control algorithm this socket is using. That single word matters when you are diagnosing throughput on long, fat, or lossy paths. CUBIC is loss-based: it treats packet loss as the signal to back off, which on a lossy long-distance link can leave throughput far below capacity. BBR is model-based and often dramatically outperforms CUBIC on such paths. Check what is configured and what is available:

```bash
# The default algorithm new sockets use, and the set the kernel has loaded.
sysctl net.ipv4.tcp_congestion_control net.ipv4.tcp_available_congestion_control
```

```text
net.ipv4.tcp_congestion_control = cubic
net.ipv4.tcp_available_congestion_control = reno cubic bbr
```

If `ss -i` shows high retransmits *and* CUBIC *and* a high-RTT path, switching that workload to BBR is a legitimate experiment -- but only after you have measured the retransmit rate, never as a blind default. The measurement justifies the change.

Socket memory limits are the other invisible throttle. The kernel autotunes per-socket send and receive buffers between the minimum, default, and maximum in `tcp_wmem`/`tcp_rmem`. On a high-bandwidth, high-RTT path the bandwidth-delay product can exceed the configured maximum, and the window simply cannot grow large enough to fill the link -- a throughput ceiling with no loss and no errors:

```bash
# Three values each: min, default, max (bytes). The max bounds how large the
# TCP window can autotune; too small caps throughput on high-BDP paths.
sysctl net.ipv4.tcp_rmem net.ipv4.tcp_wmem net.core.rmem_max net.core.wmem_max
```

```text
net.ipv4.tcp_rmem = 4096 131072 6291456
net.ipv4.tcp_wmem = 4096 16384 4194304
net.core.rmem_max = 212992
net.core.wmem_max = 212992
```

Here is a classic misconfiguration: `tcp_rmem` allows a 6 MB receive buffer, but `net.core.rmem_max` caps it at ~208 KB. The lower limit wins, so the window can never reach the size `tcp_rmem` implies. On a 10 Gbit/s link with 30 ms RTT the bandwidth-delay product is roughly 37 MB; a 208 KB window caps a single stream at well under 100 Mbit/s no matter how clean the link is. You will find this only by reading the buffer limits and computing the BDP -- never by staring at a utilization graph that simply shows the link mostly idle.

### Socket-State Census with ss -s

Before drilling into individual sockets, a one-line census of socket states often points straight at the problem class. `ss -s` summarizes counts by state:

```bash
# Summary of total sockets and TCP state counts -- a fast triage of "what kind
# of socket problem do I have" before looking at individual connections.
ss -s
```

```text
Total: 18432
TCP:   17201 (estab 9120, closed 7402, orphaned 3, timewait 7388)
```

A huge `timewait` count (here 7,388) is normal for a busy short-lived-connection server, but a *runaway* TIME-WAIT count approaching `net.ipv4.tcp_max_tw_buckets` means new outbound connections start failing because the kernel runs out of ephemeral ports or TIME-WAIT slots -- presenting as intermittent connection failures from a client that "should" have plenty of capacity. A large `orphaned` count points at sockets whose application closed without draining, consuming kernel memory. The census tells you which subsequent measurement to run.

### Listen-Queue Drops: The Silent Connection Killer

The accept queue overflow is so common and so invisible that it deserves its own measurement. When an application is not calling `accept()` fast enough, completed connections pile up in the kernel's accept queue. Once it overflows, the kernel silently drops the connection -- no error in your application logs, just a client that times out.

```bash
# -l listening sockets, -t TCP; Recv-Q on a listener = current accept-queue depth,
# Send-Q = the configured backlog maximum
ss -ltn
```

```text
State   Recv-Q  Send-Q  Local Address:Port  Peer Address:Port
LISTEN  0       4096    0.0.0.0:443         0.0.0.0:*
LISTEN  128     128     0.0.0.0:8080        0.0.0.0:*
```

For a *listening* socket, `Recv-Q` is the number of established connections waiting to be accepted and `Send-Q` is the backlog limit. The first line is healthy: queue empty, limit 4096. The second is alarming: `Recv-Q` equals `Send-Q` at 128, meaning the queue is full and the next connection will be dropped. Confirm the overflow with the dedicated counter:

```bash
# Each increment is one connection dropped because the accept queue was full
nstat -z TcpExtListenOverflows TcpExtListenDrops
```

```text
#kernel
TcpExtListenOverflows           291                0.0
TcpExtListenDrops               291                0.0
```

A non-zero, *growing* `ListenOverflows` is unambiguous: connections are being dropped before your application ever sees them. The fix is raising the backlog in the application's `listen()` call and `net.core.somaxconn`, then scaling the workers that call `accept()`. No bandwidth graph will ever show this; the link can be idle while connections die in the queue.

## Interface Counters: ip -s and ethtool -S

So far we have looked at TCP. Below TCP sits the interface, and the interface keeps its own counters that reveal hardware and driver-level loss the TCP layer cannot. The portable first stop is `ip -s link`:

```bash
# -s adds statistics; repeat (-s -s) for detailed error breakdowns
ip -s -s link show eth0
```

```text
2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP mode DEFAULT
    link/ether 0a:1b:2c:3d:4e:5f brd ff:ff:ff:ff:ff:ff
    RX:  bytes      packets   errors  dropped  missed   mcast
    9123847221     71204418  0        18421    9043     1204
    TX:  bytes      packets   errors  dropped  carrier  collsns
    44820013338    63991002  0        0        0        0
```

The columns that matter are not `bytes` -- they are `errors`, `dropped`, and `missed`. A non-zero `errors` count points at the physical layer: a failing cable, a bad SFP, or a duplex mismatch. `dropped` and `missed` on RX usually mean the kernel could not pull packets off the NIC fast enough -- the **ring buffer** overflowed because softirq processing fell behind, often under a packet-per-second flood. These drops happen *before* any TCP counter increments, so a host can be losing packets at the NIC while `ss` shows clean sockets.

For the real hardware truth, `ethtool -S` dumps the driver's private statistics, which are far more detailed than anything the generic stack exposes:

```bash
# Driver-specific stats; names vary by NIC. Filter to the counters that matter.
ethtool -S eth0 | grep -E 'drop|err|miss|fifo|rx_no_buffer|rx_missed'
```

```text
     rx_dropped: 18421
     rx_missed_errors: 9043
     rx_no_buffer_count: 9043
     rx_fifo_errors: 9043
     tx_dropped: 0
     rx_crc_errors: 0
```

`rx_missed_errors` and `rx_no_buffer_count` climbing together are the classic signature of a ring buffer that is too small for the offered packet rate. Check and raise the ring with `ethtool` itself:

```bash
# -g shows current/maximum ring sizes; -G sets them
ethtool -g eth0
```

```text
Ring parameters for eth0:
Pre-set maximums:
RX:             4096
TX:             4096
Current hardware settings:
RX:             512
TX:             512
```

When `rx_missed_errors` is climbing and the RX ring is set to 512 out of a possible 4096, raising it gives the kernel more slack to absorb bursts:

```bash
# Raise RX/TX ring buffers toward the hardware maximum to absorb packet bursts
ethtool -G eth0 rx 4096 tx 4096
```

A larger ring trades a small amount of latency for a large reduction in burst drops. It is the correct fix for `rx_missed_errors` under bursty load and the wrong fix for `errors` caused by bad cabling -- which is exactly why you must read the *specific* counter before acting. Raising the ring buffer to paper over CRC errors just hides a hardware fault.

### RX/TX Queues and Where the Work Lands

The ring buffer is per-queue, and modern NICs have multiple hardware queues so that receive processing can be spread across CPUs. How many queues exist, and whether they are actually being used, is a separate measurement from ring depth. List the queue configuration:

```bash
# -l (or -L to set): show combined/rx/tx queue counts. A single active queue on a
# multi-core host funnels all softirq work onto one CPU -- the packet-rate ceiling.
ethtool -l eth0
```

```text
Channel parameters for eth0:
Pre-set maximums:
Combined:       8
Current hardware settings:
Combined:       1
```

A NIC capable of 8 queues but running with 1 is processing all received traffic on a single CPU's softirq, which is the exact condition that produced the pinned-core `mpstat` output earlier. Confirm the mapping by looking at which CPUs the NIC's interrupts land on:

```bash
# Per-IRQ interrupt counts per CPU. All of a NIC's RX interrupts landing on one
# CPU column confirms a single-queue (or mis-affined) receive path.
grep -E 'eth0|CPU' /proc/interrupts | head
```

When the interrupts are concentrated on one CPU, raising the queue count (and letting RSS hash flows across them) spreads the load -- a packet-rate fix that no amount of bandwidth provisioning achieves. The measurement chain is: bandwidth looks fine -> one CPU pinned in `%soft` -> NIC running one queue -> raise queues. Each link in that chain is a counter you can read, and skipping straight to "add bandwidth" fixes nothing.

### MTU Mismatches and Jumbo Frames

Mismatched MTU is one of the most insidious network faults because it produces a partial failure: small packets succeed, large packets vanish. If one host is configured for jumbo frames (MTU 9000) and a switch or peer in the path is not, the small packets of a TCP handshake complete fine, so the connection establishes -- then the first full-size data segment is silently dropped, and the transfer hangs. "Ping works but the transfer stalls" is the canonical symptom. Verify the configured MTU and prove the path MTU with a do-not-fragment probe:

```bash
# Confirm the interface MTU, then probe path MTU: -M do sets don't-fragment, -s is
# the payload size. If -s 8972 (=9000 with headers) fails but -s 1472 works, the
# path does not actually support jumbo frames end to end.
ip link show eth0 | grep -o 'mtu [0-9]*'
ping -M do -s 8972 -c 3 10.0.4.31
```

```text
mtu 9000
ping: local error: message too long, mtu=1500
```

The host believes it has a 9000 MTU, but the probe reveals the path is really 1500 -- jumbo frames are not actually supported end to end, and every full-size jumbo frame is being dropped. The fix is to make MTU consistent across every device in the path; the *measurement* is the do-not-fragment probe, which is the only way to learn the real path MTU rather than the locally-configured one. This same technique is what diagnoses the Kubernetes overlay-encapsulation MTU problem covered later -- it is the same fault at a different layer.

### UDP and Socket-Buffer Drops

TCP retransmits paper over loss; UDP does not, so for UDP-heavy workloads (DNS, metrics, VoIP, video, QUIC) the drop counters are even more important. The kernel drops a UDP datagram when the receiving socket's buffer is full because the application is not reading fast enough -- and it counts those drops separately:

```bash
# Udp counters: InErrors and RcvbufErrors. RcvbufErrors climbing means the
# application is not draining its socket fast enough and datagrams are discarded.
grep -A1 '^Udp:' /proc/net/snmp
nstat -z UdpInErrors UdpRcvbufErrors UdpInDatagrams
```

```text
Udp: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors SndbufErrors InCsumErrors
Udp: 9241882 412 0 8830110 20933 0 0
```

A non-zero, growing `RcvbufErrors` (here 20,933) is a smoking gun for an application that cannot keep up with its inbound UDP rate -- the fix is a larger `SO_RCVBUF`, a faster consumer, or more receive threads, but the *diagnosis* is invisible unless you read this counter. For UDP, this single line frequently explains a "lossy network" complaint that is actually a slow consumer. The per-socket view of the same condition is the `ss -u` recv-queue:

```bash
# -u UDP, -a all, -n numeric. A persistently non-zero Recv-Q on a UDP socket is
# the per-socket version of UdpRcvbufErrors: the app is behind on reads.
ss -uan | head
```

```text
State    Recv-Q   Send-Q   Local Address:Port    Peer Address:Port
UNCONN   213440   0        10.0.4.12:8125        0.0.0.0:*
UNCONN   0        0        10.0.4.12:53          0.0.0.0:*
```

The first socket has 213 KB sitting unread in its receive queue -- a metrics receiver (port 8125, statsd) falling behind under load. That backlog is datagrams one slow consumer away from being dropped, and it is the per-socket counterpart to the cluster-wide `UdpRcvbufErrors` counter above.

### Bonded and Aggregated Links: The Aggregate Lies

Enterprise hosts frequently bond two or more NICs into a single logical interface for redundancy and throughput. The aggregate counters on the bond hide a critical failure mode: one member link can be down or degraded while the bond's totals still look healthy, because the surviving member carries the traffic. A bandwidth graph on the bond shows nothing wrong even though you have lost half your redundancy -- and the next failure takes the host offline.

Read the per-member state from the bonding driver, not the aggregate:

```bash
# The bonding driver exposes per-slave link state and the active aggregator. Check
# that every member is "up" -- the bond total hides a failed member's loss.
cat /proc/net/bonding/bond0
```

```text
Bonding Mode: IEEE 802.3ad Dynamic link aggregation
MII Status: up
Slave Interface: eth0
MII Status: up
Speed: 10000 Mbps
Slave Interface: eth1
MII Status: down
Speed: Unknown
```

`bond0` reports `up` at the top while `eth1` is `down` underneath. The host still passes traffic on `eth0`, every dashboard is green, and the operator has no idea redundancy is gone until `eth0` also fails. For LACP bonds, also confirm the switch agrees on the aggregation -- a mismatch where the host thinks it has an 802.3ad bond but the switch has the ports in individual mode produces intermittent, hard-to-reproduce loss as frames hash to a port the switch is not bundling. The lesson generalizes: whenever a counter is an aggregate over multiple physical things, the aggregate can be healthy while a component is failed, so measure the components.

### TX Drops and the Queueing Discipline

Receive drops get most of the attention, but transmit-side drops have a different cause and a different fix. A TX drop means the kernel could not hand a packet to the NIC -- usually because the queueing discipline (`qdisc`) attached to the interface ran out of buffer, which happens when the application bursts faster than the link drains. The `tc` command shows the qdisc and its own drop counters:

```bash
# Show the queueing discipline statistics for the interface. The "dropped" counter
# here is packets the qdisc could not enqueue -- a TX-side, not RX-side, drop.
tc -s qdisc show dev eth0
```

```text
qdisc mq 0: root
qdisc fq_codel 0: parent :1 limit 10240p flows 1024 quantum 1514
 Sent 44820013338 bytes 63991002 pkt (dropped 1872, overlimits 0 requeues 84)
```

A `dropped` count here points at the transmit path, and the right response depends on intent: `fq_codel` deliberately drops to control buffer bloat (which is healthy and keeps latency low), whereas drops on a simple FIFO qdisc under burst usually mean the queue is too short. The point of reading `tc -s` is to know *which* it is before you change anything -- a non-zero drop on a codel-family qdisc is often the qdisc doing its job, not a fault. Conflating TX qdisc drops with RX ring-buffer drops sends you tuning the wrong end of the stack.

## Live Rate Views: sar, iftop, and nload

Counters tell you cumulative totals. To watch rates over time, `sar` from the `sysstat` package is the workhorse, and it can read historical data after an incident -- a property no live tool has:

```bash
# -n DEV: per-interface stats, 2-second interval, 3 samples
sar -n DEV 2 3
```

```text
09:14:02   IFACE   rxpck/s   txpck/s    rxkB/s    txkB/s   %ifutil
09:14:04   eth0   48210.50  41922.00  18204.30  44102.80    36.21
09:14:06   eth0   51004.00  44188.50  19330.10  46891.40    38.50
Average:   eth0   49607.25  43055.25  18767.20  45497.10    37.36
```

Read `rxpck/s` and `txpck/s` alongside `%ifutil`. In this sample the link is only 37% utilized by bandwidth but is pushing ~50,000 packets per second per direction. If those numbers kept climbing while `%ifutil` stayed low, you would be approaching a packet-rate ceiling, not a bandwidth ceiling -- exactly the distinction that single-number dashboards erase. The companion command `sar -n EDEV 2 3` shows the per-interface *error* rates over the same windows, which is the rate-based view of the `ip -s link` counters above.

For interactive, per-connection live views, `iftop` shows which peers are consuming bandwidth right now, and `nload` gives a simple in/out gauge:

```bash
# -n: no DNS lookups (avoids blocking on slow reverse DNS), -P: show ports
iftop -i eth0 -nNP
```

These tools are for the human in front of the terminal during an incident. They are not for trending -- that is `sar`'s job, or a Prometheus node exporter scraping the same counters into a time series you can alert on.

## Testing Throughput Honestly with iperf3

Eventually you need to know what a path can actually carry, and for that you generate traffic with `iperf3`. The mistakes here are subtle enough that bad `iperf3` results regularly send teams down the wrong path entirely.

Run a server on one host and a client on the other:

```bash
# Server side: listen for tests
iperf3 -s
```

```bash
# Client: -c server, -t 30s duration, -P 4 parallel streams, -i 5 interval reporting
iperf3 -c 10.0.4.31 -t 30 -P 4 -i 5
```

```text
[SUM]   0.00-30.00  sec  31.2 GBytes  8.94 Gbits/sec  1421   sender
[SUM]   0.00-30.00  sec  31.1 GBytes  8.91 Gbits/sec        receiver
```

Three rules separate a meaningful `iperf3` result from a misleading one:

- **Run long enough.** A 5-second test never lets TCP congestion control reach steady state. Use at least 30 seconds; the first few seconds are slow-start ramp, not your real throughput.
- **Use parallel streams for high-bandwidth paths.** A single TCP stream is limited by its window and RTT (`bandwidth = window / RTT`); one stream often cannot fill a 10 Gbit/s link across any meaningful distance. The `-P 4` above lets four streams share the path, which is also a more realistic model of a busy server. If one stream gets 2 Gbit/s and four streams get 9 Gbit/s, your bottleneck was the single-stream window, not the link.
- **Watch the retransmit column.** That `1421` under `Retr` is total retransmissions during the test. A clean LAN path should be near zero. Hundreds or thousands of retransmits mean the path is lossy under load, and *that* is your real problem -- the throughput number is a symptom.

For UDP and pure packet-rate testing, add `-u` and a target bitrate. UDP testing is how you find packet-rate ceilings that TCP's congestion control hides:

```bash
# -u UDP, -b 0 means "as fast as possible", -l 64 sends tiny 64-byte datagrams
iperf3 -c 10.0.4.31 -u -b 0 -l 64 -t 20
```

Tiny-datagram UDP at maximum rate is the single best way to find the pps ceiling of a host, because it strips away payload and forces the system to spend its budget purely on per-packet work. If this test plateaus at a packet rate well below what the bandwidth would allow, you have proven a packet-rate bottleneck.

One more `iperf3` honesty rule: run the test in *both directions*. By default the client sends and the server receives. A NIC, a switch port, or a congested uplink can be asymmetric -- fast in one direction, throttled in the other -- and a one-direction test will miss it entirely. Add `-R` to reverse:

```bash
# -R reverses the direction so the server sends and the client receives. Compare
# this number to the forward test; a large gap means an asymmetric path.
iperf3 -c 10.0.4.31 -t 30 -P 4 -R
```

A forward test at 9 Gbit/s and a reverse test at 2 Gbit/s is a real, common, and easily-missed finding -- often a duplex mismatch, a half-broken bonded link, or an oversubscribed uplink in one direction. Testing only the default direction would have declared the path healthy.

### NIC Offloads and Why They Distort What You Measure

Modern NICs offload segmentation and checksum work from the CPU. Generic Receive Offload (GRO), TCP Segmentation Offload (TSO), and Generic Segmentation Offload (GSO) mean the packets the kernel *counts* are not always the packets on the *wire*: the NIC may coalesce many wire packets into one large super-packet before the stack sees it, or split one large kernel buffer into many wire frames after the stack hands it off. This is why `tcpdump` on a host with GRO enabled can show 64 KB "packets" that never existed on the cable -- a frequent source of confusion when reconciling host counters against switch port counters.

Check what is enabled before you trust a packet count:

```bash
# Show offload settings. With gro/tso/gso on, host-side packet counts reflect
# coalesced super-packets, not wire frames -- account for this when comparing to
# switch counters or when capturing with tcpdump.
ethtool -k eth0 | grep -E 'generic-receive-offload|tcp-segmentation-offload|generic-segmentation-offload'
```

```text
tcp-segmentation-offload: on
generic-segmentation-offload: on
generic-receive-offload: on
```

The takeaway is not "turn offloads off" -- they are essential for high throughput. It is that your *measurement* must account for them: a host counting 100,000 packets/s with GRO on may correspond to far more frames on the wire, so a pps comparison between the host's counters and the switch's port counters will not line up unless you know offloads are coalescing.

## Capturing Packets Without Drowning: tcpdump

When counters and tests are not enough and you need to see the actual conversation, `tcpdump` captures packets. The mistake here is capturing too much: an unfiltered capture on a busy interface drops packets (ironically skewing the very loss you are investigating) and fills the disk in minutes.

Always filter tightly and bound the capture:

```bash
# -i interface, -nn no name/port resolution, -c 200 stop after 200 packets,
# -w write to file; the filter limits capture to one host and port
tcpdump -i eth0 -nn -c 200 -w /tmp/trace.pcap 'host 10.0.9.55 and tcp port 443'
```

```text
tcpdump: listening on eth0, link-type EN10MB (Ethernet), capture size 262144 bytes
200 packets captured
214 packets received by filter
0 packets dropped by kernel
```

The line that matters is `0 packets dropped by kernel`. If that number is non-zero, your capture itself is lossy and any conclusion about retransmits or gaps is unreliable -- tighten the filter or write straight to disk with a larger buffer (`-B`). To diagnose retransmits specifically, filter for them after the fact in a tool that understands TCP sequence numbers, or use `tshark` with a retransmission display filter. The goal of a capture is to confirm a hypothesis you already formed from counters, not to go fishing in gigabytes of traffic.

For a long-running capture during an intermittent problem, do not write one giant file -- use a ring of size-bounded files so the capture can run for hours without filling the disk, keeping only the most recent slices:

```bash
# -C 100: roll to a new file every 100 MB, -W 10: keep at most 10 files (a ring),
# -G/-z exist for time-based rotation. This lets a capture run until the rare event
# occurs without unbounded disk use.
tcpdump -i eth0 -nn -C 100 -W 10 -w /home/mmattox/blog-validate-net/trace.pcap \
  'host 10.0.9.55 and tcp port 443'
```

Once you have a clean capture, the retransmit-specific view is what turns a suspicion into proof. In `tshark`, the `tcp.analysis.retransmission` filter surfaces exactly the segments the stack resent:

```bash
# Count retransmitted segments in a capture file. A cluster of these around a
# specific time confirms the loss the ss/nstat counters only summarized.
tshark -r /home/mmattox/blog-validate-net/trace.pcap -Y tcp.analysis.retransmission | wc -l
```

This closes the loop: `nstat` told you retransmits exist cluster-wide, `ss -i` told you which connection, and the capture shows the exact segments and their timing so you can correlate them with an event -- a GC pause, a failover, a backup job saturating the link. Capture is the last step, not the first, precisely because it is expensive and only meaningful once the counters have pointed you at where to look.

## Kubernetes: Where Network Measurement Gets Hard

Everything above applies to a bare Linux host. In Kubernetes, every measurement gains layers, and several entirely new failure modes appear. The single most important shift in mindset is that **the node's `eth0` counters no longer tell the whole story** -- traffic also crosses veth pairs, a CNI overlay, and the kernel `conntrack` table before it reaches a pod.

### conntrack: The Table That Silently Drops Packets

The kernel's connection-tracking table (`nf_conntrack`) records every flow so that `iptables`/`nftables` and `kube-proxy` can NAT and route it. It has a fixed maximum size. When it fills, the kernel drops new connections and logs `nf_conntrack: table full, dropping packet` -- and this is one of the most common, most invisible causes of intermittent connection failures in busy clusters.

Measure it directly:

```bash
# Current entries vs maximum; the ratio is what matters
sysctl net.netfilter.nf_conntrack_count net.netfilter.nf_conntrack_max
```

```text
net.netfilter.nf_conntrack_count = 248113
net.netfilter.nf_conntrack_max = 262144
```

At 248,113 of 262,144 the table is 95% full -- one traffic spike from dropping connections cluster-wide. The drop counter confirms whether it has already happened:

```bash
# Insertion failures and drops indicate the table overflowed at least once
cat /proc/sys/net/netfilter/nf_conntrack_count
conntrack -S | grep -E 'insert_failed|drop|early_drop'
```

```text
cpu=0   insert_failed=14   drop=14   early_drop=0
cpu=1   insert_failed=9    drop=9    early_drop=0
```

Any non-zero `insert_failed` or `drop` is a conntrack overflow that manifested as dropped packets. The fix is raising `nf_conntrack_max` (and the hashtable size) on every node, but the *measurement* is the point: without watching the count-versus-max ratio as a first-class metric, conntrack exhaustion presents as random, unreproducible connection resets that no application log explains. This belongs on every cluster's alerting, scraped from the node exporter.

When the table is filling and you need to know *why*, break the entries down by protocol and state. A flood of `TIME_WAIT` or half-open entries from one source, or a single misbehaving client opening connections faster than they close, will dominate the table:

```bash
# Group conntrack entries by protocol to see what is consuming the table. A sudden
# spike in one protocol or a single noisy source IP is the usual culprit.
conntrack -L 2>/dev/null | awk '{print $1}' | sort | uniq -c | sort -rn | head
```

```text
 198442 tcp
  41203 udp
    211 icmp
```

If `udp` entries dominate unexpectedly, a chatty UDP client (often a metrics agent or a DNS storm) is creating short-lived flows faster than they expire; the `nf_conntrack_udp_timeout` is what controls how long those linger. The general technique -- when an aggregate counter is alarming, break it down by the dimension most likely to explain it -- applies far beyond conntrack, but conntrack is where it most often saves a cluster, because the alternative is staring at a single climbing number with no idea which workload to throttle. Knowing the *composition* of the table tells you whether to raise the limit, shorten a timeout, or go fix a misbehaving client.

### kube-proxy, Overlay Overhead, and Where the Drops Live

CNI overlays such as VXLAN encapsulate every packet, adding header bytes and reducing the usable MTU inside pods. If the node MTU is 1500 and the overlay adds a 50-byte VXLAN header, the pod's effective MTU is 1450. When an application or a misconfigured pod still tries to send 1500-byte frames, you get fragmentation or silent black-holing of large packets -- which presents as "small requests work, large uploads hang." Measure the pod's view, not the node's:

```bash
# From inside a pod (kubectl exec): check the MTU the pod actually has
ip link show eth0 | grep mtu
```

```text
2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1450 qdisc noqueue state UP mode DEFAULT
```

A pod MTU lower than you expect, combined with hung large transfers, is the encapsulation overhead tax made visible. To confirm a path MTU black hole, probe with a fixed-size, do-not-fragment ping from inside the pod:

```bash
# -M do: set don't-fragment, -s 1422 payload (+28 ICMP/IP = 1450). If this works
# but -s 1472 (=1500) fails, the path MTU is 1450 and large frames are being dropped.
ping -M do -s 1422 -c 3 10.244.5.7
```

For `kube-proxy` itself, the measurement that matters depends on its mode. In `iptables` mode, a large number of services means a long rule chain that every packet traverses linearly -- a per-packet latency cost that grows with cluster size and shows up as rising baseline RTT between pods as the service count climbs. In `IPVS` mode that cost is bounded by a hash table instead. The diagnostic is comparing pod-to-pod RTT (measured with `ss -i` or application timing) against pod-to-node and node-to-node RTT: if pod-to-pod is markedly worse, the overlay and proxy layers are your cost, not the physical network.

You can measure the `iptables` rule explosion directly. Every `ClusterIP` service in `iptables` mode adds rules to the `nat` table, and the chain a packet walks grows roughly linearly with service and endpoint count:

```bash
# Count the NAT rules kube-proxy has programmed. On a large cluster in iptables
# mode this can be tens of thousands of rules every service packet may traverse.
iptables -t nat -S | wc -l
```

```text
41872
```

Forty thousand rules is the kind of number where `iptables` mode starts adding measurable, service-count-dependent latency and where every `kube-proxy` sync (which rewrites large portions of the ruleset) becomes expensive enough to show up as control-plane churn. Watching this count grow over time is a leading indicator that a cluster should move to IPVS or an eBPF-based dataplane. In IPVS mode the equivalent check is `ipvsadm -Ln`, where lookups are a hash and do not scale linearly with service count:

```bash
# In IPVS mode, list virtual servers and their real-server backends. Lookups here
# are O(1)-ish hash operations, not a linear rule walk.
ipvsadm -Ln | head -20
```

### Measuring Pod-to-Service Versus Pod-to-Pod Latency

A pod talking to another pod by IP skips the service NAT entirely. A pod talking to a `ClusterIP` service goes through the full `kube-proxy` translation and a `conntrack` entry per flow. Measuring both, from the same source pod, isolates how much latency the service layer adds:

```bash
# From inside a source pod. First hit a backend pod IP directly, then hit the
# ClusterIP service that fronts it. The delta is the service/NAT/conntrack cost.
ping -c 20 -q 10.244.5.7            # pod IP: overlay path only
curl -o /dev/null -s -w 'svc_total=%{time_total}\n' http://my-service.my-ns.svc:8080/healthz
curl -o /dev/null -s -w 'pod_total=%{time_total}\n' http://10.244.5.7:8080/healthz
```

If the service-addressed request is consistently slower than the pod-addressed one, the cost is in the proxy and NAT layer, not the application or the overlay. If both are slow but node-to-node is fast, the cost is the overlay encapsulation. This layered subtraction -- pod-to-pod, pod-to-service, node-to-node, node-to-external -- is the only reliable way to assign blame in a cluster, and it is what separates an actionable finding from a "the network feels slow" hand-wave.

DNS deserves a specific call-out here because in Kubernetes it is on the critical path of nearly every connection and is a frequent hidden source of "network" latency. A pod that resolves a name walks the `search` domains in `/etc/resolv.conf`, and the default `ndots:5` setting means short names trigger multiple failed lookups before the right one succeeds. Measure resolution time in isolation:

```bash
# Time a single resolution through the cluster DNS. Repeated runs that are slow
# or variable point at CoreDNS load or ndots search-domain amplification, not TCP.
dig +stats my-service.my-ns.svc.cluster.local | grep 'Query time'
```

A multi-millisecond or highly variable query time, multiplied across the search-domain attempts every connection makes, can dominate tail latency while every TCP and interface counter looks pristine. The fix (fully-qualified names, a tuned `ndots`, or NodeLocal DNSCache) follows only after the measurement proves DNS is the cost.

### Pressure Stall Information: Useful for CPU, Memory, and IO -- but Not Network

A natural instinct, having used `/proc/pressure/cpu`, `/proc/pressure/memory`, and `/proc/pressure/io` in the earlier posts in this series, is to look for a network equivalent. There isn't one. The kernel's Pressure Stall Information (PSI) subsystem tracks stalls on CPU, memory, and IO resources, but **there is no `/proc/pressure/network`**:

```bash
# PSI exists for cpu, memory, and io -- but not network. This listing shows the
# only three files; do not waste time looking for a network PSI metric.
ls /proc/pressure/
```

```text
cpu  io  memory
```

This is a real gap worth internalizing: you cannot get a single kernel-provided "how stalled is this workload on the network" number the way you can for the other three resources. Network pressure has to be reconstructed from the constellation of counters in this article -- retransmits, listen-queue overflows, ring-buffer drops, conntrack fullness, and softirq saturation -- because the kernel does not summarize it for you. Anyone who tells you to "just check network PSI" is describing a file that does not exist. The absence of that metric is exactly why network measurement demands more tools and more discipline than the other three resources combined.

The general Kubernetes rule for measuring correctly: take the measurement as close to the workload as possible. Node `eth0` counters miss veth and overlay drops. Service-level latency hides which layer added the delay. Measuring from inside the pod, and comparing each layer (pod-to-pod, pod-to-node, node-to-node, node-to-external) isolates exactly where the loss or latency is introduced -- which is the only way to avoid "blaming the network" when the real cost is conntrack, MTU, or a saturated overlay.

## From Ad-Hoc Commands to Standing Observability

Everything above is incident-time tooling: you run it when something is already wrong. In an enterprise environment the more valuable move is to capture these same counters continuously so that the trend is visible *before* the page fires. The good news is that almost every counter in this article is already exported by the Prometheus `node_exporter` and the kernel files it reads.

The handful of network metrics worth turning into first-class alerts -- because each one is silent in a bandwidth graph and each one has bitten real production clusters -- are:

- **Retransmit rate.** Derived from `node_netstat_Tcp_RetransSegs` over `node_netstat_Tcp_OutSegs`. Alert when the ratio crosses ~1-2% sustained; it is the goodput killer that throughput graphs hide.
- **Listen-queue overflows.** `node_netstat_TcpExt_ListenOverflows` increasing at all. Any non-zero rate is dropped connections your application never logged.
- **Interface drops and errors.** `node_network_receive_drop_total` and `node_network_receive_errs_total` per interface. Separate alerts: errors imply hardware, drops imply ring-buffer or softirq saturation.
- **Conntrack fullness.** `node_nf_conntrack_entries` over `node_nf_conntrack_entries_limit`. Alert at 80% -- the gap between "fine" and "dropping packets cluster-wide" is one traffic spike.
- **Softirq saturation.** A single CPU's `node_cpu_seconds_total{mode="softirq"}` rate approaching one full core, which is the packet-rate ceiling showing up as CPU.

The discipline is the same as the rest of this series: alert on the *property*, not on a proxy for it. A bandwidth-utilization alert will never catch any of the five failures above, which is precisely why teams that alert only on bandwidth keep getting surprised. Build the retransmit-rate panel, the conntrack-ratio panel, and the per-CPU softirq panel into the standard node dashboard, and most of the failure modes in this article become things you see coming rather than things you debug at 3 a.m.

A reasonable cadence for a host you suspect but cannot yet pin down is a short scripted snapshot that captures the delta-based counters every few seconds:

```bash
# Lightweight standing snapshot: nstat -z prints and resets, so each line is the
# delta since the previous run -- a poor-man's time series when no exporter exists.
while true; do
  date +%H:%M:%S
  nstat -z TcpRetransSegs TcpExtTCPSynRetrans TcpExtListenOverflows
  sleep 5
done
```

This is a stopgap, not a replacement for proper metrics, but it turns the static counters into a rate you can watch live during a controlled load test or a suspected incident.

## A Practical Measurement Workflow

When someone reports a network problem, resist the urge to open a bandwidth graph first. Work the four properties in order:

1. **Establish latency.** Run `ping` for a floor and `mtr` to localize. Read `mdev`/jitter and tail, not just the average. Confirm with application-level timing, because ICMP can lie.
2. **Check TCP health.** Use `ss -tinp` on the busy host to read per-connection RTT and retransmits, and `nstat` for cluster-wide retransmit and SYN-retransmit counters. A high retransmit rate is your goodput killer.
3. **Check the listen queue.** `ss -ltn` plus `TcpExtListenOverflows` -- dropped connections never appear in a bandwidth graph and never appear in application logs.
4. **Check the interface.** `ip -s -s link` and `ethtool -S` for `errors` (physical/cabling), `dropped`/`missed` (ring buffer / softirq), and `rx_no_buffer_count`. Distinguish cabling faults from ring-buffer overflow before tuning anything.
5. **Quantify the ceiling.** Only now run `iperf3` -- long duration, parallel streams, watching the retransmit column -- and add UDP small-datagram tests to find packet-rate ceilings.
6. **In Kubernetes, add the layers.** Check `nf_conntrack_count` versus `_max`, the pod's MTU, and compare per-layer RTT. The node's `eth0` is not the whole path.

Each step measures a different property, and the failure is almost always concentrated in one of them. The discipline is refusing to optimize until you have identified *which* one.

To make that workflow concrete, here is how the same complaint -- "the service is slow over the network" -- resolves to four entirely different fixes depending on which property the measurements implicate:

- **Latency-bound.** `ping` floor is fine, but `curl` per-phase timing shows `ttfb` dominating and `ss -i` shows low RTT with high `rcv_rtt`: the application is slow, not the network. No network change helps. The earlier CPU and memory posts in this series are where this thread continues.
- **Loss-bound.** `ss -i` shows a 3% byte-retransmit ratio, `nstat` confirms rising `TcpRetransSegs`, and a capture shows retransmits clustered at peak load. The fix is chasing the loss -- a saturated uplink, a bad SFP (`ethtool -S` CRC errors), or buffer bloat -- not adding bandwidth.
- **Packet-rate-bound.** Bandwidth is at 30%, but `mpstat` shows one core pinned in `%soft`, `ethtool -l` shows a single active queue, and UDP small-datagram `iperf3` plateaus far below the bandwidth ceiling. The fix is more queues and RSS, not more bandwidth.
- **Capacity-bound.** Long parallel `iperf3` actually fills the link with near-zero retransmits, and the workload genuinely needs more than the link provides. Only now is "add bandwidth" the correct answer -- and it is the rarest of the four in practice.

Three of those four root causes are *invisible* on a bandwidth utilization graph, and the fourth -- the only one bandwidth provisioning fixes -- is the least common. That ratio is the entire argument for measuring the four properties separately rather than averaging them into a single green line.

## Conclusion

Network performance is not a single number, and the most expensive measurement mistake is pretending that it is. A green Mbps graph tells you nothing about latency tails, retransmit rates, accept-queue drops, ring-buffer overflows, or a conntrack table that is one spike from collapse. Each of those is a distinct property with its own tool and its own fix, and conflating them is how real problems hide for weeks behind dashboards that all look fine.

Key takeaways:

- **Measure four properties separately:** bandwidth (capacity), throughput/goodput (actual useful bits), latency/jitter (timing), and packet rate (pps). A workload can be saturated on one while idle on the others.
- **Read distributions, not averages.** Latency lives in the tail; use `mdev`, p99, and per-connection `ss -i` RTT rather than mean ping.
- **Retransmits and listen-queue drops are silent.** `ss`, `nstat`, and the `ListenOverflows` counter expose connection-level failures that no bandwidth metric can show.
- **Interface counters distinguish hardware from software loss.** `errors` means cabling; `missed`/`rx_no_buffer_count` means ring-buffer overflow under packet pressure -- different fixes entirely.
- **Test throughput honestly:** long `iperf3` runs, parallel streams, both directions (`-R`), and small-datagram UDP for packet-rate ceilings; always watch the retransmit column.
- **Packet rate is a CPU problem.** A pps ceiling shows up as one core pinned in `%soft`; check NIC queues (`ethtool -l`) and softirq distribution before adding bandwidth that will not help.
- **Mind socket buffers and congestion control.** A `net.core.rmem_max` lower than `tcp_rmem` silently caps the window; CUBIC versus BBR matters on lossy, high-RTT paths. Compute the bandwidth-delay product before blaming the link.
- **UDP loss hides in the consumer.** `UdpRcvbufErrors` and a non-zero `ss -u` Recv-Q mean a slow application, not a lossy network -- a distinction that misroutes whole incidents.
- **Account for NIC offloads.** GRO/TSO/GSO mean host packet counts are coalesced super-packets, not wire frames; reconcile against switch counters accordingly.
- **There is no network PSI.** Unlike CPU, memory, and IO, the kernel gives you no `/proc/pressure/network`; you must reconstruct network pressure from retransmits, drops, conntrack, and softirq -- which is why it takes more discipline than any other resource.
- **In Kubernetes, measure close to the pod.** Watch `nf_conntrack_count` versus `_max`, verify pod MTU against overlay overhead, count `iptables` NAT rules as a kube-proxy scaling signal, time cluster DNS, and compare per-layer RTT (pod-to-pod, pod-to-service, node-to-node) to find which layer -- not "the network" -- is the cost.
- **Promote the silent counters to alerts.** Retransmit rate, listen-queue overflows, interface drops/errors, conntrack fullness, and per-CPU softirq belong on the standard dashboard so these failures are seen coming, not debugged at 3 a.m.

### Related Posts in This Series

- [Measuring Linux CPU Performance Correctly](/measuring-linux-performance-cpu/)
- [Measuring Linux Memory Performance Correctly](/measuring-linux-performance-memory/)
- [Measuring Linux Disk and Storage Performance Correctly](/measuring-linux-performance-disk-storage/)
- [Measuring Linux Network Performance Correctly](/measuring-linux-performance-network/) (this post)
- [Measuring Linux Performance: Recap and the Most Common Mistakes](/measuring-linux-performance-recap-common-mistakes/)
