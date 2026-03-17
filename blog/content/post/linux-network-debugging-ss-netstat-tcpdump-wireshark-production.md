---
title: "Linux Network Debugging: ss, netstat, tcpdump, and Wireshark for Production"
date: 2029-10-10T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "Debugging", "tcpdump", "Wireshark", "ss", "netstat", "Performance"]
categories:
- Linux
- Networking
- Operations
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-focused guide to Linux network debugging using ss, netstat -s counters, tcpdump filter expressions, Wireshark dissectors, packet loss diagnosis, and TCP retransmit analysis."
more_link: "yes"
url: "/linux-network-debugging-ss-netstat-tcpdump-wireshark-production/"
---

Network problems in production are some of the hardest incidents to diagnose because they manifest as symptoms — latency spikes, connection timeouts, throughput degradation — far removed from their root cause. A dropped packet at one network hop shows up as a 1-second timeout in an application three layers above. This guide provides a structured methodology for diagnosing Linux network issues using `ss`, `netstat`, `tcpdump`, and Wireshark, with specific focus on packet loss and TCP retransmit analysis.

<!--more-->

# Linux Network Debugging: ss, netstat, tcpdump, and Wireshark for Production

## The Diagnostic Ladder

Network diagnosis follows a pattern: start with socket-level observation, escalate to packet-level capture if sockets look correct, then escalate to protocol dissection if the packet trace is ambiguous.

```
Layer 7: Application logs
    ↓ (latency/error symptoms)
Layer 4: Socket state (ss, netstat)
    ↓ (abnormal states, queue buildup)
Layer 4: TCP statistics (netstat -s, /proc/net/snmp)
    ↓ (retransmits, timeouts, RSTs)
Layer 3/4: Packet capture (tcpdump)
    ↓ (need deep dissection)
Layer 2-7: Protocol analysis (Wireshark)
```

## Section 1: ss — Socket Statistics

`ss` supersedes `netstat` for socket inspection. It reads directly from kernel structures via netlink, making it faster and more capable.

### Basic Socket Listing

```bash
# All TCP sockets (listening and established)
ss -tan

# All UDP sockets
ss -uanp

# All listening sockets with process names
ss -tlnp

# Full extended information including kernel timers
ss -tanepi

# Numeric output (no DNS/service resolution)
ss -tnp
```

### Understanding ss Output Fields

```bash
ss -tanei
# Netid State Recv-Q Send-Q Local Address:Port Peer Address:Port
# tcp  ESTAB 0      0      10.0.0.5:45612    10.0.0.1:5432
#         timer:(keepalive,2min57sec,0) uid:1000 ino:287631 sk:7f8c2a00
#         skmem:(r0,rb87380,t0,tb2097152,f0,w0,o0,bl0,d0)

# Fields:
# Recv-Q: bytes received but not yet read by application (backlog buildup indicator)
# Send-Q: bytes sent but not acknowledged by peer (TCP send buffer)
# timer: (type, expiry, retransmits)
# skmem: socket memory usage: r=receive, rb=receive buffer, t=transmit, tb=transmit buffer
```

### Filtering with ss Expressions

```bash
# Show only connections to a specific port
ss -tn dst :5432

# Show connections from a specific source IP
ss -tn src 10.0.0.0/8

# Show sockets in specific states
ss -tn state established
ss -tn state time-wait
ss -tn state close-wait

# Multiple states
ss -tn '( state established or state time-wait )'

# Connections with send or receive queue > 0 (potential backlog)
ss -tn 'rcv-q > 0 or snd-q > 0'

# Long-running established connections (timer > 10 minutes)
ss -tanei | awk '/keepalive/ && /[0-9]+h[0-9]+min/ {print}'
```

### Diagnosing Connection Backlog

```bash
# Check for listen backlog overflow
ss -tlnp

# State   Recv-Q  Send-Q  Local Address:Port
# LISTEN  128     128     0.0.0.0:80
#
# Recv-Q on LISTEN socket = current backlog queue depth
# Send-Q on LISTEN socket = configured backlog (somaxconn or listen() param)
# When Recv-Q == Send-Q, the backlog is full — new SYNs are being dropped

# Monitor backlog in real time
watch -n 1 'ss -tlnp | awk "NR==1 || /LISTEN/"'

# Check system-wide accept backlog limit
cat /proc/sys/net/core/somaxconn
```

### TIME_WAIT Accumulation

```bash
# Count sockets by state
ss -tan | awk 'NR>1 {state[$1]++} END {for (s in state) print state[s], s}' | sort -rn

# Large TIME_WAIT counts indicate high connection churn
# Normal TIME_WAIT duration is 2*MSL = 60 seconds
# Tune if causing ephemeral port exhaustion:
sysctl net.ipv4.tcp_tw_reuse
sysctl net.ipv4.ip_local_port_range

# Show TIME_WAIT with peer address for attribution
ss -tn state time-wait | sort | uniq -c | sort -rn | head -20
```

### CLOSE_WAIT Investigation

```bash
# CLOSE_WAIT means the remote end closed the connection but the application
# has not called close() on the socket
ss -tn state close-wait | wc -l

# Find which process is accumulating CLOSE_WAIT sockets
ss -tnp state close-wait | awk '{print $NF}' | sort | uniq -c | sort -rn
```

## Section 2: netstat -s — Protocol Statistics

`netstat -s` dumps cumulative kernel counters for TCP, UDP, ICMP, and IP since last boot. The absolute values are less meaningful than rate-of-change. Use it to identify classes of problems.

### Key TCP Counters

```bash
netstat -s --tcp

# Sample relevant output lines:
# 15234892 segments received
# 15134021 segments sent out
# 1842 segments retransmited          ← retransmit counter
# 14 bad segments received            ← checksum errors
# 2891 resets sent
# 23456789 packets received
# 4892 SYNs to LISTEN sockets ignored ← listen backlog overflow
# 2341 times the listen queue of a socket overflowed ← same
# 8934 SYNs and ACKs dropped from outside         ← SYN flood defense
```

### Monitoring Retransmit Rate

```bash
#!/bin/bash
# retransmit-monitor.sh — Watch retransmit rate per second

prev_retrans=$(netstat -s --tcp 2>/dev/null | awk '/retransmit/ {print $1}')

while true; do
    sleep 10
    curr_retrans=$(netstat -s --tcp 2>/dev/null | awk '/retransmit/ {print $1}')
    rate=$(( (curr_retrans - prev_retrans) / 10 ))

    total_segs=$(netstat -s --tcp 2>/dev/null | awk '/segments sent/ {print $1}')

    echo "$(date '+%H:%M:%S') retransmits/s: $rate  (total retransmits: $curr_retrans)"

    if [ $rate -gt 100 ]; then
        echo "  WARNING: High retransmit rate!"
    fi

    prev_retrans=$curr_retrans
done
```

### /proc/net/snmp and /proc/net/netstat

For automated collection, read kernel counters directly:

```bash
# /proc/net/snmp contains RFC 1213 MIB values
cat /proc/net/snmp | grep Tcp:

# Sample line pair:
# Tcp: RtoAlgorithm RtoMin RtoMax MaxConn ActiveOpens PassiveOpens AttemptFails \
#      EstabResets CurrEstab InSegs OutSegs RetransSegs InErrs OutRsts InCsumErrors
# Tcp: 1 200 120000 -1 12345 8901 234 567 89 15234892 15134021 1842 14 2891 0

# Parse retransmit rate with awk
awk '/^Tcp:/ && NR==4 {print "RetransSegs:", $13}' /proc/net/snmp
```

### /proc/net/sockstat — Summary Counters

```bash
cat /proc/net/sockstat
# sockets: used 1847
# TCP: inuse 423 orphan 0 tw 1243 alloc 433 mem 892
# UDP: inuse 12 mem 8
# UDPLITE: inuse 0
# RAW: inuse 0
# FRAG: inuse 0 memory 0

# tw = TIME_WAIT count
# orphan = orphaned sockets (no process, not yet cleaned up)
# mem = pages of memory used
```

### UDP Counter Analysis

```bash
netstat -s --udp
# 2345678 packets received
# 12345 packets to unknown port received   ← service not listening
# 8934 packet receive errors               ← buffer overflow (increase rmem)
# 2234567 packets sent

# High "packet receive errors" indicates UDP receive buffer overflow
# Fix:
sysctl -w net.core.rmem_max=16777216
sysctl -w net.core.rmem_default=262144
sysctl -w net.ipv4.udp_rmem_min=4096
```

## Section 3: tcpdump — Packet Capture

tcpdump is the Swiss Army knife of packet capture on Linux. The key to effective use is writing precise filter expressions that capture exactly what you need without overwhelming the buffer.

### Essential Filter Syntax

```bash
# Basic syntax
tcpdump [options] [filter expression]

# Common options:
# -i <interface>     Capture on specific interface (eth0, any)
# -n                 No DNS resolution
# -nn                No DNS or port resolution
# -v / -vv / -vvv    Verbosity
# -c <count>         Capture N packets then stop
# -w <file>          Write to pcap file
# -r <file>          Read from pcap file
# -s <snaplen>       Capture N bytes per packet (default 65535)
# -X                 Print hex + ASCII
# -A                 Print ASCII only
# -Z <user>          Drop to this user after opening interface

# Capture all traffic to/from a host
tcpdump -nn host 10.0.0.5

# Capture only TCP traffic on port 5432 (PostgreSQL)
tcpdump -nn tcp port 5432

# Capture only TCP SYN packets (connection attempts)
tcpdump -nn 'tcp[tcpflags] == tcp-syn'

# Capture TCP SYN+ACK (connection responses)
tcpdump -nn 'tcp[tcpflags] == tcp-syn|tcp-ack'

# Capture TCP RST packets (abnormal connection terminations)
tcpdump -nn 'tcp[tcpflags] & tcp-rst != 0'

# Capture packets larger than 1400 bytes (near MTU — fragmentation indicator)
tcpdump -nn 'greater 1400'

# Capture ICMP (ping, unreachable, etc.)
tcpdump -nn icmp

# Capture DNS queries and responses
tcpdump -nn udp port 53

# Complex: TCP connections to 10.0.0.1:5432 that are resetting
tcpdump -nn 'tcp and host 10.0.0.1 and port 5432 and tcp[tcpflags] & tcp-rst != 0'
```

### Production Capture Workflow

```bash
# Step 1: Capture to file (don't analyze while capturing in production)
tcpdump -nn -i eth0 -s 0 \
  -w /tmp/capture_$(hostname)_$(date +%Y%m%d_%H%M%S).pcap \
  -c 100000 \
  'host 10.0.0.5 and tcp port 5432'

# Step 2: Analyze offline
tcpdump -nn -r /tmp/capture_hostname_20291010_143022.pcap

# Step 3: Extract specific flows for Wireshark
tcpdump -nn -r /tmp/capture.pcap \
  -w /tmp/filtered.pcap \
  'host 10.0.0.5 and port 5432'
```

### Diagnosing Packet Loss with tcpdump

```bash
# Capture with statistics to see how many packets were dropped
tcpdump -nn -i eth0 -c 50000 -w /tmp/capture.pcap &
TCPDUMP_PID=$!
sleep 30
kill -INT $TCPDUMP_PID
# Output: "5000 packets captured, 4998 packets received by filter, 2 packets dropped by kernel"
# Dropped packets = capture buffer overflow (increase with -B option)

# Increase capture buffer (default 2048 KB)
tcpdump -B 65536 -nn -i eth0 -c 100000 -w /tmp/capture.pcap

# To identify packet loss at the NIC level:
ethtool -S eth0 | grep -i 'drop\|miss\|error'

# Ring buffer overflow (NIC drops)
ethtool -g eth0      # Show ring buffer sizes
ethtool -G eth0 rx 4096 tx 4096   # Increase ring buffers
```

### Identifying Retransmissions in tcpdump

```bash
# Look for TCP retransmissions in a capture
# Retransmissions appear as duplicate sequence numbers
tcpdump -nn -r capture.pcap -A | awk '
/\[S\]/ {seq[$NF]=$0}  # Track SYN sequences
/\[.\]/ {              # Data segments
    if ($0 ~ /seq/ && prev_seq[$5] && prev_seq[$5] != $0) {
        print "Possible retransmit:", $0
    }
    prev_seq[$5] = $0
}'

# Better: use tcpstat for summary
tcpstat -r capture.pcap -o "Time %R: %N packets, %A bytes, %R retrans\n" 10
```

### Capturing on Kubernetes Pod Network

```bash
# Get the container's network namespace PID
CONTAINER_ID=$(kubectl get pod my-pod -o jsonpath='{.status.containerStatuses[0].containerID}' | cut -d/ -f3)
PID=$(crictl inspect $CONTAINER_ID | jq '.info.pid')

# Run tcpdump in the container's network namespace
nsenter -t $PID -n -- tcpdump -nn -i eth0 -w /tmp/pod_capture.pcap

# Or use kubectl-sniff (requires privileged DaemonSet)
kubectl sniff my-pod -n my-namespace -f "port 8080" -o /tmp/pod_capture.pcap

# Using ephemeral debug container
kubectl debug -it my-pod --image=nicolaka/netshoot --target=my-container -- \
  tcpdump -nn -i eth0 -w /dev/stdout | tee /tmp/debug.pcap
```

## Section 4: Wireshark — Protocol Dissection

Wireshark is essential when tcpdump shows you packets but you need to understand the protocol-level semantics.

### Loading a Capture File

```bash
# Install Wireshark (headless tshark for server analysis)
apt-get install tshark

# Basic analysis of capture file
tshark -r capture.pcap

# Summary statistics
tshark -r capture.pcap -q -z io,stat,1 "tcp"

# TCP stream reconstruction
tshark -r capture.pcap -q -z follow,tcp,ascii,0
```

### tshark Display Filters

Display filters are more expressive than tcpdump BPF filters:

```bash
# Show only TCP retransmissions
tshark -r capture.pcap -Y "tcp.analysis.retransmission"

# Show TCP out-of-order segments
tshark -r capture.pcap -Y "tcp.analysis.out_of_order"

# Show TCP zero-window conditions (receiver buffer full)
tshark -r capture.pcap -Y "tcp.analysis.zero_window"

# Show TCP duplicate ACKs (often precede retransmissions)
tshark -r capture.pcap -Y "tcp.analysis.duplicate_ack"

# Show slow ACKs (delayed ACK timeout > 200ms)
tshark -r capture.pcap -Y "frame.time_delta > 0.2 and tcp.flags.ack == 1"

# HTTP errors
tshark -r capture.pcap -Y "http.response.code >= 400"

# TLS handshake failures
tshark -r capture.pcap -Y "tls.alert_message"

# DNS query failures (NXDOMAIN, SERVFAIL)
tshark -r capture.pcap -Y "dns.flags.rcode != 0"
```

### Analyzing Retransmit Patterns

```bash
#!/bin/bash
# analyze-retransmits.sh — Summarize retransmit patterns in a pcap

PCAP=$1

echo "=== TCP Retransmissions ==="
tshark -r "$PCAP" -q -z "io,stat,10,COUNT(tcp.analysis.retransmission)tcp.analysis.retransmission" 2>/dev/null

echo ""
echo "=== Top Retransmitting Sources ==="
tshark -r "$PCAP" -Y "tcp.analysis.retransmission" \
  -T fields -e ip.src -e ip.dst -e tcp.srcport -e tcp.dstport 2>/dev/null | \
  sort | uniq -c | sort -rn | head -20

echo ""
echo "=== Retransmit-to-Total Ratio ==="
total=$(tshark -r "$PCAP" -q -z io,stat,0 2>/dev/null | awk '/0 <>/  {print $3}')
retrans=$(tshark -r "$PCAP" -Y "tcp.analysis.retransmission" -T fields -e frame.number 2>/dev/null | wc -l)
echo "Total packets: $total"
echo "Retransmissions: $retrans"
[ -n "$total" ] && [ "$total" -gt 0 ] && \
  awk "BEGIN {printf \"Retransmit rate: %.2f%%\n\", ($retrans/$total)*100}"

echo ""
echo "=== Zero-Window Events (receiver buffer full) ==="
tshark -r "$PCAP" -Y "tcp.analysis.zero_window" \
  -T fields -e frame.time_relative -e ip.src -e ip.dst -e tcp.window_size 2>/dev/null | \
  head -20
```

### Wireshark TCP Expert Analysis

Wireshark categorizes TCP analysis events automatically. In the GUI:
- Analyze → Expert Information
- Filter by Severity: Error = problems, Warning = potential issues, Note = informational

Key TCP expert events to investigate:
- `TCP Previous segment not captured` — out-of-order delivery or capture gap
- `TCP Retransmission` — packet was resent
- `TCP Fast Retransmission` — 3 duplicate ACKs triggered fast retransmit
- `TCP Spurious Retransmission` — retransmission of already-ACKed data (RTO too aggressive)
- `TCP Zero Window` — receiver's advertised window is 0 (receiver buffer full)
- `TCP Window Full` — sender has filled the receiver's advertised window

### Graph TCP Throughput

```bash
# Generate throughput data from tshark
tshark -r capture.pcap -q \
  -z "io,stat,0.1,BYTES(tcp)tcp,BYTES(tcp.analysis.retransmission)tcp.analysis.retransmission" 2>/dev/null | \
  grep "^[0-9]" | \
  awk '{printf "%s %.0f %.0f\n", $1, $3*8/1024/1024, $5*8/1024/1024}' | \
  gnuplot -e "
    set terminal png size 1200,400;
    set output '/tmp/throughput.png';
    set xlabel 'Time (s)'; set ylabel 'Mbps';
    set title 'TCP Throughput vs Retransmissions';
    plot '-' using 1:2 with lines title 'Throughput', '' using 1:3 with lines title 'Retransmits'
  "
```

## Section 5: Packet Loss Diagnosis

### Diagnosing at Each Layer

```bash
# Layer 1: NIC hardware errors
ethtool -S eth0 | grep -iE 'error|drop|miss|overflow|crc'

# Layer 2: Interface counters
ip -s link show eth0
# RX: bytes packets errors dropped overrun mcast
# TX: bytes packets errors dropped carrier collisions

# Layer 3: IP-level drops
cat /proc/net/snmp | grep "Ip:"
# InDiscards = IP input buffer overflow
# OutDiscards = IP output buffer overflow
# ForwDatagrams = forwarded packets (router)

# Layer 4: TCP-specific drops
netstat -s | grep -iE 'retran|reset|drop|fail'

# Kernel socket queue overflow (UDP)
cat /proc/net/udp | awk 'NR>1 {sum += strtonum("0x"$5)} END {print "UDP queue drops:", sum}'
```

### Capturing at Multiple Points

When loss is intermittent, capture simultaneously at source, target, and an intermediate hop:

```bash
# Terminal 1: Source host
ssh source-host "tcpdump -nn -i eth0 -w - host target-host and tcp port 8080" > /tmp/source.pcap &

# Terminal 2: Target host
ssh target-host "tcpdump -nn -i eth0 -w - host source-host and tcp port 8080" > /tmp/target.pcap &

sleep 30
kill %1 %2

# Compare packet counts
tshark -r /tmp/source.pcap -q -z io,stat,0 | grep "^0 <>"
tshark -r /tmp/target.pcap -q -z io,stat,0 | grep "^0 <>"

# Packets in source but not target = packet loss between source and target
# Use sequence numbers to identify exactly which packets were lost
```

### MTU and Fragmentation Issues

```bash
# Test path MTU
ping -M do -s 1472 target-host   # 1472 + 28 ICMP/IP header = 1500 MTU
ping -M do -s 8972 target-host   # Test jumbo frames (9000 MTU)

# Capture fragmentation
tcpdump -nn '(ip[6:2] & 0x1fff != 0) or (ip[6] & 0x20 != 0)'
# Fragmented packets indicate MTU mismatch or PMTUD black hole

# Fix PMTUD black hole (Linux)
sysctl net.ipv4.tcp_mtu_probing=1  # Enable TCP MTU probing
```

## Section 6: Structured Diagnostic Scripts

```bash
#!/bin/bash
# net-health-check.sh — Comprehensive network health snapshot

HOST=${1:-$(hostname)}
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
OUTPUT="/var/log/net-health-${HOST}-${TIMESTAMP}.txt"

{
echo "=== Network Health Check: $HOST at $(date) ==="

echo ""
echo "--- Interface Statistics ---"
ip -s link show

echo ""
echo "--- Socket State Summary ---"
ss -tan | awk 'NR>1 {state[$1]++} END {for(s in state) printf "%6d %s\n", state[s], s}' | sort -rn

echo ""
echo "--- Listen Backlog ---"
ss -tlnp | awk 'NR>1'

echo ""
echo "--- TCP Retransmit Counters ---"
netstat -s | grep -iE 'retran|reset|overflow|timeout'

echo ""
echo "--- UDP Drop Counters ---"
netstat -s | grep -iE 'udp|receive error|unknown port'

echo ""
echo "--- Socket Memory Usage ---"
cat /proc/net/sockstat

echo ""
echo "--- Routing Table ---"
ip route

echo ""
echo "--- NIC Driver Statistics ---"
for iface in $(ls /sys/class/net/ | grep -vE '^lo$'); do
    echo "Interface: $iface"
    ethtool -S "$iface" 2>/dev/null | grep -iE 'drop|error|miss|overflow' || echo "  (no stats)"
done

} > "$OUTPUT" 2>&1

echo "Output written to $OUTPUT"
```

## Section 7: Real-World Diagnostic Case Studies

### Case 1: Intermittent Connection Timeouts to PostgreSQL

```bash
# Symptoms: application reports intermittent 30s timeouts connecting to Postgres

# Step 1: Check for CLOSE_WAIT accumulation on the database side
ssh db-host "ss -tn state close-wait | wc -l"
# Result: 847 CLOSE_WAIT sockets — application is not closing connections

# Step 2: Verify with ss which process owns them
ssh db-host "ss -tnp state close-wait" | awk '{print $NF}' | sort | uniq -c

# Step 3: Check the app's connection pool settings — max_idle_conns likely too high
# or connections are being abandoned, not returned to pool
```

### Case 2: Gradual Throughput Degradation

```bash
# Symptoms: throughput to S3 degrades over time, recovers after restart

# Step 1: Check retransmit rate trend
watch -n 5 'netstat -s | grep retransmit'

# Step 2: Check TCP send buffer usage
ss -tanei | awk '/skmem/ {
    match($0, /t([0-9]+),tb([0-9]+)/, arr)
    if (arr[2] > 0 && arr[1]/arr[2] > 0.9) print "Send buffer near full:", $0
}'

# Step 3: Capture TCP zero-window events
tcpdump -nn -i eth0 -w /tmp/zerowin.pcap 'host s3.amazonaws.com' &
sleep 120; kill %1
tshark -r /tmp/zerowin.pcap -Y "tcp.analysis.zero_window"
# Result: zero window events indicate send buffer full — receiver congested

# Fix: increase TCP send buffer
sysctl -w net.core.wmem_max=16777216
sysctl -w net.ipv4.tcp_wmem="4096 65536 16777216"
```

## Conclusion

Effective network debugging on Linux is a layered process. `ss` provides fast, accurate socket state inspection that identifies the class of problem. `netstat -s` exposes the kernel's TCP/UDP counters to reveal retransmit rates, buffer overflows, and connection resets at a statistical level. `tcpdump` captures the actual packet flow for offline analysis, and Wireshark's expert analysis and display filters dissect protocol behavior that statistics alone cannot explain. Combined with systematic capture at multiple network points and the diagnostic scripts in this guide, you can identify and resolve even the most elusive network performance problems in production.
