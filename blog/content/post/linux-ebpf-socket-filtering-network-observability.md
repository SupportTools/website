---
title: "Linux eBPF Socket Filtering: Network Observability Without the Overhead"
date: 2030-05-19T00:00:00-05:00
draft: false
tags: ["eBPF", "Linux", "Networking", "XDP", "Observability", "Performance", "TC", "BPF"]
categories:
- Linux
- Networking
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Guide to using eBPF for socket filtering, XDP programs, TC hooks, packet inspection, and building low-overhead network observability tools for production systems."
more_link: "yes"
url: "/linux-ebpf-socket-filtering-network-observability/"
---

Traditional network monitoring tools such as tcpdump, Wireshark, and packet brokers introduce copying overhead that becomes prohibitive at line rates above 10 Gbps. eBPF programs attached at the kernel's network processing points—XDP (eXpress Data Path), Traffic Control (TC), and socket filters—can perform packet inspection, aggregation, and filtering entirely in kernel space with no data copies to userspace until necessary. This architecture enables production-grade network observability with sub-microsecond overhead per packet.

<!--more-->

## eBPF Network Hook Points

The Linux kernel offers multiple eBPF attachment points in the network stack, each with different capabilities and performance characteristics:

```
NIC Hardware
    ↓
XDP (eXpress Data Path) ← eBPF hook: earliest possible point, before sk_buff allocation
    ↓
Traffic Control ingress (tc/BPF) ← eBPF hook: after sk_buff, can modify and redirect
    ↓
Netfilter/iptables
    ↓
Socket Layer
    ↓
sk_filter (socket filter BPF) ← eBPF hook: per-socket packet filtering
    ↓
Application
```

### Choosing the Right Hook Point

| Hook | Latency Impact | Capabilities | Use Case |
|------|---------------|--------------|----------|
| XDP native | ~50ns per packet | Drop, pass, redirect, TX | DDoS mitigation, load balancing |
| XDP generic | ~200ns | Same as native, software fallback | Development, unsupported NICs |
| TC ingress/egress | ~100ns | Modify, redirect, forward | Network policy, traffic shaping |
| Socket filter | ~50ns | Filter, truncate, copy | Per-application packet capture |
| kprobe/fentry | Variable | Inspect any kernel function | Protocol-level tracing |

## Setting Up the Development Environment

```bash
# Install BPF development dependencies (Ubuntu/Debian)
apt-get install -y \
  clang llvm \
  linux-headers-$(uname -r) \
  libbpf-dev \
  bpftool \
  iproute2 \
  libelf-dev \
  zlib1g-dev

# Verify kernel BPF support
uname -r  # 5.15+ recommended for full feature set
bpftool feature | grep -E "bpf_prog_type|helper"

# Check available program types
bpftool feature list_builtins prog_types
```

## XDP Programs for High-Performance Packet Processing

### Basic XDP Packet Counter

```c
// xdp_packet_counter.c
// Compile: clang -O2 -target bpf -c xdp_packet_counter.c -o xdp_packet_counter.o

#include <linux/bpf.h>
#include <bpf/bpf_helpers.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/ipv6.h>
#include <linux/tcp.h>
#include <linux/udp.h>
#include <arpa/inet.h>

// Per-CPU map for atomic-free updates
struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(key_size, sizeof(__u32));
    __uint(value_size, sizeof(__u64));
    __uint(max_entries, 4);  // 0=total, 1=tcp, 2=udp, 3=other
} packet_counts SEC(".maps");

// Hash map for per-source-IP statistics
struct flow_stats {
    __u64 packets;
    __u64 bytes;
};

struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(key_size, sizeof(__u32));   // source IPv4 address
    __uint(value_size, sizeof(struct flow_stats));
    __uint(max_entries, 65536);
} ip_stats SEC(".maps");

static __always_inline void count_packet(__u32 key) {
    __u64 *count = bpf_map_lookup_elem(&packet_counts, &key);
    if (count) {
        __sync_fetch_and_add(count, 1);
    }
}

SEC("xdp")
int xdp_packet_counter(struct xdp_md *ctx) {
    void *data_end = (void *)(long)ctx->data_end;
    void *data = (void *)(long)ctx->data;

    // Bounds check: ethernet header must fit
    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return XDP_PASS;

    // Count total packets
    __u32 key_total = 0;
    count_packet(key_total);

    __u16 eth_proto = ntohs(eth->h_proto);
    if (eth_proto != ETH_P_IP)
        return XDP_PASS;

    // IPv4 header bounds check
    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return XDP_PASS;

    // Update per-source-IP statistics
    __u32 src_ip = ip->saddr;
    struct flow_stats *stats = bpf_map_lookup_elem(&ip_stats, &src_ip);
    if (stats) {
        __sync_fetch_and_add(&stats->packets, 1);
        __sync_fetch_and_add(&stats->bytes,
            (long)data_end - (long)data);
    } else {
        struct flow_stats new_stats = {.packets = 1, .bytes = (long)data_end - (long)data};
        bpf_map_update_elem(&ip_stats, &src_ip, &new_stats, BPF_NOEXIST);
    }

    // Protocol-specific counting
    switch (ip->protocol) {
    case IPPROTO_TCP: {
        __u32 key_tcp = 1;
        count_packet(key_tcp);
        break;
    }
    case IPPROTO_UDP: {
        __u32 key_udp = 2;
        count_packet(key_udp);
        break;
    }
    default: {
        __u32 key_other = 3;
        count_packet(key_other);
    }
    }

    return XDP_PASS;
}

char LICENSE[] SEC("license") = "GPL";
```

### Go Userspace Program to Load and Read XDP Maps

```go
// cmd/xdp-monitor/main.go
package main

import (
	"encoding/binary"
	"fmt"
	"net"
	"os"
	"os/signal"
	"sort"
	"syscall"
	"time"

	"github.com/cilium/ebpf"
	"github.com/cilium/ebpf/link"
)

//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -cc clang -cflags "-O2 -g -Wall" xdp_counter xdp_packet_counter.c

type FlowStats struct {
	Packets uint64
	Bytes   uint64
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintf(os.Stderr, "usage: xdp-monitor <interface>\n")
		os.Exit(1)
	}
	iface := os.Args[1]

	// Load the pre-compiled BPF objects
	objs := xdp_counterObjects{}
	if err := loadXdp_counterObjects(&objs, nil); err != nil {
		fmt.Fprintf(os.Stderr, "loading BPF objects: %v\n", err)
		os.Exit(1)
	}
	defer objs.Close()

	// Attach XDP program to the interface
	ifaceIdx, err := net.InterfaceByName(iface)
	if err != nil {
		fmt.Fprintf(os.Stderr, "interface %s not found: %v\n", iface, err)
		os.Exit(1)
	}

	l, err := link.AttachXDP(link.XDPOptions{
		Program:   objs.XdpPacketCounter,
		Interface: ifaceIdx.Index,
		Flags:     link.XDPGenericMode, // use XDPDriverMode for native support
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "attaching XDP: %v\n", err)
		os.Exit(1)
	}
	defer l.Close()

	fmt.Printf("XDP program attached to %s. Press Ctrl-C to stop.\n", iface)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)

	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			printStats(objs)
		case <-sig:
			fmt.Println("\nDetaching XDP program...")
			return
		}
	}
}

func printStats(objs xdp_counterObjects) {
	// Read per-CPU packet counts
	keys := []uint32{0, 1, 2, 3}
	labels := []string{"total", "tcp", "udp", "other"}

	fmt.Printf("\n--- Packet Counts ---\n")
	for i, key := range keys {
		var values []uint64
		if err := objs.PacketCounts.Lookup(key, &values); err != nil {
			continue
		}
		var sum uint64
		for _, v := range values {
			sum += v
		}
		fmt.Printf("  %-8s: %d\n", labels[i], sum)
	}

	// Read top IP sources
	type ipEntry struct {
		ip    string
		stats FlowStats
	}
	var entries []ipEntry

	var ipKey uint32
	var stats FlowStats
	iter := objs.IpStats.Iterate()
	for iter.Next(&ipKey, &stats) {
		ipBytes := make([]byte, 4)
		binary.BigEndian.PutUint32(ipBytes, ipKey)
		// Note: source IPs are in network byte order
		binary.LittleEndian.PutUint32(ipBytes, ipKey)
		entries = append(entries, ipEntry{
			ip:    fmt.Sprintf("%d.%d.%d.%d", ipBytes[0], ipBytes[1], ipBytes[2], ipBytes[3]),
			stats: stats,
		})
	}

	sort.Slice(entries, func(i, j int) bool {
		return entries[i].stats.Packets > entries[j].stats.Packets
	})

	fmt.Printf("\n--- Top Source IPs ---\n")
	fmt.Printf("%-20s %12s %15s\n", "Source IP", "Packets", "Bytes")
	for i, e := range entries {
		if i >= 10 {
			break
		}
		fmt.Printf("%-20s %12d %15d\n", e.ip, e.stats.Packets, e.stats.Bytes)
	}
}
```

## TC (Traffic Control) eBPF for Bidirectional Monitoring

TC hooks run after the sk_buff is allocated, enabling both ingress and egress monitoring and packet modification.

### TC-Based Connection Tracker

```c
// tc_conn_tracker.c
#include <linux/bpf.h>
#include <bpf/bpf_helpers.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/tcp.h>
#include <linux/pkt_cls.h>

struct conn_key {
    __u32 src_ip;
    __u32 dst_ip;
    __u16 src_port;
    __u16 dst_port;
    __u8  proto;
    __u8  pad[3];
};

struct conn_stats {
    __u64 tx_packets;
    __u64 tx_bytes;
    __u64 rx_packets;
    __u64 rx_bytes;
    __u64 start_ns;
    __u64 last_seen_ns;
};

struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(key_size, sizeof(struct conn_key));
    __uint(value_size, sizeof(struct conn_stats));
    __uint(max_entries, 262144);   // 256K connections
} connections SEC(".maps");

static __always_inline int process_packet(struct __sk_buff *skb, int direction) {
    void *data = (void *)(long)skb->data;
    void *data_end = (void *)(long)skb->data_end;

    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return TC_ACT_OK;

    if (ntohs(eth->h_proto) != ETH_P_IP)
        return TC_ACT_OK;

    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return TC_ACT_OK;

    if (ip->protocol != IPPROTO_TCP && ip->protocol != IPPROTO_UDP)
        return TC_ACT_OK;

    struct conn_key key = {};
    key.src_ip = ip->saddr;
    key.dst_ip = ip->daddr;
    key.proto = ip->protocol;

    if (ip->protocol == IPPROTO_TCP) {
        struct tcphdr *tcp = (void *)(ip + 1);
        if ((void *)(tcp + 1) > data_end)
            return TC_ACT_OK;
        key.src_port = tcp->source;
        key.dst_port = tcp->dest;
    }

    __u64 now = bpf_ktime_get_ns();
    __u32 pkt_len = (long)data_end - (long)data;

    struct conn_stats *stats = bpf_map_lookup_elem(&connections, &key);
    if (stats) {
        stats->last_seen_ns = now;
        if (direction == 0) {
            __sync_fetch_and_add(&stats->tx_packets, 1);
            __sync_fetch_and_add(&stats->tx_bytes, pkt_len);
        } else {
            __sync_fetch_and_add(&stats->rx_packets, 1);
            __sync_fetch_and_add(&stats->rx_bytes, pkt_len);
        }
    } else {
        struct conn_stats new_stats = {};
        new_stats.start_ns = now;
        new_stats.last_seen_ns = now;
        if (direction == 0) {
            new_stats.tx_packets = 1;
            new_stats.tx_bytes = pkt_len;
        } else {
            new_stats.rx_packets = 1;
            new_stats.rx_bytes = pkt_len;
        }
        bpf_map_update_elem(&connections, &key, &new_stats, BPF_ANY);
    }

    return TC_ACT_OK;
}

SEC("tc/ingress")
int tc_ingress(struct __sk_buff *skb) {
    return process_packet(skb, 1);  // 1 = ingress/rx
}

SEC("tc/egress")
int tc_egress(struct __sk_buff *skb) {
    return process_packet(skb, 0);  // 0 = egress/tx
}

char LICENSE[] SEC("license") = "GPL";
```

### Attaching TC Programs

```bash
# Create a qdisc on the interface (required for TC eBPF)
tc qdisc add dev eth0 clsact

# Attach ingress hook
tc filter add dev eth0 ingress bpf da obj tc_conn_tracker.o sec tc/ingress

# Attach egress hook
tc filter add dev eth0 egress bpf da obj tc_conn_tracker.o sec tc/egress

# Verify attachment
tc filter show dev eth0 ingress
tc filter show dev eth0 egress

# Remove programs
tc filter del dev eth0 ingress
tc filter del dev eth0 egress
tc qdisc del dev eth0 clsact
```

## Socket Filter Programs

Socket filters attach to a specific socket and inspect incoming packets before they are delivered to the application. They are the basis of tools like tcpdump.

### Port-Based Socket Filter

```c
// sock_filter_port.c
#include <linux/bpf.h>
#include <bpf/bpf_helpers.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/tcp.h>
#include <linux/udp.h>

// Configurable filter port stored in BPF map
struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(key_size, sizeof(__u32));
    __uint(value_size, sizeof(__u16));
    __uint(max_entries, 1);
} filter_port SEC(".maps");

// Ring buffer for captured packet metadata
struct packet_event {
    __u32 src_ip;
    __u32 dst_ip;
    __u16 src_port;
    __u16 dst_port;
    __u32 pkt_len;
    __u64 timestamp_ns;
    __u8  proto;
};

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 1 << 24);  // 16 MiB ring buffer
} events SEC(".maps");

SEC("socket")
int sock_filter_by_port(struct __sk_buff *skb) {
    __u32 key = 0;
    __u16 *target_port = bpf_map_lookup_elem(&filter_port, &key);
    if (!target_port)
        return 0;  // 0 = drop the packet for this socket

    void *data = (void *)(long)skb->data;
    void *data_end = (void *)(long)skb->data_end;

    // We're attached to a raw socket; data starts at ethernet header
    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return 0;

    if (ntohs(eth->h_proto) != ETH_P_IP)
        return 0;

    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return 0;

    __u16 src_port = 0, dst_port = 0;

    if (ip->protocol == IPPROTO_TCP) {
        struct tcphdr *tcp = (void *)(ip + 1);
        if ((void *)(tcp + 1) > data_end)
            return 0;
        src_port = ntohs(tcp->source);
        dst_port = ntohs(tcp->dest);
    } else if (ip->protocol == IPPROTO_UDP) {
        struct udphdr *udp = (void *)(ip + 1);
        if ((void *)(udp + 1) > data_end)
            return 0;
        src_port = ntohs(udp->source);
        dst_port = ntohs(udp->dest);
    } else {
        return 0;
    }

    if (src_port != *target_port && dst_port != *target_port)
        return 0;

    // Emit event to ring buffer
    struct packet_event *event = bpf_ringbuf_reserve(&events, sizeof(*event), 0);
    if (!event)
        return skb->len;  // Return packet length to pass it

    event->src_ip = ip->saddr;
    event->dst_ip = ip->daddr;
    event->src_port = src_port;
    event->dst_port = dst_port;
    event->pkt_len = (long)data_end - (long)data;
    event->timestamp_ns = bpf_ktime_get_ns();
    event->proto = ip->protocol;

    bpf_ringbuf_submit(event, 0);

    return skb->len;  // Return packet length to pass the packet
}

char LICENSE[] SEC("license") = "GPL";
```

## Using libbpf-go for Userspace Programs

The `github.com/cilium/ebpf` package is the canonical Go library for eBPF development.

### Ring Buffer Consumer

```go
// internal/netmon/consumer.go
package netmon

import (
	"context"
	"encoding/binary"
	"fmt"
	"net"
	"time"

	"github.com/cilium/ebpf"
	"github.com/cilium/ebpf/ringbuf"
	"go.uber.org/zap"
)

// PacketEvent matches the BPF packet_event struct.
type PacketEvent struct {
	SrcIP       [4]byte
	DstIP       [4]byte
	SrcPort     uint16
	DstPort     uint16
	PktLen      uint32
	TimestampNS uint64
	Proto       uint8
	_           [3]byte // padding
}

// EventConsumer reads packet events from the BPF ring buffer.
type EventConsumer struct {
	logger *zap.Logger
	rd     *ringbuf.Reader
}

// NewEventConsumer creates a ring buffer reader for the given map.
func NewEventConsumer(eventsMap *ebpf.Map, logger *zap.Logger) (*EventConsumer, error) {
	rd, err := ringbuf.NewReader(eventsMap)
	if err != nil {
		return nil, fmt.Errorf("creating ring buffer reader: %w", err)
	}
	return &EventConsumer{logger: logger, rd: rd}, nil
}

// Close releases the ring buffer reader.
func (c *EventConsumer) Close() error {
	return c.rd.Close()
}

// Run reads events from the ring buffer until the context is cancelled.
func (c *EventConsumer) Run(ctx context.Context, handler func(PacketEvent)) error {
	go func() {
		<-ctx.Done()
		c.rd.Close()
	}()

	for {
		record, err := c.rd.Read()
		if err != nil {
			if ringbuf.IsUnreadable(err) {
				return nil // ring buffer was closed
			}
			return fmt.Errorf("reading ring buffer: %w", err)
		}

		if len(record.RawSample) < 24 {
			c.logger.Warn("short ring buffer record", zap.Int("len", len(record.RawSample)))
			continue
		}

		var event PacketEvent
		event.SrcIP = [4]byte{record.RawSample[0], record.RawSample[1], record.RawSample[2], record.RawSample[3]}
		event.DstIP = [4]byte{record.RawSample[4], record.RawSample[5], record.RawSample[6], record.RawSample[7]}
		event.SrcPort = binary.LittleEndian.Uint16(record.RawSample[8:10])
		event.DstPort = binary.LittleEndian.Uint16(record.RawSample[10:12])
		event.PktLen = binary.LittleEndian.Uint32(record.RawSample[12:16])
		event.TimestampNS = binary.LittleEndian.Uint64(record.RawSample[16:24])
		if len(record.RawSample) > 24 {
			event.Proto = record.RawSample[24]
		}

		handler(event)
	}
}

// FormatEvent produces a human-readable representation of a packet event.
func FormatEvent(e PacketEvent) string {
	proto := "other"
	switch e.Proto {
	case 6:
		proto = "TCP"
	case 17:
		proto = "UDP"
	}
	return fmt.Sprintf("[%s] %s:%d → %s:%d len=%d",
		proto,
		net.IP(e.SrcIP[:]).String(), e.SrcPort,
		net.IP(e.DstIP[:]).String(), e.DstPort,
		e.PktLen,
	)
}
```

## Production Network Observability Tool

### Prometheus Metrics from XDP

```go
// internal/netmon/metrics.go
package netmon

import (
	"context"
	"fmt"
	"time"

	"github.com/cilium/ebpf"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"go.uber.org/zap"
)

// XDPMetricsCollector exports XDP map data as Prometheus metrics.
type XDPMetricsCollector struct {
	logger        *zap.Logger
	ipStatsMap    *ebpf.Map
	packetCounts  *ebpf.Map

	packetsTotal    *prometheus.CounterVec
	bytesTotal      *prometheus.CounterVec
	topSourceFlows  *prometheus.GaugeVec
}

// NewXDPMetricsCollector creates a Prometheus metrics collector for XDP maps.
func NewXDPMetricsCollector(
	ipStatsMap *ebpf.Map,
	packetCounts *ebpf.Map,
	logger *zap.Logger,
) *XDPMetricsCollector {
	return &XDPMetricsCollector{
		logger:       logger,
		ipStatsMap:   ipStatsMap,
		packetCounts: packetCounts,

		packetsTotal: promauto.NewCounterVec(
			prometheus.CounterOpts{
				Name: "xdp_packets_processed_total",
				Help: "Total packets processed by XDP program.",
			},
			[]string{"protocol"},
		),
		bytesTotal: promauto.NewCounterVec(
			prometheus.CounterOpts{
				Name: "xdp_bytes_processed_total",
				Help: "Total bytes processed by XDP program.",
			},
			[]string{"src_ip"},
		),
		topSourceFlows: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "xdp_top_source_packets",
				Help: "Packets per top source IP addresses.",
			},
			[]string{"src_ip"},
		),
	}
}

// Collect reads from BPF maps and updates Prometheus metrics.
func (c *XDPMetricsCollector) Collect(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.updateMetrics()
		}
	}
}

func (c *XDPMetricsCollector) updateMetrics() {
	protocols := []struct {
		key   uint32
		label string
	}{
		{0, "total"},
		{1, "tcp"},
		{2, "udp"},
		{3, "other"},
	}

	for _, p := range protocols {
		var values []uint64
		if err := c.packetCounts.Lookup(p.key, &values); err != nil {
			continue
		}
		var sum uint64
		for _, v := range values {
			sum += v
		}
		c.packetsTotal.WithLabelValues(p.label).Add(float64(sum))
	}
}
```

## Debugging eBPF Programs

```bash
# Inspect loaded BPF programs
bpftool prog list

# Show BPF program instructions (disassembly)
bpftool prog dump xlated id <PROG_ID>

# View BPF map contents
bpftool map list
bpftool map dump id <MAP_ID>

# Trace BPF program execution (be careful with overhead)
bpftool prog tracelog

# Check BPF verifier log for rejected programs
# The verifier log is printed when loading fails:
# libbpf: prog 'xdp_packet_counter': BPF program load failed: Permission denied
# libbpf: prog 'xdp_packet_counter': -- BEGIN PROG LOAD LOG --

# Kernel trace events for BPF
cat /sys/kernel/debug/tracing/trace_pipe &
echo 1 > /sys/kernel/debug/tracing/events/bpf/enable

# View current XDP programs on interfaces
ip link show eth0 | grep xdp

# Verify TC programs
tc filter show dev eth0 ingress

# Check BPF ring buffer statistics
bpftool map show name events
```

## Performance Benchmarking

```bash
# Measure XDP program overhead using pktgen
modprobe pktgen

# Configure pktgen for 10Gbps test
cat > /tmp/pktgen-setup.sh << 'EOF'
#!/bin/bash
pgset() {
    local result
    echo $1 > /proc/net/pktgen/$2
    result=$(cat /proc/net/pktgen/$2 | grep -E "ERROR|error")
    [ -n "$result" ] && echo "ERR: $result"
}

DEVICE=eth0
THREAD=0

pgset "rem_device_all" "kpktgend_${THREAD}"
pgset "add_device ${DEVICE}@${THREAD}" "kpktgend_${THREAD}"
pgset "count 10000000" "${DEVICE}@${THREAD}"
pgset "pkt_size 64" "${DEVICE}@${THREAD}"
pgset "dst_mac 02:00:00:00:00:01" "${DEVICE}@${THREAD}"
pgset "dst 10.0.0.2" "${DEVICE}@${THREAD}"
pgset "start" "pgctrl"
EOF
chmod +x /tmp/pktgen-setup.sh

# Baseline: no XDP program
/tmp/pktgen-setup.sh
grep -E "pps|errors" /proc/net/pktgen/eth0

# With XDP counter attached
ip link set eth0 xdp obj xdp_packet_counter.o sec xdp
/tmp/pktgen-setup.sh
grep -E "pps|errors" /proc/net/pktgen/eth0
```

## Security Considerations

### BPF Capabilities and Privileges

```bash
# eBPF requires CAP_BPF or CAP_SYS_ADMIN on kernel 5.8+
# For containerized tools:

# Check current capabilities
capsh --print | grep bpf

# Grant specific capabilities in Kubernetes
# Use only in trusted, monitored pods
```

```yaml
# Only assign BPF capabilities to dedicated observability pods
apiVersion: v1
kind: Pod
metadata:
  name: ebpf-monitor
  namespace: monitoring
spec:
  hostNetwork: true      # Required for network monitoring
  hostPID: true          # Required for process-to-socket mapping
  containers:
    - name: monitor
      image: registry.example.com/ebpf-monitor:1.0.0
      securityContext:
        capabilities:
          add:
            - NET_ADMIN    # Required for TC and XDP
            - SYS_ADMIN    # Required for BPF on older kernels
            - BPF          # Kernel 5.8+: preferred over SYS_ADMIN
          drop:
            - ALL
      volumeMounts:
        - name: bpffs
          mountPath: /sys/fs/bpf
        - name: debugfs
          mountPath: /sys/kernel/debug
  volumes:
    - name: bpffs
      hostPath:
        path: /sys/fs/bpf
        type: Directory
    - name: debugfs
      hostPath:
        path: /sys/kernel/debug
        type: Directory
```

### BPF Verifier Safety

The BPF verifier ensures programs cannot crash the kernel by statically analyzing all code paths for:
- Bounded loops (kernel 5.3+ with loop unrolling)
- Memory bounds checking (all pointer arithmetic validated)
- No unbounded stack growth
- Proper helper function usage

Programs that fail verification are rejected before loading. The verifier log provides detailed diagnostics.

eBPF-based network observability represents a paradigm shift from passive traffic copies to active in-kernel processing. By aggregating statistics at the packet processing layer, teams can monitor millions of flows per second on a single node while exporting only the aggregated metrics that matter—eliminating both the bandwidth overhead of mirroring and the processing overhead of userspace packet parsing.
