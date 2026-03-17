---
title: "Linux eBPF XDP Programs for High-Performance Packet Processing and DDoS Mitigation at Line Rate"
date: 2031-06-13T00:00:00-05:00
draft: false
tags: ["Linux", "eBPF", "XDP", "Networking", "DDoS", "Performance", "Security", "Packet Processing"]
categories:
- Linux
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to writing eBPF XDP programs for high-performance packet processing and DDoS mitigation, covering XDP hook points, BPF maps, user-space control planes, and production deployment patterns."
more_link: "yes"
url: "/linux-ebpf-xdp-high-performance-packet-processing-ddos-mitigation/"
---

eXpress Data Path (XDP) is the earliest possible hook point in the Linux network stack, executing before the kernel allocates an `sk_buff` structure. This means XDP programs can process and drop packets at the speed of the network interface driver — literally at line rate on modern NICs — making it the right tool for DDoS mitigation, packet filtering, and load balancing that would saturate a kernel's software network stack. This guide covers writing XDP programs with eBPF C, loading them with `libbpf`, building a user-space control plane with Go, and deploying IP blocklists and rate limiters that run in the kernel at hundreds of millions of packets per second.

<!--more-->

# Linux eBPF XDP: High-Performance Packet Processing

## XDP Architecture

XDP programs are eBPF programs attached to a network device's receive path. They execute synchronously in the NIC driver's receive interrupt handler (or NAPI poll handler) before the packet reaches the kernel's `netif_receive_skb`. Each XDP program returns one of:

- **XDP_DROP**: Discard the packet immediately. Zero allocation overhead.
- **XDP_PASS**: Pass the packet up to the normal kernel network stack.
- **XDP_TX**: Retransmit the packet back out the same interface (useful for load balancers).
- **XDP_REDIRECT**: Redirect to another interface or to a user-space socket via `AF_XDP`.
- **XDP_ABORTED**: Signal a fatal error; the packet is dropped and an error counter incremented.

XDP can run in three modes:

- **Native XDP** (`xdpdrv`): Runs in the NIC driver's receive path. Requires driver support. Maximum performance. Supported by most modern drivers (mlx5, i40e, bnxt, virtio_net, veth, etc.).
- **Generic XDP** (`xdpgeneric`): Runs at `netif_receive_skb`, after the driver. No driver support required but slower — roughly equivalent to `iptables` performance.
- **Offloaded XDP** (`xdpoffload`): Runs on the NIC hardware itself. Highest performance but very limited BPF feature support and requires specific NICs (Netronome).

For DDoS mitigation, native XDP is the target.

## Development Environment

```bash
# Install dependencies on Ubuntu 22.04+
apt-get install -y \
  clang \
  llvm \
  libbpf-dev \
  linux-headers-$(uname -r) \
  iproute2 \
  bpftool

# Verify BPF support
bpftool feature probe

# Install Go for the control plane
# (Follow official Go installation instructions)

# Install libbpf-go
go get github.com/cilium/ebpf/...
```

## XDP Program: IP Blocklist

The core XDP program: look up source IP in a hash map and drop if found.

```c
// xdp_blocklist.c
//go:build ignore

#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/ipv6.h>
#include <linux/in.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

// blocklist_v4 maps IPv4 source addresses to a reason code (u32).
// A value of 0 means the IP is not blocked.
// Non-zero values encode the block reason.
struct {
    __uint(type, BPF_MAP_TYPE_LPM_TRIE);
    __uint(max_entries, 65536);
    __type(key, struct {
        __u32 prefixlen;
        __u32 data;
    });
    __type(value, __u32);
    __uint(map_flags, BPF_F_NO_PREALLOC);
} blocklist_v4 SEC(".maps");

// blocklist_v6 maps IPv6 source addresses.
struct {
    __uint(type, BPF_MAP_TYPE_LPM_TRIE);
    __uint(max_entries, 65536);
    __type(key, struct {
        __u32 prefixlen;
        __u8  data[16];
    });
    __type(value, __u32);
    __uint(map_flags, BPF_F_NO_PREALLOC);
} blocklist_v6 SEC(".maps");

// stats counts packets by action (drop/pass) and by IP version.
struct xdp_stats {
    __u64 pass_pkts;
    __u64 pass_bytes;
    __u64 drop_pkts;
    __u64 drop_bytes;
};

struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(max_entries, 1);
    __type(key, __u32);
    __type(value, struct xdp_stats);
} stats SEC(".maps");

// IPv4 LPM key
struct lpm_v4_key {
    __u32 prefixlen;
    __u32 addr;
};

// IPv6 LPM key
struct lpm_v6_key {
    __u32 prefixlen;
    __u8  addr[16];
};

static __always_inline void count_packet(int action, __u32 pkt_len) {
    __u32 key = 0;
    struct xdp_stats *s = bpf_map_lookup_elem(&stats, &key);
    if (!s)
        return;

    if (action == XDP_DROP) {
        s->drop_pkts++;
        s->drop_bytes += pkt_len;
    } else {
        s->pass_pkts++;
        s->pass_bytes += pkt_len;
    }
}

SEC("xdp")
int xdp_blocklist_func(struct xdp_md *ctx) {
    void *data_end = (void *)(long)ctx->data_end;
    void *data     = (void *)(long)ctx->data;
    __u32 pkt_len  = data_end - data;

    // Parse Ethernet header
    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return XDP_PASS;

    __u16 eth_proto = bpf_ntohs(eth->h_proto);

    if (eth_proto == ETH_P_IP) {
        // Parse IPv4 header
        struct iphdr *iph = (void *)(eth + 1);
        if ((void *)(iph + 1) > data_end)
            return XDP_PASS;

        struct lpm_v4_key key = {
            .prefixlen = 32,
            .addr      = iph->saddr,
        };

        __u32 *reason = bpf_map_lookup_elem(&blocklist_v4, &key);
        if (reason && *reason != 0) {
            count_packet(XDP_DROP, pkt_len);
            return XDP_DROP;
        }

    } else if (eth_proto == ETH_P_IPV6) {
        // Parse IPv6 header
        struct ipv6hdr *ip6h = (void *)(eth + 1);
        if ((void *)(ip6h + 1) > data_end)
            return XDP_PASS;

        struct lpm_v6_key key = {
            .prefixlen = 128,
        };
        __builtin_memcpy(key.addr, ip6h->saddr.in6_u.u6_addr8, 16);

        __u32 *reason = bpf_map_lookup_elem(&blocklist_v6, &key);
        if (reason && *reason != 0) {
            count_packet(XDP_DROP, pkt_len);
            return XDP_DROP;
        }
    }

    count_packet(XDP_PASS, pkt_len);
    return XDP_PASS;
}

char _license[] SEC("license") = "GPL";
```

## XDP Program: Per-Source Rate Limiting

A token bucket rate limiter in XDP using BPF maps:

```c
// xdp_ratelimit.c
//go:build ignore

#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

// Token bucket state per source IP
struct token_bucket {
    __u64 tokens;        // Current tokens (in nanoseconds worth of tokens)
    __u64 last_refill_ns; // Last refill timestamp
};

// Rate limit configuration (filled by user space)
struct ratelimit_config {
    __u64 rate_ns;        // Nanoseconds per token (= 1e9 / tokens_per_second)
    __u64 burst_ns;       // Burst capacity in nanoseconds (= burst_tokens * rate_ns)
};

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 262144); // 256K tracked IPs
    __type(key, __u32);          // Source IPv4
    __type(value, struct token_bucket);
    __uint(map_flags, BPF_F_NO_PREALLOC);
} token_buckets SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, 1);
    __type(key, __u32);
    __type(value, struct ratelimit_config);
} ratelimit_cfg SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(max_entries, 1);
    __type(key, __u32);
    __type(value, struct xdp_stats);
} rl_stats SEC(".maps");

struct xdp_stats {
    __u64 pass_pkts;
    __u64 drop_pkts;
};

SEC("xdp")
int xdp_ratelimit_func(struct xdp_md *ctx) {
    void *data_end = (void *)(long)ctx->data_end;
    void *data     = (void *)(long)ctx->data;

    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return XDP_PASS;

    if (bpf_ntohs(eth->h_proto) != ETH_P_IP)
        return XDP_PASS;

    struct iphdr *iph = (void *)(eth + 1);
    if ((void *)(iph + 1) > data_end)
        return XDP_PASS;

    __u32 src = iph->saddr;

    // Get rate limit configuration
    __u32 cfg_key = 0;
    struct ratelimit_config *cfg = bpf_map_lookup_elem(&ratelimit_cfg, &cfg_key);
    if (!cfg)
        return XDP_PASS; // Config not set, pass all

    __u64 now = bpf_ktime_get_ns();

    // Look up or create token bucket for this source
    struct token_bucket new_bucket = {
        .tokens       = cfg->burst_ns,
        .last_refill_ns = now,
    };

    struct token_bucket *bucket = bpf_map_lookup_elem(&token_buckets, &src);
    if (!bucket) {
        bpf_map_update_elem(&token_buckets, &src, &new_bucket, BPF_NOEXIST);
        bucket = bpf_map_lookup_elem(&token_buckets, &src);
        if (!bucket)
            return XDP_PASS;
    }

    // Refill tokens based on elapsed time
    __u64 elapsed = now - bucket->last_refill_ns;
    // Avoid overflow: cap elapsed at burst_ns / rate_ns * rate_ns = burst_ns
    if (elapsed > cfg->burst_ns)
        elapsed = cfg->burst_ns;

    __u64 refill = (elapsed / cfg->rate_ns) * cfg->rate_ns;
    // Simplified: add elapsed as-is and cap at burst
    __u64 new_tokens = bucket->tokens + elapsed;
    if (new_tokens > cfg->burst_ns)
        new_tokens = cfg->burst_ns;

    __u32 stats_key = 0;
    struct xdp_stats *s = bpf_map_lookup_elem(&rl_stats, &stats_key);

    // Check if we have tokens for one packet
    if (new_tokens >= cfg->rate_ns) {
        bucket->tokens        = new_tokens - cfg->rate_ns;
        bucket->last_refill_ns = now;
        if (s) s->pass_pkts++;
        return XDP_PASS;
    }

    // Rate limit exceeded: update tokens (still accumulating)
    bucket->tokens        = new_tokens;
    bucket->last_refill_ns = now;
    if (s) s->drop_pkts++;
    return XDP_DROP;
}

char _license[] SEC("license") = "GPL";
```

## Generating Go Bindings with bpf2go

```bash
# Generate Go bindings from the BPF C code
# This is typically done via go generate

cat > bpf_gen.go << 'EOF'
//go:build ignore

package main
EOF

# Add to a Go file in your package:
# //go:generate go run github.com/cilium/ebpf/cmd/bpf2go -target amd64,arm64 \
#     XDPBlocklist xdp_blocklist.c -- -I/usr/include/bpf
# //go:generate go run github.com/cilium/ebpf/cmd/bpf2go -target amd64,arm64 \
#     XDPRatelimit xdp_ratelimit.c -- -I/usr/include/bpf

go generate ./...
```

## Go Control Plane: Loading and Managing XDP Programs

```go
// pkg/xdp/manager.go
package xdp

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/cilium/ebpf"
	"github.com/cilium/ebpf/link"
	"github.com/cilium/ebpf/rlimit"
)

// BlocklistManager manages an XDP-based IP blocklist.
type BlocklistManager struct {
	objs      XDPBlocklistObjects
	link      link.Link
	ifaceName string
}

// NewBlocklistManager loads the XDP program onto the given interface.
func NewBlocklistManager(ifaceName string) (*BlocklistManager, error) {
	// Remove the memlock rlimit (required for BPF map creation on older kernels)
	if err := rlimit.RemoveMemlock(); err != nil {
		return nil, fmt.Errorf("removing memlock rlimit: %w", err)
	}

	// Load the compiled BPF objects (generated by bpf2go)
	var objs XDPBlocklistObjects
	if err := LoadXDPBlocklistObjects(&objs, nil); err != nil {
		return nil, fmt.Errorf("loading BPF objects: %w", err)
	}

	// Get the network interface
	iface, err := net.InterfaceByName(ifaceName)
	if err != nil {
		objs.Close()
		return nil, fmt.Errorf("getting interface %q: %w", ifaceName, err)
	}

	// Attach the XDP program to the interface
	// Use link.XDPAttachFlags to select native/generic/offload mode
	l, err := link.AttachXDP(link.XDPOptions{
		Program:   objs.XdpBlocklistFunc,
		Interface: iface.Index,
		// Flags: link.XDPDriverMode for native XDP
		// Flags: link.XDPGenericMode for generic XDP (fallback)
	})
	if err != nil {
		objs.Close()
		return nil, fmt.Errorf("attaching XDP to %q: %w", ifaceName, err)
	}

	return &BlocklistManager{
		objs:      objs,
		link:      l,
		ifaceName: ifaceName,
	}, nil
}

// BlockIPv4 adds an IPv4 CIDR to the blocklist.
func (m *BlocklistManager) BlockIPv4(cidr string, reason uint32) error {
	prefix, err := netip.ParsePrefix(cidr)
	if err != nil {
		return fmt.Errorf("parsing CIDR %q: %w", cidr, err)
	}

	if !prefix.Addr().Is4() {
		return fmt.Errorf("%q is not an IPv4 prefix", cidr)
	}

	// LPM trie key: prefixlen (u32) + address (u32)
	key := make([]byte, 8)
	binary.BigEndian.PutUint32(key[0:4], uint32(prefix.Bits()))
	addr := prefix.Masked().Addr().As4()
	copy(key[4:], addr[:])

	if err := m.objs.BlocklistV4.Put(key, reason); err != nil {
		return fmt.Errorf("adding %q to blocklist: %w", cidr, err)
	}
	return nil
}

// UnblockIPv4 removes an IPv4 CIDR from the blocklist.
func (m *BlocklistManager) UnblockIPv4(cidr string) error {
	prefix, err := netip.ParsePrefix(cidr)
	if err != nil {
		return fmt.Errorf("parsing CIDR %q: %w", cidr, err)
	}

	key := make([]byte, 8)
	binary.BigEndian.PutUint32(key[0:4], uint32(prefix.Bits()))
	addr := prefix.Masked().Addr().As4()
	copy(key[4:], addr[:])

	if err := m.objs.BlocklistV4.Delete(key); err != nil {
		if errors.Is(err, ebpf.ErrKeyNotExist) {
			return nil // Already removed
		}
		return fmt.Errorf("removing %q from blocklist: %w", cidr, err)
	}
	return nil
}

// Stats returns current packet counters.
type Stats struct {
	PassPackets  uint64
	PassBytes    uint64
	DropPackets  uint64
	DropBytes    uint64
}

// ReadStats reads per-CPU stats and aggregates them.
func (m *BlocklistManager) ReadStats() (Stats, error) {
	var key uint32 = 0
	var perCPU []XDPBlocklistStatsT

	if err := m.objs.Stats.Lookup(key, &perCPU); err != nil {
		return Stats{}, fmt.Errorf("reading stats: %w", err)
	}

	var total Stats
	for _, s := range perCPU {
		total.PassPackets += s.PassPkts
		total.PassBytes += s.PassBytes
		total.DropPackets += s.DropPkts
		total.DropBytes += s.DropBytes
	}
	return total, nil
}

// Close detaches the XDP program and releases resources.
func (m *BlocklistManager) Close() error {
	errs := []error{
		m.link.Close(),
		m.objs.Close(),
	}
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
}

// PinToFilesystem pins the BPF maps to the filesystem for persistence and sharing.
// Pinned maps survive program restarts.
func (m *BlocklistManager) PinToFilesystem(pinDir string) error {
	if err := os.MkdirAll(pinDir, 0700); err != nil {
		return err
	}
	if err := m.objs.BlocklistV4.Pin(pinDir + "/blocklist_v4"); err != nil {
		return fmt.Errorf("pinning blocklist_v4: %w", err)
	}
	if err := m.objs.Stats.Pin(pinDir + "/stats"); err != nil {
		return fmt.Errorf("pinning stats: %w", err)
	}
	return nil
}
```

## Automatic DDoS Detection and Response

```go
// pkg/ddos/detector.go
package ddos

import (
	"context"
	"fmt"
	"log/slog"
	"net/netip"
	"sync"
	"time"

	"yourorg/xdp-tools/pkg/xdp"
)

// FlowStats tracks packet counts per source IP.
type FlowStats struct {
	PacketsPerSecond float64
	BytesPerSecond   float64
	FirstSeen        time.Time
	LastSeen         time.Time
	TotalPackets     uint64
}

// Config holds detection thresholds.
type Config struct {
	// PacketsPerSecondThreshold triggers blocking when exceeded.
	PacketsPerSecondThreshold float64
	// BytesPerSecondThreshold triggers blocking when exceeded.
	BytesPerSecondThreshold float64
	// BlockDuration is how long to block an IP.
	BlockDuration time.Duration
	// SampleInterval is how often to sample flow stats.
	SampleInterval time.Duration
}

// Detector monitors flow stats and automatically blocks attack sources.
type Detector struct {
	cfg      Config
	blocklist *xdp.BlocklistManager
	flows    map[uint32]*flowState
	mu       sync.Mutex
	logger   *slog.Logger
}

type flowState struct {
	lastCount uint64
	lastTime  time.Time
	pps       float64
	bps       float64
	blocked   bool
	blockUntil time.Time
}

// NewDetector creates a new DDoS detector.
func NewDetector(cfg Config, blocklist *xdp.BlocklistManager, logger *slog.Logger) *Detector {
	if cfg.SampleInterval == 0 {
		cfg.SampleInterval = 1 * time.Second
	}
	if cfg.BlockDuration == 0 {
		cfg.BlockDuration = 15 * time.Minute
	}
	return &Detector{
		cfg:      cfg,
		blocklist: blocklist,
		flows:    make(map[uint32]*flowState),
		logger:   logger,
	}
}

// Run starts the detection loop.
func (d *Detector) Run(ctx context.Context) error {
	ticker := time.NewTicker(d.cfg.SampleInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			d.sample()
			d.unblockExpired()
		}
	}
}

func (d *Detector) sample() {
	// In a real implementation, read per-source stats from a BPF hash map.
	// The flow_stats map would be populated by the XDP program.
	// This is a conceptual example showing the detection logic.

	d.mu.Lock()
	defer d.mu.Unlock()

	now := time.Now()
	for ip, state := range d.flows {
		if state.blocked {
			continue
		}

		if state.pps > d.cfg.PacketsPerSecondThreshold ||
			state.bps > d.cfg.BytesPerSecondThreshold {

			ipAddr := netip.AddrFrom4([4]byte{
				byte(ip >> 24), byte(ip >> 16), byte(ip >> 8), byte(ip),
			})
			cidr := fmt.Sprintf("%s/32", ipAddr)

			const blockReason = 1 // DDoS detected
			if err := d.blocklist.BlockIPv4(cidr, blockReason); err != nil {
				d.logger.Error("blocking IP", "ip", cidr, "error", err)
				continue
			}

			state.blocked = true
			state.blockUntil = now.Add(d.cfg.BlockDuration)

			d.logger.Warn("blocking attack source",
				"ip", cidr,
				"pps", state.pps,
				"bps", state.bps,
				"block_until", state.blockUntil,
			)
		}
	}
}

func (d *Detector) unblockExpired() {
	d.mu.Lock()
	defer d.mu.Unlock()

	now := time.Now()
	for ip, state := range d.flows {
		if state.blocked && now.After(state.blockUntil) {
			ipAddr := netip.AddrFrom4([4]byte{
				byte(ip >> 24), byte(ip >> 16), byte(ip >> 8), byte(ip),
			})
			cidr := fmt.Sprintf("%s/32", ipAddr)

			if err := d.blocklist.UnblockIPv4(cidr); err != nil {
				d.logger.Error("unblocking IP", "ip", cidr, "error", err)
				continue
			}

			state.blocked = false
			d.logger.Info("unblocking IP after block duration", "ip", cidr)
		}
	}
}
```

## Loading a Blocklist from File

```go
// pkg/blocklist/loader.go
package blocklist

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"yourorg/xdp-tools/pkg/xdp"
)

// LoadFromFile reads a newline-separated list of CIDR prefixes and adds them
// to the XDP blocklist. Lines beginning with '#' are ignored.
func LoadFromFile(mgr *xdp.BlocklistManager, path string) (int, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, fmt.Errorf("opening blocklist file %q: %w", path, err)
	}
	defer f.Close()

	const reasonFileBlock = 2

	var count int
	var lineNum int
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		lineNum++
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		// Normalize: add /32 if no prefix length
		if !strings.Contains(line, "/") {
			line += "/32"
		}

		if err := mgr.BlockIPv4(line, reasonFileBlock); err != nil {
			return count, fmt.Errorf("line %d: blocking %q: %w", lineNum, line, err)
		}
		count++
	}

	return count, scanner.Err()
}
```

## Monitoring XDP Performance

```bash
# Check XDP program is attached
ip link show eth0
# Look for: xdp/id:XXX in the output

# Use bpftool to inspect the loaded program
bpftool prog list

# Detailed program info
bpftool prog show id <prog_id>

# Inspect map contents
bpftool map list
bpftool map dump id <map_id>

# Real-time packet counters (using perf events or BPF trace output)
# For production monitoring, use the Go control plane to read stats maps

# Check XDP mode
ip link show dev eth0 | grep xdp
# xdpdrv = native
# xdpgeneric = generic (slower)
# xdpoffload = hardware offload
```

### Prometheus Metrics Exporter

```go
// pkg/metrics/exporter.go
package metrics

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"yourorg/xdp-tools/pkg/xdp"
)

type XDPExporter struct {
	manager     *xdp.BlocklistManager
	passPackets prometheus.Counter
	dropPackets prometheus.Counter
	passBytes   prometheus.Counter
	dropBytes   prometheus.Counter
	logger      *slog.Logger
}

func NewXDPExporter(mgr *xdp.BlocklistManager, reg prometheus.Registerer, logger *slog.Logger) *XDPExporter {
	e := &XDPExporter{
		manager: mgr,
		logger:  logger,
		passPackets: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "xdp_pass_packets_total",
			Help: "Total packets passed by XDP",
		}),
		dropPackets: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "xdp_drop_packets_total",
			Help: "Total packets dropped by XDP",
		}),
		passBytes: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "xdp_pass_bytes_total",
			Help: "Total bytes passed by XDP",
		}),
		dropBytes: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "xdp_drop_bytes_total",
			Help: "Total bytes dropped by XDP",
		}),
	}

	reg.MustRegister(e.passPackets, e.dropPackets, e.passBytes, e.dropBytes)
	return e
}

func (e *XDPExporter) Run(interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	var lastStats xdp.Stats

	for range ticker.C {
		stats, err := e.manager.ReadStats()
		if err != nil {
			e.logger.Error("reading XDP stats", "error", err)
			continue
		}

		// Add deltas to counters (Prometheus counters are cumulative)
		if stats.PassPackets > lastStats.PassPackets {
			e.passPackets.Add(float64(stats.PassPackets - lastStats.PassPackets))
		}
		if stats.DropPackets > lastStats.DropPackets {
			e.dropPackets.Add(float64(stats.DropPackets - lastStats.DropPackets))
		}
		if stats.PassBytes > lastStats.PassBytes {
			e.passBytes.Add(float64(stats.PassBytes - lastStats.PassBytes))
		}
		if stats.DropBytes > lastStats.DropBytes {
			e.dropBytes.Add(float64(stats.DropBytes - lastStats.DropBytes))
		}

		lastStats = stats
	}
}

func ServeMetrics(addr string) {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	http.ListenAndServe(addr, mux)
}
```

## Performance Characteristics

XDP's performance advantage over iptables and nftables is dramatic:

| Mechanism | Packet Drop Performance (Mpps) | Notes |
|---|---|---|
| XDP native | 20–100+ Mpps | Driver-level, before sk_buff allocation |
| XDP generic | 5–15 Mpps | After sk_buff allocation |
| nftables | 1–5 Mpps | Kernel software stack |
| iptables | 1–4 Mpps | Legacy netfilter |
| userspace (DPDK) | 10–100+ Mpps | Kernel bypass, dedicated CPU cores |

For a 100GbE interface (148.8 Mpps at minimum frame size), native XDP can saturate the link. For 10GbE (14.88 Mpps), a single modern server core running native XDP can handle full line rate packet filtering.

Key factors affecting XDP performance:
- **Map lookup type**: LPM trie is slower than hash maps. Use hash maps for known IPs; LPM trie for CIDR ranges.
- **Per-CPU maps**: Using `BPF_MAP_TYPE_PERCPU_HASH` or `BPF_MAP_TYPE_PERCPU_ARRAY` eliminates lock contention for stats.
- **Program complexity**: Every additional lookup or branch adds cycles. Profile with `bpftool prog profile`.
- **JIT compilation**: Verify the BPF JIT is enabled (`cat /proc/sys/net/core/bpf_jit_enable` should be 1 or 2).

```bash
# Enable BPF JIT (should be default on modern kernels)
sysctl -w net.core.bpf_jit_enable=1

# Enable hardened JIT (constant blinding against Spectre)
sysctl -w net.core.bpf_jit_harden=2
```

## Conclusion

XDP provides kernel-level packet processing that can saturate modern network interfaces with a few hundred lines of eBPF C code. The combination of LPM trie maps for CIDR blocklists, per-CPU stats maps for lock-free counters, and a Go control plane for dynamic updates creates a DDoS mitigation system that is both high-performance and operationally manageable. The `libbpf` / `bpf2go` toolchain makes integrating XDP programs into Go services straightforward, and the ability to pin BPF maps to the filesystem means the blocklist survives program restarts. For teams operating internet-facing services, adding XDP-based mitigation is one of the highest-leverage investments available.
