---
title: "eBPF Program Development: Comprehensive Production Guide for Observability and Security"
date: 2026-06-19T00:00:00-05:00
draft: false
tags: ["eBPF", "Linux", "Observability", "Security", "Kernel Programming", "BPF", "Performance"]
categories: ["Linux", "Security", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to developing production-ready eBPF programs for system observability, security monitoring, and performance analysis with practical examples and best practices."
more_link: "yes"
url: "/ebpf-program-development-comprehensive-guide/"
---

Extended Berkeley Packet Filter (eBPF) has revolutionized Linux observability and security by enabling safe, efficient kernel-level programming without kernel modules. This comprehensive guide covers production eBPF program development, from basic concepts to advanced implementation patterns for enterprise environments.

<!--more-->

# eBPF Program Development: Comprehensive Production Guide

## Executive Summary

eBPF enables running sandboxed programs in the Linux kernel without changing kernel source code or loading kernel modules. This technology powers modern observability tools, security solutions, and network functionality. This guide provides a complete approach to developing production-ready eBPF programs, covering development tools, implementation patterns, security considerations, and operational deployment strategies.

## Understanding eBPF Architecture

### eBPF Execution Model

```
┌──────────────────────────────────────────────────────────┐
│                     User Space                           │
│  ┌────────────┐  ┌────────────┐  ┌─────────────────┐   │
│  │  libbpf    │  │   BCC      │  │  bpftrace       │   │
│  │  Programs  │  │   Tools    │  │  Scripts        │   │
│  └──────┬─────┘  └──────┬─────┘  └────────┬────────┘   │
│         │                │                  │            │
│         └────────────────┴──────────────────┘            │
│                          │                               │
└──────────────────────────┼───────────────────────────────┘
                           │ System Calls
┌──────────────────────────┼───────────────────────────────┐
│                     Kernel Space                         │
│  ┌────────────────────────┴──────────────────────────┐  │
│  │         BPF Verifier (Safety Checks)              │  │
│  └────────────────────────┬──────────────────────────┘  │
│  ┌────────────────────────┴──────────────────────────┐  │
│  │         JIT Compiler (x86/ARM/etc)                │  │
│  └────────────────────────┬──────────────────────────┘  │
│  ┌────────────────────────┴──────────────────────────┐  │
│  │              eBPF Programs                        │  │
│  │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐            │  │
│  │  │ XDP  │ │ TC   │ │Trace │ │Sock │            │  │
│  │  └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘            │  │
│  └─────┼────────┼────────┼────────┼─────────────────┘  │
│  ┌─────┴────────┴────────┴────────┴─────────────────┐  │
│  │          BPF Maps (Shared Data)                   │  │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────────────┐    │  │
│  │  │ Hash    │ │ Array   │ │ Ring Buffer     │    │  │
│  │  └─────────┘ └─────────┘ └─────────────────┘    │  │
│  └───────────────────────────────────────────────────┘  │
│                                                          │
│  ┌───────────────────────────────────────────────────┐  │
│  │         Kernel Events & Hook Points               │  │
│  │  Network | Tracepoints | kprobes | uprobes        │  │
│  └───────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### eBPF Program Types

eBPF supports various program types for different use cases:

1. **XDP (eXpress Data Path)**: Network packet processing at NIC driver level
2. **TC (Traffic Control)**: Network traffic filtering and manipulation
3. **Tracepoints**: Stable kernel event tracing
4. **kprobes/kretprobes**: Dynamic kernel function tracing
5. **uprobes/uretprobes**: User-space function tracing
6. **Socket filters**: Socket-level packet filtering
7. **cgroup programs**: Container-level resource control

## Development Environment Setup

### Installing Required Tools

```bash
#!/bin/bash
# setup-ebpf-dev.sh

set -euo pipefail

echo "Setting up eBPF development environment..."

# Update system
apt-get update
apt-get upgrade -y

# Install build essentials
apt-get install -y \
    build-essential \
    clang \
    llvm \
    libelf-dev \
    libssl-dev \
    pkg-config \
    linux-headers-$(uname -r) \
    linux-tools-common \
    linux-tools-generic \
    linux-tools-$(uname -r)

# Install libbpf
git clone https://github.com/libbpf/libbpf.git /opt/libbpf
cd /opt/libbpf/src
make
make install
ldconfig

# Install bpftool
git clone --recurse-submodules https://github.com/libbpf/bpftool.git /opt/bpftool
cd /opt/bpftool/src
make
make install

# Install BCC (BPF Compiler Collection)
apt-get install -y \
    bpfcc-tools \
    libbpfcc \
    libbpfcc-dev \
    python3-bpfcc

# Install bpftrace
apt-get install -y bpftrace

# Install CO-RE dependencies
apt-get install -y \
    libdw-dev \
    zlib1g-dev

# Verify installations
echo "Verifying installations..."
clang --version
llvm-config --version
bpftool version
bpftrace --version

echo "eBPF development environment setup complete!"
```

### Project Structure

```bash
# Create standard eBPF project structure
mkdir -p ebpf-project/{src,include,tools,examples,tests}

cat > ebpf-project/Makefile << 'EOF'
# Makefile for eBPF programs

CLANG := clang
LLC := llc
BPFTOOL := bpftool
ARCH := $(shell uname -m | sed 's/x86_64/x86/' | sed 's/aarch64/arm64/')

INCLUDE_DIR := include
SRC_DIR := src
BUILD_DIR := build

BPF_CFLAGS := -O2 -g -Wall -Werror -target bpf -D__TARGET_ARCH_$(ARCH)
BPF_INCLUDES := -I$(INCLUDE_DIR) -I/usr/include/$(ARCH)-linux-gnu

SRCS := $(wildcard $(SRC_DIR)/*.bpf.c)
OBJS := $(patsubst $(SRC_DIR)/%.bpf.c,$(BUILD_DIR)/%.bpf.o,$(SRCS))
SKELS := $(patsubst $(SRC_DIR)/%.bpf.c,$(BUILD_DIR)/%.skel.h,$(SRCS))

all: $(OBJS) $(SKELS)

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

$(BUILD_DIR)/%.bpf.o: $(SRC_DIR)/%.bpf.c | $(BUILD_DIR)
	$(CLANG) $(BPF_CFLAGS) $(BPF_INCLUDES) -c $< -o $@

$(BUILD_DIR)/%.skel.h: $(BUILD_DIR)/%.bpf.o
	$(BPFTOOL) gen skeleton $< > $@

clean:
	rm -rf $(BUILD_DIR)

.PHONY: all clean
EOF
```

## Basic eBPF Program: System Call Monitoring

### Kernel-Space eBPF Program

```c
// src/syscall_monitor.bpf.c
#include <linux/bpf.h>
#include <linux/ptrace.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

#define TASK_COMM_LEN 16
#define MAX_FILENAME_LEN 256

// Event structure shared between kernel and user space
struct syscall_event {
    __u32 pid;
    __u32 tid;
    __u32 uid;
    __u32 gid;
    __u64 timestamp;
    __u64 syscall_nr;
    __s64 ret_value;
    char comm[TASK_COMM_LEN];
    char filename[MAX_FILENAME_LEN];
};

// Ring buffer for sending events to user space
struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 256 * 1024);
} events SEC(".maps");

// Hash map for tracking syscall latency
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 10240);
    __type(key, __u32);
    __type(value, __u64);
} syscall_start_time SEC(".maps");

// Per-CPU array for statistics
struct syscall_stats {
    __u64 count;
    __u64 total_time;
    __u64 min_time;
    __u64 max_time;
};

struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(max_entries, 512);
    __type(key, __u32);
    __type(value, struct syscall_stats);
} stats SEC(".maps");

// Helper to get current task info
static __always_inline void get_task_info(struct syscall_event *event)
{
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u64 uid_gid = bpf_get_current_uid_gid();

    event->pid = pid_tgid >> 32;
    event->tid = (__u32)pid_tgid;
    event->uid = (__u32)uid_gid;
    event->gid = uid_gid >> 32;
    event->timestamp = bpf_ktime_get_ns();

    bpf_get_current_comm(&event->comm, sizeof(event->comm));
}

// Tracepoint for syscall entry
SEC("tracepoint/raw_syscalls/sys_enter")
int trace_sys_enter(struct trace_event_raw_sys_enter *ctx)
{
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 tid = (__u32)pid_tgid;
    __u64 timestamp = bpf_ktime_get_ns();

    // Store entry timestamp for latency calculation
    bpf_map_update_elem(&syscall_start_time, &tid, &timestamp, BPF_ANY);

    return 0;
}

// Tracepoint for syscall exit
SEC("tracepoint/raw_syscalls/sys_exit")
int trace_sys_exit(struct trace_event_raw_sys_exit *ctx)
{
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 tid = (__u32)pid_tgid;
    __u64 *start_time;
    __u64 end_time = bpf_ktime_get_ns();
    __u64 duration;

    // Get start time
    start_time = bpf_map_lookup_elem(&syscall_start_time, &tid);
    if (!start_time)
        return 0;

    duration = end_time - *start_time;

    // Update statistics
    __u32 syscall_nr = (__u32)ctx->id;
    struct syscall_stats *stat = bpf_map_lookup_elem(&stats, &syscall_nr);
    if (stat) {
        __sync_fetch_and_add(&stat->count, 1);
        __sync_fetch_and_add(&stat->total_time, duration);

        if (stat->min_time == 0 || duration < stat->min_time)
            stat->min_time = duration;
        if (duration > stat->max_time)
            stat->max_time = duration;
    } else {
        struct syscall_stats new_stat = {
            .count = 1,
            .total_time = duration,
            .min_time = duration,
            .max_time = duration,
        };
        bpf_map_update_elem(&stats, &syscall_nr, &new_stat, BPF_ANY);
    }

    // Send event to user space for slow syscalls (> 1ms)
    if (duration > 1000000) {
        struct syscall_event *event;

        event = bpf_ringbuf_reserve(&events, sizeof(*event), 0);
        if (!event) {
            bpf_map_delete_elem(&syscall_start_time, &tid);
            return 0;
        }

        get_task_info(event);
        event->syscall_nr = ctx->id;
        event->ret_value = ctx->ret;

        bpf_ringbuf_submit(event, 0);
    }

    bpf_map_delete_elem(&syscall_start_time, &tid);
    return 0;
}

// Kprobe for sys_openat
SEC("kprobe/do_sys_openat2")
int BPF_KPROBE(trace_openat, int dfd, const char __user *filename)
{
    struct syscall_event *event;

    event = bpf_ringbuf_reserve(&events, sizeof(*event), 0);
    if (!event)
        return 0;

    get_task_info(event);
    event->syscall_nr = 257; // __NR_openat

    // Read filename from user space
    bpf_probe_read_user_str(&event->filename, sizeof(event->filename), filename);

    bpf_ringbuf_submit(event, 0);
    return 0;
}

// Kretprobe for sys_openat
SEC("kretprobe/do_sys_openat2")
int BPF_KRETPROBE(trace_openat_ret, long ret)
{
    // Can track file descriptor here
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
```

### User-Space Loader Program

```c
// tools/syscall_monitor.c
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <signal.h>
#include <unistd.h>
#include <sys/resource.h>
#include <bpf/libbpf.h>
#include <bpf/bpf.h>
#include "build/syscall_monitor.skel.h"

static volatile bool exiting = false;

static void sig_handler(int sig)
{
    exiting = true;
}

static int libbpf_print_fn(enum libbpf_print_level level, const char *format, va_list args)
{
    if (level == LIBBPF_DEBUG)
        return 0;
    return vfprintf(stderr, format, args);
}

static int handle_event(void *ctx, void *data, size_t data_sz)
{
    const struct syscall_event *e = data;
    struct tm *tm;
    char ts[32];
    time_t t;

    time(&t);
    tm = localtime(&t);
    strftime(ts, sizeof(ts), "%H:%M:%S", tm);

    printf("%-8s %-7d %-7d %-16s %-6lld",
           ts, e->pid, e->tid, e->comm, e->syscall_nr);

    if (strlen(e->filename) > 0)
        printf(" %-s", e->filename);

    if (e->ret_value != 0)
        printf(" (ret: %lld)", e->ret_value);

    printf("\n");
    return 0;
}

static void print_stats(int stats_fd)
{
    __u32 syscall_nr;
    struct syscall_stats stat;
    struct syscall_stats aggregated;

    printf("\n=== Syscall Statistics ===\n");
    printf("%-10s %-12s %-15s %-15s %-15s %-15s\n",
           "SYSCALL", "COUNT", "TOTAL_TIME(us)", "MIN_TIME(us)", "MAX_TIME(us)", "AVG_TIME(us)");

    for (syscall_nr = 0; syscall_nr < 512; syscall_nr++) {
        if (bpf_map_lookup_elem(stats_fd, &syscall_nr, &stat) != 0)
            continue;

        if (stat.count == 0)
            continue;

        // For per-CPU maps, aggregate results
        aggregated.count = stat.count;
        aggregated.total_time = stat.total_time;
        aggregated.min_time = stat.min_time;
        aggregated.max_time = stat.max_time;

        __u64 avg_time = aggregated.total_time / aggregated.count;

        printf("%-10u %-12llu %-15llu %-15llu %-15llu %-15llu\n",
               syscall_nr,
               aggregated.count,
               aggregated.total_time / 1000,
               aggregated.min_time / 1000,
               aggregated.max_time / 1000,
               avg_time / 1000);
    }
}

int main(int argc, char **argv)
{
    struct ring_buffer *rb = NULL;
    struct syscall_monitor_bpf *skel;
    int err;

    // Set up libbpf errors and debug info callback
    libbpf_set_print(libbpf_print_fn);

    // Setup signal handlers
    signal(SIGINT, sig_handler);
    signal(SIGTERM, sig_handler);

    // Bump RLIMIT_MEMLOCK to allow BPF sub-system to do anything
    struct rlimit rlim_new = {
        .rlim_cur = RLIM_INFINITY,
        .rlim_max = RLIM_INFINITY,
    };

    if (setrlimit(RLIMIT_MEMLOCK, &rlim_new)) {
        fprintf(stderr, "Failed to increase RLIMIT_MEMLOCK limit!\n");
        return 1;
    }

    // Open BPF application
    skel = syscall_monitor_bpf__open();
    if (!skel) {
        fprintf(stderr, "Failed to open BPF skeleton\n");
        return 1;
    }

    // Load & verify BPF programs
    err = syscall_monitor_bpf__load(skel);
    if (err) {
        fprintf(stderr, "Failed to load and verify BPF skeleton\n");
        goto cleanup;
    }

    // Attach tracepoints
    err = syscall_monitor_bpf__attach(skel);
    if (err) {
        fprintf(stderr, "Failed to attach BPF skeleton\n");
        goto cleanup;
    }

    // Set up ring buffer
    rb = ring_buffer__new(bpf_map__fd(skel->maps.events), handle_event, NULL, NULL);
    if (!rb) {
        err = -1;
        fprintf(stderr, "Failed to create ring buffer\n");
        goto cleanup;
    }

    printf("Successfully started! Monitoring syscalls...\n");
    printf("%-8s %-7s %-7s %-16s %-6s %s\n",
           "TIME", "PID", "TID", "COMM", "SYSCALL", "DETAILS");

    // Process events
    while (!exiting) {
        err = ring_buffer__poll(rb, 100);
        if (err == -EINTR) {
            err = 0;
            break;
        }
        if (err < 0) {
            fprintf(stderr, "Error polling ring buffer: %d\n", err);
            break;
        }
    }

    // Print final statistics
    print_stats(bpf_map__fd(skel->maps.stats));

cleanup:
    ring_buffer__free(rb);
    syscall_monitor_bpf__destroy(skel);
    return -err;
}
```

## Advanced eBPF: Network Packet Filtering (XDP)

### XDP Program for DDoS Protection

```c
// src/xdp_ddos_protect.bpf.c
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/tcp.h>
#include <linux/udp.h>
#include <linux/in.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

#define MAX_RULES 1024
#define MAX_CONNTRACK 65536

// Rate limiting configuration
struct rate_limit {
    __u64 last_seen;
    __u64 packet_count;
    __u64 byte_count;
};

// Connection tracking entry
struct conn_key {
    __u32 saddr;
    __u32 daddr;
    __u16 sport;
    __u16 dport;
    __u8 protocol;
};

// Firewall rule
struct fw_rule {
    __u32 saddr;
    __u32 smask;
    __u32 daddr;
    __u32 dmask;
    __u16 sport_min;
    __u16 sport_max;
    __u16 dport_min;
    __u16 dport_max;
    __u8 protocol;
    __u8 action; // 0=DROP, 1=PASS
};

// Statistics
struct xdp_stats {
    __u64 packets_passed;
    __u64 packets_dropped;
    __u64 bytes_passed;
    __u64 bytes_dropped;
};

// BPF maps
struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(max_entries, 1);
    __type(key, __u32);
    __type(value, struct xdp_stats);
} stats_map SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, MAX_CONNTRACK);
    __type(key, struct conn_key);
    __type(value, struct rate_limit);
} conntrack_map SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, MAX_RULES);
    __type(key, __u32);
    __type(value, struct fw_rule);
} rules_map SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, 10000);
    __type(key, __u32);
    __type(value, __u64);
} blacklist_map SEC(".maps");

// Configuration
struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, 1);
    __type(key, __u32);
    __type(value, __u64);
} config_map SEC(".maps");

#define CFG_RATE_LIMIT_PPS 0
#define CFG_RATE_LIMIT_BPS 1
#define CFG_RATE_WINDOW_NS 2

// Helper: Update statistics
static __always_inline void update_stats(struct xdp_stats *stats, __u64 bytes, bool dropped)
{
    if (dropped) {
        __sync_fetch_and_add(&stats->packets_dropped, 1);
        __sync_fetch_and_add(&stats->bytes_dropped, bytes);
    } else {
        __sync_fetch_and_add(&stats->packets_passed, 1);
        __sync_fetch_and_add(&stats->bytes_passed, bytes);
    }
}

// Helper: Check rate limit
static __always_inline bool check_rate_limit(struct conn_key *key, __u64 bytes)
{
    struct rate_limit *limit;
    __u64 now = bpf_ktime_get_ns();
    __u64 window = 1000000000; // 1 second default
    __u64 max_pps = 1000;      // packets per second
    __u64 max_bps = 10000000;  // bytes per second

    // Get configuration
    __u32 cfg_key = CFG_RATE_WINDOW_NS;
    __u64 *cfg_val = bpf_map_lookup_elem(&config_map, &cfg_key);
    if (cfg_val)
        window = *cfg_val;

    cfg_key = CFG_RATE_LIMIT_PPS;
    cfg_val = bpf_map_lookup_elem(&config_map, &cfg_key);
    if (cfg_val)
        max_pps = *cfg_val;

    cfg_key = CFG_RATE_LIMIT_BPS;
    cfg_val = bpf_map_lookup_elem(&config_map, &cfg_key);
    if (cfg_val)
        max_bps = *cfg_val;

    limit = bpf_map_lookup_elem(&conntrack_map, key);
    if (!limit) {
        struct rate_limit new_limit = {
            .last_seen = now,
            .packet_count = 1,
            .byte_count = bytes,
        };
        bpf_map_update_elem(&conntrack_map, key, &new_limit, BPF_ANY);
        return true;
    }

    // Reset counters if window expired
    if (now - limit->last_seen > window) {
        limit->last_seen = now;
        limit->packet_count = 1;
        limit->byte_count = bytes;
        return true;
    }

    // Check limits
    if (limit->packet_count >= max_pps || limit->byte_count >= max_bps) {
        return false;
    }

    // Update counters
    limit->packet_count++;
    limit->byte_count += bytes;
    return true;
}

// Helper: Check firewall rules
static __always_inline int check_firewall_rules(struct conn_key *key)
{
    struct fw_rule *rule;
    __u32 i;

    #pragma unroll
    for (i = 0; i < MAX_RULES; i++) {
        rule = bpf_map_lookup_elem(&rules_map, &i);
        if (!rule)
            continue;

        // Check protocol
        if (rule->protocol != 0 && rule->protocol != key->protocol)
            continue;

        // Check source address
        if (rule->saddr != 0 && (key->saddr & rule->smask) != (rule->saddr & rule->smask))
            continue;

        // Check destination address
        if (rule->daddr != 0 && (key->daddr & rule->dmask) != (rule->daddr & rule->dmask))
            continue;

        // Check source port
        if (rule->sport_min != 0 && (key->sport < rule->sport_min || key->sport > rule->sport_max))
            continue;

        // Check destination port
        if (rule->dport_min != 0 && (key->dport < rule->dport_min || key->dport > rule->dport_max))
            continue;

        // Rule matched
        return rule->action;
    }

    return 1; // Default PASS
}

SEC("xdp")
int xdp_ddos_protect(struct xdp_md *ctx)
{
    void *data_end = (void *)(long)ctx->data_end;
    void *data = (void *)(long)ctx->data;
    struct ethhdr *eth = data;
    struct iphdr *iph;
    struct tcphdr *tcph;
    struct udphdr *udph;
    struct conn_key key = {};
    __u32 stats_key = 0;
    struct xdp_stats *stats;
    __u64 *blacklist_time;
    __u64 packet_size;
    int action;

    // Parse Ethernet header
    if (data + sizeof(*eth) > data_end)
        return XDP_DROP;

    // Only handle IPv4
    if (eth->h_proto != bpf_htons(ETH_P_IP))
        return XDP_PASS;

    iph = data + sizeof(*eth);
    if ((void *)(iph + 1) > data_end)
        return XDP_DROP;

    packet_size = data_end - data;

    // Get statistics map
    stats = bpf_map_lookup_elem(&stats_map, &stats_key);
    if (!stats)
        return XDP_DROP;

    // Populate connection key
    key.saddr = iph->saddr;
    key.daddr = iph->daddr;
    key.protocol = iph->protocol;

    // Check if source IP is blacklisted
    blacklist_time = bpf_map_lookup_elem(&blacklist_map, &key.saddr);
    if (blacklist_time) {
        __u64 now = bpf_ktime_get_ns();
        if (now - *blacklist_time < 3600000000000ULL) { // 1 hour
            update_stats(stats, packet_size, true);
            return XDP_DROP;
        }
    }

    // Parse transport layer
    switch (iph->protocol) {
    case IPPROTO_TCP:
        tcph = (void *)iph + sizeof(*iph);
        if ((void *)(tcph + 1) > data_end)
            return XDP_DROP;
        key.sport = bpf_ntohs(tcph->source);
        key.dport = bpf_ntohs(tcph->dest);

        // SYN flood protection
        if (tcph->syn && !tcph->ack) {
            if (!check_rate_limit(&key, packet_size)) {
                // Add to blacklist
                __u64 now = bpf_ktime_get_ns();
                bpf_map_update_elem(&blacklist_map, &key.saddr, &now, BPF_ANY);
                update_stats(stats, packet_size, true);
                return XDP_DROP;
            }
        }
        break;

    case IPPROTO_UDP:
        udph = (void *)iph + sizeof(*iph);
        if ((void *)(udph + 1) > data_end)
            return XDP_DROP;
        key.sport = bpf_ntohs(udph->source);
        key.dport = bpf_ntohs(udph->dest);

        // UDP flood protection
        if (!check_rate_limit(&key, packet_size)) {
            __u64 now = bpf_ktime_get_ns();
            bpf_map_update_elem(&blacklist_map, &key.saddr, &now, BPF_ANY);
            update_stats(stats, packet_size, true);
            return XDP_DROP;
        }
        break;

    default:
        // Allow other protocols (ICMP, etc.) with basic rate limiting
        if (!check_rate_limit(&key, packet_size)) {
            update_stats(stats, packet_size, true);
            return XDP_DROP;
        }
        update_stats(stats, packet_size, false);
        return XDP_PASS;
    }

    // Check firewall rules
    action = check_firewall_rules(&key);
    if (action == 0) {
        update_stats(stats, packet_size, true);
        return XDP_DROP;
    }

    update_stats(stats, packet_size, false);
    return XDP_PASS;
}

char LICENSE[] SEC("license") = "GPL";
```

### XDP Loader and Management Tool

```c
// tools/xdp_manager.c
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <net/if.h>
#include <linux/if_link.h>
#include <arpa/inet.h>
#include <bpf/libbpf.h>
#include <bpf/bpf.h>
#include "build/xdp_ddos_protect.skel.h"

static void print_usage(const char *prog)
{
    fprintf(stderr,
            "Usage: %s [OPTIONS]\n"
            "Options:\n"
            "  -i, --interface <iface>  Network interface (required)\n"
            "  -l, --load               Load XDP program\n"
            "  -u, --unload             Unload XDP program\n"
            "  -s, --stats              Show statistics\n"
            "  -r, --rule <rule>        Add firewall rule\n"
            "  -b, --blacklist <ip>     Add IP to blacklist\n"
            "  -c, --config <key=val>   Set configuration\n"
            "  -h, --help               Show this help\n",
            prog);
}

static int load_xdp_program(const char *ifname)
{
    struct xdp_ddos_protect_bpf *skel;
    int ifindex, err;

    ifindex = if_nametoindex(ifname);
    if (!ifindex) {
        fprintf(stderr, "Interface %s not found\n", ifname);
        return -1;
    }

    skel = xdp_ddos_protect_bpf__open();
    if (!skel) {
        fprintf(stderr, "Failed to open BPF skeleton\n");
        return -1;
    }

    err = xdp_ddos_protect_bpf__load(skel);
    if (err) {
        fprintf(stderr, "Failed to load BPF skeleton: %d\n", err);
        goto cleanup;
    }

    err = bpf_xdp_attach(ifindex,
                         bpf_program__fd(skel->progs.xdp_ddos_protect),
                         XDP_FLAGS_UPDATE_IF_NOEXIST,
                         NULL);
    if (err) {
        fprintf(stderr, "Failed to attach XDP program: %d\n", err);
        goto cleanup;
    }

    printf("Successfully loaded XDP program on interface %s\n", ifname);

    // Set default configuration
    __u32 key = 0;
    __u64 value;

    // Rate limit: 1000 packets per second
    value = 1000;
    bpf_map_update_elem(bpf_map__fd(skel->maps.config_map), &key, &value, BPF_ANY);

    // Rate limit: 10MB per second
    key = 1;
    value = 10000000;
    bpf_map_update_elem(bpf_map__fd(skel->maps.config_map), &key, &value, BPF_ANY);

    // Window: 1 second
    key = 2;
    value = 1000000000;
    bpf_map_update_elem(bpf_map__fd(skel->maps.config_map), &key, &value, BPF_ANY);

    printf("Default configuration applied\n");

    return 0;

cleanup:
    xdp_ddos_protect_bpf__destroy(skel);
    return err;
}

static int unload_xdp_program(const char *ifname)
{
    int ifindex;

    ifindex = if_nametoindex(ifname);
    if (!ifindex) {
        fprintf(stderr, "Interface %s not found\n", ifname);
        return -1;
    }

    if (bpf_xdp_detach(ifindex, 0, NULL) < 0) {
        fprintf(stderr, "Failed to detach XDP program\n");
        return -1;
    }

    printf("Successfully unloaded XDP program from interface %s\n", ifname);
    return 0;
}

static int show_stats(const char *ifname)
{
    // Implementation would query the stats map
    // and display current statistics
    printf("Statistics for interface %s:\n", ifname);
    // ... stats display code ...
    return 0;
}

int main(int argc, char **argv)
{
    const char *ifname = NULL;
    int opt;
    int action = 0; // 0=none, 1=load, 2=unload, 3=stats

    while ((opt = getopt(argc, argv, "i:lusr:b:c:h")) != -1) {
        switch (opt) {
        case 'i':
            ifname = optarg;
            break;
        case 'l':
            action = 1;
            break;
        case 'u':
            action = 2;
            break;
        case 's':
            action = 3;
            break;
        case 'h':
        default:
            print_usage(argv[0]);
            return 1;
        }
    }

    if (!ifname) {
        fprintf(stderr, "Interface name is required\n");
        print_usage(argv[0]);
        return 1;
    }

    switch (action) {
    case 1:
        return load_xdp_program(ifname);
    case 2:
        return unload_xdp_program(ifname);
    case 3:
        return show_stats(ifname);
    default:
        print_usage(argv[0]);
        return 1;
    }
}
```

## CO-RE (Compile Once, Run Everywhere)

### CO-RE Enabled Process Monitor

```c
// src/process_monitor.bpf.c
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

struct process_event {
    __u32 pid;
    __u32 ppid;
    __u32 uid;
    char comm[16];
    char filename[256];
    __u64 timestamp;
};

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 256 * 1024);
} events SEC(".maps");

SEC("tp/sched/sched_process_exec")
int handle_exec(struct trace_event_raw_sched_process_exec *ctx)
{
    struct task_struct *task;
    struct process_event *event;

    event = bpf_ringbuf_reserve(&events, sizeof(*event), 0);
    if (!event)
        return 0;

    task = (struct task_struct *)bpf_get_current_task();

    event->pid = BPF_CORE_READ(task, tgid);
    event->ppid = BPF_CORE_READ(task, real_parent, tgid);
    event->uid = BPF_CORE_READ(task, real_cred, uid.val);
    event->timestamp = bpf_ktime_get_ns();

    bpf_get_current_comm(&event->comm, sizeof(event->comm));
    bpf_probe_read_kernel_str(&event->filename, sizeof(event->filename),
                               BPF_CORE_READ(task, mm, exe_file, f_path.dentry, d_name.name));

    bpf_ringbuf_submit(event, 0);
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
```

## Kubernetes Integration

### DaemonSet for Cluster-Wide eBPF Deployment

```yaml
# k8s/ebpf-monitor-daemonset.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: ebpf-monitoring
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ebpf-monitor
  namespace: ebpf-monitoring
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: ebpf-monitor
rules:
- apiGroups: [""]
  resources: ["nodes", "pods"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ebpf-monitor
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: ebpf-monitor
subjects:
- kind: ServiceAccount
  name: ebpf-monitor
  namespace: ebpf-monitoring
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: ebpf-monitor
  namespace: ebpf-monitoring
  labels:
    app: ebpf-monitor
spec:
  selector:
    matchLabels:
      app: ebpf-monitor
  template:
    metadata:
      labels:
        app: ebpf-monitor
    spec:
      serviceAccountName: ebpf-monitor
      hostNetwork: true
      hostPID: true
      hostIPC: true
      tolerations:
      - key: node-role.kubernetes.io/master
        effect: NoSchedule
      - key: node-role.kubernetes.io/control-plane
        effect: NoSchedule
      containers:
      - name: ebpf-monitor
        image: ghcr.io/myorg/ebpf-monitor:latest
        securityContext:
          privileged: true
          capabilities:
            add:
            - SYS_ADMIN
            - SYS_RESOURCE
            - SYS_PTRACE
            - NET_ADMIN
            - IPC_LOCK
            - BPF
        volumeMounts:
        - name: sys
          mountPath: /sys
        - name: debugfs
          mountPath: /sys/kernel/debug
        - name: bpffs
          mountPath: /sys/fs/bpf
        - name: modules
          mountPath: /lib/modules
          readOnly: true
        env:
        - name: NODE_NAME
          valueFrom:
            fieldRef:
              fieldPath: spec.nodeName
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
      volumes:
      - name: sys
        hostPath:
          path: /sys
      - name: debugfs
        hostPath:
          path: /sys/kernel/debug
      - name: bpffs
        hostPath:
          path: /sys/fs/bpf
          type: DirectoryOrCreate
      - name: modules
        hostPath:
          path: /lib/modules
```

## Production Deployment Best Practices

### eBPF Program Versioning and Updates

```bash
#!/bin/bash
# deploy-ebpf-update.sh

set -euo pipefail

NAMESPACE="ebpf-monitoring"
NEW_VERSION="$1"

echo "Deploying eBPF monitor version: $NEW_VERSION"

# Build new image
docker build -t ghcr.io/myorg/ebpf-monitor:${NEW_VERSION} .
docker push ghcr.io/myorg/ebpf-monitor:${NEW_VERSION}

# Update DaemonSet with rolling update
kubectl set image daemonset/ebpf-monitor \
  ebpf-monitor=ghcr.io/myorg/ebpf-monitor:${NEW_VERSION} \
  -n ${NAMESPACE}

# Wait for rollout
kubectl rollout status daemonset/ebpf-monitor -n ${NAMESPACE}

echo "Deployment complete!"
```

## Conclusion

eBPF represents a fundamental shift in how we approach Linux observability, security, and networking. This guide has provided comprehensive coverage of eBPF program development, from basic tracing to advanced XDP networking and Kubernetes integration. Organizations leveraging eBPF gain unprecedented visibility into system behavior, enhanced security posture, and improved performance through kernel-level programmability without the risks of traditional kernel modules.

Key takeaways for production eBPF deployment:
- Start with CO-RE for maximum portability
- Implement comprehensive error handling and resource management
- Use appropriate map types for performance and scalability
- Deploy via Kubernetes DaemonSets for cluster-wide coverage
- Monitor eBPF program performance and resource usage
- Maintain proper versioning and update procedures
- Follow security best practices for privileged operations

As eBPF continues to evolve with new program types, helper functions, and kernel integrations, it will become increasingly central to cloud-native infrastructure operations, security enforcement, and performance optimization.