---
title: "Linux eBPF Socket Filtering: SO_ATTACH_BPF, sk_filter Programs, cgroup-sock Programs, and Traffic Accounting"
date: 2031-12-17T00:00:00-05:00
draft: false
tags: ["eBPF", "Linux", "Networking", "Socket Programming", "cgroup", "Traffic Accounting", "Kernel", "BPF"]
categories:
- Linux
- Networking
- eBPF
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive technical guide to eBPF socket filtering covering SO_ATTACH_BPF socket options, BPF_PROG_TYPE_SOCKET_FILTER programs, cgroup-sock BPF hooks, and per-cgroup traffic accounting for container environments."
more_link: "yes"
url: "/linux-ebpf-socket-filtering-so-attach-bpf-sk-filter-cgroup-traffic-accounting/"
---

eBPF socket filtering is one of the oldest and most versatile BPF application domains, predating the extended BPF instruction set by decades. The original BPF socket filter (tcpdump's engine) allowed attaching simple filter programs to sockets to drop or accept packets. Modern eBPF extends this concept dramatically with full map support, helper function access, and integration with cgroup hooks that make per-container traffic accounting and policy enforcement practical at production scale.

This guide covers the full socket filtering stack from raw `SO_ATTACH_BPF` usage through production-grade cgroup-sock programs with per-pod traffic accounting for Kubernetes environments.

<!--more-->

# Linux eBPF Socket Filtering: SO_ATTACH_BPF, sk_filter, cgroup-sock, and Traffic Accounting

## Section 1: Socket Filtering Architecture

### 1.1 Program Types for Socket Filtering

Linux eBPF provides several program types that operate on network sockets:

| Type | Hook | Use Case |
|------|------|----------|
| `BPF_PROG_TYPE_SOCKET_FILTER` | `SO_ATTACH_BPF` | Per-socket ingress filter |
| `BPF_PROG_TYPE_CGROUP_SKB` | cgroup ingress/egress | Per-cgroup packet filter |
| `BPF_PROG_TYPE_SOCK_OPS` | TCP socket events | TCP parameter tuning |
| `BPF_PROG_TYPE_SK_SKB` | sockmap | Socket redirection |
| `BPF_PROG_TYPE_CGROUP_SOCK_ADDR` | `connect()`/`bind()` | Address translation |

### 1.2 Packet Flow

```
NIC → driver → netdev rx → TC ingress → IP routing
    → iptables PREROUTING → cgroup_skb/ingress → socket
    → SO_ATTACH_BPF filter → recv buffer → application

application → sendmsg → SO_ATTACH_BPF (egress) →
    → cgroup_skb/egress → TC egress → NIC
```

### 1.3 Return Codes

For `SOCKET_FILTER` programs:
- Return value > 0: accept packet, truncate to N bytes
- Return value == 0: drop packet

For `CGROUP_SKB` programs:
- Return value == 1: allow packet
- Return value == 0: drop packet

## Section 2: SO_ATTACH_BPF Socket Filters

### 2.1 Classic BPF vs eBPF Filters

The original `SO_ATTACH_FILTER` (classic BPF) is what libpcap generates. `SO_ATTACH_BPF` attaches modern eBPF programs with full map access.

### 2.2 Writing a SOCKET_FILTER Program in C with libbpf

```c
// socket_filter.bpf.c
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/tcp.h>
#include <linux/udp.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

// Map to count packets per protocol
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 256);
    __type(key, __u8);    // IP protocol number
    __type(value, __u64); // packet count
} proto_count SEC(".maps");

// Map to track blocked source IPs
struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, 10000);
    __type(key, __u32);   // source IPv4 address
    __type(value, __u8);  // 1 = blocked
} blocked_ips SEC(".maps");

SEC("socket")
int socket_filter_prog(struct __sk_buff *skb)
{
    // Load Ethernet header
    struct ethhdr eth;
    if (bpf_skb_load_bytes(skb, 0, &eth, sizeof(eth)) < 0)
        return skb->len; // accept on parse error

    // Only process IPv4
    if (bpf_ntohs(eth.h_proto) != ETH_P_IP)
        return skb->len;

    // Load IP header
    struct iphdr ip;
    if (bpf_skb_load_bytes(skb, sizeof(eth), &ip, sizeof(ip)) < 0)
        return skb->len;

    // Check blocked IPs
    __u32 src_ip = ip.saddr;
    __u8 *blocked = bpf_map_lookup_elem(&blocked_ips, &src_ip);
    if (blocked && *blocked == 1)
        return 0; // drop

    // Count by protocol
    __u8 proto = ip.protocol;
    __u64 *count = bpf_map_lookup_elem(&proto_count, &proto);
    if (count) {
        __sync_fetch_and_add(count, 1);
    } else {
        __u64 one = 1;
        bpf_map_update_elem(&proto_count, &proto, &one, BPF_ANY);
    }

    return skb->len; // accept full packet
}

char LICENSE[] SEC("license") = "GPL";
```

### 2.3 Compiling and Loading with libbpf

```c
// socket_filter_loader.c
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <sys/socket.h>
#include <arpa/inet.h>
#include <linux/if_packet.h>
#include <net/ethernet.h>
#include <bpf/libbpf.h>
#include "socket_filter.skel.h"

int main(int argc, char **argv)
{
    struct socket_filter_bpf *skel;
    int raw_sock, prog_fd;
    int err;

    // Load and verify BPF program
    skel = socket_filter_bpf__open_and_load();
    if (!skel) {
        fprintf(stderr, "Failed to open and load BPF skeleton\n");
        return 1;
    }

    prog_fd = bpf_program__fd(skel->progs.socket_filter_prog);

    // Create a raw socket to capture all packets on eth0
    raw_sock = socket(AF_PACKET, SOCK_RAW, htons(ETH_P_ALL));
    if (raw_sock < 0) {
        fprintf(stderr, "socket() failed: %s\n", strerror(errno));
        err = 1;
        goto cleanup;
    }

    // Attach eBPF program to the socket
    err = setsockopt(raw_sock, SOL_SOCKET, SO_ATTACH_BPF,
                     &prog_fd, sizeof(prog_fd));
    if (err) {
        fprintf(stderr, "SO_ATTACH_BPF failed: %s\n", strerror(errno));
        err = 1;
        goto cleanup_sock;
    }

    printf("eBPF socket filter attached. Monitoring packets...\n");
    printf("Press Ctrl+C to show statistics\n");

    // Wait for signal
    pause();

    // Read statistics
    int map_fd = bpf_map__fd(skel->maps.proto_count);
    __u8 key = 0;
    __u64 value;
    printf("\nPacket statistics by IP protocol:\n");
    while (bpf_map_get_next_key(map_fd, key ? &key : NULL, &key) == 0) {
        bpf_map_lookup_elem(map_fd, &key, &value);
        printf("  Protocol %3d: %llu packets\n", key, value);
    }

cleanup_sock:
    close(raw_sock);
cleanup:
    socket_filter_bpf__destroy(skel);
    return err;
}
```

### 2.4 Makefile

```makefile
CLANG ?= clang
LLC   ?= llc
ARCH  := $(shell uname -m | sed 's/x86_64/x86/')

CFLAGS := -g -O2 -target bpf -D__TARGET_ARCH_$(ARCH)
INCLUDES := -I/usr/include/$(shell uname -m)-linux-gnu \
            -I/usr/local/include \
            -I./vmlinux

all: socket_filter.bpf.o socket_filter.skel.h socket_filter_loader

socket_filter.bpf.o: socket_filter.bpf.c
	$(CLANG) $(CFLAGS) $(INCLUDES) -c $< -o $@

socket_filter.skel.h: socket_filter.bpf.o
	bpftool gen skeleton $< > $@

socket_filter_loader: socket_filter_loader.c socket_filter.skel.h
	gcc -g -O2 -o $@ $< -lbpf -lelf -lz

clean:
	rm -f *.o *.skel.h socket_filter_loader
```

## Section 3: cgroup-sock BPF Programs

### 3.1 cgroup BPF Hook Points

cgroup BPF allows attaching programs to control groups for traffic filtering and accounting. The hooks are:

```
BPF_CGROUP_INET_INGRESS  - ingress packets (type: CGROUP_SKB)
BPF_CGROUP_INET_EGRESS   - egress packets  (type: CGROUP_SKB)
BPF_CGROUP_INET_SOCK_CREATE - socket creation (type: CGROUP_SOCK)
BPF_CGROUP_SOCK_OPS      - TCP socket operations (type: SOCK_OPS)
BPF_CGROUP_INET4_CONNECT - IPv4 connect() (type: CGROUP_SOCK_ADDR)
BPF_CGROUP_INET6_CONNECT - IPv6 connect() (type: CGROUP_SOCK_ADDR)
```

### 3.2 Per-Container Traffic Accounting Program

This program tracks bytes and packets per container (identified by cgroup ID):

```c
// cgroup_traffic_account.bpf.c
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/ipv6.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

// Per-cgroup traffic statistics
struct traffic_stats {
    __u64 rx_bytes;
    __u64 rx_packets;
    __u64 tx_bytes;
    __u64 tx_packets;
};

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 4096);
    __type(key, __u64);              // cgroup id
    __type(value, struct traffic_stats);
} cgroup_stats SEC(".maps");

// Per-IP-pair traffic for flow accounting
struct flow_key {
    __u32 src_ip;
    __u32 dst_ip;
    __u16 src_port;
    __u16 dst_port;
    __u8  protocol;
    __u8  pad[3];
};

struct flow_stats {
    __u64 bytes;
    __u64 packets;
    __u64 cgroup_id;
};

struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, 65536);
    __type(key, struct flow_key);
    __type(value, struct flow_stats);
} flow_table SEC(".maps");

static __always_inline __u64 get_cgroup_id(void)
{
    struct bpf_func_id id;
    // Get the cgroup id of the socket's owning cgroup
    return bpf_get_current_cgroup_id();
}

static __always_inline int parse_ip_header(struct __sk_buff *skb,
                                            __u32 *src, __u32 *dst,
                                            __u16 *sport, __u16 *dport,
                                            __u8 *proto)
{
    struct ethhdr eth;
    struct iphdr ip;

    if (bpf_skb_load_bytes(skb, 0, &eth, sizeof(eth)) < 0)
        return -1;

    if (bpf_ntohs(eth.h_proto) != ETH_P_IP)
        return -1;

    if (bpf_skb_load_bytes(skb, sizeof(eth), &ip, sizeof(ip)) < 0)
        return -1;

    *src = bpf_ntohl(ip.saddr);
    *dst = bpf_ntohl(ip.daddr);
    *proto = ip.protocol;

    __u32 ip_hdr_len = ip.ihl * 4;
    __u32 l4_offset = sizeof(eth) + ip_hdr_len;

    if (ip.protocol == IPPROTO_TCP) {
        struct tcphdr tcp;
        if (bpf_skb_load_bytes(skb, l4_offset, &tcp, sizeof(tcp)) < 0)
            return -1;
        *sport = bpf_ntohs(tcp.source);
        *dport = bpf_ntohs(tcp.dest);
    } else if (ip.protocol == IPPROTO_UDP) {
        struct udphdr udp;
        if (bpf_skb_load_bytes(skb, l4_offset, &udp, sizeof(udp)) < 0)
            return -1;
        *sport = bpf_ntohs(udp.source);
        *dport = bpf_ntohs(udp.dest);
    }

    return 0;
}

SEC("cgroup_skb/ingress")
int cgroup_ingress(struct __sk_buff *skb)
{
    __u64 cgroup_id = get_cgroup_id();
    __u64 bytes = skb->len;

    // Update per-cgroup stats
    struct traffic_stats *stats = bpf_map_lookup_elem(&cgroup_stats, &cgroup_id);
    if (stats) {
        __sync_fetch_and_add(&stats->rx_bytes, bytes);
        __sync_fetch_and_add(&stats->rx_packets, 1);
    } else {
        struct traffic_stats new_stats = {
            .rx_bytes = bytes,
            .rx_packets = 1,
        };
        bpf_map_update_elem(&cgroup_stats, &cgroup_id, &new_stats, BPF_ANY);
    }

    // Track per-flow
    __u32 src = 0, dst = 0;
    __u16 sport = 0, dport = 0;
    __u8 proto = 0;

    if (parse_ip_header(skb, &src, &dst, &sport, &dport, &proto) == 0) {
        struct flow_key fk = {
            .src_ip = src, .dst_ip = dst,
            .src_port = sport, .dst_port = dport,
            .protocol = proto,
        };
        struct flow_stats *fstats = bpf_map_lookup_elem(&flow_table, &fk);
        if (fstats) {
            __sync_fetch_and_add(&fstats->bytes, bytes);
            __sync_fetch_and_add(&fstats->packets, 1);
        } else {
            struct flow_stats nfs = {
                .bytes = bytes, .packets = 1, .cgroup_id = cgroup_id,
            };
            bpf_map_update_elem(&flow_table, &fk, &nfs, BPF_ANY);
        }
    }

    return 1; // allow
}

SEC("cgroup_skb/egress")
int cgroup_egress(struct __sk_buff *skb)
{
    __u64 cgroup_id = get_cgroup_id();
    __u64 bytes = skb->len;

    struct traffic_stats *stats = bpf_map_lookup_elem(&cgroup_stats, &cgroup_id);
    if (stats) {
        __sync_fetch_and_add(&stats->tx_bytes, bytes);
        __sync_fetch_and_add(&stats->tx_packets, 1);
    } else {
        struct traffic_stats new_stats = {
            .tx_bytes = bytes,
            .tx_packets = 1,
        };
        bpf_map_update_elem(&cgroup_stats, &cgroup_id, &new_stats, BPF_ANY);
    }

    return 1; // allow
}

char LICENSE[] SEC("license") = "GPL";
```

### 3.3 Attaching cgroup BPF Programs

```c
// cgroup_attach.c
#include <stdio.h>
#include <stdlib.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <string.h>
#include <linux/bpf.h>
#include <bpf/libbpf.h>
#include "cgroup_traffic_account.skel.h"

int main(int argc, char **argv)
{
    if (argc < 2) {
        fprintf(stderr, "Usage: %s <cgroup_path>\n", argv[0]);
        fprintf(stderr, "  Example: %s /sys/fs/cgroup/system.slice\n", argv[0]);
        return 1;
    }

    const char *cgroup_path = argv[1];

    struct cgroup_traffic_account_bpf *skel;
    int cgroup_fd, err;

    // Load BPF programs
    skel = cgroup_traffic_account_bpf__open_and_load();
    if (!skel) {
        fprintf(stderr, "Failed to load BPF programs\n");
        return 1;
    }

    // Open cgroup directory
    cgroup_fd = open(cgroup_path, O_RDONLY);
    if (cgroup_fd < 0) {
        fprintf(stderr, "Failed to open cgroup %s: %s\n",
                cgroup_path, strerror(errno));
        err = 1;
        goto cleanup;
    }

    // Attach ingress program
    err = bpf_prog_attach(
        bpf_program__fd(skel->progs.cgroup_ingress),
        cgroup_fd,
        BPF_CGROUP_INET_INGRESS,
        BPF_F_ALLOW_MULTI  // allow stacking with other programs
    );
    if (err) {
        fprintf(stderr, "Failed to attach ingress program: %s\n", strerror(errno));
        goto cleanup_fd;
    }

    // Attach egress program
    err = bpf_prog_attach(
        bpf_program__fd(skel->progs.cgroup_egress),
        cgroup_fd,
        BPF_CGROUP_INET_EGRESS,
        BPF_F_ALLOW_MULTI
    );
    if (err) {
        fprintf(stderr, "Failed to attach egress program: %s\n", strerror(errno));
        goto cleanup_fd;
    }

    printf("Traffic accounting active for cgroup: %s\n", cgroup_path);
    printf("Press Ctrl+C to print statistics\n");

    pause();

    // Print statistics
    int map_fd = bpf_map__fd(skel->maps.cgroup_stats);
    __u64 key = 0, next_key;
    struct traffic_stats stats;

    printf("\n%-20s %12s %12s %12s %12s\n",
           "Cgroup ID", "RX Bytes", "RX Pkts", "TX Bytes", "TX Pkts");
    printf("%-20s %12s %12s %12s %12s\n",
           "--------------------",
           "------------", "------------", "------------", "------------");

    int rc;
    while ((rc = bpf_map_get_next_key(map_fd, key ? &key : NULL, &next_key)) == 0) {
        key = next_key;
        if (bpf_map_lookup_elem(map_fd, &key, &stats) == 0) {
            printf("%-20llu %12llu %12llu %12llu %12llu\n",
                   key,
                   stats.rx_bytes, stats.rx_packets,
                   stats.tx_bytes, stats.tx_packets);
        }
    }

cleanup_fd:
    close(cgroup_fd);
cleanup:
    cgroup_traffic_account_bpf__destroy(skel);
    return err;
}
```

## Section 4: Traffic Policing with cgroup-sock

### 4.1 Rate Limiting Program

```c
// cgroup_ratelimit.bpf.c
#include <linux/bpf.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

// Token bucket state per cgroup
struct token_bucket {
    __u64 tokens;         // current tokens (bytes)
    __u64 last_refill_ns; // last refill timestamp
    __u64 rate_bps;       // rate limit in bytes per second
    __u64 burst_bytes;    // maximum burst size
};

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 4096);
    __type(key, __u64);                 // cgroup id
    __type(value, struct token_bucket);
} rate_limits SEC(".maps");

// Configuration map: cgroup_id -> rate limit settings
struct rate_config {
    __u64 rate_bps;
    __u64 burst_bytes;
};

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 4096);
    __type(key, __u64);
    __type(value, struct rate_config);
} rate_configs SEC(".maps");

static __always_inline int token_bucket_consume(
    struct token_bucket *tb,
    __u64 bytes,
    __u64 now_ns)
{
    // Refill tokens based on elapsed time
    __u64 elapsed_ns = now_ns - tb->last_refill_ns;
    __u64 new_tokens = (elapsed_ns * tb->rate_bps) / 1000000000ULL;

    tb->tokens += new_tokens;
    if (tb->tokens > tb->burst_bytes)
        tb->tokens = tb->burst_bytes;
    tb->last_refill_ns = now_ns;

    // Try to consume tokens
    if (tb->tokens >= bytes) {
        tb->tokens -= bytes;
        return 1; // allow
    }

    return 0; // drop
}

SEC("cgroup_skb/egress")
int cgroup_rate_limit_egress(struct __sk_buff *skb)
{
    __u64 cgroup_id = bpf_get_current_cgroup_id();

    // Check if this cgroup has a rate limit configured
    struct rate_config *config = bpf_map_lookup_elem(&rate_configs, &cgroup_id);
    if (!config)
        return 1; // no limit, allow

    __u64 now_ns = bpf_ktime_get_ns();
    __u64 pkt_bytes = skb->len;

    // Get or initialize token bucket
    struct token_bucket *tb = bpf_map_lookup_elem(&rate_limits, &cgroup_id);
    if (!tb) {
        struct token_bucket new_tb = {
            .tokens = config->burst_bytes,
            .last_refill_ns = now_ns,
            .rate_bps = config->rate_bps,
            .burst_bytes = config->burst_bytes,
        };
        bpf_map_update_elem(&rate_limits, &cgroup_id, &new_tb, BPF_ANY);
        return 1; // first packet: always allow
    }

    return token_bucket_consume(tb, pkt_bytes, now_ns);
}

char LICENSE[] SEC("license") = "GPL";
```

### 4.2 Configuring Rate Limits from Userspace

```go
// ratelimit_manager.go
package main

import (
    "fmt"
    "log"
    "os"
    "strconv"
    "unsafe"

    "github.com/cilium/ebpf"
)

type RateConfig struct {
    RateBPS   uint64
    BurstBytes uint64
}

type TrafficAccountingManager struct {
    rateConfigMap *ebpf.Map
    rateLimitMap  *ebpf.Map
}

func NewTrafficAccountingManager(pinPath string) (*TrafficAccountingManager, error) {
    rateConfigMap, err := ebpf.LoadPinnedMap(pinPath+"/rate_configs", nil)
    if err != nil {
        return nil, fmt.Errorf("loading rate_configs map: %w", err)
    }

    rateLimitMap, err := ebpf.LoadPinnedMap(pinPath+"/rate_limits", nil)
    if err != nil {
        return nil, fmt.Errorf("loading rate_limits map: %w", err)
    }

    return &TrafficAccountingManager{
        rateConfigMap: rateConfigMap,
        rateLimitMap:  rateLimitMap,
    }, nil
}

// SetCgroupRateLimit configures rate limiting for a specific cgroup.
// cgroupID can be obtained from /proc/self/cgroup or bpf_get_current_cgroup_id.
func (m *TrafficAccountingManager) SetCgroupRateLimit(cgroupID uint64, rateMbps float64, burstMB float64) error {
    config := RateConfig{
        RateBPS:    uint64(rateMbps * 1e6 / 8), // Convert Mbps to bytes/sec
        BurstBytes: uint64(burstMB * 1024 * 1024),
    }

    if err := m.rateConfigMap.Put(cgroupID, config); err != nil {
        return fmt.Errorf("setting rate config for cgroup %d: %w", cgroupID, err)
    }

    log.Printf("Set rate limit for cgroup %d: %.1f Mbps, %.1f MB burst",
        cgroupID, rateMbps, burstMB)
    return nil
}

// GetCgroupID returns the cgroup ID for the cgroup at the given path.
func GetCgroupID(cgroupPath string) (uint64, error) {
    f, err := os.Open(cgroupPath)
    if err != nil {
        return 0, fmt.Errorf("opening cgroup path: %w", err)
    }
    defer f.Close()

    var stat syscall.Stat_t
    if err := syscall.Fstat(int(f.Fd()), &stat); err != nil {
        return 0, fmt.Errorf("fstat: %w", err)
    }

    return stat.Ino, nil
}

func main() {
    mgr, err := NewTrafficAccountingManager("/sys/fs/bpf/traffic_accounting")
    if err != nil {
        log.Fatalf("Failed to create manager: %v", err)
    }

    // Set 100 Mbps limit with 10 MB burst for a specific pod's cgroup
    cgroupPath := "/sys/fs/cgroup/kubepods/burstable/pod<pod-uid>/<container-id>"
    cgroupID, err := GetCgroupID(cgroupPath)
    if err != nil {
        log.Fatalf("Failed to get cgroup ID: %v", err)
    }

    if err := mgr.SetCgroupRateLimit(cgroupID, 100.0, 10.0); err != nil {
        log.Fatalf("Failed to set rate limit: %v", err)
    }
}
```

## Section 5: SK_MSG and Socket Redirection

### 5.1 sockmap-based Socket Redirection

```c
// sockmap_redirect.bpf.c
#include <linux/bpf.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

// Map of sockets indexed by port
struct {
    __uint(type, BPF_MAP_TYPE_SOCKHASH);
    __uint(max_entries, 65535);
    __type(key, __u32);     // destination port
    __type(value, __u64);   // socket cookie
} sock_hash SEC(".maps");

SEC("sk_msg")
int sock_msg_prog(struct sk_msg_md *msg)
{
    // Get destination port from message
    __u32 dst_port = bpf_ntohl(msg->remote_port);

    // Redirect to socket registered for this port
    return bpf_msg_redirect_hash(msg, &sock_hash, &dst_port, BPF_F_INGRESS);
}

// Program to register sockets into the hash
SEC("sk_skb/stream_parser")
int stream_parser(struct __sk_buff *skb)
{
    // Return the full packet length for complete message delivery
    return skb->len;
}

SEC("sk_skb/stream_verdict")
int stream_verdict(struct __sk_buff *skb)
{
    __u32 dst_port = bpf_ntohl(skb->remote_port);
    return bpf_sk_redirect_hash(skb, &sock_hash, &dst_port, BPF_F_INGRESS);
}

char LICENSE[] SEC("license") = "GPL";
```

## Section 6: Kubernetes Integration

### 6.1 DaemonSet for Traffic Accounting

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: ebpf-traffic-accounting
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: ebpf-traffic-accounting
  template:
    metadata:
      labels:
        app: ebpf-traffic-accounting
    spec:
      hostNetwork: true
      hostPID: true
      priorityClassName: system-node-critical
      tolerations:
        - operator: Exists
          effect: NoSchedule
        - operator: Exists
          effect: NoExecute
      initContainers:
        - name: install-ebpf
          image: registry.example.com/ebpf-traffic-accounting:latest
          command: ["/install.sh"]
          securityContext:
            privileged: true
          volumeMounts:
            - name: bpf-fs
              mountPath: /sys/fs/bpf
            - name: cgroup
              mountPath: /sys/fs/cgroup
      containers:
        - name: metrics-exporter
          image: registry.example.com/ebpf-traffic-accounting:latest
          command: ["/metrics-exporter"]
          args:
            - "--bpf-pin-path=/sys/fs/bpf/traffic_accounting"
            - "--metrics-addr=:9091"
            - "--node-name=$(NODE_NAME)"
          env:
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
          ports:
            - name: metrics
              containerPort: 9091
          securityContext:
            privileged: true
            capabilities:
              add: ["BPF", "NET_ADMIN", "SYS_ADMIN"]
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 128Mi
          volumeMounts:
            - name: bpf-fs
              mountPath: /sys/fs/bpf
            - name: cgroup
              mountPath: /sys/fs/cgroup
              readOnly: true
      volumes:
        - name: bpf-fs
          hostPath:
            path: /sys/fs/bpf
            type: DirectoryOrCreate
        - name: cgroup
          hostPath:
            path: /sys/fs/cgroup
            type: Directory
```

### 6.2 Prometheus Metrics Exporter

```go
// metrics_exporter.go
package main

import (
    "flag"
    "fmt"
    "log"
    "net/http"
    "time"

    "github.com/cilium/ebpf"
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promhttp"
)

type TrafficCollector struct {
    cgroupStatsMap *ebpf.Map
    nodeName       string

    rxBytesDesc   *prometheus.Desc
    txBytesDesc   *prometheus.Desc
    rxPacketsDesc *prometheus.Desc
    txPacketsDesc *prometheus.Desc
}

type TrafficStats struct {
    RxBytes   uint64
    RxPackets uint64
    TxBytes   uint64
    TxPackets uint64
}

func NewTrafficCollector(mapPath, nodeName string) (*TrafficCollector, error) {
    cgroupMap, err := ebpf.LoadPinnedMap(mapPath+"/cgroup_stats", nil)
    if err != nil {
        return nil, fmt.Errorf("loading cgroup_stats map: %w", err)
    }

    labels := []string{"node", "cgroup_id"}

    return &TrafficCollector{
        cgroupStatsMap: cgroupMap,
        nodeName:       nodeName,
        rxBytesDesc: prometheus.NewDesc(
            "ebpf_cgroup_rx_bytes_total",
            "Total bytes received by cgroup",
            labels, nil,
        ),
        txBytesDesc: prometheus.NewDesc(
            "ebpf_cgroup_tx_bytes_total",
            "Total bytes transmitted by cgroup",
            labels, nil,
        ),
        rxPacketsDesc: prometheus.NewDesc(
            "ebpf_cgroup_rx_packets_total",
            "Total packets received by cgroup",
            labels, nil,
        ),
        txPacketsDesc: prometheus.NewDesc(
            "ebpf_cgroup_tx_packets_total",
            "Total packets transmitted by cgroup",
            labels, nil,
        ),
    }, nil
}

func (c *TrafficCollector) Describe(ch chan<- *prometheus.Desc) {
    ch <- c.rxBytesDesc
    ch <- c.txBytesDesc
    ch <- c.rxPacketsDesc
    ch <- c.txPacketsDesc
}

func (c *TrafficCollector) Collect(ch chan<- prometheus.Metric) {
    var key uint64
    var stats TrafficStats

    iter := c.cgroupStatsMap.Iterate()
    for iter.Next(&key, &stats) {
        cgroupID := fmt.Sprintf("%d", key)
        labels := []string{c.nodeName, cgroupID}

        ch <- prometheus.MustNewConstMetric(
            c.rxBytesDesc, prometheus.CounterValue,
            float64(stats.RxBytes), labels...,
        )
        ch <- prometheus.MustNewConstMetric(
            c.txBytesDesc, prometheus.CounterValue,
            float64(stats.TxBytes), labels...,
        )
        ch <- prometheus.MustNewConstMetric(
            c.rxPacketsDesc, prometheus.CounterValue,
            float64(stats.RxPackets), labels...,
        )
        ch <- prometheus.MustNewConstMetric(
            c.txPacketsDesc, prometheus.CounterValue,
            float64(stats.TxPackets), labels...,
        )
    }

    if err := iter.Err(); err != nil {
        log.Printf("Error iterating cgroup_stats map: %v", err)
    }
}

func main() {
    bpfPinPath := flag.String("bpf-pin-path", "/sys/fs/bpf/traffic_accounting", "BPF pin path")
    metricsAddr := flag.String("metrics-addr", ":9091", "Metrics listen address")
    nodeName := flag.String("node-name", "unknown", "Kubernetes node name")
    flag.Parse()

    collector, err := NewTrafficCollector(*bpfPinPath, *nodeName)
    if err != nil {
        log.Fatalf("Failed to create collector: %v", err)
    }

    prometheus.MustRegister(collector)

    http.Handle("/metrics", promhttp.Handler())
    http.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    })

    log.Printf("Starting metrics server on %s", *metricsAddr)
    if err := http.ListenAndServe(*metricsAddr, nil); err != nil {
        log.Fatalf("Server failed: %v", err)
    }
}
```

## Section 7: Debugging and Troubleshooting

### 7.1 Inspecting Loaded Programs

```bash
# List all loaded BPF programs
bpftool prog list

# Show detailed program info
bpftool prog show id <program-id>

# Dump program bytecode (verifier output)
bpftool prog dump xlated id <program-id>

# Check JIT-compiled output
bpftool prog dump jited id <program-id>

# List all BPF maps
bpftool map list

# Dump map contents
bpftool map dump id <map-id>

# Check programs attached to a cgroup
bpftool cgroup tree /sys/fs/cgroup/kubepods

# Check programs attached to a specific socket (via /proc)
cat /proc/<pid>/fdinfo/<socket-fd>
```

### 7.2 Verifier Errors

Common verifier failures and fixes:

```bash
# "invalid indirect read from stack" - uninitialized stack variable
# Fix: zero-initialize all stack variables
struct flow_key fk = {};  // not: struct flow_key fk;

# "unbounded memory access" - variable-length memory access
# Fix: add explicit bounds check before bpf_skb_load_bytes

# "map_value pointer goes out of range"
# Fix: always check pointer is non-NULL after bpf_map_lookup_elem

# "back-edge from insn X to Y" - unbounded loop
# Fix: use bounded loops with #pragma unroll or explicit iteration limit
```

### 7.3 Performance Monitoring

```bash
# Enable BPF stats
sysctl -w kernel.bpf_stats_enabled=1

# Check run time and count
bpftool prog show id <id>
# run_time_ns: 12345678
# run_cnt:     100000

# Average run time
echo "scale=2; 12345678 / 100000" | bc  # microseconds per invocation

# Use perf to profile BPF programs
perf stat -e bpf:* -p <pid>

# Check map statistics
bpftool map show id <map-id>
```

## Section 8: Security Considerations

### 8.1 Required Capabilities

```bash
# BPF programs require CAP_BPF (Linux 5.8+) or CAP_SYS_ADMIN
# For socket filters only:
CAP_NET_ADMIN  # to attach to sockets
CAP_BPF        # to load BPF programs

# Verify container security context
kubectl get pod <pod-name> -o jsonpath='{.spec.containers[0].securityContext}'
```

### 8.2 Restricting BPF via Seccomp

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "syscalls": [
    {
      "names": ["bpf"],
      "action": "SCMP_ACT_ERRNO",
      "args": [
        {
          "index": 0,
          "value": 5,
          "op": "SCMP_CMP_EQ"
        }
      ]
    }
  ]
}
```

## Summary

eBPF socket filtering provides fine-grained, high-performance network visibility and control without kernel module development. The key patterns covered:

- `SO_ATTACH_BPF` for per-socket packet filtering with full map access
- `CGROUP_SKB` programs for per-container ingress and egress accounting
- Token bucket rate limiting implemented entirely in eBPF
- `SK_MSG` and sockmap for transparent socket redirection
- Kubernetes DaemonSet deployment with Prometheus metrics export
- bpftool-based debugging and performance profiling

The cgroup-based approach is particularly well-suited to Kubernetes environments because each pod's containers share a cgroup subtree, enabling accurate per-pod traffic metering without the overhead of iptables or network namespace traversal.
