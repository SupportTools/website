---
title: "eBPF Programming for Performance Monitoring and Security: Advanced Techniques for Enterprise Systems"
date: 2026-06-20T00:00:00-05:00
draft: false
tags: ["eBPF", "Linux", "Performance Monitoring", "Security", "Systems Programming", "Kernel", "BCC", "libbpf"]
categories:
- Systems Programming
- Performance Monitoring
- Security
- Linux Kernel
author: "Matthew Mattox - mmattox@support.tools"
description: "Master advanced eBPF programming techniques for building high-performance monitoring and security tools. Learn kernel programming, BPF maps, verifier internals, and production deployment strategies."
more_link: "yes"
url: "/ebpf-programming-performance-monitoring-security/"
---

Extended Berkeley Packet Filter (eBPF) has revolutionized the way we approach performance monitoring and security in Linux systems. This comprehensive guide explores advanced eBPF programming techniques, from kernel-level programming to production deployment strategies for enterprise environments.

<!--more-->

# [Understanding eBPF Architecture and Internals](#understanding-ebpf-architecture)

## Section 1: eBPF Virtual Machine and Execution Model

eBPF operates as a virtual machine within the Linux kernel, providing a safe and efficient way to run user-defined programs in kernel space without requiring kernel modules or changes to the kernel source code.

### eBPF Instruction Set Architecture

The eBPF instruction set is based on a 64-bit RISC architecture with 11 64-bit registers (R0-R10), where R10 serves as the frame pointer and R0 holds return values.

```c
// Example: Basic eBPF assembly showing register usage
struct bpf_insn prog[] = {
    // Load immediate value into R1
    BPF_MOV64_IMM(BPF_REG_1, 42),
    
    // Load value from stack
    BPF_LDX_MEM(BPF_DW, BPF_REG_2, BPF_REG_10, -8),
    
    // Add registers
    BPF_ALU64_REG(BPF_ADD, BPF_REG_1, BPF_REG_2),
    
    // Move result to return register
    BPF_MOV64_REG(BPF_REG_0, BPF_REG_1),
    
    // Exit
    BPF_EXIT_INSN(),
};
```

### Verifier Deep Dive

The eBPF verifier ensures program safety through static analysis, tracking register states, memory access patterns, and control flow.

```c
// Verifier-friendly code patterns
SEC("kprobe/sys_openat")
int trace_openat(struct pt_regs *ctx)
{
    // Bounds checking is crucial for verifier
    char filename[256];
    long ret;
    
    // Get the filename pointer from syscall arguments
    char *fname = (char *)PT_REGS_PARM2(ctx);
    
    // Safe memory access with bounds checking
    ret = bpf_probe_read_user_str(filename, sizeof(filename), fname);
    if (ret < 0)
        return 0;
    
    // Process the filename safely
    return 0;
}
```

## Section 2: Advanced BPF Map Types and Usage Patterns

BPF maps serve as the primary data structure for communication between eBPF programs and userspace, as well as between different eBPF programs.

### High-Performance Map Operations

```c
// Performance-optimized map definitions
struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_HASH);
    __uint(max_entries, 10240);
    __type(key, u32);
    __type(value, struct event_data);
} events_map SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, 10240);
    __type(key, u64);
    __type(value, struct connection_info);
} connections SEC(".maps");

// Efficient map access patterns
static __always_inline int update_event_stats(u32 pid)
{
    struct event_data *data, zero = {};
    
    // Use per-CPU maps to avoid lock contention
    data = bpf_map_lookup_elem(&events_map, &pid);
    if (!data) {
        bpf_map_update_elem(&events_map, &pid, &zero, BPF_NOEXIST);
        data = bpf_map_lookup_elem(&events_map, &pid);
        if (!data)
            return -1;
    }
    
    __sync_fetch_and_add(&data->count, 1);
    data->last_seen = bpf_ktime_get_ns();
    
    return 0;
}
```

### Ring Buffer Implementation for High-Throughput Data Transfer

```c
// Modern ring buffer usage for efficient data transfer
struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 256 * 1024);
} rb SEC(".maps");

struct event {
    u64 timestamp;
    u32 pid;
    u32 tid;
    char comm[16];
    char filename[256];
};

SEC("kprobe/do_sys_openat")
int trace_openat_entry(struct pt_regs *ctx)
{
    struct event *e;
    
    // Reserve space in ring buffer
    e = bpf_ringbuf_reserve(&rb, sizeof(*e), 0);
    if (!e)
        return 0;
    
    // Fill event data
    e->timestamp = bpf_ktime_get_ns();
    e->pid = bpf_get_current_pid_tgid() >> 32;
    e->tid = bpf_get_current_pid_tgid();
    bpf_get_current_comm(&e->comm, sizeof(e->comm));
    
    // Get filename from syscall arguments
    char *filename = (char *)PT_REGS_PARM2(ctx);
    bpf_probe_read_user_str(e->filename, sizeof(e->filename), filename);
    
    // Submit to ring buffer
    bpf_ringbuf_submit(e, 0);
    
    return 0;
}
```

# [Building Production-Grade Performance Monitoring Tools](#performance-monitoring-tools)

## Section 3: CPU Performance Analysis with eBPF

### Advanced CPU Profiling and Flame Graph Generation

```c
// CPU profiling with stack trace collection
struct {
    __uint(type, BPF_MAP_TYPE_STACK_TRACE);
    __uint(max_entries, 10000);
    __uint(key_size, sizeof(u32));
    __uint(value_size, PERF_MAX_STACK_DEPTH * sizeof(u64));
} stack_traces SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 10000);
    __type(key, struct stack_key);
    __type(value, u64);
} counts SEC(".maps");

struct stack_key {
    u32 pid;
    int user_stack_id;
    int kernel_stack_id;
};

SEC("perf_event")
int do_perf_event(struct bpf_perf_event_data *ctx)
{
    u64 id = bpf_get_current_pid_tgid();
    u32 pid = id >> 32;
    u32 tid = id;
    
    // Skip kernel threads
    if (pid == 0)
        return 0;
    
    struct stack_key key = {};
    key.pid = pid;
    
    // Collect user and kernel stack traces
    key.user_stack_id = bpf_get_stackid(ctx, &stack_traces, BPF_F_USER_STACK);
    key.kernel_stack_id = bpf_get_stackid(ctx, &stack_traces, 0);
    
    // Update counter
    u64 *val, zero = 0;
    val = bpf_map_lookup_elem(&counts, &key);
    if (val) {
        __sync_fetch_and_add(val, 1);
    } else {
        zero = 1;
        bpf_map_update_elem(&counts, &key, &zero, BPF_NOEXIST);
    }
    
    return 0;
}
```

### Memory Access Pattern Analysis

```c
// Memory access tracing for cache analysis
struct mem_access {
    u64 addr;
    u64 timestamp;
    u32 pid;
    u32 size;
    u8 type; // 0 = read, 1 = write
};

struct {
    __uint(type, BPF_MAP_TYPE_PERF_EVENT_ARRAY);
    __uint(max_entries, 1024);
} mem_events SEC(".maps");

SEC("perf_event")
int trace_memory_access(struct bpf_perf_event_data *ctx)
{
    struct mem_access access = {};
    
    // Get memory address from perf event
    access.addr = ctx->regs.ip;
    access.timestamp = bpf_ktime_get_ns();
    access.pid = bpf_get_current_pid_tgid() >> 32;
    
    // Determine access type and size from instruction
    // This would require more complex instruction decoding
    
    bpf_perf_event_output(ctx, &mem_events, BPF_F_CURRENT_CPU, 
                         &access, sizeof(access));
    
    return 0;
}
```

## Section 4: Network Performance Monitoring

### High-Performance Packet Analysis

```c
// Network packet analysis with classification
struct packet_info {
    __be32 saddr;
    __be32 daddr;
    __be16 sport;
    __be16 dport;
    u8 protocol;
    u32 length;
    u64 timestamp;
};

struct flow_key {
    __be32 saddr;
    __be32 daddr;
    __be16 sport;
    __be16 dport;
    u8 protocol;
};

struct flow_stats {
    u64 packets;
    u64 bytes;
    u64 first_seen;
    u64 last_seen;
};

struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, 65536);
    __type(key, struct flow_key);
    __type(value, struct flow_stats);
} flow_table SEC(".maps");

SEC("xdp")
int xdp_packet_analyzer(struct xdp_md *ctx)
{
    void *data_end = (void *)(long)ctx->data_end;
    void *data = (void *)(long)ctx->data;
    
    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return XDP_PASS;
    
    if (eth->h_proto != htons(ETH_P_IP))
        return XDP_PASS;
    
    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return XDP_PASS;
    
    struct flow_key key = {};
    key.saddr = ip->saddr;
    key.daddr = ip->daddr;
    key.protocol = ip->protocol;
    
    // Parse transport layer headers
    if (ip->protocol == IPPROTO_TCP) {
        struct tcphdr *tcp = (void *)ip + (ip->ihl * 4);
        if ((void *)(tcp + 1) > data_end)
            return XDP_PASS;
        
        key.sport = tcp->source;
        key.dport = tcp->dest;
    } else if (ip->protocol == IPPROTO_UDP) {
        struct udphdr *udp = (void *)ip + (ip->ihl * 4);
        if ((void *)(udp + 1) > data_end)
            return XDP_PASS;
        
        key.sport = udp->source;
        key.dport = udp->dest;
    }
    
    // Update flow statistics
    struct flow_stats *stats = bpf_map_lookup_elem(&flow_table, &key);
    if (stats) {
        __sync_fetch_and_add(&stats->packets, 1);
        __sync_fetch_and_add(&stats->bytes, ntohs(ip->tot_len));
        stats->last_seen = bpf_ktime_get_ns();
    } else {
        struct flow_stats new_stats = {
            .packets = 1,
            .bytes = ntohs(ip->tot_len),
            .first_seen = bpf_ktime_get_ns(),
            .last_seen = bpf_ktime_get_ns(),
        };
        bpf_map_update_elem(&flow_table, &key, &new_stats, BPF_NOEXIST);
    }
    
    return XDP_PASS;
}
```

### TCP Connection State Tracking

```c
// Advanced TCP connection monitoring
struct tcp_connection {
    __be32 saddr;
    __be32 daddr;
    __be16 sport;
    __be16 dport;
    u32 state;
    u64 established_time;
    u64 close_time;
    u64 bytes_sent;
    u64 bytes_received;
    u32 retransmits;
    u32 rtt_samples;
    u32 avg_rtt;
};

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 65536);
    __type(key, struct flow_key);
    __type(value, struct tcp_connection);
} tcp_connections SEC(".maps");

SEC("kprobe/tcp_set_state")
int trace_tcp_state_change(struct pt_regs *ctx)
{
    struct sock *sk = (struct sock *)PT_REGS_PARM1(ctx);
    int state = (int)PT_REGS_PARM2(ctx);
    
    // Extract connection tuple
    struct flow_key key = {};
    BPF_CORE_READ_INTO(&key.saddr, sk, __sk_common.skc_rcv_saddr);
    BPF_CORE_READ_INTO(&key.daddr, sk, __sk_common.skc_daddr);
    BPF_CORE_READ_INTO(&key.sport, sk, __sk_common.skc_num);
    BPF_CORE_READ_INTO(&key.dport, sk, __sk_common.skc_dport);
    key.protocol = IPPROTO_TCP;
    
    struct tcp_connection *conn = bpf_map_lookup_elem(&tcp_connections, &key);
    if (!conn) {
        struct tcp_connection new_conn = {};
        new_conn.saddr = key.saddr;
        new_conn.daddr = key.daddr;
        new_conn.sport = key.sport;
        new_conn.dport = key.dport;
        new_conn.state = state;
        
        if (state == TCP_ESTABLISHED)
            new_conn.established_time = bpf_ktime_get_ns();
        
        bpf_map_update_elem(&tcp_connections, &key, &new_conn, BPF_NOEXIST);
    } else {
        conn->state = state;
        
        if (state == TCP_ESTABLISHED && conn->established_time == 0)
            conn->established_time = bpf_ktime_get_ns();
        else if (state == TCP_CLOSE)
            conn->close_time = bpf_ktime_get_ns();
    }
    
    return 0;
}
```

# [eBPF Security Applications](#ebpf-security-applications)

## Section 5: Runtime Security Monitoring

### Advanced Syscall Filtering and Anomaly Detection

```c
// Comprehensive syscall monitoring for security
struct syscall_event {
    u64 timestamp;
    u32 pid;
    u32 tid;
    u32 uid;
    u32 gid;
    int syscall_nr;
    u64 args[6];
    char comm[16];
    char filename[256];
    u8 suspicious;
};

struct process_profile {
    u64 first_seen;
    u64 last_seen;
    u32 syscall_count[400]; // Track syscall frequency
    u32 total_syscalls;
    u8 baseline_established;
};

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 10240);
    __type(key, u32); // PID
    __type(value, struct process_profile);
} process_profiles SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 256 * 1024);
} security_events SEC(".maps");

// Suspicious syscall patterns
static int is_suspicious_pattern(int syscall_nr, struct pt_regs *ctx)
{
    // Check for privilege escalation attempts
    if (syscall_nr == __NR_setuid || syscall_nr == __NR_setgid ||
        syscall_nr == __NR_setresuid || syscall_nr == __NR_setresgid) {
        uid_t uid = (uid_t)PT_REGS_PARM1(ctx);
        if (uid == 0) // Attempting to become root
            return 1;
    }
    
    // Check for suspicious file operations
    if (syscall_nr == __NR_openat || syscall_nr == __NR_open) {
        char *filename = (char *)PT_REGS_PARM2(ctx);
        char path[64];
        
        if (bpf_probe_read_user_str(path, sizeof(path), filename) > 0) {
            // Check for access to sensitive files
            if (bpf_strncmp(path, "/etc/passwd", 11) == 0 ||
                bpf_strncmp(path, "/etc/shadow", 11) == 0 ||
                bpf_strncmp(path, "/proc/", 6) == 0) {
                return 1;
            }
        }
    }
    
    return 0;
}

SEC("tracepoint/raw_syscalls/sys_enter")
int trace_syscall_enter(struct trace_event_raw_sys_enter *ctx)
{
    u64 id = bpf_get_current_pid_tgid();
    u32 pid = id >> 32;
    u32 tid = id;
    int syscall_nr = ctx->id;
    
    // Skip kernel threads
    if (pid == 0)
        return 0;
    
    // Update process profile
    struct process_profile *profile = bpf_map_lookup_elem(&process_profiles, &pid);
    if (!profile) {
        struct process_profile new_profile = {};
        new_profile.first_seen = bpf_ktime_get_ns();
        new_profile.last_seen = bpf_ktime_get_ns();
        bpf_map_update_elem(&process_profiles, &pid, &new_profile, BPF_NOEXIST);
        profile = bpf_map_lookup_elem(&process_profiles, &pid);
        if (!profile)
            return 0;
    }
    
    // Update syscall statistics
    if (syscall_nr >= 0 && syscall_nr < 400) {
        __sync_fetch_and_add(&profile->syscall_count[syscall_nr], 1);
        __sync_fetch_and_add(&profile->total_syscalls, 1);
    }
    profile->last_seen = bpf_ktime_get_ns();
    
    // Check for suspicious activity
    int suspicious = is_suspicious_pattern(syscall_nr, (struct pt_regs *)ctx->args);
    
    // Generate security event if suspicious
    if (suspicious || (profile->baseline_established && 
                      profile->syscall_count[syscall_nr] == 1)) {
        struct syscall_event *event = bpf_ringbuf_reserve(&security_events, 
                                                         sizeof(*event), 0);
        if (event) {
            event->timestamp = bpf_ktime_get_ns();
            event->pid = pid;
            event->tid = tid;
            event->uid = bpf_get_current_uid_gid();
            event->gid = bpf_get_current_uid_gid() >> 32;
            event->syscall_nr = syscall_nr;
            event->suspicious = suspicious;
            
            // Copy syscall arguments
            for (int i = 0; i < 6; i++) {
                event->args[i] = ctx->args[i];
            }
            
            bpf_get_current_comm(&event->comm, sizeof(event->comm));
            bpf_ringbuf_submit(event, 0);
        }
    }
    
    return 0;
}
```

### File Integrity Monitoring

```c
// Advanced file integrity monitoring
struct file_event {
    u64 timestamp;
    u32 pid;
    u32 uid;
    u32 gid;
    u32 mode;
    char comm[16];
    char filename[256];
    char operation[16];
    u64 inode;
    u64 size;
};

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 10000);
    __type(key, u64); // inode number
    __type(value, struct file_metadata);
} monitored_files SEC(".maps");

struct file_metadata {
    u64 inode;
    u64 size;
    u64 mtime;
    u32 uid;
    u32 gid;
    u32 mode;
    char path[256];
};

SEC("kprobe/vfs_write")
int trace_file_write(struct pt_regs *ctx)
{
    struct file *file = (struct file *)PT_REGS_PARM1(ctx);
    struct inode *inode;
    u64 inode_num;
    
    // Get inode information
    BPF_CORE_READ_INTO(&inode, file, f_inode);
    BPF_CORE_READ_INTO(&inode_num, inode, i_ino);
    
    // Check if this file is being monitored
    struct file_metadata *metadata = bpf_map_lookup_elem(&monitored_files, &inode_num);
    if (!metadata)
        return 0;
    
    // Generate file modification event
    struct file_event *event = bpf_ringbuf_reserve(&security_events, 
                                                  sizeof(*event), 0);
    if (event) {
        event->timestamp = bpf_ktime_get_ns();
        event->pid = bpf_get_current_pid_tgid() >> 32;
        event->uid = bpf_get_current_uid_gid();
        event->gid = bpf_get_current_uid_gid() >> 32;
        event->inode = inode_num;
        
        bpf_get_current_comm(&event->comm, sizeof(event->comm));
        bpf_probe_read_kernel_str(&event->operation, sizeof(event->operation), "write");
        bpf_probe_read_kernel_str(&event->filename, sizeof(event->filename), 
                                 metadata->path);
        
        bpf_ringbuf_submit(event, 0);
    }
    
    return 0;
}
```

# [Advanced eBPF Programming Techniques](#advanced-techniques)

## Section 6: CO-RE (Compile Once - Run Everywhere) Programming

### Portable eBPF Programs with BTF

```c
// CO-RE enabled structure definitions
struct task_struct___old {
    int pid;
    char comm[16];
} __attribute__((preserve_access_index));

struct task_struct___new {
    int pid;
    int tgid;
    char comm[16];
    struct mm_struct *mm;
} __attribute__((preserve_access_index));

// CO-RE helper macros for field access
#define BPF_CORE_READ_TASK_PID(task) ({                    \
    int pid = 0;                                          \
    if (bpf_core_field_exists(task->tgid)) {              \
        BPF_CORE_READ_INTO(&pid, task, tgid);             \
    } else {                                              \
        BPF_CORE_READ_INTO(&pid, task, pid);              \
    }                                                     \
    pid;                                                  \
})

SEC("kprobe/schedule")
int trace_schedule(struct pt_regs *ctx)
{
    struct task_struct *task = (struct task_struct *)bpf_get_current_task();
    int pid = BPF_CORE_READ_TASK_PID(task);
    
    char comm[16];
    BPF_CORE_READ_STR_INTO(&comm, task, comm);
    
    // Process scheduling information
    return 0;
}
```

### Dynamic Program Loading and Management

```c
// libbpf-based program loader
#include <bpf/libbpf.h>
#include <bpf/bpf.h>

struct ebpf_program_manager {
    struct bpf_object *obj;
    struct bpf_program *prog;
    struct bpf_link *link;
    int map_fd;
};

int load_ebpf_program(const char *filename, 
                     struct ebpf_program_manager *mgr)
{
    struct bpf_object_open_attr open_attr = {
        .file = filename,
        .prog_type = BPF_PROG_TYPE_KPROBE,
    };
    
    // Open BPF object
    mgr->obj = bpf_object__open_xattr(&open_attr);
    if (libbpf_get_error(mgr->obj)) {
        fprintf(stderr, "Failed to open BPF object\n");
        return -1;
    }
    
    // Set program type if needed
    bpf_object__for_each_program(mgr->prog, mgr->obj) {
        bpf_program__set_type(mgr->prog, BPF_PROG_TYPE_KPROBE);
    }
    
    // Load programs
    if (bpf_object__load(mgr->obj)) {
        fprintf(stderr, "Failed to load BPF object\n");
        bpf_object__close(mgr->obj);
        return -1;
    }
    
    // Find main program
    mgr->prog = bpf_object__find_program_by_title(mgr->obj, "kprobe/sys_openat");
    if (!mgr->prog) {
        fprintf(stderr, "Failed to find program\n");
        bpf_object__close(mgr->obj);
        return -1;
    }
    
    // Attach to kernel
    mgr->link = bpf_program__attach(mgr->prog);
    if (libbpf_get_error(mgr->link)) {
        fprintf(stderr, "Failed to attach program\n");
        bpf_object__close(mgr->obj);
        return -1;
    }
    
    // Get map file descriptor
    struct bpf_map *map = bpf_object__find_map_by_name(mgr->obj, "events");
    if (map) {
        mgr->map_fd = bpf_map__fd(map);
    }
    
    return 0;
}

void cleanup_ebpf_program(struct ebpf_program_manager *mgr)
{
    if (mgr->link) {
        bpf_link__destroy(mgr->link);
    }
    if (mgr->obj) {
        bpf_object__close(mgr->obj);
    }
}
```

## Section 7: Performance Optimization Strategies

### Efficient Data Structures and Algorithms

```c
// Lock-free ring buffer implementation for eBPF
struct lockfree_ringbuf {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, RINGBUF_SIZE + 1);
    __type(key, u32);
    __type(value, struct ringbuf_entry);
} ringbuf SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, 2);
    __type(key, u32);
    __type(value, u64);
} ringbuf_cursors SEC(".maps");

struct ringbuf_entry {
    u64 timestamp;
    u32 pid;
    char data[248]; // Align to 256 bytes
};

static __always_inline int ringbuf_push(struct ringbuf_entry *entry)
{
    u32 head_key = 0, tail_key = 1;
    u64 *head, *tail;
    u64 next_head;
    
    // Get current cursors
    head = bpf_map_lookup_elem(&ringbuf_cursors, &head_key);
    tail = bpf_map_lookup_elem(&ringbuf_cursors, &tail_key);
    
    if (!head || !tail)
        return -1;
    
    // Calculate next head position
    next_head = (*head + 1) % RINGBUF_SIZE;
    
    // Check if buffer is full
    if (next_head == *tail)
        return -1; // Buffer full
    
    // Insert entry
    u32 pos = *head;
    if (bpf_map_update_elem(&ringbuf, &pos, entry, BPF_ANY) != 0)
        return -1;
    
    // Update head pointer atomically
    __sync_val_compare_and_swap(head, *head, next_head);
    
    return 0;
}

// Batch processing for improved performance
#define BATCH_SIZE 32

struct batch_context {
    struct ringbuf_entry entries[BATCH_SIZE];
    u32 count;
    u64 last_flush;
};

struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(max_entries, 1);
    __type(key, u32);
    __type(value, struct batch_context);
} batch_map SEC(".maps");

static __always_inline int add_to_batch(struct ringbuf_entry *entry)
{
    u32 key = 0;
    struct batch_context *batch = bpf_map_lookup_elem(&batch_map, &key);
    
    if (!batch)
        return -1;
    
    // Add to batch
    if (batch->count < BATCH_SIZE) {
        __builtin_memcpy(&batch->entries[batch->count], entry, sizeof(*entry));
        batch->count++;
    }
    
    // Flush batch if full or timeout
    u64 now = bpf_ktime_get_ns();
    if (batch->count >= BATCH_SIZE || 
        (now - batch->last_flush) > 1000000000ULL) { // 1 second
        
        // Process batch
        for (u32 i = 0; i < batch->count; i++) {
            ringbuf_push(&batch->entries[i]);
        }
        
        batch->count = 0;
        batch->last_flush = now;
    }
    
    return 0;
}
```

### Memory-Efficient Data Aggregation

```c
// Hierarchical hash maps for efficient aggregation
struct {
    __uint(type, BPF_MAP_TYPE_HASH_OF_MAPS);
    __uint(max_entries, 1024);
    __type(key, u32); // Process ID
    __type(value, u32); // Inner map ID
} process_maps SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 10000);
    __type(key, u64); // Function address
    __type(value, u64); // Call count
} inner_map_template SEC(".maps");

// Efficient aggregation with hierarchical maps
static int update_function_count(u32 pid, u64 func_addr)
{
    void *inner_map = bpf_map_lookup_elem(&process_maps, &pid);
    if (!inner_map) {
        // Create new inner map for this process
        int inner_map_fd = bpf_map_create(BPF_MAP_TYPE_HASH, NULL, 
                                         sizeof(u64), sizeof(u64), 
                                         10000, NULL);
        if (inner_map_fd < 0)
            return -1;
        
        u32 map_id = inner_map_fd;
        bpf_map_update_elem(&process_maps, &pid, &map_id, BPF_NOEXIST);
        inner_map = bpf_map_lookup_elem(&process_maps, &pid);
    }
    
    if (inner_map) {
        u64 *count = bpf_map_lookup_elem(inner_map, &func_addr);
        if (count) {
            __sync_fetch_and_add(count, 1);
        } else {
            u64 one = 1;
            bpf_map_update_elem(inner_map, &func_addr, &one, BPF_NOEXIST);
        }
    }
    
    return 0;
}
```

# [Production Deployment and Best Practices](#production-deployment)

## Section 8: Monitoring and Observability for eBPF Programs

### eBPF Program Health Monitoring

```c
// Program statistics and health metrics
struct prog_stats {
    u64 events_processed;
    u64 events_dropped;
    u64 map_operations;
    u64 errors;
    u64 last_activity;
    u64 cpu_cycles;
};

struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, 1);
    __type(key, u32);
    __type(value, struct prog_stats);
} program_stats SEC(".maps");

static __always_inline void update_stats(int operation, int result)
{
    u32 key = 0;
    struct prog_stats *stats = bpf_map_lookup_elem(&program_stats, &key);
    
    if (!stats)
        return;
    
    stats->last_activity = bpf_ktime_get_ns();
    
    switch (operation) {
    case 0: // Event processing
        if (result == 0) {
            __sync_fetch_and_add(&stats->events_processed, 1);
        } else {
            __sync_fetch_and_add(&stats->events_dropped, 1);
        }
        break;
    case 1: // Map operation
        __sync_fetch_and_add(&stats->map_operations, 1);
        if (result != 0) {
            __sync_fetch_and_add(&stats->errors, 1);
        }
        break;
    }
}

// Performance monitoring with instruction counting
SEC("kprobe/example_function")
int monitored_kprobe(struct pt_regs *ctx)
{
    u64 start_cycles = bpf_get_cycles();
    
    // Main program logic here
    int result = do_main_processing(ctx);
    
    u64 end_cycles = bpf_get_cycles();
    
    // Update performance statistics
    u32 key = 0;
    struct prog_stats *stats = bpf_map_lookup_elem(&program_stats, &key);
    if (stats) {
        __sync_fetch_and_add(&stats->cpu_cycles, end_cycles - start_cycles);
    }
    
    update_stats(0, result);
    return 0;
}
```

### Comprehensive Userspace Management Framework

```c
// Complete userspace management system
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <signal.h>
#include <pthread.h>
#include <sys/resource.h>
#include <bpf/libbpf.h>
#include <bpf/bpf.h>

struct ebpf_manager {
    struct bpf_object *obj;
    struct bpf_program **programs;
    struct bpf_link **links;
    struct bpf_map **maps;
    int num_programs;
    int num_maps;
    pthread_t monitoring_thread;
    volatile int running;
};

// Program lifecycle management
int initialize_ebpf_manager(struct ebpf_manager *mgr, const char *obj_file)
{
    // Set memory limits for eBPF programs
    struct rlimit rlim = {
        .rlim_cur = RLIM_INFINITY,
        .rlim_max = RLIM_INFINITY,
    };
    setrlimit(RLIMIT_MEMLOCK, &rlim);
    
    // Open and load BPF object
    mgr->obj = bpf_object__open(obj_file);
    if (libbpf_get_error(mgr->obj)) {
        fprintf(stderr, "Failed to open BPF object: %s\n", obj_file);
        return -1;
    }
    
    // Configure programs
    struct bpf_program *prog;
    mgr->num_programs = 0;
    bpf_object__for_each_program(prog, mgr->obj) {
        mgr->num_programs++;
    }
    
    mgr->programs = calloc(mgr->num_programs, sizeof(struct bpf_program *));
    mgr->links = calloc(mgr->num_programs, sizeof(struct bpf_link *));
    
    // Load object
    if (bpf_object__load(mgr->obj)) {
        fprintf(stderr, "Failed to load BPF object\n");
        return -1;
    }
    
    // Attach programs
    int i = 0;
    bpf_object__for_each_program(prog, mgr->obj) {
        mgr->programs[i] = prog;
        mgr->links[i] = bpf_program__attach(prog);
        if (libbpf_get_error(mgr->links[i])) {
            fprintf(stderr, "Failed to attach program %d\n", i);
            return -1;
        }
        i++;
    }
    
    // Initialize maps
    struct bpf_map *map;
    mgr->num_maps = 0;
    bpf_object__for_each_map(map, mgr->obj) {
        mgr->num_maps++;
    }
    
    mgr->maps = calloc(mgr->num_maps, sizeof(struct bpf_map *));
    i = 0;
    bpf_object__for_each_map(map, mgr->obj) {
        mgr->maps[i++] = map;
    }
    
    mgr->running = 1;
    
    return 0;
}

// Health monitoring thread
void *monitoring_thread(void *arg)
{
    struct ebpf_manager *mgr = (struct ebpf_manager *)arg;
    
    while (mgr->running) {
        // Check program statistics
        for (int i = 0; i < mgr->num_maps; i++) {
            if (strcmp(bpf_map__name(mgr->maps[i]), "program_stats") == 0) {
                int map_fd = bpf_map__fd(mgr->maps[i]);
                u32 key = 0;
                struct prog_stats stats;
                
                if (bpf_map_lookup_elem(map_fd, &key, &stats) == 0) {
                    printf("Stats: processed=%llu, dropped=%llu, errors=%llu\n",
                           stats.events_processed, stats.events_dropped, 
                           stats.errors);
                    
                    // Check for health issues
                    if (stats.events_dropped > stats.events_processed * 0.1) {
                        printf("WARNING: High drop rate detected\n");
                    }
                    
                    u64 now = time(NULL) * 1000000000ULL;
                    if (now - stats.last_activity > 60000000000ULL) {
                        printf("WARNING: Program appears inactive\n");
                    }
                }
            }
        }
        
        sleep(30); // Check every 30 seconds
    }
    
    return NULL;
}

// Graceful shutdown handling
void signal_handler(int sig)
{
    printf("Received signal %d, shutting down...\n", sig);
    // Set global shutdown flag
}

int main(int argc, char **argv)
{
    if (argc != 2) {
        fprintf(stderr, "Usage: %s <bpf_object.o>\n", argv[0]);
        return 1;
    }
    
    // Install signal handlers
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);
    
    struct ebpf_manager mgr = {};
    
    if (initialize_ebpf_manager(&mgr, argv[1]) != 0) {
        fprintf(stderr, "Failed to initialize eBPF manager\n");
        return 1;
    }
    
    // Start monitoring thread
    pthread_create(&mgr.monitoring_thread, NULL, monitoring_thread, &mgr);
    
    printf("eBPF programs loaded and running. Press Ctrl+C to stop.\n");
    
    // Main event loop
    while (mgr.running) {
        // Process ring buffer events, handle map updates, etc.
        sleep(1);
    }
    
    // Cleanup
    mgr.running = 0;
    pthread_join(mgr.monitoring_thread, NULL);
    
    for (int i = 0; i < mgr.num_programs; i++) {
        if (mgr.links[i]) {
            bpf_link__destroy(mgr.links[i]);
        }
    }
    
    if (mgr.obj) {
        bpf_object__close(mgr.obj);
    }
    
    free(mgr.programs);
    free(mgr.links);
    free(mgr.maps);
    
    return 0;
}
```

## Section 9: Security Considerations and Hardening

### Secure eBPF Program Development

```c
// Security-hardened eBPF program template
#include <linux/bpf.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_core_read.h>

// Input validation macros
#define VALIDATE_PTR(ptr) \
    do { \
        if (!ptr) return -EINVAL; \
    } while(0)

#define VALIDATE_BOUNDS(val, min, max) \
    do { \
        if (val < min || val > max) return -EINVAL; \
    } while(0)

// Secure string operations
static __always_inline int secure_strncpy(char *dst, const char *src, 
                                         size_t dst_size)
{
    if (!dst || !src || dst_size == 0)
        return -EINVAL;
    
    int ret = bpf_probe_read_str(dst, dst_size, src);
    if (ret < 0)
        return ret;
    
    // Ensure null termination
    dst[dst_size - 1] = '\0';
    return 0;
}

// Rate limiting to prevent DoS
struct rate_limiter {
    u64 last_update;
    u32 tokens;
    u32 max_tokens;
    u64 refill_rate; // tokens per nanosecond
};

struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, 1024);
    __type(key, u32); // Source identifier
    __type(value, struct rate_limiter);
} rate_limit_map SEC(".maps");

static int check_rate_limit(u32 source_id, u32 tokens_needed)
{
    u64 now = bpf_ktime_get_ns();
    struct rate_limiter *limiter = bpf_map_lookup_elem(&rate_limit_map, &source_id);
    
    if (!limiter) {
        struct rate_limiter new_limiter = {
            .last_update = now,
            .tokens = 100, // Initial tokens
            .max_tokens = 100,
            .refill_rate = 10, // 10 tokens per second
        };
        bpf_map_update_elem(&rate_limit_map, &source_id, &new_limiter, BPF_NOEXIST);
        return tokens_needed <= 100 ? 0 : -EBUSY;
    }
    
    // Refill tokens based on time elapsed
    u64 elapsed = now - limiter->last_update;
    u64 new_tokens = elapsed * limiter->refill_rate / 1000000000ULL;
    
    limiter->tokens = (u32)min(limiter->max_tokens, 
                              (u64)limiter->tokens + new_tokens);
    limiter->last_update = now;
    
    if (limiter->tokens >= tokens_needed) {
        limiter->tokens -= tokens_needed;
        return 0;
    }
    
    return -EBUSY; // Rate limited
}

// Secure syscall tracing with validation
SEC("tracepoint/syscalls/sys_enter_openat")
int secure_trace_openat(struct trace_event_raw_sys_enter *ctx)
{
    u32 pid = bpf_get_current_pid_tgid() >> 32;
    
    // Apply rate limiting
    if (check_rate_limit(pid, 1) != 0)
        return 0;
    
    // Validate syscall arguments
    VALIDATE_BOUNDS(ctx->args[0], 0, 1024); // dirfd
    VALIDATE_BOUNDS(ctx->args[2], 0, 0x7FFFFFFF); // flags
    
    char filename[256];
    char *user_filename = (char *)ctx->args[1];
    
    // Secure string copy with validation
    if (secure_strncpy(filename, user_filename, sizeof(filename)) != 0)
        return 0;
    
    // Additional security checks
    if (bpf_strncmp(filename, "/proc/", 6) == 0) {
        // Special handling for /proc access
        if (bpf_strncmp(filename, "/proc/self/mem", 14) == 0) {
            // Block potentially dangerous memory access
            return 0;
        }
    }
    
    // Process the event securely
    return 0;
}
```

This comprehensive guide provides advanced eBPF programming techniques for building production-grade performance monitoring and security tools. The examples demonstrate kernel-level programming, efficient data structures, security hardening, and complete deployment strategies for enterprise environments. By following these patterns and best practices, developers can create robust, secure, and high-performance eBPF applications that scale effectively in production systems.

The key to successful eBPF development lies in understanding the underlying kernel architecture, implementing proper security measures, and designing efficient data paths that minimize overhead while maximizing observability and control capabilities.