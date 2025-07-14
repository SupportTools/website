---
title: "Advanced Linux Tracing and Instrumentation Frameworks: Mastering eBPF, SystemTap, and Performance Analysis"
date: 2025-04-09T10:00:00-05:00
draft: false
tags: ["Linux", "Tracing", "eBPF", "SystemTap", "Performance", "Instrumentation", "Observability", "Debugging"]
categories:
- Linux
- Performance Analysis
author: "Matthew Mattox - mmattox@support.tools"
description: "Master advanced Linux tracing and instrumentation using eBPF, SystemTap, ftrace, and custom observability frameworks for deep system analysis and performance optimization"
more_link: "yes"
url: "/advanced-linux-tracing-instrumentation-frameworks/"
---

Modern Linux systems require sophisticated tracing and instrumentation capabilities for performance analysis, debugging, and observability. This comprehensive guide explores advanced tracing frameworks including eBPF, SystemTap, ftrace, and building custom instrumentation solutions for production environments.

<!--more-->

# [Advanced Linux Tracing and Instrumentation Frameworks](#advanced-linux-tracing-instrumentation)

## eBPF Programming and Advanced Kernel Instrumentation

### Complete eBPF Program Development Framework

```c
// ebpf_framework.c - Advanced eBPF program development framework
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <linux/bpf.h>
#include <linux/perf_event.h>
#include <linux/ptrace.h>
#include <linux/version.h>
#include <bpf/bpf.h>
#include <bpf/libbpf.h>
#include <bpf/btf.h>
#include <signal.h>
#include <time.h>
#include <pthread.h>
#include <poll.h>

#define MAX_CPUS 256
#define MAX_ENTRIES 10240
#define TASK_COMM_LEN 16

// Data structures for eBPF maps
struct event_data {
    __u32 pid;
    __u32 tid;
    __u64 timestamp;
    __u64 duration;
    __u32 cpu;
    char comm[TASK_COMM_LEN];
    __u32 syscall_nr;
    __s64 retval;
    __u64 args[6];
};

struct perf_sample {
    struct perf_event_header header;
    __u32 size;
    char data[];
};

struct histogram_key {
    __u32 bucket;
};

struct histogram_value {
    __u64 count;
};

struct stack_trace_key {
    __u32 pid;
    __u32 kernel_stack_id;
    __u32 user_stack_id;
};

struct stack_trace_value {
    __u64 count;
    char comm[TASK_COMM_LEN];
};

// eBPF program management structure
struct ebpf_program {
    const char *name;
    const char *section;
    int prog_fd;
    int map_fd;
    struct bpf_object *obj;
    struct bpf_program *prog;
    struct bpf_map *map;
    struct bpf_link *link;
    bool loaded;
    bool attached;
};

// Global eBPF context
struct ebpf_context {
    struct ebpf_program programs[16];
    int program_count;
    struct bpf_object *obj;
    bool running;
    pthread_t event_thread;
    int perf_map_fd;
    struct perf_buffer *pb;
} ebpf_ctx = {0};

// eBPF helper functions
static int bump_memlock_rlimit(void) {
    struct rlimit rlim_new = {
        .rlim_cur = RLIM_INFINITY,
        .rlim_max = RLIM_INFINITY,
    };
    
    return setrlimit(RLIMIT_MEMLOCK, &rlim_new);
}

static int open_raw_sock(const char *name) {
    struct sockaddr_ll sll;
    int sock;

    sock = socket(PF_PACKET, SOCK_RAW | SOCK_NONBLOCK | SOCK_CLOEXEC, htons(ETH_P_ALL));
    if (sock < 0) {
        fprintf(stderr, "Cannot create raw socket\n");
        return -1;
    }

    memset(&sll, 0, sizeof(sll));
    sll.sll_family = AF_PACKET;
    sll.sll_ifindex = if_nametoindex(name);
    sll.sll_protocol = htons(ETH_P_ALL);
    if (bind(sock, (struct sockaddr *)&sll, sizeof(sll)) < 0) {
        fprintf(stderr, "Cannot bind to %s: %s\n", name, strerror(errno));
        close(sock);
        return -1;
    }

    return sock;
}

// Syscall tracing eBPF program (embedded as string)
static const char syscall_tracer_prog[] = R"(
#include <linux/bpf.h>
#include <linux/ptrace.h>
#include <linux/sched.h>
#include <linux/version.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

#define TASK_COMM_LEN 16
#define MAX_ENTRIES 10240

struct event_data {
    __u32 pid;
    __u32 tid;
    __u64 timestamp;
    __u64 duration;
    __u32 cpu;
    char comm[TASK_COMM_LEN];
    __u32 syscall_nr;
    __s64 retval;
    __u64 args[6];
};

struct {
    __uint(type, BPF_MAP_TYPE_PERF_EVENT_ARRAY);
    __uint(key_size, sizeof(__u32));
    __uint(value_size, sizeof(__u32));
} events SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __type(key, __u32);
    __type(value, __u64);
    __uint(max_entries, MAX_ENTRIES);
} start_times SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_HISTOGRAM);
    __type(key, __u32);
    __type(value, __u64);
    __uint(max_entries, 64);
} duration_hist SEC(".maps");

SEC("tracepoint/raw_syscalls/sys_enter")
int trace_enter(struct trace_event_raw_sys_enter *ctx) {
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 pid = pid_tgid >> 32;
    __u32 tid = (__u32)pid_tgid;
    __u64 ts = bpf_ktime_get_ns();
    
    // Store start time
    bpf_map_update_elem(&start_times, &tid, &ts, BPF_ANY);
    
    return 0;
}

SEC("tracepoint/raw_syscalls/sys_exit")
int trace_exit(struct trace_event_raw_sys_exit *ctx) {
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 pid = pid_tgid >> 32;
    __u32 tid = (__u32)pid_tgid;
    __u64 *start_ts, ts, duration;
    
    start_ts = bpf_map_lookup_elem(&start_times, &tid);
    if (!start_ts) {
        return 0;
    }
    
    ts = bpf_ktime_get_ns();
    duration = ts - *start_ts;
    
    // Update histogram
    __u32 bucket = 0;
    if (duration < 1000) bucket = 0;          // < 1μs
    else if (duration < 10000) bucket = 1;    // < 10μs
    else if (duration < 100000) bucket = 2;   // < 100μs
    else if (duration < 1000000) bucket = 3;  // < 1ms
    else if (duration < 10000000) bucket = 4; // < 10ms
    else bucket = 5;                          // >= 10ms
    
    __u64 *count = bpf_map_lookup_elem(&duration_hist, &bucket);
    if (count) {
        __sync_fetch_and_add(count, 1);
    } else {
        __u64 one = 1;
        bpf_map_update_elem(&duration_hist, &bucket, &one, BPF_ANY);
    }
    
    // Send event to userspace
    struct event_data event = {};
    event.pid = pid;
    event.tid = tid;
    event.timestamp = ts;
    event.duration = duration;
    event.cpu = bpf_get_smp_processor_id();
    event.syscall_nr = ctx->id;
    event.retval = ctx->ret;
    
    bpf_get_current_comm(&event.comm, sizeof(event.comm));
    
    bpf_perf_event_output(ctx, &events, BPF_F_CURRENT_CPU, &event, sizeof(event));
    
    // Clean up start time
    bpf_map_delete_elem(&start_times, &tid);
    
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
)";

// Network packet tracing eBPF program
static const char network_tracer_prog[] = R"(
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/tcp.h>
#include <linux/udp.h>
#include <linux/in.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

#define MAX_ENTRIES 10240

struct packet_info {
    __u32 src_ip;
    __u32 dst_ip;
    __u16 src_port;
    __u16 dst_port;
    __u8 protocol;
    __u32 length;
    __u64 timestamp;
};

struct {
    __uint(type, BPF_MAP_TYPE_PERF_EVENT_ARRAY);
    __uint(key_size, sizeof(__u32));
    __uint(value_size, sizeof(__u32));
} packet_events SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __type(key, __u32);
    __type(value, __u64);
    __uint(max_entries, MAX_ENTRIES);
} flow_stats SEC(".maps");

static inline int parse_ipv4(void *data, __u64 nh_off, void *data_end, 
                            struct packet_info *info) {
    struct iphdr *iph = data + nh_off;
    
    if ((void *)(iph + 1) > data_end) {
        return 0;
    }
    
    info->src_ip = bpf_ntohl(iph->saddr);
    info->dst_ip = bpf_ntohl(iph->daddr);
    info->protocol = iph->protocol;
    info->length = bpf_ntohs(iph->tot_len);
    
    return iph->ihl * 4;
}

static inline int parse_tcp(void *data, __u64 nh_off, void *data_end,
                           struct packet_info *info) {
    struct tcphdr *tcph = data + nh_off;
    
    if ((void *)(tcph + 1) > data_end) {
        return 0;
    }
    
    info->src_port = bpf_ntohs(tcph->source);
    info->dst_port = bpf_ntohs(tcph->dest);
    
    return 1;
}

static inline int parse_udp(void *data, __u64 nh_off, void *data_end,
                           struct packet_info *info) {
    struct udphdr *udph = data + nh_off;
    
    if ((void *)(udph + 1) > data_end) {
        return 0;
    }
    
    info->src_port = bpf_ntohs(udph->source);
    info->dst_port = bpf_ntohs(udph->dest);
    
    return 1;
}

SEC("socket")
int socket_filter(struct __sk_buff *skb) {
    void *data_end = (void *)(long)skb->data_end;
    void *data = (void *)(long)skb->data;
    struct ethhdr *eth = data;
    struct packet_info info = {};
    __u64 nh_off;
    int ip_len;
    
    nh_off = sizeof(*eth);
    if (data + nh_off > data_end) {
        return 0;
    }
    
    if (eth->h_proto != bpf_htons(ETH_P_IP)) {
        return 0;
    }
    
    ip_len = parse_ipv4(data, nh_off, data_end, &info);
    if (ip_len == 0) {
        return 0;
    }
    
    nh_off += ip_len;
    
    if (info.protocol == IPPROTO_TCP) {
        parse_tcp(data, nh_off, data_end, &info);
    } else if (info.protocol == IPPROTO_UDP) {
        parse_udp(data, nh_off, data_end, &info);
    }
    
    info.timestamp = bpf_ktime_get_ns();
    
    // Update flow statistics
    __u32 flow_key = info.src_ip ^ info.dst_ip ^ info.src_port ^ info.dst_port;
    __u64 *count = bpf_map_lookup_elem(&flow_stats, &flow_key);
    if (count) {
        __sync_fetch_and_add(count, 1);
    } else {
        __u64 one = 1;
        bpf_map_update_elem(&flow_stats, &flow_key, &one, BPF_ANY);
    }
    
    // Send to userspace
    bpf_perf_event_output(skb, &packet_events, BPF_F_CURRENT_CPU, 
                         &info, sizeof(info));
    
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
)";

// Stack tracing eBPF program
static const char stack_tracer_prog[] = R"(
#include <linux/bpf.h>
#include <linux/ptrace.h>
#include <linux/sched.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

#define TASK_COMM_LEN 16
#define STACK_STORAGE_SIZE 16384

struct stack_trace_key {
    __u32 pid;
    __u32 kernel_stack_id;
    __u32 user_stack_id;
};

struct stack_trace_value {
    __u64 count;
    char comm[TASK_COMM_LEN];
};

struct {
    __uint(type, BPF_MAP_TYPE_STACK_TRACE);
    __uint(key_size, sizeof(__u32));
    __uint(value_size, STACK_STORAGE_SIZE);
    __uint(max_entries, 10000);
} stack_traces SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __type(key, struct stack_trace_key);
    __type(value, struct stack_trace_value);
    __uint(max_entries, 10000);
} counts SEC(".maps");

SEC("perf_event")
int on_perf_event(struct bpf_perf_event_data *ctx) {
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 pid = pid_tgid >> 32;
    __u32 tid = (__u32)pid_tgid;
    
    struct stack_trace_key key = {};
    key.pid = pid;
    key.kernel_stack_id = bpf_get_stackid(ctx, &stack_traces, 0);
    key.user_stack_id = bpf_get_stackid(ctx, &stack_traces, BPF_F_USER_STACK);
    
    struct stack_trace_value *val = bpf_map_lookup_elem(&counts, &key);
    if (val) {
        __sync_fetch_and_add(&val->count, 1);
    } else {
        struct stack_trace_value new_val = {};
        new_val.count = 1;
        bpf_get_current_comm(&new_val.comm, sizeof(new_val.comm));
        bpf_map_update_elem(&counts, &key, &new_val, BPF_ANY);
    }
    
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
)";

// Memory allocation tracking eBPF program
static const char memory_tracer_prog[] = R"(
#include <linux/bpf.h>
#include <linux/ptrace.h>
#include <linux/sched.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

#define TASK_COMM_LEN 16

struct alloc_info {
    __u64 size;
    __u64 timestamp;
    __u32 pid;
    __u32 tid;
    char comm[TASK_COMM_LEN];
    __u32 stack_id;
};

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __type(key, __u64);
    __type(value, struct alloc_info);
    __uint(max_entries, 1000000);
} allocs SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_STACK_TRACE);
    __uint(key_size, sizeof(__u32));
    __uint(value_size, 16384);
    __uint(max_entries, 10000);
} stack_traces SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __type(key, __u32);
    __type(value, __u64);
    __uint(max_entries, 10000);
} stack_counts SEC(".maps");

SEC("uprobe/malloc")
int malloc_enter(struct pt_regs *ctx) {
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 pid = pid_tgid >> 32;
    __u32 tid = (__u32)pid_tgid;
    
    size_t size = PT_REGS_PARM1(ctx);
    
    struct alloc_info info = {};
    info.size = size;
    info.timestamp = bpf_ktime_get_ns();
    info.pid = pid;
    info.tid = tid;
    info.stack_id = bpf_get_stackid(ctx, &stack_traces, BPF_F_USER_STACK);
    
    bpf_get_current_comm(&info.comm, sizeof(info.comm));
    
    // Store allocation info temporarily with TID as key
    bpf_map_update_elem(&allocs, &pid_tgid, &info, BPF_ANY);
    
    return 0;
}

SEC("uretprobe/malloc")
int malloc_exit(struct pt_regs *ctx) {
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    void *ptr = (void *)PT_REGS_RC(ctx);
    
    if (!ptr) {
        return 0;
    }
    
    struct alloc_info *info = bpf_map_lookup_elem(&allocs, &pid_tgid);
    if (!info) {
        return 0;
    }
    
    // Move allocation info to be keyed by pointer
    __u64 ptr_key = (__u64)ptr;
    bpf_map_update_elem(&allocs, &ptr_key, info, BPF_ANY);
    
    // Update stack count
    __u64 *count = bpf_map_lookup_elem(&stack_counts, &info->stack_id);
    if (count) {
        __sync_fetch_and_add(count, 1);
    } else {
        __u64 one = 1;
        bpf_map_update_elem(&stack_counts, &info->stack_id, &one, BPF_ANY);
    }
    
    // Remove temporary entry
    bpf_map_delete_elem(&allocs, &pid_tgid);
    
    return 0;
}

SEC("uprobe/free")
int free_enter(struct pt_regs *ctx) {
    void *ptr = (void *)PT_REGS_PARM1(ctx);
    
    if (!ptr) {
        return 0;
    }
    
    __u64 ptr_key = (__u64)ptr;
    bpf_map_delete_elem(&allocs, &ptr_key);
    
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
)";

// Load eBPF program from string
static int load_ebpf_program(const char *prog_str, const char *prog_name, 
                           struct ebpf_program *prog) {
    struct bpf_object *obj;
    struct bpf_program *bpf_prog;
    int prog_fd;
    
    // Create temporary file for program
    char temp_file[] = "/tmp/ebpf_prog_XXXXXX";
    int fd = mkstemp(temp_file);
    if (fd < 0) {
        perror("mkstemp");
        return -1;
    }
    
    if (write(fd, prog_str, strlen(prog_str)) < 0) {
        perror("write");
        close(fd);
        unlink(temp_file);
        return -1;
    }
    close(fd);
    
    // Load eBPF object
    obj = bpf_object__open(temp_file);
    unlink(temp_file);
    
    if (libbpf_get_error(obj)) {
        fprintf(stderr, "Failed to open eBPF object: %s\n", prog_name);
        return -1;
    }
    
    if (bpf_object__load(obj)) {
        fprintf(stderr, "Failed to load eBPF object: %s\n", prog_name);
        bpf_object__close(obj);
        return -1;
    }
    
    // Find the main program
    bpf_prog = bpf_object__find_program_by_name(obj, prog_name);
    if (!bpf_prog) {
        fprintf(stderr, "Failed to find eBPF program: %s\n", prog_name);
        bpf_object__close(obj);
        return -1;
    }
    
    prog_fd = bpf_program__fd(bpf_prog);
    if (prog_fd < 0) {
        fprintf(stderr, "Failed to get program fd: %s\n", prog_name);
        bpf_object__close(obj);
        return -1;
    }
    
    prog->obj = obj;
    prog->prog = bpf_prog;
    prog->prog_fd = prog_fd;
    prog->loaded = true;
    
    printf("Loaded eBPF program: %s (fd=%d)\n", prog_name, prog_fd);
    return 0;
}

// Event processing callback
static void handle_event(void *ctx, int cpu, void *data, __u32 data_sz) {
    struct event_data *event = data;
    char ts_str[32];
    struct tm *tm_info;
    time_t ts_sec = event->timestamp / 1000000000;
    
    tm_info = localtime(&ts_sec);
    strftime(ts_str, sizeof(ts_str), "%H:%M:%S", tm_info);
    
    printf("[%s.%06llu] CPU:%u PID:%u TID:%u COMM:%-16s SYSCALL:%u RET:%lld DUR:%llu ns\n",
           ts_str, 
           (event->timestamp % 1000000000) / 1000,
           event->cpu,
           event->pid,
           event->tid,
           event->comm,
           event->syscall_nr,
           event->retval,
           event->duration);
}

// Lost events callback
static void handle_lost_events(void *ctx, int cpu, __u64 lost_cnt) {
    printf("Lost %llu events on CPU %d\n", lost_cnt, cpu);
}

// Event processing thread
static void *event_processor_thread(void *arg) {
    struct ebpf_context *ctx = (struct ebpf_context *)arg;
    
    printf("Event processor thread started\n");
    
    while (ctx->running) {
        int ret = perf_buffer__poll(ctx->pb, 100);
        if (ret < 0 && ret != -EINTR) {
            fprintf(stderr, "Error polling perf buffer: %d\n", ret);
            break;
        }
    }
    
    printf("Event processor thread exiting\n");
    return NULL;
}

// Initialize eBPF context
static int init_ebpf_context(void) {
    if (bump_memlock_rlimit()) {
        fprintf(stderr, "Failed to increase RLIMIT_MEMLOCK\n");
        return -1;
    }
    
    ebpf_ctx.running = true;
    ebpf_ctx.program_count = 0;
    
    printf("eBPF context initialized\n");
    return 0;
}

// Load and attach syscall tracer
static int load_syscall_tracer(void) {
    struct ebpf_program *prog = &ebpf_ctx.programs[ebpf_ctx.program_count];
    struct bpf_map *events_map;
    struct perf_buffer_opts pb_opts = {};
    
    prog->name = "syscall_tracer";
    
    if (load_ebpf_program(syscall_tracer_prog, "trace_exit", prog) < 0) {
        return -1;
    }
    
    // Find events map
    events_map = bpf_object__find_map_by_name(prog->obj, "events");
    if (!events_map) {
        fprintf(stderr, "Failed to find events map\n");
        return -1;
    }
    
    prog->map_fd = bpf_map__fd(events_map);
    
    // Attach to tracepoints
    prog->link = bpf_program__attach(prog->prog);
    if (libbpf_get_error(prog->link)) {
        fprintf(stderr, "Failed to attach syscall tracer\n");
        return -1;
    }
    
    prog->attached = true;
    
    // Setup perf buffer for events
    pb_opts.sample_cb = handle_event;
    pb_opts.lost_cb = handle_lost_events;
    
    ebpf_ctx.pb = perf_buffer__new(prog->map_fd, 8, &pb_opts);
    if (libbpf_get_error(ebpf_ctx.pb)) {
        fprintf(stderr, "Failed to create perf buffer\n");
        return -1;
    }
    
    ebpf_ctx.program_count++;
    
    printf("Syscall tracer loaded and attached\n");
    return 0;
}

// Load and attach network tracer
static int load_network_tracer(const char *interface) {
    struct ebpf_program *prog = &ebpf_ctx.programs[ebpf_ctx.program_count];
    int sock_fd;
    
    prog->name = "network_tracer";
    
    if (load_ebpf_program(network_tracer_prog, "socket_filter", prog) < 0) {
        return -1;
    }
    
    // Create raw socket
    sock_fd = open_raw_sock(interface);
    if (sock_fd < 0) {
        return -1;
    }
    
    // Attach to socket
    if (setsockopt(sock_fd, SOL_SOCKET, SO_ATTACH_BPF, &prog->prog_fd, 
                   sizeof(prog->prog_fd)) < 0) {
        perror("setsockopt SO_ATTACH_BPF");
        close(sock_fd);
        return -1;
    }
    
    prog->attached = true;
    ebpf_ctx.program_count++;
    
    printf("Network tracer loaded and attached to %s\n", interface);
    return 0;
}

// Print statistics from eBPF maps
static void print_statistics(void) {
    struct bpf_map *hist_map;
    __u32 key, next_key;
    __u64 value;
    int map_fd;
    
    printf("\n=== Syscall Duration Histogram ===\n");
    
    // Find first program with histogram map
    for (int i = 0; i < ebpf_ctx.program_count; i++) {
        hist_map = bpf_object__find_map_by_name(ebpf_ctx.programs[i].obj, "duration_hist");
        if (hist_map) {
            map_fd = bpf_map__fd(hist_map);
            break;
        }
    }
    
    if (!hist_map) {
        printf("No histogram map found\n");
        return;
    }
    
    const char *buckets[] = {
        "< 1μs", "< 10μs", "< 100μs", "< 1ms", "< 10ms", "≥ 10ms"
    };
    
    key = 0;
    while (bpf_map_get_next_key(map_fd, &key, &next_key) == 0) {
        if (bpf_map_lookup_elem(map_fd, &next_key, &value) == 0) {
            if (next_key < 6) {
                printf("  %-8s: %llu\n", buckets[next_key], value);
            }
        }
        key = next_key;
    }
    
    printf("\n");
}

// Cleanup eBPF resources
static void cleanup_ebpf(void) {
    ebpf_ctx.running = false;
    
    // Wait for event processor thread
    if (ebpf_ctx.event_thread) {
        pthread_join(ebpf_ctx.event_thread, NULL);
    }
    
    // Cleanup perf buffer
    if (ebpf_ctx.pb) {
        perf_buffer__free(ebpf_ctx.pb);
    }
    
    // Cleanup programs
    for (int i = 0; i < ebpf_ctx.program_count; i++) {
        struct ebpf_program *prog = &ebpf_ctx.programs[i];
        
        if (prog->link) {
            bpf_link__destroy(prog->link);
        }
        
        if (prog->obj) {
            bpf_object__close(prog->obj);
        }
    }
    
    printf("eBPF resources cleaned up\n");
}

// Signal handler
static void signal_handler(int sig) {
    printf("\nReceived signal %d, cleaning up...\n", sig);
    cleanup_ebpf();
    exit(0);
}

// Main eBPF tracer function
static int run_ebpf_tracer(int duration_sec, const char *interface) {
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);
    
    printf("Advanced eBPF Tracer starting...\n");
    
    if (init_ebpf_context() < 0) {
        return -1;
    }
    
    // Load tracers
    if (load_syscall_tracer() < 0) {
        cleanup_ebpf();
        return -1;
    }
    
    if (interface && load_network_tracer(interface) < 0) {
        printf("Warning: Failed to load network tracer\n");
    }
    
    // Start event processor thread
    if (pthread_create(&ebpf_ctx.event_thread, NULL, event_processor_thread, &ebpf_ctx) != 0) {
        fprintf(stderr, "Failed to create event processor thread\n");
        cleanup_ebpf();
        return -1;
    }
    
    printf("eBPF tracer running. Press Ctrl+C to stop.\n");
    
    // Run for specified duration or until interrupted
    if (duration_sec > 0) {
        sleep(duration_sec);
        ebpf_ctx.running = false;
    } else {
        while (ebpf_ctx.running) {
            sleep(5);
            print_statistics();
        }
    }
    
    cleanup_ebpf();
    return 0;
}
```

## SystemTap Advanced Scripting Framework

### Comprehensive SystemTap Analysis Scripts

```bash
#!/bin/bash
# systemtap_framework.sh - Advanced SystemTap scripting framework

STAP_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/stap_scripts"
OUTPUT_DIR="/tmp/systemtap_output"
DURATION=${DURATION:-30}

echo "=== Advanced SystemTap Analysis Framework ==="

# Setup environment
setup_systemtap() {
    echo "Setting up SystemTap environment..."
    
    mkdir -p "$STAP_SCRIPT_DIR"
    mkdir -p "$OUTPUT_DIR"
    
    # Check if SystemTap is installed
    if ! command -v stap &> /dev/null; then
        echo "Installing SystemTap..."
        sudo apt-get update
        sudo apt-get install -y systemtap systemtap-sdt-dev
    fi
    
    # Install kernel debug symbols if needed
    if [ ! -d "/usr/lib/debug/boot" ]; then
        echo "Installing kernel debug symbols..."
        sudo apt-get install -y linux-image-$(uname -r)-dbgsym
    fi
    
    echo "SystemTap environment ready"
}

# Create comprehensive system call analyzer
create_syscall_analyzer() {
    cat > "$STAP_SCRIPT_DIR/syscall_analyzer.stp" << 'EOF'
#!/usr/bin/env stap
# Advanced system call analyzer with performance metrics

global syscall_count, syscall_time, syscall_errors
global process_syscalls, process_time
global start_time, total_syscalls
global file_operations, network_operations
global top_processes, top_syscalls

probe begin {
    printf("Advanced SystemCall Analyzer Started\n")
    printf("Timestamp: %s\n", ctime(gettimeofday_s()))
    printf("===========================================\n")
    start_time = gettimeofday_us()
}

# Track syscall entry
probe syscall.* {
    if (target() == 0 || pid() == target()) {
        syscall_start[tid()] = gettimeofday_us()
        process_syscalls[pid(), execname()]++
        total_syscalls++
        
        # Track file operations
        if (name == "open" || name == "openat" || name == "read" || 
            name == "write" || name == "close") {
            file_operations[name]++
        }
        
        # Track network operations  
        if (name == "socket" || name == "bind" || name == "listen" ||
            name == "accept" || name == "connect" || name == "send" ||
            name == "recv" || name == "sendto" || name == "recvfrom") {
            network_operations[name]++
        }
    }
}

# Track syscall return
probe syscall.*.return {
    if (target() == 0 || pid() == target()) {
        if (tid() in syscall_start) {
            elapsed = gettimeofday_us() - syscall_start[tid()]
            delete syscall_start[tid()]
            
            syscall_count[name]++
            syscall_time[name] += elapsed
            process_time[pid(), execname()] += elapsed
            
            # Track errors
            if ($return < 0) {
                syscall_errors[name]++
            }
            
            # Update top lists
            top_syscalls[name] = syscall_count[name]
            top_processes[pid(), execname()] = process_syscalls[pid(), execname()]
        }
    }
}

# Memory allocation tracking
probe process.function("malloc").call {
    if (target() == 0 || pid() == target()) {
        malloc_calls[pid(), execname()]++
        malloc_size[pid(), execname()] += $size
    }
}

probe process.function("free").call {
    if (target() == 0 || pid() == target()) {
        free_calls[pid(), execname()]++
    }
}

# Signal handling
probe signal.send {
    if (target() == 0 || pid() == target() || pid_task == target()) {
        signals_sent[sig_name]++
        signal_senders[pid(), execname()]++
    }
}

# Process lifecycle
probe process.begin {
    if (target() == 0 || pid() == target()) {
        process_starts[pid(), execname()] = gettimeofday_s()
        printf("Process started: PID=%d COMM=%s\n", pid(), execname())
    }
}

probe process.end {
    if (target() == 0 || pid() == target()) {
        if ([pid(), execname()] in process_starts) {
            lifetime = gettimeofday_s() - process_starts[pid(), execname()]
            printf("Process ended: PID=%d COMM=%s LIFETIME=%ds\n", 
                   pid(), execname(), lifetime)
            delete process_starts[pid(), execname()]
        }
    }
}

# Periodic reporting
probe timer.s(10) {
    printf("\n=== 10-Second Summary ===\n")
    printf("Total syscalls: %d\n", total_syscalls)
    printf("Rate: %.1f syscalls/sec\n", 
           total_syscalls * 1000000.0 / (gettimeofday_us() - start_time))
    
    printf("\nTop 5 Syscalls by Count:\n")
    foreach ([syscall] in top_syscalls- limit 5) {
        avg_time = (syscall_count[syscall] > 0) ? 
                   syscall_time[syscall] / syscall_count[syscall] : 0
        error_rate = (syscall_count[syscall] > 0) ?
                     syscall_errors[syscall] * 100.0 / syscall_count[syscall] : 0
        printf("  %-20s: %8d calls, %6.1fμs avg, %5.1f%% errors\n",
               syscall, syscall_count[syscall], avg_time, error_rate)
    }
    printf("\n")
}

probe end {
    elapsed_time = (gettimeofday_us() - start_time) / 1000000.0
    
    printf("\n=== Final Report ===\n")
    printf("Runtime: %.1f seconds\n", elapsed_time)
    printf("Total syscalls: %d\n", total_syscalls)
    printf("Average rate: %.1f syscalls/sec\n", total_syscalls / elapsed_time)
    
    printf("\n=== System Call Statistics ===\n")
    printf("%-20s %10s %12s %10s %8s\n", 
           "SYSCALL", "COUNT", "TOTAL_TIME", "AVG_TIME", "ERRORS")
    printf("%s\n", sprintf("%*s", 70, "="))
    
    foreach ([syscall] in syscall_count- limit 20) {
        avg_time = syscall_time[syscall] / syscall_count[syscall]
        printf("%-20s %10d %10dμs %8.1fμs %8d\n",
               syscall, syscall_count[syscall], syscall_time[syscall],
               avg_time, syscall_errors[syscall])
    }
    
    printf("\n=== Process Activity ===\n")
    printf("%-8s %-20s %10s %12s\n", "PID", "COMMAND", "SYSCALLS", "TIME(μs)")
    printf("%s\n", sprintf("%*s", 50, "="))
    
    foreach ([pid, comm] in process_syscalls- limit 15) {
        printf("%-8d %-20s %10d %12d\n",
               pid, comm, process_syscalls[pid, comm], process_time[pid, comm])
    }
    
    if (total_syscalls > 0) {
        printf("\n=== File Operations ===\n")
        foreach ([op] in file_operations-) {
            printf("%-15s: %d\n", op, file_operations[op])
        }
        
        printf("\n=== Network Operations ===\n")
        foreach ([op] in network_operations-) {
            printf("%-15s: %d\n", op, network_operations[op])
        }
    }
}
EOF
}

# Create memory analysis script
create_memory_analyzer() {
    cat > "$STAP_SCRIPT_DIR/memory_analyzer.stp" << 'EOF'
#!/usr/bin/env stap
# Advanced memory allocation and usage analyzer

global malloc_sizes, malloc_count, free_count
global allocation_stacks, large_allocs
global process_memory, peak_memory
global memory_leaks, allocation_times
global brk_calls, mmap_calls
global total_allocated, total_freed

probe begin {
    printf("Advanced Memory Analyzer Started\n")
    printf("Tracking malloc/free, mmap/munmap, brk/sbrk\n")
    printf("=========================================\n")
}

# Track malloc/calloc/realloc
probe process.function("malloc").call {
    if (target() == 0 || pid() == target()) {
        size = $size
        stack = sprint_ustack(ubacktrace())
        allocation_stacks[tid()] = stack
        malloc_sizes[tid()] = size
        allocation_times[tid()] = gettimeofday_us()
        
        process_memory[pid(), execname()] += size
        total_allocated += size
        malloc_count[pid(), execname()]++
        
        if (size > 1024*1024) {  # > 1MB
            printf("Large allocation: PID=%d SIZE=%d COMM=%s\n",
                   pid(), size, execname())
            large_allocs[pid(), size, gettimeofday_s()]++
        }
        
        # Track peak memory per process
        if (process_memory[pid(), execname()] > peak_memory[pid(), execname()]) {
            peak_memory[pid(), execname()] = process_memory[pid(), execname()]
        }
    }
}

probe process.function("malloc").return {
    if (target() == 0 || pid() == target()) {
        if (tid() in malloc_sizes && $return != 0) {
            ptr = $return
            size = malloc_sizes[tid()]
            stack = allocation_stacks[tid()]
            alloc_time = allocation_times[tid()]
            
            # Store allocation info
            allocations[ptr] = sprintf("%d:%s:%d:%s", 
                                     pid(), execname(), size, stack)
            alloc_timestamps[ptr] = alloc_time
            
            delete malloc_sizes[tid()]
            delete allocation_stacks[tid()]
            delete allocation_times[tid()]
        }
    }
}

probe process.function("free").call {
    if (target() == 0 || pid() == target()) {
        ptr = $ptr
        if (ptr in allocations) {
            # Parse allocation info
            info = allocations[ptr]
            split_info = strtok(info, ":")
            alloc_pid = strtol(split_info[1], 10)
            alloc_comm = split_info[2]
            alloc_size = strtol(split_info[3], 10)
            
            process_memory[alloc_pid, alloc_comm] -= alloc_size
            total_freed += alloc_size
            free_count[pid(), execname()]++
            
            # Calculate allocation lifetime
            if (ptr in alloc_timestamps) {
                lifetime = gettimeofday_us() - alloc_timestamps[ptr]
                if (lifetime > 1000000) {  # > 1 second
                    printf("Long-lived allocation freed: SIZE=%d LIFETIME=%dμs\n",
                           alloc_size, lifetime)
                }
                delete alloc_timestamps[ptr]
            }
            
            delete allocations[ptr]
        }
    }
}

# Track mmap/munmap
probe syscall.mmap*, syscall.mmap2* {
    if (target() == 0 || pid() == target()) {
        mmap_calls[pid(), execname()]++
        if ($length > 0) {
            process_memory[pid(), execname()] += $length
            total_allocated += $length
        }
    }
}

probe syscall.munmap {
    if (target() == 0 || pid() == target()) {
        if ($length > 0) {
            process_memory[pid(), execname()] -= $length
            total_freed += $length
        }
    }
}

# Track brk/sbrk
probe syscall.brk {
    if (target() == 0 || pid() == target()) {
        brk_calls[pid(), execname()]++
    }
}

# Page fault tracking
probe vm.pagefault {
    if (target() == 0 || pid() == target()) {
        page_faults[pid(), execname()]++
        if (write_access) {
            write_faults[pid(), execname()]++
        }
    }
}

# Periodic memory leak detection
probe timer.s(30) {
    printf("\n=== Memory Leak Detection ===\n")
    leak_count = 0
    
    foreach (ptr in allocations) {
        if (ptr in alloc_timestamps) {
            lifetime = gettimeofday_us() - alloc_timestamps[ptr]
            if (lifetime > 30000000) {  # > 30 seconds
                info = allocations[ptr]
                split_info = strtok(info, ":")
                size = strtol(split_info[3], 10)
                
                printf("Potential leak: PTR=0x%x SIZE=%d LIFETIME=%.1fs\n",
                       ptr, size, lifetime / 1000000.0)
                leak_count++
                
                if (leak_count >= 10) break  # Limit output
            }
        }
    }
    
    if (leak_count == 0) {
        printf("No potential memory leaks detected\n")
    }
}

probe end {
    printf("\n=== Memory Analysis Report ===\n")
    printf("Total allocated: %d bytes (%.1f MB)\n", 
           total_allocated, total_allocated / 1024.0 / 1024.0)
    printf("Total freed: %d bytes (%.1f MB)\n",
           total_freed, total_freed / 1024.0 / 1024.0)
    printf("Net difference: %d bytes (%.1f MB)\n",
           total_allocated - total_freed, 
           (total_allocated - total_freed) / 1024.0 / 1024.0)
    
    printf("\n=== Per-Process Memory Usage ===\n")
    printf("%-8s %-20s %12s %12s %10s %10s\n",
           "PID", "COMMAND", "MALLOC", "FREE", "PEAK_MB", "CURRENT_MB")
    printf("%s\n", sprintf("%*s", 80, "="))
    
    foreach ([pid, comm] in malloc_count-) {
        current_mb = process_memory[pid, comm] / 1024.0 / 1024.0
        peak_mb = peak_memory[pid, comm] / 1024.0 / 1024.0
        
        printf("%-8d %-20s %12d %12d %10.1f %10.1f\n",
               pid, comm, malloc_count[pid, comm], free_count[pid, comm],
               peak_mb, current_mb)
    }
    
    if (total_syscalls > 0) {
        printf("\n=== Memory Operations Summary ===\n")
        foreach ([pid, comm] in mmap_calls-) {
            printf("%-20s: mmap=%d brk=%d page_faults=%d\n",
                   comm, mmap_calls[pid, comm], brk_calls[pid, comm],
                   page_faults[pid, comm])
        }
    }
    
    printf("\n=== Large Allocations (>1MB) ===\n")
    if (@count(large_allocs) > 0) {
        foreach ([pid, size, time] in large_allocs-) {
            printf("PID=%d SIZE=%.1fMB TIME=%s\n",
                   pid, size / 1024.0 / 1024.0, ctime(time))
        }
    } else {
        printf("No large allocations detected\n")
    }
}
EOF
}

# Create I/O performance analyzer
create_io_analyzer() {
    cat > "$STAP_SCRIPT_DIR/io_analyzer.stp" << 'EOF'
#!/usr/bin/env stap
# Advanced I/O performance analyzer

global read_bytes, write_bytes, read_count, write_count
global io_latency, io_start_time
global file_access, process_io
global slow_io, io_errors
global block_io_stats, filesystem_stats

probe begin {
    printf("Advanced I/O Performance Analyzer Started\n")
    printf("Tracking file I/O, block I/O, and network I/O\n")
    printf("============================================\n")
}

# File I/O tracking
probe syscall.read {
    if (target() == 0 || pid() == target()) {
        io_start_time[tid()] = gettimeofday_us()
    }
}

probe syscall.read.return {
    if (target() == 0 || pid() == target()) {
        if (tid() in io_start_time) {
            latency = gettimeofday_us() - io_start_time[tid()]
            delete io_start_time[tid()]
            
            if ($return > 0) {
                read_bytes[pid(), execname()] += $return
                read_count[pid(), execname()]++
                io_latency["read"] += latency
                process_io[pid(), execname(), "read_bytes"] += $return
                
                if (latency > 10000) {  # > 10ms
                    slow_io["read"]++
                    printf("Slow read: PID=%d LATENCY=%dμs BYTES=%d FILE=%s\n",
                           pid(), latency, $return, 
                           @defined($fd) ? d_name(task_fd_path(task_current(), $fd)) : "unknown")
                }
            } else if ($return < 0) {
                io_errors["read"]++
            }
        }
    }
}

probe syscall.write {
    if (target() == 0 || pid() == target()) {
        io_start_time[tid()] = gettimeofday_us()
    }
}

probe syscall.write.return {
    if (target() == 0 || pid() == target()) {
        if (tid() in io_start_time) {
            latency = gettimeofday_us() - io_start_time[tid()]
            delete io_start_time[tid()]
            
            if ($return > 0) {
                write_bytes[pid(), execname()] += $return
                write_count[pid(), execname()]++
                io_latency["write"] += latency
                process_io[pid(), execname(), "write_bytes"] += $return
                
                if (latency > 10000) {  # > 10ms
                    slow_io["write"]++
                    printf("Slow write: PID=%d LATENCY=%dμs BYTES=%d\n",
                           pid(), latency, $return)
                }
            } else if ($return < 0) {
                io_errors["write"]++
            }
        }
    }
}

# Block I/O tracking
probe ioblock.request {
    if (target() == 0 || devname != "") {
        block_io_start[bio] = gettimeofday_us()
        block_io_stats[devname, rw == 1 ? "write" : "read", "count"]++
        block_io_stats[devname, rw == 1 ? "write" : "read", "bytes"] += size
    }
}

probe ioblock.end {
    if (bio in block_io_start) {
        latency = gettimeofday_us() - block_io_start[bio]
        delete block_io_start[bio]
        
        block_io_stats[devname, "latency"] += latency
        
        if (latency > 50000) {  # > 50ms
            printf("Slow block I/O: DEV=%s OP=%s LATENCY=%dμs SIZE=%d\n",
                   devname, rw == 1 ? "write" : "read", latency, size)
        }
    }
}

# Filesystem operation tracking
probe vfs.read {
    filesystem_stats[file_pathname, "read_ops"]++
}

probe vfs.write {
    filesystem_stats[file_pathname, "write_ops"]++
}

probe vfs.open {
    file_access[file_pathname]++
    filesystem_stats[file_pathname, "open_ops"]++
}

# Network I/O tracking
probe syscall.send*, syscall.sendto* {
    if (target() == 0 || pid() == target()) {
        network_start[tid()] = gettimeofday_us()
    }
}

probe syscall.send*.return, syscall.sendto*.return {
    if (target() == 0 || pid() == target()) {
        if (tid() in network_start) {
            latency = gettimeofday_us() - network_start[tid()]
            delete network_start[tid()]
            
            if ($return > 0) {
                process_io[pid(), execname(), "net_send"] += $return
                if (latency > 5000) {  # > 5ms
                    printf("Slow network send: PID=%d LATENCY=%dμs BYTES=%d\n",
                           pid(), latency, $return)
                }
            }
        }
    }
}

probe syscall.recv*, syscall.recvfrom* {
    if (target() == 0 || pid() == target()) {
        network_start[tid()] = gettimeofday_us()
    }
}

probe syscall.recv*.return, syscall.recvfrom*.return {
    if (target() == 0 || pid() == target()) {
        if (tid() in network_start) {
            latency = gettimeofday_us() - network_start[tid()]
            delete network_start[tid()]
            
            if ($return > 0) {
                process_io[pid(), execname(), "net_recv"] += $return
            }
        }
    }
}

probe timer.s(15) {
    printf("\n=== I/O Performance Summary (15s) ===\n")
    
    total_read = 0
    total_write = 0
    
    foreach ([pid, comm] in read_bytes) {
        total_read += read_bytes[pid, comm]
    }
    
    foreach ([pid, comm] in write_bytes) {
        total_write += write_bytes[pid, comm]
    }
    
    printf("Total read: %.1f MB, Total write: %.1f MB\n",
           total_read / 1024.0 / 1024.0, total_write / 1024.0 / 1024.0)
    
    if (@count(slow_io) > 0) {
        printf("Slow I/O operations: read=%d write=%d\n",
               slow_io["read"], slow_io["write"])
    }
}

probe end {
    printf("\n=== I/O Analysis Report ===\n")
    
    printf("\n=== Per-Process I/O Statistics ===\n")
    printf("%-8s %-20s %12s %12s %10s %10s\n",
           "PID", "COMMAND", "READ_BYTES", "WRITE_BYTES", "READ_OPS", "WRITE_OPS")
    printf("%s\n", sprintf("%*s", 80, "="))
    
    foreach ([pid, comm] in read_bytes) {
        read_mb = read_bytes[pid, comm] / 1024.0 / 1024.0
        write_mb = write_bytes[pid, comm] / 1024.0 / 1024.0
        
        printf("%-8d %-20s %10.1fMB %10.1fMB %10d %10d\n",
               pid, comm, read_mb, write_mb,
               read_count[pid, comm], write_count[pid, comm])
    }
    
    if (@count(file_access) > 0) {
        printf("\n=== Most Accessed Files ===\n")
        count = 0
        foreach ([file] in file_access- limit 20) {
            printf("%-60s: %d\n", file, file_access[file])
            count++
        }
    }
    
    if (@count(block_io_stats) > 0) {
        printf("\n=== Block Device Statistics ===\n")
        foreach ([dev, op, metric] in block_io_stats) {
            if (metric == "bytes") {
                printf("%-20s %-10s: %.1f MB\n", 
                       dev, op, block_io_stats[dev, op, metric] / 1024.0 / 1024.0)
            } else if (metric == "count") {
                printf("%-20s %-10s: %d operations\n",
                       dev, op, block_io_stats[dev, op, metric])
            }
        }
    }
    
    printf("\n=== I/O Error Summary ===\n")
    printf("Read errors: %d\n", io_errors["read"])
    printf("Write errors: %d\n", io_errors["write"])
    printf("Slow read operations: %d\n", slow_io["read"])
    printf("Slow write operations: %d\n", slow_io["write"])
}
EOF
}

# Create network traffic analyzer
create_network_analyzer() {
    cat > "$STAP_SCRIPT_DIR/network_analyzer.stp" << 'EOF'
#!/usr/bin/env stap
# Advanced network traffic analyzer

global connections, connection_stats
global tcp_states, udp_traffic
global network_bytes, network_packets
global slow_connections, connection_errors
global port_activity, protocol_stats

probe begin {
    printf("Advanced Network Traffic Analyzer Started\n")
    printf("Tracking TCP/UDP connections and traffic\n")
    printf("======================================\n")
}

# TCP connection tracking
probe tcp.connect {
    if (target() == 0 || pid() == target()) {
        conn_key = sprintf("%s:%d->%s:%d", saddr, sport, daddr, dport)
        connections[conn_key] = gettimeofday_s()
        connection_stats[pid(), execname(), "tcp_connects"]++
        
        printf("TCP connect: PID=%d %s\n", pid(), conn_key)
    }
}

probe tcp.disconnect {
    if (target() == 0 || pid() == target()) {
        conn_key = sprintf("%s:%d->%s:%d", saddr, sport, daddr, dport)
        
        if (conn_key in connections) {
            duration = gettimeofday_s() - connections[conn_key]
            printf("TCP disconnect: PID=%d %s DURATION=%ds\n", 
                   pid(), conn_key, duration)
            delete connections[conn_key]
        }
        
        connection_stats[pid(), execname(), "tcp_disconnects"]++
    }
}

# TCP state changes
probe tcp.state.change {
    tcp_states[new_state]++
    
    if (new_state == 1) {  # ESTABLISHED
        port_activity[dport, "tcp"]++
    }
}

# Data transmission tracking
probe tcp.sendmsg {
    if (target() == 0 || pid() == target()) {
        network_bytes[pid(), execname(), "tcp_send"] += size
        network_packets[pid(), execname(), "tcp_send"]++
        protocol_stats["tcp_bytes"] += size
        
        if (size > 64*1024) {  # Large send
            printf("Large TCP send: PID=%d SIZE=%d\n", pid(), size)
        }
    }
}

probe tcp.recvmsg {
    if (target() == 0 || pid() == target()) {
        network_bytes[pid(), execname(), "tcp_recv"] += size
        network_packets[pid(), execname(), "tcp_recv"]++
        protocol_stats["tcp_bytes"] += size
    }
}

# UDP traffic tracking
probe udp.sendmsg {
    if (target() == 0 || pid() == target()) {
        network_bytes[pid(), execname(), "udp_send"] += size
        network_packets[pid(), execname(), "udp_send"]++
        protocol_stats["udp_bytes"] += size
        udp_traffic[dport]++
        port_activity[dport, "udp"]++
    }
}

probe udp.recvmsg {
    if (target() == 0 || pid() == target()) {
        network_bytes[pid(), execname(), "udp_recv"] += size
        network_packets[pid(), execname(), "udp_recv"]++
        protocol_stats["udp_bytes"] += size
    }
}

# Socket operations
probe syscall.socket {
    if (target() == 0 || pid() == target()) {
        socket_creates[pid(), execname()]++
        
        family_name = ""
        if ($family == 2) family_name = "IPv4"
        else if ($family == 10) family_name = "IPv6"
        else if ($family == 1) family_name = "Unix"
        
        type_name = ""
        if ($type == 1) type_name = "TCP"
        else if ($type == 2) type_name = "UDP"
        
        if (family_name != "" && type_name != "") {
            socket_types[family_name, type_name]++
        }
    }
}

probe syscall.bind {
    if (target() == 0 || pid() == target()) {
        bind_calls[pid(), execname()]++
    }
}

probe syscall.listen {
    if (target() == 0 || pid() == target()) {
        listen_calls[pid(), execname()]++
        printf("Process listening: PID=%d COMM=%s\n", pid(), execname())
    }
}

probe syscall.accept*, syscall.accept4* {
    if (target() == 0 || pid() == target()) {
        accept_start[tid()] = gettimeofday_us()
    }
}

probe syscall.accept*.return, syscall.accept4*.return {
    if (target() == 0 || pid() == target()) {
        if (tid() in accept_start) {
            latency = gettimeofday_us() - accept_start[tid()]
            delete accept_start[tid()]
            
            if ($return >= 0) {
                accept_calls[pid(), execname()]++
                if (latency > 1000000) {  # > 1 second
                    slow_connections["accept"]++
                    printf("Slow accept: PID=%d LATENCY=%dμs\n", pid(), latency)
                }
            } else {
                connection_errors["accept"]++
            }
        }
    }
}

# DNS resolution tracking
probe process.function("gethostbyname*").call {
    if (target() == 0 || pid() == target()) {
        dns_start[tid()] = gettimeofday_us()
        dns_queries[pid(), execname()]++
    }
}

probe process.function("gethostbyname*").return {
    if (target() == 0 || pid() == target()) {
        if (tid() in dns_start) {
            latency = gettimeofday_us() - dns_start[tid()]
            delete dns_start[tid()]
            
            if (latency > 5000000) {  # > 5 seconds
                printf("Slow DNS query: PID=%d LATENCY=%.1fs\n", 
                       pid(), latency / 1000000.0)
                slow_connections["dns"]++
            }
        }
    }
}

probe timer.s(20) {
    printf("\n=== Network Activity Summary (20s) ===\n")
    
    total_tcp = protocol_stats["tcp_bytes"]
    total_udp = protocol_stats["udp_bytes"]
    
    printf("TCP traffic: %.1f MB\n", total_tcp / 1024.0 / 1024.0)
    printf("UDP traffic: %.1f MB\n", total_udp / 1024.0 / 1024.0)
    
    printf("Active TCP states:\n")
    foreach ([state] in tcp_states) {
        state_name = ""
        if (state == 1) state_name = "ESTABLISHED"
        else if (state == 2) state_name = "SYN_SENT"
        else if (state == 3) state_name = "SYN_RECV"
        else if (state == 10) state_name = "LISTEN"
        else state_name = sprintf("STATE_%d", state)
        
        printf("  %s: %d\n", state_name, tcp_states[state])
    }
}

probe end {
    printf("\n=== Network Analysis Report ===\n")
    
    printf("\n=== Per-Process Network Usage ===\n")
    printf("%-8s %-20s %12s %12s %10s %10s\n",
           "PID", "COMMAND", "TCP_SEND", "TCP_RECV", "UDP_SEND", "UDP_RECV")
    printf("%s\n", sprintf("%*s", 80, "="))
    
    foreach ([pid, comm, direction] in network_bytes) {
        if (direction == "tcp_send") {
            tcp_send_mb = network_bytes[pid, comm, direction] / 1024.0 / 1024.0
            tcp_recv_mb = network_bytes[pid, comm, "tcp_recv"] / 1024.0 / 1024.0
            udp_send_mb = network_bytes[pid, comm, "udp_send"] / 1024.0 / 1024.0
            udp_recv_mb = network_bytes[pid, comm, "udp_recv"] / 1024.0 / 1024.0
            
            printf("%-8d %-20s %10.1fMB %10.1fMB %8.1fMB %8.1fMB\n",
                   pid, comm, tcp_send_mb, tcp_recv_mb, udp_send_mb, udp_recv_mb)
        }
    }
    
    printf("\n=== Socket Operations ===\n")
    foreach ([pid, comm] in socket_creates) {
        printf("%-20s: creates=%d binds=%d listens=%d accepts=%d dns=%d\n",
               comm, socket_creates[pid, comm], bind_calls[pid, comm],
               listen_calls[pid, comm], accept_calls[pid, comm],
               dns_queries[pid, comm])
    }
    
    printf("\n=== Port Activity ===\n")
    count = 0
    foreach ([port, proto] in port_activity- limit 20) {
        printf("Port %d/%s: %d connections\n", port, proto, port_activity[port, proto])
        count++
    }
    
    printf("\n=== Protocol Statistics ===\n")
    printf("Total TCP bytes: %.1f MB\n", protocol_stats["tcp_bytes"] / 1024.0 / 1024.0)
    printf("Total UDP bytes: %.1f MB\n", protocol_stats["udp_bytes"] / 1024.0 / 1024.0)
    
    if (@count(socket_types) > 0) {
        printf("\nSocket types created:\n")
        foreach ([family, type] in socket_types) {
            printf("  %s/%s: %d\n", family, type, socket_types[family, type])
        }
    }
    
    printf("\n=== Performance Issues ===\n")
    printf("Slow accepts: %d\n", slow_connections["accept"])
    printf("Slow DNS queries: %d\n", slow_connections["dns"])
    printf("Accept errors: %d\n", connection_errors["accept"])
}
EOF
}

# Run SystemTap analysis
run_systemtap_analysis() {
    local script_name=$1
    local duration=${2:-$DURATION}
    local target_pid=${3:-0}
    local output_file="$OUTPUT_DIR/systemtap_${script_name}_$(date +%Y%m%d_%H%M%S).txt"
    
    echo "Running SystemTap analysis: $script_name"
    echo "Duration: ${duration}s"
    echo "Output: $output_file"
    
    local stap_args=""
    if [ "$target_pid" != "0" ]; then
        stap_args="-x $target_pid"
    fi
    
    # Run SystemTap with timeout
    timeout ${duration}s sudo stap $stap_args "$STAP_SCRIPT_DIR/${script_name}.stp" 2>&1 | tee "$output_file"
    
    echo "Analysis completed. Output saved to: $output_file"
}

# Main execution
main() {
    case "${1:-help}" in
        setup)
            setup_systemtap
            ;;
        create-scripts)
            setup_systemtap
            create_syscall_analyzer
            create_memory_analyzer
            create_io_analyzer
            create_network_analyzer
            echo "SystemTap scripts created in: $STAP_SCRIPT_DIR"
            ;;
        syscall)
            run_systemtap_analysis "syscall_analyzer" "$2" "$3"
            ;;
        memory)
            run_systemtap_analysis "memory_analyzer" "$2" "$3"
            ;;
        io)
            run_systemtap_analysis "io_analyzer" "$2" "$3"
            ;;
        network)
            run_systemtap_analysis "network_analyzer" "$2" "$3"
            ;;
        all)
            setup_systemtap
            create_syscall_analyzer
            create_memory_analyzer
            create_io_analyzer
            create_network_analyzer
            
            echo "Running comprehensive SystemTap analysis..."
            run_systemtap_analysis "syscall_analyzer" 30 &
            run_systemtap_analysis "memory_analyzer" 30 &
            run_systemtap_analysis "io_analyzer" 30 &
            run_systemtap_analysis "network_analyzer" 30 &
            
            wait
            echo "All analyses completed"
            ;;
        *)
            echo "Usage: $0 {setup|create-scripts|syscall|memory|io|network|all} [duration] [pid]"
            echo ""
            echo "Commands:"
            echo "  setup          - Install SystemTap and dependencies"
            echo "  create-scripts - Generate SystemTap analysis scripts"
            echo "  syscall        - Run system call analysis"
            echo "  memory         - Run memory allocation analysis"
            echo "  io             - Run I/O performance analysis"
            echo "  network        - Run network traffic analysis"
            echo "  all            - Run all analyses concurrently"
            echo ""
            echo "Parameters:"
            echo "  duration       - Analysis duration in seconds (default: 30)"
            echo "  pid            - Target process PID (0 for system-wide)"
            ;;
    esac
}

main "$@"
```

## Ftrace and Perf Integration Framework

### Advanced Performance Analysis Toolkit

```bash
#!/bin/bash
# performance_analysis_toolkit.sh - Comprehensive performance analysis using ftrace and perf

ANALYSIS_DIR="/tmp/performance_analysis"
TRACE_DIR="/sys/kernel/debug/tracing"
DURATION=${DURATION:-30}

echo "=== Advanced Performance Analysis Toolkit ==="

# Setup environment
setup_environment() {
    echo "Setting up performance analysis environment..."
    
    mkdir -p "$ANALYSIS_DIR"
    
    # Check if debugfs is mounted
    if [ ! -d "$TRACE_DIR" ]; then
        echo "Mounting debugfs..."
        sudo mount -t debugfs debugfs /sys/kernel/debug
    fi
    
    # Install perf tools if needed
    if ! command -v perf &> /dev/null; then
        echo "Installing perf tools..."
        sudo apt-get update
        sudo apt-get install -y linux-tools-$(uname -r) linux-tools-generic
    fi
    
    # Enable ftrace
    echo "Enabling ftrace..."
    sudo sh -c 'echo 0 > /sys/kernel/debug/tracing/tracing_on'
    sudo sh -c 'echo > /sys/kernel/debug/tracing/trace'
    
    echo "Environment setup completed"
}

# Function tracing with ftrace
function_tracing() {
    local duration=${1:-30}
    local function_pattern=${2:-"*"}
    local output_file="$ANALYSIS_DIR/function_trace_$(date +%Y%m%d_%H%M%S).txt"
    
    echo "Starting function tracing for ${duration}s..."
    echo "Pattern: $function_pattern"
    echo "Output: $output_file"
    
    # Configure ftrace
    sudo sh -c 'echo function > /sys/kernel/debug/tracing/current_tracer'
    sudo sh -c "echo '$function_pattern' > /sys/kernel/debug/tracing/set_ftrace_filter"
    sudo sh -c 'echo 1 > /sys/kernel/debug/tracing/tracing_on'
    
    # Collect trace data
    sleep "$duration"
    
    # Stop tracing and save results
    sudo sh -c 'echo 0 > /sys/kernel/debug/tracing/tracing_on'
    sudo cat /sys/kernel/debug/tracing/trace > "$output_file"
    
    # Analyze results
    echo "Function trace analysis:"
    echo "========================"
    echo "Top 20 most called functions:"
    grep -o '[a-zA-Z_][a-zA-Z0-9_]*' "$output_file" | sort | uniq -c | sort -nr | head -20
    
    echo "Trace saved to: $output_file"
}

# Advanced perf profiling
advanced_perf_profiling() {
    local duration=${1:-30}
    local pid=${2:-""}
    local output_prefix="$ANALYSIS_DIR/perf_$(date +%Y%m%d_%H%M%S)"
    
    echo "Starting advanced perf profiling for ${duration}s..."
    
    local perf_args=""
    if [ -n "$pid" ]; then
        perf_args="-p $pid"
        echo "Target PID: $pid"
    else
        echo "System-wide profiling"
    fi
    
    # CPU profiling
    echo "Running CPU profiling..."
    sudo perf record -g -F 997 $perf_args -o "${output_prefix}_cpu.data" -- sleep "$duration" &
    CPU_PID=$!
    
    # Memory profiling
    echo "Running memory profiling..."
    sudo perf record -e cache-misses,cache-references,page-faults $perf_args -o "${output_prefix}_memory.data" -- sleep "$duration" &
    MEM_PID=$!
    
    # I/O profiling
    echo "Running I/O profiling..."
    sudo perf record -e block:block_rq_issue,block:block_rq_complete $perf_args -o "${output_prefix}_io.data" -- sleep "$duration" &
    IO_PID=$!
    
    # Branch prediction profiling
    echo "Running branch prediction profiling..."
    sudo perf record -e branches,branch-misses $perf_args -o "${output_prefix}_branches.data" -- sleep "$duration" &
    BRANCH_PID=$!
    
    # Wait for all profiling to complete
    wait $CPU_PID $MEM_PID $IO_PID $BRANCH_PID
    
    # Generate reports
    echo "Generating analysis reports..."
    
    # CPU hotspots
    echo "=== CPU Hotspots ===" > "${output_prefix}_report.txt"
    sudo perf report -i "${output_prefix}_cpu.data" --stdio | head -50 >> "${output_prefix}_report.txt"
    
    # Memory statistics
    echo -e "\n=== Memory Statistics ===" >> "${output_prefix}_report.txt"
    sudo perf report -i "${output_prefix}_memory.data" --stdio | head -30 >> "${output_prefix}_report.txt"
    
    # I/O statistics
    echo -e "\n=== I/O Statistics ===" >> "${output_prefix}_report.txt"
    sudo perf report -i "${output_prefix}_io.data" --stdio | head -30 >> "${output_prefix}_report.txt"
    
    # Branch prediction
    echo -e "\n=== Branch Prediction ===" >> "${output_prefix}_report.txt"
    sudo perf report -i "${output_prefix}_branches.data" --stdio | head -30 >> "${output_prefix}_report.txt"
    
    # Generate flame graph if available
    if command -v stackcollapse-perf.pl &> /dev/null && command -v flamegraph.pl &> /dev/null; then
        echo "Generating flame graph..."
        sudo perf script -i "${output_prefix}_cpu.data" | stackcollapse-perf.pl | flamegraph.pl > "${output_prefix}_flamegraph.svg"
        echo "Flame graph saved to: ${output_prefix}_flamegraph.svg"
    fi
    
    echo "Perf analysis completed. Report saved to: ${output_prefix}_report.txt"
}

# Event-based tracing
event_tracing() {
    local duration=${1:-30}
    local events=${2:-"syscalls:sys_enter_*,syscalls:sys_exit_*"}
    local output_file="$ANALYSIS_DIR/event_trace_$(date +%Y%m%d_%H%M%S).txt"
    
    echo "Starting event tracing for ${duration}s..."
    echo "Events: $events"
    echo "Output: $output_file"
    
    # Configure event tracing
    sudo sh -c 'echo nop > /sys/kernel/debug/tracing/current_tracer'
    sudo sh -c 'echo > /sys/kernel/debug/tracing/set_event'
    
    # Enable specific events
    IFS=',' read -ra EVENT_ARRAY <<< "$events"
    for event in "${EVENT_ARRAY[@]}"; do
        echo "Enabling event: $event"
        sudo sh -c "echo '$event' >> /sys/kernel/debug/tracing/set_event"
    done
    
    # Start tracing
    sudo sh -c 'echo 1 > /sys/kernel/debug/tracing/tracing_on'
    
    # Collect data
    sleep "$duration"
    
    # Stop tracing and save results
    sudo sh -c 'echo 0 > /sys/kernel/debug/tracing/tracing_on'
    sudo cat /sys/kernel/debug/tracing/trace > "$output_file"
    
    # Analyze events
    echo "Event analysis:"
    echo "==============="
    echo "Event counts:"
    grep -o 'sys_enter_[a-z]*\|sys_exit_[a-z]*' "$output_file" | sort | uniq -c | sort -nr | head -20
    
    echo "Event trace saved to: $output_file"
}

# Latency analysis
latency_analysis() {
    local duration=${1:-30}
    local output_file="$ANALYSIS_DIR/latency_analysis_$(date +%Y%m%d_%H%M%S).txt"
    
    echo "Starting latency analysis for ${duration}s..."
    echo "Output: $output_file"
    
    {
        echo "=== Latency Analysis Report ==="
        echo "Generated: $(date)"
        echo "Duration: ${duration}s"
        echo ""
        
        # Scheduling latency
        echo "=== Scheduling Latency ==="
        sudo perf sched record -o /tmp/sched.data -- sleep "$duration" 2>/dev/null
        sudo perf sched latency -i /tmp/sched.data | head -20
        echo ""
        
        # Interrupt latency
        echo "=== Interrupt Latency ==="
        sudo sh -c 'echo irqsoff > /sys/kernel/debug/tracing/current_tracer'
        sudo sh -c 'echo 1 > /sys/kernel/debug/tracing/tracing_on'
        sleep "$duration"
        sudo sh -c 'echo 0 > /sys/kernel/debug/tracing/tracing_on'
        sudo cat /sys/kernel/debug/tracing/trace | grep -A5 -B5 "irqs off" | head -30
        echo ""
        
        # Preemption latency
        echo "=== Preemption Latency ==="
        sudo sh -c 'echo preemptoff > /sys/kernel/debug/tracing/current_tracer'
        sudo sh -c 'echo 1 > /sys/kernel/debug/tracing/tracing_on'
        sleep "$duration"
        sudo sh -c 'echo 0 > /sys/kernel/debug/tracing/tracing_on'
        sudo cat /sys/kernel/debug/tracing/trace | grep -A5 -B5 "preempt off" | head -30
        echo ""
        
        # Wake-up latency
        echo "=== Wake-up Latency ==="
        sudo sh -c 'echo wakeup > /sys/kernel/debug/tracing/current_tracer'
        sudo sh -c 'echo 1 > /sys/kernel/debug/tracing/tracing_on'
        sleep "$duration"
        sudo sh -c 'echo 0 > /sys/kernel/debug/tracing/tracing_on'
        sudo cat /sys/kernel/debug/tracing/trace | grep -A5 -B5 "wakeup" | head -30
        
    } > "$output_file"
    
    echo "Latency analysis completed. Report saved to: $output_file"
}

# Memory analysis
memory_analysis() {
    local duration=${1:-30}
    local output_file="$ANALYSIS_DIR/memory_analysis_$(date +%Y%m%d_%H%M%S).txt"
    
    echo "Starting memory analysis for ${duration}s..."
    echo "Output: $output_file"
    
    {
        echo "=== Memory Analysis Report ==="
        echo "Generated: $(date)"
        echo "Duration: ${duration}s"
        echo ""
        
        # Memory events profiling
        echo "=== Memory Events Profiling ==="
        sudo perf record -e page-faults,cache-misses,cache-references -a -o /tmp/memory.data -- sleep "$duration" 2>/dev/null
        sudo perf report -i /tmp/memory.data --stdio | head -30
        echo ""
        
        # Memory allocation tracing
        echo "=== Memory Allocation Tracing ==="
        sudo sh -c 'echo 1 > /sys/kernel/debug/tracing/events/kmem/enable'
        sudo sh -c 'echo 1 > /sys/kernel/debug/tracing/tracing_on'
        sleep "$duration"
        sudo sh -c 'echo 0 > /sys/kernel/debug/tracing/tracing_on'
        
        echo "Top memory allocators:"
        sudo cat /sys/kernel/debug/tracing/trace | grep "kmem_" | 
            awk '{print $1}' | sort | uniq -c | sort -nr | head -20
        echo ""
        
        # Page fault analysis
        echo "=== Page Fault Analysis ==="
        sudo perf record -e page-faults -a -g -o /tmp/pagefaults.data -- sleep "$duration" 2>/dev/null
        sudo perf report -i /tmp/pagefaults.data --stdio | head -20
        
    } > "$output_file"
    
    echo "Memory analysis completed. Report saved to: $output_file"
}

# Comprehensive system analysis
comprehensive_analysis() {
    local duration=${1:-60}
    local output_dir="$ANALYSIS_DIR/comprehensive_$(date +%Y%m%d_%H%M%S)"
    
    echo "Starting comprehensive system analysis for ${duration}s..."
    mkdir -p "$output_dir"
    
    # Run all analyses in parallel
    echo "Running parallel analyses..."
    
    # CPU analysis
    (
        echo "CPU Analysis" > "$output_dir/cpu_analysis.txt"
        sudo perf stat -a -d sleep "$duration" 2>> "$output_dir/cpu_analysis.txt"
    ) &
    
    # Memory analysis  
    (
        memory_analysis "$duration" > /dev/null
        mv "$ANALYSIS_DIR"/memory_analysis_*.txt "$output_dir/memory_analysis.txt"
    ) &
    
    # I/O analysis
    (
        echo "I/O Analysis" > "$output_dir/io_analysis.txt"
        sudo perf record -e block:* -a -o "$output_dir/io.data" -- sleep "$duration" 2>/dev/null
        sudo perf report -i "$output_dir/io.data" --stdio >> "$output_dir/io_analysis.txt"
    ) &
    
    # Network analysis
    (
        echo "Network Analysis" > "$output_dir/network_analysis.txt"
        sudo perf record -e net:* -a -o "$output_dir/network.data" -- sleep "$duration" 2>/dev/null
        sudo perf report -i "$output_dir/network.data" --stdio >> "$output_dir/network_analysis.txt"
    ) &
    
    # System call analysis
    (
        event_tracing "$duration" "syscalls:*" > /dev/null
        mv "$ANALYSIS_DIR"/event_trace_*.txt "$output_dir/syscall_analysis.txt"
    ) &
    
    # Wait for all analyses to complete
    wait
    
    # Generate summary report
    cat > "$output_dir/summary_report.txt" << EOF
=== Comprehensive System Analysis Summary ===
Generated: $(date)
Duration: ${duration}s
Analysis Directory: $output_dir

Analysis Components:
- CPU performance and statistics
- Memory usage and allocation patterns
- I/O operations and block device activity
- Network traffic and socket operations
- System call frequency and latency

Individual reports are available in separate files within this directory.

Top System Statistics:
$(sudo perf stat -a sleep 1 2>&1 | grep -E "(task-clock|context-switches|cpu-migrations|page-faults)")

EOF
    
    echo "Comprehensive analysis completed in: $output_dir"
    echo "Summary report: $output_dir/summary_report.txt"
}

# Generate performance dashboard
generate_dashboard() {
    local analysis_dir=${1:-"$ANALYSIS_DIR"}
    local dashboard_file="$analysis_dir/performance_dashboard.html"
    
    echo "Generating performance dashboard..."
    
    cat > "$dashboard_file" << 'EOF'
<!DOCTYPE html>
<html>
<head>
    <title>Performance Analysis Dashboard</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .section { margin: 20px 0; padding: 15px; border: 1px solid #ddd; }
        .metric { margin: 10px 0; }
        .high { color: red; }
        .medium { color: orange; }
        .low { color: green; }
        pre { background: #f5f5f5; padding: 10px; overflow-x: auto; }
    </style>
</head>
<body>
    <h1>Performance Analysis Dashboard</h1>
    <div class="section">
        <h2>Analysis Overview</h2>
        <div class="metric">Generated: <script>document.write(new Date())</script></div>
        <div class="metric">Analysis Directory: ANALYSIS_DIR_PLACEHOLDER</div>
    </div>
    
    <div class="section">
        <h2>Quick Metrics</h2>
        <div class="metric">System Load: <span id="load">Loading...</span></div>
        <div class="metric">Memory Usage: <span id="memory">Loading...</span></div>
        <div class="metric">CPU Usage: <span id="cpu">Loading...</span></div>
    </div>
    
    <div class="section">
        <h2>Available Reports</h2>
        <ul>
            <li><a href="comprehensive_*/summary_report.txt">Comprehensive Analysis Summary</a></li>
            <li><a href="perf_*_report.txt">Perf Analysis Reports</a></li>
            <li><a href="function_trace_*.txt">Function Trace Logs</a></li>
            <li><a href="memory_analysis_*.txt">Memory Analysis</a></li>
            <li><a href="latency_analysis_*.txt">Latency Analysis</a></li>
        </ul>
    </div>
    
    <div class="section">
        <h2>Performance Recommendations</h2>
        <div id="recommendations">
            <p>Recommendations will be generated based on analysis results...</p>
        </div>
    </div>
</body>
</html>
EOF
    
    # Replace placeholder with actual directory
    sed -i "s|ANALYSIS_DIR_PLACEHOLDER|$analysis_dir|g" "$dashboard_file"
    
    echo "Dashboard generated: $dashboard_file"
    echo "Open in browser: file://$dashboard_file"
}

# Main execution
main() {
    case "${1:-help}" in
        setup)
            setup_environment
            ;;
        function-trace)
            function_tracing "$2" "$3"
            ;;
        perf-profile)
            advanced_perf_profiling "$2" "$3"
            ;;
        event-trace)
            event_tracing "$2" "$3"
            ;;
        latency)
            latency_analysis "$2"
            ;;
        memory)
            memory_analysis "$2"
            ;;
        comprehensive)
            setup_environment
            comprehensive_analysis "$2"
            ;;
        dashboard)
            generate_dashboard "$2"
            ;;
        all)
            setup_environment
            comprehensive_analysis 60
            generate_dashboard
            ;;
        *)
            echo "Usage: $0 {setup|function-trace|perf-profile|event-trace|latency|memory|comprehensive|dashboard|all} [duration] [pid/pattern]"
            echo ""
            echo "Commands:"
            echo "  setup           - Setup analysis environment"
            echo "  function-trace  - Trace kernel function calls"
            echo "  perf-profile    - Advanced perf profiling"
            echo "  event-trace     - Event-based tracing"
            echo "  latency         - Latency analysis"
            echo "  memory          - Memory analysis"
            echo "  comprehensive   - Run all analyses"
            echo "  dashboard       - Generate HTML dashboard"
            echo "  all             - Setup, analyze, and generate dashboard"
            echo ""
            echo "Parameters:"
            echo "  duration        - Analysis duration in seconds"
            echo "  pid/pattern     - Target PID or function pattern"
            ;;
    esac
}

main "$@"
```

This comprehensive Linux tracing and instrumentation framework provides:

- Complete eBPF program development with syscall, network, memory, and stack tracing
- Advanced SystemTap scripting for system call, memory, I/O, and network analysis
- Integrated ftrace and perf performance analysis toolkit
- Automated report generation and HTML dashboards
- Production-ready monitoring and observability solutions

The implementations demonstrate real-world tracing techniques used in modern observability platforms and performance monitoring systems.

<function_calls>
<invoke name="TodoWrite">
<parameter name="todos">[{"content": "Spread existing blog posts across multiple weeks with proper dates", "status": "completed", "priority": "high", "id": "1"}, {"content": "Create 20 additional advanced Linux/systems programming blog posts", "status": "completed", "priority": "high", "id": "2"}, {"content": "Create 100 more advanced Linux/systems programming blog posts", "status": "in_progress", "priority": "high", "id": "3"}]