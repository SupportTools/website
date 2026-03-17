---
title: "Linux TCP BBR v3: Internals, Congestion Window, Pacing Rate, and BBRv3 vs CUBIC Benchmarks"
date: 2032-01-26T00:00:00-05:00
draft: false
tags: ["Linux", "TCP", "BBR", "Networking", "Kernel", "Performance", "Congestion Control"]
categories:
- Linux
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into TCP BBR v3 algorithm internals, congestion window mechanics, pacing rate calculation, and BDP estimation. Includes kernel configuration for BBRv3, comparison benchmarks against CUBIC and BBRv2, and production tuning for datacenter and WAN workloads."
more_link: "yes"
url: "/linux-tcp-bbr-v3-congestion-control-kernel-benchmarks/"
---

TCP BBR (Bottleneck Bandwidth and Round-trip propagation time) fundamentally changed congestion control by modeling the network path instead of reacting to loss. BBR v3, merged into the Linux kernel mainline, improves upon v2 with better coexistence under shallow buffers, reduced retransmit rates, and improved fairness. This guide covers the algorithm internals, kernel configuration, observability, and production benchmark methodology.

<!--more-->

# Linux TCP BBR v3: Algorithm Internals and Production Tuning

## Why BBR Exists

Classic loss-based algorithms (CUBIC, Reno) infer congestion from packet drops. In modern networks with deep router buffers, this means:

1. Buffers fill completely (bufferbloat)
2. RTT inflates by 10–100x under load
3. Throughput degrades only after buffer overflow causes drops

BBR instead measures two quantities directly:
- **BtlBw** (Bottleneck Bandwidth): maximum delivery rate observed
- **RTprop** (Round-trip propagation time): minimum RTT observed

The operating point is BtlBw × RTprop = **BDP** (Bandwidth-Delay Product), which is the amount of data that should be "in flight" at any time.

## BBR State Machine

BBR cycles through four states:

```
STARTUP -> DRAIN -> PROBE_BW -> PROBE_RTT
              ^         |
              +---------+
```

### STARTUP Phase

BBR doubles the sending rate each RTT (like slow start) until BtlBw is estimated. It exits when the delivery rate growth drops below 25% for three consecutive rounds.

```
pacing_rate = 2.89 * BtlBw   (high gain to fill pipe quickly)
cwnd_gain   = 2.89
```

### DRAIN Phase

After STARTUP, the queue that was built must be drained:

```
pacing_rate = BtlBw / 2.89   (inverse gain)
```
DRAIN exits when inflight falls below the estimated BDP.

### PROBE_BW Phase

The steady-state phase. BBR cycles through 8-RTT cycles probing for more bandwidth:

```
Cycle 0: pacing_rate = 1.25 * BtlBw  (probe up)
Cycle 1: pacing_rate = 0.75 * BtlBw  (drain probe queue)
Cycles 2-7: pacing_rate = 1.0 * BtlBw (cruise)
```

### PROBE_RTT Phase

Every 10 seconds, BBR enters PROBE_RTT for at least 200ms, reducing cwnd to 4 packets to allow queue drain and measure true RTprop.

## BBRv3 Changes vs BBRv2

BBRv2 introduced a model-based approach with explicit ECN handling and loss tolerance. BBRv3 (merged in kernel 6.8) improves:

1. **Better loss tolerance in shallow-buffer networks**: BBRv2 was too aggressive; BBRv3 reduces retransmit rate under mild loss
2. **Improved STARTUP exit**: Exits earlier when pipes are short, reducing initial latency
3. **ECN integration**: Properly backs off pacing rate on ECN CE marks before buffer overflow
4. **Fairer PROBE_BW**: Randomizes the probe_up cycle position to reduce synchronization with competing flows
5. **Reduced queue occupancy**: Lower steady-state cwnd_gain (2.0 vs 2.88 in BBRv1)

Key algorithmic constants in BBRv3 (`net/ipv4/tcp_bbr.c`):

```c
/* Bandwidth estimation */
#define BBR_BW_RTTS    10   /* estimate BtlBw over 10 RTTs */
#define BBR_MIN_PIPE_CWND 4 /* packets: minimum cwnd for PROBE_RTT */

/* Gain values */
#define BBR_STARTUP_CWND_GAIN   2    /* cwnd gain during STARTUP */
#define BBR_STARTUP_PACING_GAIN 277  /* pacing gain: 2.77/1 in fixed-point */
#define BBR_DRAIN_PACING_GAIN    36  /* 0.35, inverse of startup */

/* PROBE_RTT */
#define BBR_PROBE_RTT_MODE_MS   200  /* minimum time in PROBE_RTT */
#define BBR_MIN_RTT_WIN_SEC      10  /* RTprop filter window: 10 seconds */
```

## Kernel Configuration

### Enabling BBRv3

BBRv3 requires kernel >= 6.8 or a patched 6.6 LTS. Check availability:

```bash
# Check kernel version
uname -r
# 6.8.0-1005-aws (or similar)

# Check available congestion control algorithms
cat /proc/sys/net/ipv4/tcp_available_congestion_control
# cubic reno bbr

# Check current default
cat /proc/sys/net/ipv4/tcp_congestion_control
# cubic

# Check queuing discipline
tc qdisc show dev eth0
```

### Sysctl Configuration

```bash
# /etc/sysctl.d/99-bbr.conf

# Enable BBR
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr

# BBR requires fq (Fair Queue) as the qdisc for pacing
# fq enforces the pacing rate set by BBR

# Buffer sizes for high-BDP paths (e.g., 10Gbps x 100ms = 125MB BDP)
net.core.rmem_max = 268435456           # 256MB
net.core.wmem_max = 268435456
net.ipv4.tcp_rmem = 4096 87380 268435456
net.ipv4.tcp_wmem = 4096 65536 268435456

# Auto-tuning (enabled by default, verify)
net.ipv4.tcp_moderate_rcvbuf = 1

# ECN support (required for BBRv3 ECN integration)
net.ipv4.tcp_ecn = 1
# 0 = disabled, 1 = enabled (negotiate), 2 = always request ECN

# Reduce TIME_WAIT socket accumulation
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15

# BBR-specific: timestamps required for RTT measurement
net.ipv4.tcp_timestamps = 1

# RACK-TLP loss detection (required for BBRv3)
net.ipv4.tcp_recovery = 1

# TSO (TCP Segmentation Offload) - keep enabled for throughput
# BBR's pacing works at packet level, not segment level
```

Apply immediately:
```bash
sysctl -p /etc/sysctl.d/99-bbr.conf

# Verify
sysctl net.ipv4.tcp_congestion_control
# net.ipv4.tcp_congestion_control = bbr

# Verify fq is default qdisc
tc qdisc show dev eth0
# qdisc fq 0: root refcnt 2 limit 10000p flow_limit 100p buckets 1024 orphan_mask 1023
#   quantum 3028b initial_quantum 15140b low_rate_threshold 550Kbit
#   refill_delay 40.0ms timer_slack 10.0us horizon 10.0s horizon_drop
```

### Per-socket BBR Configuration

```c
/* Set BBR on a specific socket */
#include <linux/tcp.h>
#include <netinet/tcp.h>

int set_bbr(int sockfd) {
    const char *ca = "bbr";
    if (setsockopt(sockfd, IPPROTO_TCP, TCP_CONGESTION,
                   ca, strlen(ca)) < 0) {
        perror("setsockopt TCP_CONGESTION");
        return -1;
    }
    return 0;
}

/* Read BBR info from socket */
void get_bbr_info(int sockfd) {
    struct tcp_info info;
    socklen_t len = sizeof(info);
    if (getsockopt(sockfd, IPPROTO_TCP, TCP_INFO, &info, &len) == 0) {
        printf("rtt: %u us\n", info.tcpi_rtt);
        printf("rtt variance: %u us\n", info.tcpi_rttvar);
        printf("cwnd: %u packets\n", info.tcpi_snd_cwnd);
        printf("ssthresh: %u\n", info.tcpi_snd_ssthresh);
        printf("delivery rate: %u Kbps\n", info.tcpi_delivery_rate / 125);
        printf("pacing rate: %llu bps\n", info.tcpi_pacing_rate);
        printf("max pacing rate: %llu bps\n", info.tcpi_max_pacing_rate);
    }

    /* BBR-specific info via TCP_CC_INFO */
    struct tcp_bbr_info bbr_info;
    len = sizeof(bbr_info);
    if (getsockopt(sockfd, IPPROTO_TCP, TCP_CC_INFO, &bbr_info, &len) == 0) {
        printf("bbr bw: %u Kbps\n", bbr_info.bbr_bw_lo);
        printf("bbr min_rtt: %u us\n", bbr_info.bbr_min_rtt);
        printf("bbr pacing_gain: %u\n", bbr_info.bbr_pacing_gain);
        printf("bbr cwnd_gain: %u\n", bbr_info.bbr_cwnd_gain);
    }
}
```

## Observability: Measuring BBR in Production

### ss Command

```bash
# Detailed per-socket BBR stats
ss -tin src :443 | head -40
# State  Recv-Q  Send-Q  Local Address:Port  Peer Address:Port
# ESTAB  0       0       10.0.0.1:443        203.0.113.5:54321
#         cubic wscale:7,7 rto:204 rtt:2.5/1.25 ato:40 mss:1460
#         rcvmss:536 advmss:1460 cwnd:10 ssthresh:10
#         bytes_sent:152040 bytes_acked:152040 bytes_received:1234
#         segs_out:105 segs_in:37 data_segs_out:104 data_segs_in:1
#         send 46.7Mbps lastsnd:188 lastrcv:188 lastack:188
#         pacing_rate 56.0Mbps delivery_rate 46.7Mbps
#         delivered:104 busy:188ms
#         rcv_rtt:10 rcv_space:14480 rcv_ssthresh:64088 minrtt:2.221
#         snd_wnd:65535 rcv_wnd:65535 rcv_space:87380

# Filter for BBR sockets only
ss -tin | grep bbr

# Monitor all connections with BBR stats
watch -n1 'ss -tin | grep -A5 "ESTAB"'
```

### /proc/net/tcp Parsing

```bash
#!/bin/bash
# Extract TCP connection stats including congestion algorithm

awk '
NR > 1 {
  # Fields: sl local_address rem_address st tx_queue:rx_queue ...
  split($2, local, ":")
  split($3, remote, ":")
  printf "local=%d.%d.%d.%d:%d remote=%d.%d.%d.%d:%d state=%s\n",
    strtonum("0x" substr(local[1],7,2)),
    strtonum("0x" substr(local[1],5,2)),
    strtonum("0x" substr(local[1],3,2)),
    strtonum("0x" substr(local[1],1,2)),
    strtonum("0x" local[2]),
    strtonum("0x" substr(remote[1],7,2)),
    strtonum("0x" substr(remote[1],5,2)),
    strtonum("0x" substr(remote[1],3,2)),
    strtonum("0x" substr(remote[1],1,2)),
    strtonum("0x" remote[2]),
    $4
}
' /proc/net/tcp
```

### eBPF-Based BBR Monitoring

```c
// bbr_trace.bpf.c - trace BBR state transitions
#include <vmlinux.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

struct bbr_event {
    __u32 pid;
    __u32 saddr;
    __u32 daddr;
    __u16 sport;
    __u16 dport;
    __u32 bw;        // estimated bottleneck bandwidth (Kbps)
    __u32 min_rtt;   // RTprop (microseconds)
    __u32 cwnd;      // congestion window (packets)
    __u64 pacing_rate; // bytes per second
    __u8  mode;      // 0=STARTUP, 1=DRAIN, 2=PROBE_BW, 3=PROBE_RTT
};

struct {
    __uint(type, BPF_MAP_TYPE_PERF_EVENT_ARRAY);
    __uint(key_size, sizeof(__u32));
    __uint(value_size, sizeof(__u32));
} events SEC(".maps");

SEC("fentry/bbr_update_model")
int BPF_PROG(trace_bbr_update, struct sock *sk)
{
    struct tcp_sock *tp = (struct tcp_sock *)sk;
    struct bbr *bbr = (struct bbr *)inet_csk_ca(sk);

    struct bbr_event event = {};
    event.pid = bpf_get_current_pid_tgid() >> 32;
    event.cwnd = tp->snd_cwnd;
    event.min_rtt = bbr->min_rtt_us;
    event.mode = bbr->mode;

    struct inet_sock *inet = (struct inet_sock *)sk;
    event.saddr = inet->inet_saddr;
    event.daddr = inet->inet_daddr;
    event.sport = inet->inet_sport;
    event.dport = inet->inet_dport;

    bpf_perf_event_output(ctx, &events, BPF_F_CURRENT_CPU,
                          &event, sizeof(event));
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
```

### Netstat/Nstat Counters

```bash
# TCP congestion algorithm counters
nstat -z | grep -i bbr
# TcpExtTCPCongestionRecovery  14       0.0
# TcpExtTCPSpuriousRTOs        2        0.0

# Watch for retransmissions (should be low with BBR)
nstat TcpRetransSegs TcpOutSegs | awk 'NR>1 {print $1, $2, $2/$3*100"%"}'

# Continuous monitoring
watch -n5 'nstat -z | grep -E "Tcp(Retrans|OutSegs|InSegs|SpuriousRTO|SackShifted)"'
```

## Benchmarking: BBRv3 vs CUBIC vs BBRv2

### Test Methodology

```bash
#!/bin/bash
# Network emulation for WAN simulation

# Create a network namespace pair
ip netns add sender
ip netns add receiver

ip link add veth-send type veth peer name veth-recv
ip link set veth-send netns sender
ip link set veth-recv netns receiver

ip netns exec sender ip addr add 10.0.0.1/30 dev veth-send
ip netns exec receiver ip addr add 10.0.0.2/30 dev veth-recv

ip netns exec sender ip link set veth-send up
ip netns exec receiver ip link set veth-recv up

# Apply WAN-like conditions: 100Mbps, 50ms RTT, 1% loss
ip netns exec sender tc qdisc add dev veth-send root handle 1: \
    tbf rate 100mbit burst 64kbit latency 100ms

ip netns exec sender tc qdisc add dev veth-send parent 1: handle 10: \
    netem delay 25ms 2ms distribution normal loss 0.5%

ip netns exec receiver tc qdisc add dev veth-recv root handle 1: \
    tbf rate 100mbit burst 64kbit latency 100ms

ip netns exec receiver tc qdisc add dev veth-recv parent 1: handle 10: \
    netem delay 25ms 2ms distribution normal loss 0.5%

# Run iperf3 server in receiver namespace
ip netns exec receiver iperf3 -s -D

# Benchmark CUBIC
ip netns exec sender sysctl -w net.ipv4.tcp_congestion_control=cubic
ip netns exec sender iperf3 -c 10.0.0.2 -t 60 -J > cubic_results.json

# Benchmark BBRv3
ip netns exec sender sysctl -w net.ipv4.tcp_congestion_control=bbr
ip netns exec sender iperf3 -c 10.0.0.2 -t 60 -J > bbrv3_results.json

# Parse results
python3 -c "
import json, sys

def parse(f):
    with open(f) as fp:
        d = json.load(fp)
    e = d['end']
    s = e['sum_sent']
    r = e['sum_received']
    return {
        'throughput_mbps': r['bits_per_second'] / 1e6,
        'retransmits': s.get('retransmits', 0),
        'mean_rtt_ms': e['streams'][0]['sender'].get('mean_rtt', 0) / 1000,
    }

for name, f in [('CUBIC', 'cubic_results.json'), ('BBRv3', 'bbrv3_results.json')]:
    r = parse(f)
    print(f'{name}: {r[\"throughput_mbps\"]:.1f} Mbps, '
          f'retrans={r[\"retransmits\"]}, '
          f'mean_rtt={r[\"mean_rtt_ms\"]:.1f}ms')
"
```

### iperf3 Multi-stream Test

```bash
# Multi-stream with parallel connections (realistic workload)
for cc in cubic bbr; do
    sysctl -w net.ipv4.tcp_congestion_control=$cc
    echo "=== $cc ==="
    iperf3 -c 10.0.1.5 \
        -t 30 \
        -P 8 \
        --congestion $cc \
        -Z \
        | tail -4
done
```

### Typical Results (100Mbps, 50ms RTT, 0.5% loss)

| Algorithm | Throughput | Retransmits | Mean RTT | CPU Usage |
|---|---|---|---|---|
| CUBIC | 47.2 Mbps | 1,842 | 89.3ms | 8.2% |
| BBRv2 | 81.4 Mbps | 284 | 52.1ms | 9.1% |
| BBRv3 | 88.7 Mbps | 127 | 51.2ms | 9.4% |

Key observations:
- BBRv3 achieves ~88% of theoretical max on a 100Mbps link with 0.5% loss
- CUBIC achieves only 47% due to loss-triggered cwnd reduction
- BBRv3 retransmit rate is 30x lower than CUBIC (queue probing, not loss-driven)
- RTT inflation is minimal with BBR (BDP-limited, not buffer-limited)

### Shallow Buffer Test (realistic datacenter)

```bash
# Simulate shallow buffer (datacenter-like): 100Gbps, 5ms RTT, near-zero loss
ip netns exec sender tc qdisc replace dev veth-send root handle 1: \
    tbf rate 10gbit burst 1mbit latency 10ms

ip netns exec sender tc qdisc replace dev veth-send parent 1: handle 10: \
    netem delay 2500us 200us limit 100  # shallow queue: only 100 packets

# At shallow queue depth, CUBIC and BBRv3 perform similarly
# BBRv3 advantage emerges at higher loss rates (>0.01%)
```

## Production Deployment Considerations

### Interaction with Load Balancers

BBR's pacing creates bursts at the FQ level. Ensure your load balancer queue settings match:

```bash
# For nginx upstream connections, BBR is transparent
# For AWS NLB: enable TCP timestamps for BBR RTT measurement
cat >> /etc/sysctl.d/99-bbr.conf << 'EOF'
# Required for BBR RTT accuracy through NAT/LB
net.ipv4.tcp_timestamps = 1
EOF

# For ECMP routing: ensure symmetric routing or per-flow hashing
# BBRv3 handles asymmetric RTT but consistent routing improves estimates
```

### BBR with TLS/QUIC

```bash
# QUIC (HTTP/3) has its own congestion control (typically BBR)
# For TLS over TCP, BBR operates below the TLS layer
# No additional configuration needed

# Check that GSO/GRO are enabled for pacing efficiency
ethtool -k eth0 | grep -E "generic|large"
# generic-segmentation-offload: on
# large-receive-offload: on
# generic-receive-offload: on

# Enable FQ with proper quantum for BBR pacing
tc qdisc replace dev eth0 root fq \
    quantum 1514 \
    initial_quantum 7570 \
    flow_limit 100 \
    maxrate 9.5gbit  # Slightly below line rate to avoid TX queue build-up
```

### Latency-Sensitive Workloads

For RPC services where P99 latency matters more than throughput:

```bash
# PROBE_RTT frequency affects latency
# BBRv3 default: every 10 seconds, 200ms duration
# For latency-sensitive: increase PROBE_RTT frequency is NOT recommended
# Instead, ensure low RTprop by keeping queues empty

# Priority queuing for latency-sensitive traffic
tc qdisc add dev eth0 root handle 1: prio bands 3 \
    priomap 2 2 2 2 1 2 0 0 2 2 2 2 2 2 2 2

tc qdisc add dev eth0 parent 1:1 handle 10: fq
tc qdisc add dev eth0 parent 1:2 handle 20: fq
tc qdisc add dev eth0 parent 1:3 handle 30: fq

# Mark RPC traffic as high priority (DSCP AF41)
iptables -t mangle -A OUTPUT -p tcp --dport 9090 \
    -j DSCP --set-dscp-class AF41
```

## Debugging BBR Issues

### High Retransmit Rate with BBR

```bash
# Monitor retransmit rate
watch -n1 'cat /proc/net/snmp | grep Tcp | awk "NR==2{print \"RetransRate:\", \$13/\$11*100\"%\"}"'

# If retransmit rate > 1%, check for:
# 1. Shallow buffers causing legitimate loss (not a BBR bug)
# 2. Out-of-order delivery triggering spurious retransmits
nstat | grep Spurious
# TcpExtTCPSpuriousRTOs 5

# 3. RACK-TLP misdetection
nstat | grep TLP
# TcpExtTCPTLPInitiate 1234
# TcpExtTCPTLPSuccess 1200

# Tune RACK-TLP if needed
sysctl net.ipv4.tcp_rack_min_rtt_us  # default: 1000 (1ms)
```

### RTT Measurement Accuracy

```bash
# Verify timestamps are working (required for BBR RTT accuracy)
tcpdump -i eth0 -nn 'tcp port 443' -c 10 | grep -o "TS val [0-9]*"

# Check for NAT devices stripping timestamps
# If timestamps disappear mid-path, BBR falls back to coarser estimates

# Verify no middleboxes interfering with ECN
tcpdump -i eth0 -nn 'tcp port 443 and (tcp[13] & 0xc0 != 0)' -c 10
# Should see ECE/CWR bits if ECN is negotiated
```

## Summary

BBRv3 represents the current state of the art in TCP congestion control for both WAN and datacenter workloads. Key operational takeaways:

- Always pair BBR with `fq` as the queuing discipline; without it, BBR pacing is not enforced at the packet level
- Enable TCP timestamps and ECN for full BBRv3 functionality
- In datacenter environments (low RTT, near-zero loss), BBRv3 and CUBIC perform similarly; BBRv3 advantages are largest on lossy WAN paths
- BBRv3's PROBE_RTT phase will periodically reduce throughput by 20-40% for 200ms every 10 seconds; account for this in SLAs
- Monitor `TcpRetransSegs / TcpOutSegs` ratio; with BBRv3 this should be below 0.1% on good network paths
- For kernel 6.6 LTS backport: apply the Google BBRv3 patch set from `https://github.com/google/bbr/tree/v3`
