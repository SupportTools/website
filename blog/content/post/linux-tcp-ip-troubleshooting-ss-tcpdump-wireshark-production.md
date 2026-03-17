---
title: "Linux TCP/IP Troubleshooting: ss, tcpdump, and Wireshark for Production"
date: 2031-05-11T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "TCP/IP", "tcpdump", "Wireshark", "Kubernetes", "Troubleshooting"]
categories:
- Linux
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-grade guide to TCP/IP troubleshooting using ss for socket inspection, tcpdump for targeted packet capture, Wireshark for deep analysis, TCP state machine diagnosis, and capturing Kubernetes service traffic."
more_link: "yes"
url: "/linux-tcp-ip-troubleshooting-ss-tcpdump-wireshark-production/"
---

Production network issues have a frustrating quality: they are intermittent, time-sensitive, and often invisible until you know exactly what you're looking for. `netstat` is the tool most engineers reach for first, but it has been obsolete for years on modern Linux. `ss` from the iproute2 suite provides the same information faster, with better filtering, and with kernel-internal socket state that netstat cannot show. Combined with `tcpdump` for raw packet capture and Wireshark for deep protocol analysis, you can diagnose everything from TIME_WAIT exhaustion to TCP retransmit storms to service mesh mTLS handshake failures.

This guide focuses on the specific incantations that solve real production problems, not just command syntax overviews.

<!--more-->

# Linux TCP/IP Troubleshooting: ss, tcpdump, and Wireshark for Production

## Section 1: ss — The Modern netstat

`ss` directly queries the kernel's TCP socket tables through netlink, making it 10-100x faster than `netstat` on systems with thousands of connections.

### 1.1 Basic Socket Inspection

```bash
# Show all TCP connections (equivalent to netstat -tn)
ss -tn

# Show listening sockets
ss -tlnp

# Show all sockets (TCP + UDP + Unix) with process info
ss -tulnp

# Show established connections with timers
ss -tn state established

# Connection counts by state
ss -tn | awk 'NR>1 {print $1}' | sort | uniq -c | sort -rn

# Or more directly
ss -s
# Netid  State      Recv-Q  Send-Q
# TCP    ESTABLISHED 0       0       *:* (summary count)
```

### 1.2 Advanced Filtering with ss Expressions

The `ss` filter DSL is powerful — expressions can be combined with `and`, `or`, `not`:

```bash
# All connections to a specific port
ss -tn 'dport = :8080'
ss -tn 'dport = :postgresql'  # Can use service names

# All connections from a specific IP
ss -tn 'src 10.0.0.5'

# Connections to a CIDR range
ss -tn 'dst 10.96.0.0/12'  # Kubernetes service CIDR

# Connections in CLOSE_WAIT state from port 8080
ss -tn state close-wait 'sport = :8080'

# Find connections with large receive queue (application not reading fast enough)
ss -tn 'rcv-buf > 1000000'

# Connections with high retransmit count
ss -tin | grep -A1 "retrans"

# All sockets for a specific process by PID
ss -tp pid:12345

# Sockets for a specific program name
ss -tp | grep nginx
```

### 1.3 TCP State Machine States

Understanding TCP states is essential for diagnosing connection issues:

```
LISTEN      - Server waiting for connections
SYN_SENT    - Client sent SYN, waiting for SYN-ACK
SYN_RECV    - Server received SYN, sent SYN-ACK, waiting for ACK
ESTABLISHED - Connection is active
FIN_WAIT1   - Local side sent FIN, waiting for ACK or FIN+ACK
FIN_WAIT2   - Local received ACK of FIN, waiting for remote FIN
CLOSE_WAIT  - Remote side closed, local must send FIN
CLOSING     - Both sides sent FIN simultaneously
LAST_ACK    - Waiting for ACK of our FIN
TIME_WAIT   - Waiting 2*MSL for delayed packets to expire
CLOSED      - No connection
```

### 1.4 Diagnosing TIME_WAIT Exhaustion

TIME_WAIT is a normal TCP state that lasts 2*MSL (typically 60 seconds). Under high connection rate, TIME_WAIT sockets can exhaust local port ranges:

```bash
# Count TIME_WAIT sockets
ss -tn state time-wait | wc -l

# Check current TIME_WAIT count vs limits
ss -s | grep -i "time-wait"

# Check the local port range
cat /proc/sys/net/ipv4/ip_local_port_range
# 32768   60999  (28,231 ports available)

# See how many are in use
ss -tn | awk 'NR>1 {print $4}' | cut -d: -f2 | sort -u | wc -l

# Kernel parameters for TIME_WAIT management
# Enable TCP socket reuse for outgoing connections
sysctl net.ipv4.tcp_tw_reuse
# net.ipv4.tcp_tw_reuse = 1  (recommended for clients)

# Maximum TIME_WAIT sockets before kernel starts destroying them
sysctl net.ipv4.tcp_max_tw_buckets
# net.ipv4.tcp_max_tw_buckets = 262144
```

Tune TIME_WAIT behavior:

```bash
# /etc/sysctl.d/99-tcp-tuning.conf
# Allow reuse of TIME_WAIT sockets for new connections
net.ipv4.tcp_tw_reuse = 1

# Increase local port range
net.ipv4.ip_local_port_range = 1024 65535

# Increase TIME_WAIT bucket limit
net.ipv4.tcp_max_tw_buckets = 1048576

# Enable TCP keepalive
net.ipv4.tcp_keepalive_time = 60
net.ipv4.tcp_keepalive_intvl = 10
net.ipv4.tcp_keepalive_probes = 6

# Reduce FIN_WAIT2 timeout (default 60s)
net.ipv4.tcp_fin_timeout = 30

# Apply
sysctl -p /etc/sysctl.d/99-tcp-tuning.conf
```

### 1.5 Diagnosing CLOSE_WAIT Accumulation

CLOSE_WAIT means the remote end closed the connection but your application hasn't called `close()`. This is always an application bug:

```bash
# Find CLOSE_WAIT connections
ss -tnp state close-wait

# CLOSE_WAIT on port 8080 - which process?
ss -tnp state close-wait 'sport = :8080'

# If the process isn't calling close(), look for:
# 1. File descriptor leak (lsof -p <pid> | wc -l)
# 2. Connection pooling bug (connections returned to pool but never closed)
# 3. Goroutine/thread blocking on I/O without timeout

# Check FD count for a process
PID=$(pgrep -f myapp | head -1)
ls -la /proc/$PID/fd | wc -l
cat /proc/sys/fs/file-max  # System-wide limit

# Check if FD limit is being approached
lsof -p $PID 2>/dev/null | wc -l
cat /proc/$PID/limits | grep "open files"
```

### 1.6 TCP Retransmit Analysis with ss

```bash
# Show detailed TCP statistics for established connections
ss -tni

# Output includes:
# cubic wscale:7,7 rto:204 rtt:1.234/0.5 ato:40 mss:1448
# rcvmss:536 advmss:1448 cwnd:10 ssthresh:2147483647 bytes_sent:123456
# bytes_retrans:512 bytes_acked:122944 bytes_received:78910
# segs_out:85 segs_in:42 data_segs_out:84 data_segs_in:4
# send 94.1Mbps lastsnd:0 lastrcv:0 lastack:0 pacing_rate 188Mbps
# delivery_rate 94.1Mbps delivered:85 app_limited retrans:0/4
# rcv_rtt:10.231 rcv_space:43690 rcv_ssthresh:43690 minrtt:1.123

# Focus on connections with retransmissions
ss -tni | grep -B1 "retrans:[0-9]*/[^0]"

# Aggregate retransmit statistics
ss -s | grep -i "TCP:"
# TCP:   1234 (estab 456, closed 12, orphaned 0, timewait 789)
# Transport Total     IP        IPv6
# RAW       0         0         0
# UDP       12        8         4
# TCP       1234      1000      234
```

## Section 2: tcpdump for Production Packet Capture

### 2.1 Filter Syntax Fundamentals

tcpdump uses Berkeley Packet Filter (BPF) syntax. Mastering the filter language is what separates useful captures from 10GB noise files:

```bash
# Basic host filtering
tcpdump -i eth0 host 10.0.0.5
tcpdump -i eth0 src host 10.0.0.5
tcpdump -i eth0 dst host 10.0.0.5

# Port filtering
tcpdump -i eth0 port 8080
tcpdump -i eth0 'tcp port 8080 or tcp port 8443'

# Network (CIDR) filtering
tcpdump -i eth0 net 10.96.0.0/12

# Protocol filtering
tcpdump -i eth0 icmp
tcpdump -i eth0 'tcp[tcpflags] & (tcp-syn) != 0'  # SYN packets only
tcpdump -i eth0 'tcp[tcpflags] & (tcp-rst) != 0'  # RST packets (connection resets)

# Exclude noisy traffic to focus on problems
tcpdump -i eth0 'not port 22 and not arp and not icmp'

# Capture DNS queries
tcpdump -i eth0 'port 53 and udp'

# HTTP traffic (port 80 and 8080)
tcpdump -i eth0 'tcp and (port 80 or port 8080)' -A | grep -E 'GET|POST|HTTP'
```

### 2.2 Production-Safe Capture Options

Raw captures generate enormous amounts of data. Always limit capture size and duration:

```bash
# -n: Don't resolve hostnames (faster, less DNS noise)
# -nn: Don't resolve hostnames or port names
# -s 0: Capture full packet (default in modern tcpdump is already 65535)
# -C 100: Rotate file at 100MB
# -W 5: Keep max 5 rotated files (500MB total)
# -G 3600: Rotate by time (seconds)
# -w: Write to file (essential for Wireshark analysis)

# Capture with automatic rotation
tcpdump -i eth0 \
  -nn \
  -s 0 \
  -C 100 \
  -W 10 \
  -w /tmp/capture_%Y%m%d_%H%M%S.pcap \
  'tcp port 8080 and (tcp[tcpflags] & (tcp-syn|tcp-rst|tcp-fin) != 0 or tcp[14:2] != 0)'

# Capture for exactly 60 seconds then stop
timeout 60 tcpdump -i eth0 -nn -s 0 -w /tmp/capture.pcap port 8080

# Limit to 100,000 packets
tcpdump -i eth0 -nn -s 0 -w /tmp/capture.pcap -c 100000 port 8080
```

### 2.3 Targeted Filter Recipes

These filters solve specific production problems:

```bash
# Find TCP RST packets (connection resets - often indicates server refusing connections)
tcpdump -i eth0 -nn 'tcp[tcpflags] & tcp-rst != 0'

# Find SYN packets without corresponding SYN-ACK (dropped connections)
tcpdump -i eth0 -nn 'tcp[tcpflags] = tcp-syn'

# Capture retransmissions (packets with non-zero retransmit count)
# (This is best done with ss -tni, but tcpdump can show duplicate ACKs)
tcpdump -i eth0 -nn 'tcp[8:4] != 0 and tcp[4:4] == tcp[8:4]'

# HTTP 5xx errors (payload contains "5" as first digit of status)
tcpdump -i eth0 -nn -A 'tcp port 80 and (((ip[2:2] - ((ip[0]&0xf)<<2)) - ((tcp[12]&0xf0)>>2)) != 0)' | \
  grep -E "HTTP/1\.[01] 5[0-9]{2}"

# Large TCP packets (potential MTU issues)
tcpdump -i eth0 -nn 'ip[2:2] > 1400'

# Packets with ECN congestion marks (network congestion indicator)
tcpdump -i eth0 -nn 'tcp[13] & 0x40 != 0'

# TLS handshake failures (ClientHello on 443 but no ServerHello)
tcpdump -i eth0 -nn 'tcp port 443 and tcp[20] = 22 and tcp[25] = 1'
```

### 2.4 Analyzing Captures in Real-Time

```bash
# Print ASCII payload for HTTP debugging
tcpdump -i eth0 -nn -A 'port 8080' | grep -v "^[a-f0-9][a-f0-9]"

# Print hex+ASCII (useful for binary protocols)
tcpdump -i eth0 -nn -X 'port 5432'  # PostgreSQL

# Verbose output showing TCP options, sequence numbers
tcpdump -i eth0 -vv -nn 'tcp port 8080'

# Count packets per second
tcpdump -i eth0 -nn -q 'port 8080' 2>&1 | \
  awk 'NR%100==0 {print NR, "packets"}'

# Find top talkers (source IPs generating most traffic)
tcpdump -i eth0 -nn -c 10000 2>/dev/null | \
  awk '{print $3}' | \
  cut -d. -f1-4 | \
  sort | uniq -c | sort -rn | head -20
```

### 2.5 Capturing on Multiple Interfaces

```bash
# On all interfaces
tcpdump -i any -nn -w /tmp/capture.pcap 'port 8080'

# List available interfaces
tcpdump -D

# On a specific VLAN interface
tcpdump -i eth0.100 -nn port 8080

# On a bridge interface (common in Kubernetes)
tcpdump -i cni0 -nn port 8080
```

## Section 3: Wireshark Remote Capture

### 3.1 Remote Capture via SSH Pipe

The most powerful production workflow: run tcpdump on the server, pipe the raw pcap data over SSH to Wireshark on your workstation. No files on disk, real-time analysis:

```bash
# macOS/Linux workstation - requires Wireshark installed
ssh user@prod-server "sudo tcpdump -nn -s 0 -U -w - 'port 8080'" | wireshark -k -i -

# With specific interface and filter
ssh -C user@10.0.0.5 \
  "sudo tcpdump -nn -s 0 -U -w - -i eth0 'not port 22 and port 8080'" | \
  wireshark -k -i -

# For Kubernetes pods - capture in a pod's network namespace
POD="my-pod-xyz"
NAMESPACE="production"
NODE=$(kubectl get pod $POD -n $NAMESPACE -o jsonpath='{.spec.nodeName}')

ssh $NODE "
  PID=\$(docker inspect \$(docker ps | grep $POD | awk '{print \$1}' | head -1) \
    --format '{{.State.Pid}}')
  sudo nsenter -t \$PID -n tcpdump -nn -s 0 -U -w - 'port 8080'
" | wireshark -k -i -
```

### 3.2 tshark for Command-Line Analysis

When Wireshark GUI isn't available, `tshark` (Wireshark's CLI) provides the same dissectors:

```bash
# Read a pcap file with tshark
tshark -r capture.pcap

# Filter by protocol
tshark -r capture.pcap -Y 'http'
tshark -r capture.pcap -Y 'tcp.analysis.retransmission'

# Show HTTP request/response pairs
tshark -r capture.pcap -Y 'http.request or http.response' \
  -T fields \
  -e frame.number \
  -e ip.src \
  -e ip.dst \
  -e http.request.method \
  -e http.request.uri \
  -e http.response.code \
  -E separator=,

# Show TCP retransmissions with timing
tshark -r capture.pcap -Y 'tcp.analysis.retransmission' \
  -T fields \
  -e frame.time_relative \
  -e ip.src \
  -e ip.dst \
  -e tcp.srcport \
  -e tcp.dstport \
  -e tcp.seq \
  -e tcp.analysis.retransmission_delay

# Statistics: protocol hierarchy
tshark -r capture.pcap -q -z io,phs

# Statistics: TCP stream graph (for a specific stream)
tshark -r capture.pcap -q -z "follow,tcp,ascii,0"

# Identify slow HTTP responses (>1 second)
tshark -r capture.pcap -q -z "http,tree" | grep -A2 "Response Time"
```

### 3.3 Key Wireshark Display Filters for Production Issues

In Wireshark GUI, use these display filters in the filter bar:

```
# TCP retransmissions (find packet loss)
tcp.analysis.retransmission

# Duplicate ACKs (precursor to retransmission)
tcp.analysis.duplicate_ack

# TCP window full (receiver-side bottleneck)
tcp.analysis.window_full

# TCP zero window (receiver not reading data)
tcp.analysis.zero_window

# TCP reset packets (connection rejections)
tcp.flags.reset == 1

# TCP SYN packets (new connection attempts)
tcp.flags.syn == 1 && tcp.flags.ack == 0

# All expert information (errors, warnings, notes)
expert.severity == error

# HTTP 5xx errors
http.response.code >= 500

# TLS handshake failures
tls.alert_message.level == 2

# Slow HTTP response times
http.time > 1.0

# gRPC status code errors
grpc.status_code != 0

# DNS query timeouts (query with no response in the capture)
dns && dns.flags.response == 0 && !dns.flags.response
```

## Section 4: Kubernetes Network Troubleshooting

### 4.1 Capturing Pod-to-Pod Traffic

Kubernetes pods run in network namespaces. To capture their traffic, you must enter the namespace:

```bash
# Method 1: kubectl debug ephemeral container (requires EphemeralContainers feature)
kubectl debug -it my-pod -n production \
  --image=nicolaka/netshoot \
  --target=my-container

# Inside the netshoot container:
tcpdump -i eth0 -nn -w /tmp/capture.pcap port 8080
# Ctrl+C when done

# Copy the capture file
kubectl cp production/my-pod:/tmp/capture.pcap ./capture.pcap -c debugger

# Method 2: Enter pod network namespace via node
# Find which node the pod is on
kubectl get pod my-pod -n production -o wide
# NAME     READY   STATUS    RESTARTS   AGE   IP           NODE
# my-pod   1/1     Running   0          2d    10.244.1.5   node-1

# SSH to node-1, then find the pod's netns
ssh node-1

# Get the container PID
CONTAINER_ID=$(crictl pods --name my-pod --namespace production -q)
CONTAINER_TASK=$(crictl inspect $CONTAINER_ID | jq -r '.info.pid')

# Or using kubectl describe
PID=$(kubectl describe pod my-pod -n production | grep "Container ID" | \
  awk -F'/' '{print $NF}' | xargs docker inspect --format='{{.State.Pid}}' 2>/dev/null || \
  kubectl describe pod my-pod -n production | grep "Container ID" | \
  awk -F'/' '{print $NF}' | xargs crictl inspect --output json | jq '.info.pid')

# Enter the network namespace and capture
sudo nsenter -t $PID -n tcpdump -nn -s 0 -w /tmp/pod-capture.pcap

# Method 3: Use ksniff kubectl plugin
kubectl sniff my-pod -n production -p -o /tmp/capture.pcap
# Automatically streams to Wireshark:
kubectl sniff my-pod -n production -p | wireshark -k -i -
```

### 4.2 Capturing Kubernetes Service Traffic

Services are implemented by kube-proxy (iptables/ipvs) rules. Capture at the right layer:

```bash
# Capture traffic to a ClusterIP (on the node where the client pod runs)
SERVICE_IP=$(kubectl get svc my-service -n production -o jsonpath='{.spec.clusterIP}')
tcpdump -i any -nn "host $SERVICE_IP"

# Capture traffic at the kube-proxy DNAT level (after NAT translation)
# Use the pod IP instead of service IP
POD_IPS=$(kubectl get endpoints my-service -n production \
  -o jsonpath='{.subsets[*].addresses[*].ip}')
echo "Pod IPs: $POD_IPS"

for ip in $POD_IPS; do
  tcpdump -i any -nn "host $ip" -w /tmp/svc-traffic-$ip.pcap &
done

# Capture DNS resolution for Kubernetes services
tcpdump -i any -nn 'port 53' | grep -E "my-service|kube-dns"

# Check iptables rules for a service
iptables-save | grep $SERVICE_IP

# IPVS mode - check virtual server
ipvsadm -Ln | grep $SERVICE_IP
```

### 4.3 Diagnosing CoreDNS Issues

DNS failures are the most common Kubernetes networking complaint. Use tcpdump to distinguish between client timeout, DNS server error, and network issues:

```bash
# Capture all DNS traffic on a node
tcpdump -i any -nn 'port 53' -w /tmp/dns-capture.pcap

# Analyze DNS capture with tshark
tshark -r dns-capture.pcap -Y "dns" \
  -T fields \
  -e frame.time_relative \
  -e ip.src \
  -e ip.dst \
  -e dns.qry.name \
  -e dns.flags.response \
  -e dns.resp.ttl \
  -e dns.flags.rcode \
  | column -t

# Find DNS queries with NXDOMAIN responses
tshark -r dns-capture.pcap -Y "dns.flags.rcode == 3" \
  -T fields -e dns.qry.name

# Find DNS queries that never got a response (potential timeouts)
# Queries with flags.response == 0 and no matching response in file
tshark -r dns-capture.pcap -Y "dns.flags.qr == 0" \
  -T fields -e frame.number -e dns.id -e dns.qry.name

# Check CoreDNS performance in the cluster
kubectl exec -n kube-system deploy/coredns -- dig @localhost kubernetes.default.svc.cluster.local +stats
```

### 4.4 Investigating Network Policy Drops

When NetworkPolicies are dropping packets, you'll see connection timeouts but no error responses:

```bash
# Use conntrack to see dropped packets
conntrack -L | grep "UNREPLIED"
conntrack -S  # Show statistics including drops

# Check kernel drop counters per interface
ip -s link show eth0
# Shows RX/TX dropped packets

# iptables drop statistics
iptables -L -v -n | grep -E "DROP|REJECT"

# Capture RST packets - if you see RST, the server received the packet
# If you see nothing, packets are being dropped before reaching the server
tcpdump -i eth0 -nn "host 10.244.1.5 and tcp[tcpflags] & tcp-rst != 0"

# Check if Cilium (or Calico) is dropping packets
# For Cilium:
cilium monitor --type drop

# For Calico:
kubectl exec -n kube-system ds/calico-node -- \
  calico-node -felix-live-logging-enabled -dv 2>&1 | grep "Dropped"
```

## Section 5: TCP Retransmit Analysis

### 5.1 Identifying Retransmit Storms

```bash
# Watch retransmit counters in real-time
watch -n1 'ss -s | grep "TCP:"'

# More detailed per-connection retransmit tracking
ss -tni | grep -E "^ESTAB|retrans" | paste - - | \
  awk '$2 != "0/0" {print}' | head -20

# System-wide TCP statistics
netstat -s | grep -i "retransmit\|timeout\|failed"
# Or with ss:
cat /proc/net/snmp | grep -i tcp

# Detailed TCP MIB counters
nstat -az | grep -E "TcpRetrans|TcpLostRetransmit|TcpTimeouts"

# Watch retransmit rate
watch -n1 "nstat -z 2>/dev/null | grep TcpRetrans"
```

### 5.2 Tuning TCP Retransmit Behavior

```bash
# Check current retransmit timeout settings
sysctl net.ipv4.tcp_retries1
sysctl net.ipv4.tcp_retries2
# tcp_retries1 = 3  (before reporting to IP layer)
# tcp_retries2 = 15 (before giving up; ~13-30 minutes!)

# For microservice environments with fast failover:
# Reduce to fail faster
cat >> /etc/sysctl.d/99-tcp-tuning.conf << 'EOF'
# Reduce retransmit count for faster failure detection
# Be careful: too low causes false failures on slow networks
net.ipv4.tcp_retries2 = 8

# Syn retransmits before giving up on new connection
net.ipv4.tcp_syn_retries = 3

# Reduce initial RTO (retransmit timeout) minimum
# Default: 200ms, reduce for fast LANs
net.ipv4.tcp_rto_min_us = 5000  # 5ms minimum (kernel 4.19+)
EOF

sysctl -p /etc/sysctl.d/99-tcp-tuning.conf
```

### 5.3 Diagnosing MTU Issues with tcpdump

Path MTU Discovery (PMTUD) failures cause intermittent large-packet failures:

```bash
# Check interface MTU
ip link show eth0 | grep mtu

# Test specific MTU sizes
ping -M do -s 1472 10.0.0.1  # 1472 + 28 IP/ICMP header = 1500 MTU test
ping -M do -s 1452 10.0.0.1  # Test with VPN/tunnel overhead

# Capture ICMP "fragmentation needed" messages (PMTUD signals)
tcpdump -i eth0 -nn 'icmp[0] = 3 and icmp[1] = 4'
# icmp type 3 = destination unreachable, code 4 = fragmentation needed

# If PMTUD is broken (firewall blocking ICMP type 3/4),
# use clamp MSS to avoid fragmentation
iptables -t mangle -A FORWARD -p tcp --tcp-flags SYN,RST SYN \
  -j TCPMSS --clamp-mss-to-pmtu

# In Kubernetes, check pod MTU vs node MTU (often an issue with overlays)
# Node MTU
ip link show eth0 | grep mtu
# Pod/CNI MTU (should be ~50 bytes less for overlay headers)
kubectl exec my-pod -- ip link show eth0 | grep mtu
```

## Section 6: Complete Production Runbook

### 6.1 The "Connection Refused" Investigation Script

```bash
#!/bin/bash
# investigate-connection-refused.sh
TARGET_HOST=${1:?"Usage: $0 <host> <port>"}
TARGET_PORT=${2:?"Usage: $0 <host> <port>"}
INTERFACE=${3:-eth0}

echo "=== Investigating connection to $TARGET_HOST:$TARGET_PORT ==="

echo ""
echo "[1] DNS Resolution:"
dig +short "$TARGET_HOST" || echo "Not a hostname - treating as IP"

echo ""
echo "[2] TCP Connectivity Test:"
timeout 5 bash -c "echo >/dev/tcp/$TARGET_HOST/$TARGET_PORT" && \
  echo "Port OPEN" || echo "Port CLOSED or FILTERED"

echo ""
echo "[3] Current connections to target:"
ss -tn "dst $TARGET_HOST and dport = :$TARGET_PORT"

echo ""
echo "[4] Routing path to target:"
traceroute -T -p $TARGET_PORT $TARGET_HOST 2>/dev/null | head -10 || \
  tracepath $TARGET_HOST 2>/dev/null | head -10

echo ""
echo "[5] Firewall rules for target port:"
iptables -L -n -v | grep "$TARGET_PORT"

echo ""
echo "[6] Starting packet capture (10 seconds)..."
timeout 10 tcpdump -i "$INTERFACE" -nn -w /tmp/debug-capture.pcap \
  "host $TARGET_HOST and port $TARGET_PORT" 2>&1 &
TCPDUMP_PID=$!

# Try to connect during capture
for i in {1..5}; do
  timeout 2 bash -c "echo >/dev/tcp/$TARGET_HOST/$TARGET_PORT" 2>/dev/null
  sleep 1
done

wait $TCPDUMP_PID

echo ""
echo "[7] Capture analysis:"
tcpdump -r /tmp/debug-capture.pcap -nn 2>/dev/null | head -30

echo ""
echo "[8] TCP flags in capture:"
tshark -r /tmp/debug-capture.pcap \
  -T fields -e ip.src -e ip.dst -e tcp.flags.syn -e tcp.flags.ack \
  -e tcp.flags.rst -e tcp.flags.fin 2>/dev/null | head -20

echo ""
echo "Capture saved to /tmp/debug-capture.pcap"
echo "Open with: wireshark /tmp/debug-capture.pcap"
```

### 6.2 Kubernetes Service Connectivity Diagnostic

```bash
#!/bin/bash
# k8s-svc-connectivity.sh
SERVICE_NAME=${1:?"Usage: $0 <service-name> <namespace>"}
NAMESPACE=${2:-default}

echo "=== Diagnosing service: $SERVICE_NAME in $NAMESPACE ==="

echo ""
echo "[1] Service definition:"
kubectl get svc "$SERVICE_NAME" -n "$NAMESPACE" -o wide

echo ""
echo "[2] Endpoints:"
kubectl get endpoints "$SERVICE_NAME" -n "$NAMESPACE" -o wide

echo ""
echo "[3] Backing pods (matching selector):"
SELECTOR=$(kubectl get svc "$SERVICE_NAME" -n "$NAMESPACE" \
  -o jsonpath='{.spec.selector}' | jq -r 'to_entries | map(.key+"="+.value) | join(",")')
kubectl get pods -n "$NAMESPACE" -l "$SELECTOR" -o wide

echo ""
echo "[4] Pod readiness:"
kubectl get pods -n "$NAMESPACE" -l "$SELECTOR" \
  -o jsonpath='{range .items[*]}{.metadata.name}: ready={.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}'

echo ""
echo "[5] Testing DNS resolution from cluster:"
kubectl run dns-test --rm -it --restart=Never \
  --image=busybox:1.36 \
  --command -- nslookup "$SERVICE_NAME.$NAMESPACE.svc.cluster.local" 2>/dev/null || true

echo ""
echo "[6] Testing HTTP connectivity from cluster:"
SVC_PORT=$(kubectl get svc "$SERVICE_NAME" -n "$NAMESPACE" \
  -o jsonpath='{.spec.ports[0].port}')
kubectl run http-test --rm -it --restart=Never \
  --image=curlimages/curl:8.7.1 \
  --command -- curl -v --connect-timeout 5 \
  "http://$SERVICE_NAME.$NAMESPACE.svc.cluster.local:$SVC_PORT/healthz" 2>/dev/null || true

echo ""
echo "[7] NetworkPolicy affecting the service:"
kubectl get networkpolicy -n "$NAMESPACE" -o wide

echo ""
echo "Diagnostic complete."
```

Network troubleshooting is a skill built through systematic methodology. The tools described here — ss for state inspection, tcpdump for targeted capture, and tshark/Wireshark for analysis — provide a complete toolkit. The key is knowing which layer to inspect: socket state reveals application behavior, packet captures reveal network behavior, and TCP counters reveal systemic performance patterns.
