---
title: "Linux eBPF Networking: TC Hooks and Socket Programs"
date: 2029-08-21T00:00:00-05:00
draft: false
tags: ["Linux", "eBPF", "Networking", "TC", "BPF", "Kubernetes", "Cilium", "Performance"]
categories: ["Linux", "Networking", "eBPF"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux eBPF networking at the TC layer: BPF_PROG_TYPE_SCHED_CLS programs, tc ingress/egress hooks, socket filter programs, sk_msg redirect, and sockmap-based connection acceleration for high-performance networking."
more_link: "yes"
url: "/linux-ebpf-networking-tc-hooks-socket-programs/"
---

The Linux Traffic Control (TC) subsystem combined with eBPF provides programmable packet processing at a position in the network stack that makes it ideal for container networking, load balancing, and observability. Unlike XDP which operates at the NIC driver level, TC hooks run after the kernel has parsed the packet headers, giving access to full socket and routing context. Socket programs extend this further by operating at the socket level, enabling zero-copy data redirection between sockets. This post covers TC eBPF programs, socket filters, and the sockmap acceleration pattern used by Cilium and Katran.

<!--more-->

# Linux eBPF Networking: TC Hooks and Socket Programs

## TC Architecture and BPF Hook Points

The Linux network stack provides multiple points where eBPF programs can intercept packets:

```
                    ┌──────────────────────────────────────────┐
                    │  Application (userspace)                  │
                    └──────────────┬───────────────────────────┘
                                   │
                    ┌──────────────▼───────────────────────────┐
                    │  Socket Layer                             │
                    │  BPF_PROG_TYPE_SOCKET_FILTER              │ ← Socket filter
                    │  BPF_PROG_TYPE_SK_MSG                     │ ← sk_msg (send)
                    │  BPF_PROG_TYPE_SK_SKB                     │ ← sockmap (recv)
                    └──────────────┬───────────────────────────┘
                                   │
                    ┌──────────────▼───────────────────────────┐
                    │  netfilter/iptables                       │
                    └──────────────┬───────────────────────────┘
                                   │
                    ┌──────────────▼───────────────────────────┐
                    │  Traffic Control (TC)                     │
                    │  TC egress: BPF_PROG_TYPE_SCHED_CLS       │ ← TC egress
                    │  TC ingress: BPF_PROG_TYPE_SCHED_CLS      │ ← TC ingress
                    └──────────────┬───────────────────────────┘
                                   │
                    ┌──────────────▼───────────────────────────┐
                    │  Network Device Driver                    │
                    │  XDP: BPF_PROG_TYPE_XDP                  │ ← XDP (earliest)
                    └──────────────┬───────────────────────────┘
                                   │
                                  Wire
```

### Why TC Rather Than XDP?

- **XDP**: Runs at the NIC driver, before the kernel allocates an `sk_buff`. Maximum performance (line rate possible) but no access to socket context, routing tables, or netfilter state.
- **TC**: Runs after `sk_buff` allocation, with full access to the parsed packet, socket information, routing decisions, and the ability to redirect between interfaces and sockets.

TC eBPF is used by Cilium for:
- Container traffic policy enforcement
- Service load balancing (replacing kube-proxy)
- Transparent encryption (WireGuard/IPsec key injection)
- Bandwidth management

## Writing TC eBPF Programs in C

### Minimal TC Program Structure

```c
// tc_drop.bpf.c — Drop packets matching a destination port
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/tcp.h>
#include <linux/pkt_cls.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

// Return codes for TC programs:
// TC_ACT_OK (0)       — continue processing
// TC_ACT_SHOT (2)     — drop the packet
// TC_ACT_REDIRECT (7) — redirect to another interface
// TC_ACT_PIPE (3)     — pass to next classifier

SEC("tc/ingress")
int tc_ingress_drop(struct __sk_buff *skb) {
    void *data_end = (void *)(long)skb->data_end;
    void *data     = (void *)(long)skb->data;

    // Parse Ethernet header
    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return TC_ACT_OK;

    // Only process IPv4
    if (eth->h_proto != bpf_htons(ETH_P_IP))
        return TC_ACT_OK;

    // Parse IP header
    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return TC_ACT_OK;

    // Only process TCP
    if (ip->protocol != IPPROTO_TCP)
        return TC_ACT_OK;

    // Parse TCP header
    struct tcphdr *tcp = (void *)ip + (ip->ihl * 4);
    if ((void *)(tcp + 1) > data_end)
        return TC_ACT_OK;

    // Drop packets to port 31337
    if (tcp->dest == bpf_htons(31337)) {
        bpf_printk("Dropping packet to port 31337 from %pI4\n", &ip->saddr);
        return TC_ACT_SHOT;
    }

    return TC_ACT_OK;
}

char LICENSE[] SEC("license") = "GPL";
```

### TC Program with BPF Maps

```c
// tc_ratelimit.bpf.c — Rate limiting using token bucket via BPF maps
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/pkt_cls.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

// Token bucket state per source IP
struct token_bucket {
    __u64 tokens;       // Current token count
    __u64 last_update;  // Last update time in nanoseconds
    __u64 rate;         // Tokens per nanosecond
    __u64 burst;        // Maximum token accumulation
};

// BPF hash map: source IP -> token bucket state
struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __type(key, __u32);           // Source IP address
    __type(value, struct token_bucket);
    __uint(max_entries, 65536);
} rate_limit_map SEC(".maps");

// Configuration map: key 0 = global config
struct rate_config {
    __u64 rate_bps;    // Rate in bits per second
    __u64 burst_bytes; // Burst size in bytes
};

struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __type(key, __u32);
    __type(value, struct rate_config);
    __uint(max_entries, 1);
} config_map SEC(".maps");

SEC("tc/ingress")
int tc_ratelimit(struct __sk_buff *skb) {
    void *data_end = (void *)(long)skb->data_end;
    void *data     = (void *)(long)skb->data;

    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return TC_ACT_OK;

    if (eth->h_proto != bpf_htons(ETH_P_IP))
        return TC_ACT_OK;

    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return TC_ACT_OK;

    __u32 src_ip = ip->saddr;
    __u32 config_key = 0;

    // Get global configuration
    struct rate_config *cfg = bpf_map_lookup_elem(&config_map, &config_key);
    if (!cfg)
        return TC_ACT_OK;

    // Get or create token bucket for this source IP
    struct token_bucket *bucket = bpf_map_lookup_elem(&rate_limit_map, &src_ip);
    struct token_bucket new_bucket = {};

    if (!bucket) {
        new_bucket.tokens = cfg->burst_bytes;
        new_bucket.last_update = bpf_ktime_get_ns();
        new_bucket.rate = cfg->rate_bps / 8;  // bits/s to bytes/s
        new_bucket.burst = cfg->burst_bytes;
        bpf_map_update_elem(&rate_limit_map, &src_ip, &new_bucket, BPF_ANY);
        return TC_ACT_OK;
    }

    // Calculate tokens to add since last update
    __u64 now = bpf_ktime_get_ns();
    __u64 elapsed_ns = now - bucket->last_update;
    __u64 new_tokens = (elapsed_ns * bucket->rate) / 1000000000ULL;

    // Refill tokens, capped at burst
    bucket->tokens += new_tokens;
    if (bucket->tokens > bucket->burst)
        bucket->tokens = bucket->burst;
    bucket->last_update = now;

    // Check if enough tokens for this packet
    __u32 pkt_len = skb->len;
    if (bucket->tokens >= pkt_len) {
        bucket->tokens -= pkt_len;
        return TC_ACT_OK;
    }

    // Not enough tokens — drop
    return TC_ACT_SHOT;
}

char LICENSE[] SEC("license") = "GPL";
```

### Packet Redirection Between Interfaces

```c
// tc_redirect.bpf.c — Redirect packets between interfaces for transparent proxying
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/tcp.h>
#include <linux/pkt_cls.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

// Map: destination port -> redirect interface ifindex
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __type(key, __u16);    // Destination port
    __type(value, __u32);  // Target interface ifindex
    __uint(max_entries, 64);
} redirect_map SEC(".maps");

SEC("tc/ingress")
int tc_transparent_redirect(struct __sk_buff *skb) {
    void *data_end = (void *)(long)skb->data_end;
    void *data     = (void *)(long)skb->data;

    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return TC_ACT_OK;

    if (eth->h_proto != bpf_htons(ETH_P_IP))
        return TC_ACT_OK;

    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return TC_ACT_OK;

    if (ip->protocol != IPPROTO_TCP)
        return TC_ACT_OK;

    int ip_len = ip->ihl * 4;
    struct tcphdr *tcp = (void *)ip + ip_len;
    if ((void *)(tcp + 1) > data_end)
        return TC_ACT_OK;

    __u16 dst_port = bpf_ntohs(tcp->dest);

    // Check if this port should be redirected
    __u32 *ifindex = bpf_map_lookup_elem(&redirect_map, &dst_port);
    if (!ifindex)
        return TC_ACT_OK;

    // Redirect packet to another interface
    // TC_ACT_REDIRECT + bpf_redirect() changes the destination interface
    return bpf_redirect(*ifindex, 0);
}

char LICENSE[] SEC("license") = "GPL";
```

## Loading TC Programs with Go (cilium/ebpf)

### Program Loading and Attaching

```go
// pkg/tcprog/loader.go
package tcprog

import (
    "fmt"
    "net"
    "os"

    "github.com/cilium/ebpf"
    "github.com/cilium/ebpf/link"
    "github.com/vishvananda/netlink"
    "golang.org/x/sys/unix"
)

//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -cc clang -cflags "-O2 -g -Wall" TcDrop tc_drop.bpf.c

type TCManager struct {
    objs   *TcDropObjects
    filter *netlink.BpfFilter
    iface  string
}

func NewTCManager(iface string) (*TCManager, error) {
    // Load the compiled BPF program
    objs := &TcDropObjects{}
    if err := LoadTcDropObjects(objs, &ebpf.CollectionOptions{
        Programs: ebpf.ProgramOptions{
            LogLevel: ebpf.LogLevelInstruction,
            LogSize:  ebpf.DefaultVerifierLogSize,
        },
    }); err != nil {
        return nil, fmt.Errorf("loading BPF objects: %w", err)
    }

    return &TCManager{
        objs:  objs,
        iface: iface,
    }, nil
}

func (m *TCManager) Attach() error {
    // Get the network interface
    link, err := netlink.LinkByName(m.iface)
    if err != nil {
        return fmt.Errorf("getting interface %s: %w", m.iface, err)
    }

    // Ensure qdisc (clsact) exists — required for TC BPF
    // clsact is a special qdisc that supports BPF classifiers at
    // ingress and egress without any actual queuing
    if err := ensureClsactQdisc(link); err != nil {
        return fmt.Errorf("ensuring clsact qdisc: %w", err)
    }

    // Attach the BPF program as a TC filter
    filter := &netlink.BpfFilter{
        FilterAttrs: netlink.FilterAttrs{
            LinkIndex: link.Attrs().Index,
            Parent:    netlink.HANDLE_MIN_INGRESS, // Ingress hook
            Handle:    netlink.MakeHandle(0, 1),
            Protocol:  unix.ETH_P_ALL,
            Priority:  1,
        },
        Fd:           m.objs.TcIngressDrop.FD(),
        Name:         "tc-drop",
        DirectAction: true, // Enable TC_ACT_* return values
    }

    if err := netlink.FilterReplace(filter); err != nil {
        return fmt.Errorf("attaching TC filter: %w", err)
    }

    m.filter = filter
    return nil
}

func (m *TCManager) Detach() error {
    if m.filter == nil {
        return nil
    }

    link, err := netlink.LinkByName(m.iface)
    if err != nil {
        return err
    }

    filters, err := netlink.FilterList(link, netlink.HANDLE_MIN_INGRESS)
    if err != nil {
        return err
    }

    for _, f := range filters {
        if f.Attrs().Handle == m.filter.Handle {
            return netlink.FilterDel(f)
        }
    }
    return nil
}

func (m *TCManager) Close() {
    m.Detach()
    m.objs.Close()
}

func ensureClsactQdisc(link netlink.Link) error {
    qdiscs, err := netlink.QdiscList(link)
    if err != nil {
        return err
    }

    for _, q := range qdiscs {
        if q.Type() == "clsact" {
            return nil
        }
    }

    // Add clsact qdisc
    qdisc := &netlink.GenericQdisc{
        QdiscAttrs: netlink.QdiscAttrs{
            LinkIndex: link.Attrs().Index,
            Handle:    netlink.MakeHandle(0xffff, 0),
            Parent:    netlink.HANDLE_CLSACT,
        },
        QdiscType: "clsact",
    }
    return netlink.QdiscAdd(qdisc)
}
```

### Reading BPF Maps from Go

```go
// pkg/tcprog/metrics.go
package tcprog

import (
    "encoding/binary"
    "fmt"
    "net"
    "time"

    "github.com/cilium/ebpf"
)

type RateLimitEntry struct {
    SourceIP   net.IP
    Tokens     uint64
    LastUpdate time.Time
    Rate       uint64
    Burst      uint64
}

func (m *TCManager) GetRateLimitEntries() ([]RateLimitEntry, error) {
    var entries []RateLimitEntry

    var key uint32
    var value struct {
        Tokens     uint64
        LastUpdate uint64
        Rate       uint64
        Burst      uint64
    }

    iter := m.objs.RateLimitMap.Iterate()
    for iter.Next(&key, &value) {
        ip := make(net.IP, 4)
        binary.LittleEndian.PutUint32(ip, key)

        entries = append(entries, RateLimitEntry{
            SourceIP:   ip,
            Tokens:     value.Tokens,
            LastUpdate: time.Unix(0, int64(value.LastUpdate)),
            Rate:       value.Rate,
            Burst:      value.Burst,
        })
    }

    if err := iter.Err(); err != nil {
        return nil, fmt.Errorf("iterating map: %w", err)
    }

    return entries, nil
}

func (m *TCManager) AddRedirectRule(port uint16, ifindex uint32) error {
    return m.objs.RedirectMap.Put(port, ifindex)
}

func (m *TCManager) RemoveRedirectRule(port uint16) error {
    return m.objs.RedirectMap.Delete(port)
}
```

## Socket Filter Programs

Socket filters attach to individual sockets and can accept, drop, or truncate packets before they reach the application.

```c
// socket_filter.bpf.c — Filter packets on a raw socket
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/tcp.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

// Return values for socket filters:
// 0 = drop (do not deliver to socket)
// > 0 = accept, truncate to this many bytes

SEC("socket")
int socket_filter_http(struct __sk_buff *skb) {
    void *data_end = (void *)(long)skb->data_end;
    void *data     = (void *)(long)skb->data;

    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return 0;

    if (eth->h_proto != bpf_htons(ETH_P_IP))
        return 0;

    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return 0;

    if (ip->protocol != IPPROTO_TCP)
        return 0;

    struct tcphdr *tcp = (void *)ip + ip->ihl * 4;
    if ((void *)(tcp + 1) > data_end)
        return 0;

    // Only pass HTTP traffic (ports 80 and 8080)
    __u16 dst_port = bpf_ntohs(tcp->dest);
    __u16 src_port = bpf_ntohs(tcp->source);

    if (dst_port == 80 || dst_port == 8080 ||
        src_port == 80 || src_port == 8080) {
        return skb->len;  // Accept full packet
    }

    return 0;  // Drop
}

char LICENSE[] SEC("license") = "GPL";
```

### Attaching Socket Filter in Go

```go
// pkg/sockfilter/filter.go
package sockfilter

import (
    "fmt"
    "net"
    "syscall"
    "unsafe"

    "github.com/cilium/ebpf"
    "golang.org/x/sys/unix"
)

type RawSocketCapture struct {
    fd     int
    prog   *ebpf.Program
    iface  string
}

func NewRawSocketCapture(iface string, prog *ebpf.Program) (*RawSocketCapture, error) {
    // Create raw socket
    fd, err := unix.Socket(unix.AF_PACKET, unix.SOCK_RAW, int(htons(unix.ETH_P_ALL)))
    if err != nil {
        return nil, fmt.Errorf("creating raw socket: %w", err)
    }

    // Attach BPF program to socket
    if err := unix.SetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_ATTACH_BPF, prog.FD()); err != nil {
        unix.Close(fd)
        return nil, fmt.Errorf("attaching BPF to socket: %w", err)
    }

    // Bind to specific interface
    iface_link, err := net.InterfaceByName(iface)
    if err != nil {
        unix.Close(fd)
        return nil, err
    }

    sa := &unix.SockaddrLinklayer{
        Protocol: htons(unix.ETH_P_ALL),
        Ifindex:  iface_link.Index,
    }
    if err := unix.Bind(fd, sa); err != nil {
        unix.Close(fd)
        return nil, fmt.Errorf("binding socket: %w", err)
    }

    return &RawSocketCapture{
        fd:    fd,
        prog:  prog,
        iface: iface,
    }, nil
}

func (r *RawSocketCapture) Read(buf []byte) (int, error) {
    return unix.Read(r.fd, buf)
}

func (r *RawSocketCapture) Close() error {
    return unix.Close(r.fd)
}

func htons(i uint16) uint16 {
    b := make([]byte, 2)
    binary.BigEndian.PutUint16(b, i)
    return binary.LittleEndian.Uint16(b)
}
```

## sk_msg and Sockmap: Connection Acceleration

Sockmap allows eBPF programs to redirect data between sockets without copying through userspace. This is the kernel mechanism that enables Cilium's transparent accelerated local service communication.

### How Sockmap Works

When two local processes communicate (e.g., two containers on the same host communicating via a ClusterIP service), the normal path is:

```
App A -> socket send -> TCP/IP stack -> loopback -> TCP/IP stack -> socket recv -> App B
```

With sockmap + sk_msg redirect:

```
App A -> socket send -> BPF sk_msg program -> sockmap lookup -> direct to App B's recv buffer
```

The data never goes through the TCP/IP stack — it's moved directly from the sender's send buffer to the receiver's receive buffer.

### Sockmap BPF Program

```c
// sockmap.bpf.c — Redirect socket traffic using sockmap
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/tcp.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>
#include <bpf/bpf_tracing.h>

// Sockmap: maps socket cookies to socket file descriptors
struct {
    __uint(type, BPF_MAP_TYPE_SOCKHASH);
    __type(key, struct sock_key);
    __type(value, int);
    __uint(max_entries, 65535);
} sock_ops_map SEC(".maps");

struct sock_key {
    __u32 sip4;    // Source IP
    __u32 dip4;    // Destination IP
    __u16 sport;   // Source port
    __u16 dport;   // Destination port
    __u32 family;  // Address family
};

// sock_ops program: called on socket events (connect, accept, etc.)
// Used to populate the sockmap
SEC("sockops")
int bpf_sockops(struct bpf_sock_ops *skops) {
    struct sock_key key = {};

    // Only handle IPv4
    if (skops->family != AF_INET)
        return 0;

    // Handle new active connections (outgoing connect)
    if (skops->op == BPF_SOCK_OPS_ACTIVE_ESTABLISHED_CB ||
        skops->op == BPF_SOCK_OPS_PASSIVE_ESTABLISHED_CB) {

        key.sip4   = skops->local_ip4;
        key.dip4   = skops->remote_ip4;
        key.sport  = bpf_htons(skops->local_port);
        key.dport  = skops->remote_port;
        key.family = skops->family;

        // Insert this socket into the sockmap
        bpf_sock_hash_update(skops, &sock_ops_map, &key, BPF_NOEXIST);
    }

    return 0;
}

// sk_msg program: called when data is sent via a socket in the sockmap
// Redirects the data to the peer socket without going through TCP/IP stack
SEC("sk_msg")
int bpf_redir(struct sk_msg_md *msg) {
    struct sock_key key = {};

    // Build the reverse key: redirect to the peer
    // (src/dst are swapped to find the receiving socket)
    key.sip4   = msg->remote_ip4;
    key.dip4   = msg->local_ip4;
    key.sport  = msg->remote_port;
    key.dport  = bpf_htons(msg->local_port);
    key.family = msg->family;

    // Redirect to the socket matching the reverse key
    return bpf_msg_redirect_hash(msg, &sock_ops_map, &key, BPF_F_INGRESS);
}

char LICENSE[] SEC("license") = "GPL";
```

### Loading Sockmap Programs

```go
// pkg/sockmap/manager.go
package sockmap

import (
    "fmt"
    "os"

    "github.com/cilium/ebpf"
    "github.com/cilium/ebpf/link"
)

//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -cc clang Sockmap sockmap.bpf.c

type SockmapManager struct {
    objs         *SockmapObjects
    sockopsLink  link.Link
    skMsgLink    link.Link
    cgroupPath   string
}

func NewSockmapManager(cgroupPath string) (*SockmapManager, error) {
    objs := &SockmapObjects{}

    if err := LoadSockmapObjects(objs, nil); err != nil {
        return nil, fmt.Errorf("loading sockmap objects: %w", err)
    }

    return &SockmapManager{
        objs:       objs,
        cgroupPath: cgroupPath,
    }, nil
}

func (m *SockmapManager) Attach() error {
    cgroupFd, err := os.Open(m.cgroupPath)
    if err != nil {
        return fmt.Errorf("opening cgroup: %w", err)
    }
    defer cgroupFd.Close()

    // Attach sock_ops program to cgroup
    // This program fires on socket connect/accept events
    sockopsLink, err := link.AttachCgroup(link.CgroupOptions{
        Path:    m.cgroupPath,
        Attach:  ebpf.AttachCGroupSockOps,
        Program: m.objs.BpfSockops,
    })
    if err != nil {
        return fmt.Errorf("attaching sock_ops: %w", err)
    }
    m.sockopsLink = sockopsLink

    // Attach sk_msg program to the sockmap
    // This program fires when data is sent via a socket in the map
    skMsgLink, err := link.AttachRawLink(link.RawLinkOptions{
        Program: m.objs.BpfRedir,
        Attach:  ebpf.AttachSkMsgVerdict,
        Target:  m.objs.SockOpsMap.FD(),
    })
    if err != nil {
        m.sockopsLink.Close()
        return fmt.Errorf("attaching sk_msg: %w", err)
    }
    m.skMsgLink = skMsgLink

    return nil
}

func (m *SockmapManager) Close() {
    if m.sockopsLink != nil {
        m.sockopsLink.Close()
    }
    if m.skMsgLink != nil {
        m.skMsgLink.Close()
    }
    m.objs.Close()
}
```

## TC Programs for Kubernetes Container Networking

### Implementing Pod Egress Policy

```c
// pod_policy.bpf.c — Simple pod egress policy enforcement
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/tcp.h>
#include <linux/udp.h>
#include <linux/pkt_cls.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

// Policy rule: allow traffic to specific CIDR/port combinations
struct policy_key {
    __u32 dst_prefix;  // Network prefix (e.g., 10.96.0.0)
    __u32 dst_mask;    // Mask (e.g., 0xFFFF0000 for /16)
    __u16 dst_port;    // Destination port (0 = any)
    __u8  protocol;    // Protocol (0 = any)
    __u8  pad;
};

struct policy_value {
    __u8 action;  // 0 = drop, 1 = allow
};

// Map: egress policy rules
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __type(key, struct policy_key);
    __type(value, struct policy_value);
    __uint(max_entries, 1024);
} egress_policy SEC(".maps");

// Statistics map
struct stats_key {
    __u32 reason;  // 0=allowed, 1=denied_no_rule, 2=denied_by_rule
};

struct stats_value {
    __u64 packets;
    __u64 bytes;
};

struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __type(key, __u32);
    __type(value, struct stats_value);
    __uint(max_entries, 3);
} egress_stats SEC(".maps");

static __always_inline void update_stats(__u32 reason, __u32 pkt_len) {
    struct stats_value *stats = bpf_map_lookup_elem(&egress_stats, &reason);
    if (stats) {
        __sync_fetch_and_add(&stats->packets, 1);
        __sync_fetch_and_add(&stats->bytes, pkt_len);
    }
}

SEC("tc/egress")
int pod_egress_policy(struct __sk_buff *skb) {
    void *data_end = (void *)(long)skb->data_end;
    void *data     = (void *)(long)skb->data;

    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return TC_ACT_OK;

    if (eth->h_proto != bpf_htons(ETH_P_IP))
        return TC_ACT_OK;

    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return TC_ACT_OK;

    __u32 dst_ip = ip->daddr;
    __u8 protocol = ip->protocol;
    __u16 dst_port = 0;

    if (protocol == IPPROTO_TCP) {
        struct tcphdr *tcp = (void *)ip + ip->ihl * 4;
        if ((void *)(tcp + 1) > data_end)
            return TC_ACT_OK;
        dst_port = bpf_ntohs(tcp->dest);
    } else if (protocol == IPPROTO_UDP) {
        struct udphdr *udp = (void *)ip + ip->ihl * 4;
        if ((void *)(udp + 1) > data_end)
            return TC_ACT_OK;
        dst_port = bpf_ntohs(udp->dest);
    }

    // Check policy: exact match first, then wildcard
    struct policy_key key = {
        .dst_prefix = dst_ip,
        .dst_mask   = 0xFFFFFFFF,
        .dst_port   = dst_port,
        .protocol   = protocol,
    };

    struct policy_value *policy = bpf_map_lookup_elem(&egress_policy, &key);
    if (policy) {
        if (policy->action == 1) {
            update_stats(0, skb->len);
            return TC_ACT_OK;
        }
        update_stats(2, skb->len);
        return TC_ACT_SHOT;
    }

    // No matching rule — default deny
    update_stats(1, skb->len);
    return TC_ACT_SHOT;
}

char LICENSE[] SEC("license") = "GPL";
```

## Observability and Debugging

### Tracing TC Program Execution

```bash
# View attached TC programs on an interface
tc filter show dev eth0 ingress
tc filter show dev eth0 egress

# Dump BPF program bytecode
tc filter show dev eth0 ingress verbose

# View BPF maps
bpftool map list
bpftool map dump id <MAP_ID>

# Trace BPF printk output (bpf_printk)
cat /sys/kernel/debug/tracing/trace_pipe

# Monitor BPF program statistics (runs, failures)
bpftool prog show id <PROG_ID>
# Output:
# 42: sched_cls  name tc_ingress_drop  tag abc123
#     loaded_at 2024-01-15T10:00:00+0000  uid 0
#     xlated 512B  jited 288B  memlock 4096B  map_ids 5
#     run_cnt 1000000  run_time_ns 5000000

# Watch TC program performance in real-time
watch -n1 'bpftool prog show id 42 | grep run'
```

### Performance Benchmarking

```bash
# Measure TC program latency with pktgen
# Install pktgen kernel module
modprobe pktgen

# Configure pktgen traffic generator
echo "rem_dev eth0" > /proc/net/pktgen/pgctrl
echo "add_device eth0" > /proc/net/pktgen/pgctrl

cat > /proc/net/pktgen/eth0 << 'EOF'
count 1000000
pkt_size 64
dst_mac 00:11:22:33:44:55
dst 10.0.0.1
EOF

echo start > /proc/net/pktgen/pgctrl
cat /proc/net/pktgen/eth0 | grep -E "(ok|error|pps)"

# Flamegraph the BPF JIT compiled code using perf
perf record -g -a -- sleep 10
perf script | stackcollapse-perf.pl | flamegraph.pl > bpf-flame.svg
```

## Summary

TC eBPF programs provide programmable packet processing at a strategic position in the Linux network stack. Key takeaways:

- **TC vs XDP**: Use TC when you need socket context, routing table access, or bidirectional (ingress + egress) processing. Use XDP when you need maximum performance at ingress only.
- **BPF_PROG_TYPE_SCHED_CLS**: The TC program type. Returns TC_ACT_OK, TC_ACT_SHOT, or TC_ACT_REDIRECT.
- **clsact qdisc**: Required for direct-action TC programs; attach both ingress and egress hooks without queuing.
- **Sockmap + sk_msg**: Enables kernel-bypass local socket-to-socket communication, eliminating TCP/IP stack overhead for intra-node traffic.
- **Per-CPU maps**: Use BPF_MAP_TYPE_PERCPU_ARRAY/HASH for high-frequency statistics to avoid atomic contention.

These primitives are the foundation of Cilium's eBPF-native networking — replacing iptables rules with efficient BPF programs that run at line rate.
