---
title: "Linux BPF Type Format (BTF): Portability and CO-RE Deep Dive"
date: 2029-04-11T00:00:00-05:00
draft: false
tags: ["Linux", "eBPF", "BTF", "CO-RE", "Kernel", "Performance", "Observability"]
categories:
- Linux
- eBPF
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into BPF Type Format (BTF) covering BTF generation, vmlinux.h, type introspection, CO-RE relocations, btf_dump, pahole, and verifier improvements for portable eBPF programs."
more_link: "yes"
url: "/linux-btf-bpf-type-format-core-portability-guide/"
---

Before BPF Type Format existed, writing portable eBPF programs was nearly impossible. A program compiled against one kernel's header files would break silently on a different kernel version where struct fields moved or were renamed. BTF changed this entirely by embedding rich type information directly into the kernel and into compiled BPF objects, enabling CO-RE (Compile Once, Run Everywhere) relocations.

This guide covers BTF from first principles through production use: how BTF is generated, how the kernel exports it, how CO-RE relocations work, and how tools like pahole and btf_dump make BTF introspectable.

<!--more-->

# Linux BPF Type Format (BTF): Portability and CO-RE Deep Dive

## Section 1: The Problem BTF Solves

### Traditional eBPF Portability Problems

An eBPF program that reads a field from `task_struct` must know the exact byte offset of that field at compile time:

```c
// Compiled against kernel 5.10 headers
SEC("kprobe/wake_up_new_task")
int trace_new_task(struct pt_regs *ctx)
{
    struct task_struct *p = (struct task_struct *)PT_REGS_PARM1(ctx);
    pid_t pid;

    // offset of 'pid' in task_struct compiled in at build time
    // On kernel 5.15, this offset may have changed
    bpf_probe_read_kernel(&pid, sizeof(pid), &p->pid);
    bpf_printk("new task pid: %d\n", pid);
    return 0;
}
```

If the `task_struct` layout changes between kernel versions, this program will read garbage data or crash. Prior to BTF, the only solution was to ship per-kernel-version compiled BPF object files.

### What BTF Provides

BTF is a compact binary format that describes C types with exact field names, sizes, and offsets. It enables:

1. **Kernel type export**: The kernel exports its own type information via `/sys/kernel/btf/vmlinux`
2. **CO-RE relocations**: The BPF loader (libbpf) adjusts field offsets at load time to match the running kernel
3. **Verifier improvements**: The BPF verifier uses BTF to verify programs access memory correctly
4. **BTF-based maps**: BTF-annotated maps allow `bpftool` and other tools to pretty-print map contents

## Section 2: BTF Format Internals

### BTF Binary Layout

A BTF blob consists of a header followed by two sections: the type section and the string section.

```c
struct btf_header {
    __u16 magic;        // 0xeB9F
    __u8  version;      // currently 1
    __u8  flags;
    __u32 hdr_len;

    // type section
    __u32 type_off;
    __u32 type_len;

    // string section
    __u32 str_off;
    __u32 str_len;
};
```

Each type entry begins with:

```c
struct btf_type {
    __u32 name_off;  // offset into string section
    // bits 0-15: vlen (varies by kind)
    // bits 24-28: kind (INT, PTR, ARRAY, STRUCT, etc.)
    // bit 31: kind_flag
    __u32 info;
    union {
        __u32 size;   // for INT, STRUCT, UNION, ENUM
        __u32 type;   // for PTR, TYPEDEF, VOLATILE, CONST, etc.
    };
};
```

BTF type kinds include:

| Kind | ID | Description |
|---|---|---|
| INT | 1 | Integer type (char, int, long) |
| PTR | 2 | Pointer type |
| ARRAY | 3 | Array type |
| STRUCT | 4 | Struct type |
| UNION | 5 | Union type |
| ENUM | 6 | Enum type (32-bit values) |
| TYPEDEF | 8 | Typedef |
| FUNC | 12 | Function |
| FUNC_PROTO | 13 | Function prototype |
| VAR | 14 | Variable |
| DATASEC | 15 | Data section |
| FLOAT | 16 | Floating point type |
| ENUM64 | 19 | Enum type (64-bit values) |

### Inspecting BTF with bpftool

```bash
# View all BTF types in the running kernel
bpftool btf dump file /sys/kernel/btf/vmlinux format raw | head -100

# View BTF in a human-readable C format
bpftool btf dump file /sys/kernel/btf/vmlinux format c | grep -A 20 "struct task_struct {"

# Show BTF for a specific loaded BPF program
bpftool prog show

# Dump BTF for a compiled BPF object file
bpftool btf dump file my_program.bpf.o
```

### pahole — The BTF Generation Tool

`pahole` (Poke-A-Hole) was originally designed to find padding holes in structs. It was extended to generate BTF and is the primary tool used to embed BTF into the kernel's vmlinux image.

```bash
# Install pahole (part of dwarves package)
apt-get install dwarves
# or
dnf install dwarves

# Generate BTF from a DWARF-annotated binary
pahole --btf_encode my_program

# Show struct layout with padding holes
pahole task_struct /proc/kcore 2>/dev/null | head -100

# Show all structs containing a specific field
pahole -C pid_namespace /usr/lib/debug/boot/vmlinux-$(uname -r)

# Extract BTF from kernel image
pahole --btf_encode_detached /tmp/vmlinux.btf /boot/vmlinux-$(uname -r)

# Get the size of a struct
pahole -s task_struct /proc/kcore 2>/dev/null
# task_struct: 9792 bytes, 64 bytes alignment
```

### Generating vmlinux.h

`vmlinux.h` is a single auto-generated header file that contains all kernel type definitions derived from BTF. It replaces hundreds of kernel header includes.

```bash
# Generate vmlinux.h for the running kernel
bpftool btf dump file /sys/kernel/btf/vmlinux format c > vmlinux.h

# Verify it contains common types
grep "struct task_struct" vmlinux.h | head -5
# struct task_struct {
```

Using `vmlinux.h` in a BPF program:

```c
// No more #include <linux/...> headers needed
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

SEC("kprobe/do_sys_openat2")
int trace_openat(struct pt_regs *ctx)
{
    struct task_struct *task = (struct task_struct *)bpf_get_current_task();

    // CO-RE read: libbpf adjusts the offset to match the running kernel
    pid_t tgid = BPF_CORE_READ(task, tgid);
    pid_t pid  = BPF_CORE_READ(task, pid);

    bpf_printk("openat: tgid=%d pid=%d\n", tgid, pid);
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
```

## Section 3: CO-RE Relocations

### How CO-RE Works

CO-RE (Compile Once, Run Everywhere) allows eBPF programs compiled against one kernel's type definitions to run correctly on a different kernel where struct layouts may differ.

The process:

1. **Compile time**: Clang with BTF support embeds relocation records into the BPF ELF object alongside BTF for types the program uses
2. **Load time**: libbpf reads the program's BTF and the running kernel's BTF from `/sys/kernel/btf/vmlinux`, computes the difference in field offsets, and patches the BPF bytecode before loading

### CO-RE Read Macros

`bpf_core_read.h` provides macros that emit the correct relocation records:

```c
#include "vmlinux.h"
#include <bpf/bpf_core_read.h>

SEC("tp_btf/sched_process_exec")
int handle_exec(struct trace_event_raw_sched_process_exec *ctx)
{
    struct task_struct *task;
    __u32 pid, ppid;
    __u64 start_time;
    char comm[TASK_COMM_LEN];

    task = (struct task_struct *)bpf_get_current_task();

    // Simple field read
    pid = BPF_CORE_READ(task, pid);

    // Nested field read (follows pointers)
    ppid = BPF_CORE_READ(task, real_parent, pid);

    // Read start time
    start_time = BPF_CORE_READ(task, start_time);

    // Read string field
    BPF_CORE_READ_STR_INTO(&comm, task, comm);

    bpf_printk("exec: pid=%u ppid=%u comm=%s\n", pid, ppid, comm);
    return 0;
}
```

### CO-RE Bitfield Access

Bitfields require special handling because their offset includes bit position within the containing byte:

```c
SEC("kprobe/schedule")
int trace_schedule(struct pt_regs *ctx)
{
    struct task_struct *task = (struct task_struct *)bpf_get_current_task();

    // BPF_CORE_READ_BITFIELD handles bitfield extraction with correct masking
    __u32 migrated = BPF_CORE_READ_BITFIELD(task, sched_migrated);
    __u32 reset_on_fork = BPF_CORE_READ_BITFIELD(task, sched_reset_on_fork);

    if (migrated) {
        bpf_printk("task migrated, pid=%d\n", BPF_CORE_READ(task, pid));
    }
    return 0;
}
```

### CO-RE Type Existence Checks

Different kernel versions may add or remove struct fields. CO-RE provides existence checks:

```c
SEC("kprobe/tcp_connect")
int trace_tcp_connect(struct pt_regs *ctx)
{
    struct sock *sk = (struct sock *)PT_REGS_PARM1(ctx);
    __u32 saddr, daddr;
    __u16 sport, dport;

    // Check if field exists before reading
    if (bpf_core_field_exists(struct sock, sk_v6_rcv_saddr)) {
        bpf_printk("IPv6 field available\n");
    }

    saddr = BPF_CORE_READ(sk, __sk_common.skc_rcv_saddr);
    daddr = BPF_CORE_READ(sk, __sk_common.skc_daddr);
    sport = BPF_CORE_READ(sk, __sk_common.skc_num);
    dport = bpf_ntohs(BPF_CORE_READ(sk, __sk_common.skc_dport));

    bpf_printk("connect: %x:%d -> %x:%d\n", saddr, sport, daddr, dport);
    return 0;
}
```

### Enum Value Relocations

Kernel enums can change their values between versions. CO-RE handles this transparently:

```c
// Access enum values safely across kernel versions
if (bpf_core_enum_value_exists(enum bpf_map_type, BPF_MAP_TYPE_RINGBUF)) {
    bpf_printk("ring buffer map type is available\n");
}

__u32 ringbuf_type = bpf_core_enum_value(enum bpf_map_type, BPF_MAP_TYPE_RINGBUF);
```

## Section 4: BTF-Annotated Maps

### Map BTF for Pretty-Printing

Adding BTF annotations to BPF maps allows `bpftool` to display map contents with proper type names:

```c
struct event {
    __u32 pid;
    __u32 tid;
    __u64 timestamp_ns;
    char  comm[16];
    char  filename[256];
    __s32 ret;
};

// BTF-annotated ring buffer map
struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 1 << 24);  // 16MB ring buffer
} events SEC(".maps");

// BTF-annotated hash map
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 10240);
    __type(key, __u32);
    __type(value, struct event);
} pid_events SEC(".maps");
```

With BTF annotations, `bpftool map dump` shows human-readable output:

```bash
bpftool map dump name pid_events
# [{
#         "key": 1234,
#         "value": {
#             "pid": 1234,
#             "tid": 1234,
#             "timestamp_ns": 1712000000000000000,
#             "comm": "nginx",
#             "filename": "/etc/nginx/nginx.conf",
#             "ret": 3
#         }
#     }
# ]
```

### Spin Lock Maps

BTF enables BPF spin locks, which require type information to verify correct usage:

```c
struct value {
    struct bpf_spin_lock lock;
    __u64 counter;
};

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 1024);
    __type(key, __u32);
    __type(value, struct value);
} counters SEC(".maps");

SEC("kprobe/some_event")
int count_event(struct pt_regs *ctx)
{
    __u32 key = 0;
    struct value *val = bpf_map_lookup_elem(&counters, &key);
    if (!val)
        return 0;

    bpf_spin_lock(&val->lock);
    val->counter++;
    bpf_spin_unlock(&val->lock);

    return 0;
}
```

## Section 5: BTF Dump and Introspection

### btf_dump API in libbpf

The `btf_dump` API allows programmatic BTF introspection from user space:

```c
#include <bpf/btf.h>
#include <bpf/libbpf.h>
#include <stdio.h>

static void btf_dump_printf(void *ctx, const char *fmt, va_list args)
{
    vprintf(fmt, args);
}

int dump_struct(const char *struct_name)
{
    struct btf *btf;
    struct btf_dump *dump;
    int err;

    // Load BTF from the running kernel
    btf = btf__load_vmlinux_btf();
    if (libbpf_get_error(btf)) {
        fprintf(stderr, "failed to load kernel BTF\n");
        return -1;
    }

    struct btf_dump_opts opts = { .sz = sizeof(opts) };
    dump = btf_dump__new(btf, btf_dump_printf, NULL, &opts);
    if (libbpf_get_error(dump)) {
        btf__free(btf);
        return -1;
    }

    __s32 id = btf__find_by_name_kind(btf, struct_name, BTF_KIND_STRUCT);
    if (id < 0) {
        fprintf(stderr, "struct %s not found\n", struct_name);
        goto cleanup;
    }

    err = btf_dump__dump_type(dump, id);

cleanup:
    btf_dump__free(dump);
    btf__free(btf);
    return err;
}
```

### Querying Field Offsets

```c
void print_field_offset(const char *struct_name, const char *field_name)
{
    struct btf *btf = btf__load_vmlinux_btf();
    if (libbpf_get_error(btf))
        return;

    __s32 type_id = btf__find_by_name_kind(btf, struct_name, BTF_KIND_STRUCT);
    if (type_id < 0)
        goto out;

    const struct btf_type *t = btf__type_by_id(btf, type_id);
    const struct btf_member *members = btf_members(t);
    __u16 vlen = btf_vlen(t);

    for (int i = 0; i < vlen; i++) {
        const char *name = btf__name_by_offset(btf, members[i].name_off);
        if (strcmp(name, field_name) == 0) {
            __u32 bit_off = btf_member_bit_offset(t, i);
            printf("%s->%s: byte offset %u (bit offset %u)\n",
                struct_name, field_name, bit_off / 8, bit_off);
            goto out;
        }
    }

out:
    btf__free(btf);
}
```

### Using bpftool for BTF Inspection

```bash
# List all types matching a pattern
bpftool btf dump file /sys/kernel/btf/vmlinux format c | grep -E "^struct (tcp|udp|sk_).*\{"

# Show BTF statistics
bpftool btf show

# Dump BTF for a specific program
bpftool btf dump prog pinned /sys/fs/bpf/my_prog

# Compare BTF between two kernel versions
bpftool btf dump file /sys/kernel/btf/vmlinux format c > kernel-5.15.btf.h
bpftool btf dump file /path/to/other/vmlinux format c > kernel-6.1.btf.h
diff kernel-5.15.btf.h kernel-6.1.btf.h | grep "task_struct" | head -20
```

## Section 6: BTF and the BPF Verifier

### Verifier Use of BTF

The BPF verifier uses BTF to enforce type safety. When a program is loaded with BTF, the verifier:

1. **Validates pointer access**: Checks that pointer arithmetic stays within struct bounds
2. **Enforces read-only access**: Prevents modification of kernel memory through typed pointers
3. **Validates map access**: Ensures map operations use correctly typed keys and values
4. **Type-checks helpers**: Validates that BPF helper function arguments match expected types

### BTF-Enabled Program Types

Some program types require BTF for correct operation:

```c
// BTF-based tracepoints (tp_btf) get typed arguments directly
SEC("tp_btf/sched_wakeup")
int handle_wakeup(struct task_struct *p)
{
    // p is a BTF-typed pointer — verifier knows its layout
    __u32 pid = BPF_CORE_READ(p, pid);
    bpf_printk("wakeup: pid=%u\n", pid);
    return 0;
}

// fentry/fexit require BTF for argument types
SEC("fentry/tcp_connect")
int BPF_PROG(trace_tcp_connect, struct sock *sk)
{
    __u32 saddr = BPF_CORE_READ(sk, __sk_common.skc_rcv_saddr);
    bpf_printk("tcp_connect from 0x%x\n", saddr);
    return 0;
}

SEC("fexit/tcp_connect")
int BPF_PROG(trace_tcp_connect_ret, struct sock *sk, int ret)
{
    bpf_printk("tcp_connect returned %d\n", ret);
    return 0;
}
```

### Verifier Error Messages with BTF

Without BTF, verifier errors reference raw register numbers. With BTF, errors include type information:

```
# Without BTF:
R1 invalid mem access 'inv'

# With BTF:
; bpf: store to read-only BPF map area
invalid access to memory, off=0 size=1
R1(id=0,off=0,umax=0,var_off=(0x0; 0x0))
```

## Section 7: Building Portable BPF Programs with libbpf

### Complete CO-RE Program Example

```c
// execsnoop.bpf.c — trace execve calls portably
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

#define TASK_COMM_LEN 16
#define NAME_MAX      255

struct event {
    __u32 pid;
    __u32 ppid;
    __u32 uid;
    __s32 retval;
    char  comm[TASK_COMM_LEN];
    char  filename[NAME_MAX];
};

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 256 * 1024);
} events SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 10240);
    __type(key, __u32);
    __type(value, struct event);
} staging SEC(".maps");

SEC("tp_btf/sys_enter")
int handle_sys_enter(struct trace_event_raw_sys_enter *ctx)
{
    long id = ctx->id;
    if (id != 59 && id != 322)  // __NR_execve, __NR_execveat
        return 0;

    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 pid = pid_tgid >> 32;
    __u32 tid = (__u32)pid_tgid;

    if (pid != tid)
        return 0;

    struct event evt = {};
    evt.pid = pid;
    evt.uid = bpf_get_current_uid_gid();
    bpf_get_current_comm(&evt.comm, sizeof(evt.comm));

    struct task_struct *task = (struct task_struct *)bpf_get_current_task();
    evt.ppid = BPF_CORE_READ(task, real_parent, tgid);

    const char *filename = (const char *)ctx->args[0];
    bpf_probe_read_user_str(&evt.filename, sizeof(evt.filename), filename);

    bpf_map_update_elem(&staging, &tid, &evt, BPF_ANY);
    return 0;
}

SEC("tp_btf/sys_exit")
int handle_sys_exit(struct trace_event_raw_sys_exit *ctx)
{
    long id = ctx->id;
    if (id != 59 && id != 322)
        return 0;

    __u32 tid = (__u32)bpf_get_current_pid_tgid();

    struct event *evtp = bpf_map_lookup_elem(&staging, &tid);
    if (!evtp)
        return 0;

    struct event *evt = bpf_ringbuf_reserve(&events, sizeof(*evt), 0);
    if (!evt) {
        bpf_map_delete_elem(&staging, &tid);
        return 0;
    }

    *evt = *evtp;
    evt->retval = ctx->ret;
    bpf_map_delete_elem(&staging, &tid);
    bpf_ringbuf_submit(evt, 0);
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
```

### Makefile for CO-RE Programs

```makefile
CLANG    ?= clang
BPFTOOL  ?= bpftool
ARCH     ?= $(shell uname -m | sed 's/x86_64/x86/' | sed 's/aarch64/arm64/')

BPF_CFLAGS = -g -O2 -target bpf -D__TARGET_ARCH_$(ARCH) \
             -I/usr/include/$(shell uname -m)-linux-gnu \
             -I./include

# Generate vmlinux.h from running kernel
vmlinux.h:
	$(BPFTOOL) btf dump file /sys/kernel/btf/vmlinux format c > $@

# Compile BPF program
%.bpf.o: %.bpf.c vmlinux.h
	$(CLANG) $(BPF_CFLAGS) -c $< -o $@

# Generate BPF skeleton header
%.skel.h: %.bpf.o
	$(BPFTOOL) gen skeleton $< > $@

# Compile user-space program
%: %.c %.skel.h
	cc -g -O2 -o $@ $< -lbpf -lelf -lz

.PHONY: clean
clean:
	rm -f *.o *.skel.h vmlinux.h execsnoop
```

## Section 8: BTF and Module Support

### Kernel Module BTF

Kernel modules can also export BTF for their types:

```bash
# List BTF objects including modules
bpftool btf show
# 1: name [vmlinux]  size 6090240B
# 2: name [amd_iommu]  size 12560B
# 3: name [xfs]  size 84320B

# Dump module BTF
bpftool btf dump id 3 format c | grep -E "^struct xfs.*\{"
```

### Accessing Module Types in BPF

```c
// Program targeting module-specific types
#include "vmlinux.h"
#include <bpf/bpf_core_read.h>

SEC("fentry/xfs_file_write_iter")
int trace_xfs_write(struct kiocb *iocb)
{
    struct file *f = BPF_CORE_READ(iocb, ki_filp);
    struct inode *inode = BPF_CORE_READ(f, f_inode);

    // Use type existence check for module-specific types
    if (bpf_core_type_exists(struct xfs_inode)) {
        bpf_printk("XFS write to ino=%llu\n",
            BPF_CORE_READ(inode, i_ino));
    }

    return 0;
}
```

## Section 9: Debugging BTF Issues

### Common BTF Problems and Solutions

**Problem: BTF not found for kernel**

```bash
# Check kernel BTF availability
ls -la /sys/kernel/btf/vmlinux
# -r--r--r-- 1 root root 6090240 Apr 11 00:00 /sys/kernel/btf/vmlinux

# Check kernel config
grep BTF /boot/config-$(uname -r)
# CONFIG_DEBUG_INFO_BTF=y
# CONFIG_DEBUG_INFO_BTF_MODULES=y
```

If BTF is not built into the kernel, generate it from debug symbols:

```bash
pahole --btf_encode /boot/vmlinux-$(uname -r)
cp /boot/vmlinux-$(uname -r).btf /sys/kernel/btf/vmlinux
```

**Problem: CO-RE relocation failed**

```bash
# Enable libbpf verbose output
LIBBPF_LOG_LEVEL=debug ./my_bpf_program 2>&1 | grep -i "reloc\|btf\|error"

# Check if field exists in running kernel
bpftool btf dump file /sys/kernel/btf/vmlinux format c | \
  grep -A 50 "struct task_struct {" | grep "pid\b"
```

**Problem: BTF size mismatch**

```bash
# Load with verbose output to see verifier errors
bpftool prog load my_prog.bpf.o /sys/fs/bpf/my_prog 2>&1

# Check struct size in compiled BTF
bpftool btf dump file my_prog.bpf.o | grep "struct event"
```

### BTF Validation Tools

```bash
# Validate BTF blob format
bpftool btf dump file /sys/kernel/btf/vmlinux 2>&1 | tail -5
# Found 123456 types in BTF

# Check for BTF parse errors in kernel log
dmesg | grep -i btf | tail -20

# Trace BTF-related syscalls
strace -e bpf ./my_bpf_loader 2>&1 | grep -E "BPF_BTF_LOAD|BPF_PROG_LOAD"
```

## Summary

BTF is the foundational technology that makes modern eBPF development practical. It enables CO-RE — the ability to compile a BPF program once and run it reliably across kernel versions without recompilation. The key components are:

- `/sys/kernel/btf/vmlinux` — the kernel's exported type information
- `vmlinux.h` — the generated header containing all kernel types
- `BPF_CORE_READ` macros — emit CO-RE relocation records at compile time
- `libbpf` — performs CO-RE relocations at program load time
- `pahole` and `bpftool` — tools for generating, inspecting, and debugging BTF

With BTF and CO-RE, the days of maintaining per-kernel BPF binaries are over. A single compiled BPF object can run on any kernel version from 5.4 onwards that has BTF enabled, making eBPF a reliable foundation for production observability and security tooling.
