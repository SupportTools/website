---
title: "Linux BPF Type Format (BTF): CO-RE Portability, pahole Tooling, and libbpf Skeleton Workflow"
date: 2031-10-18T00:00:00-05:00
draft: false
tags: ["Linux", "eBPF", "BTF", "CO-RE", "libbpf", "Kernel", "Observability"]
categories:
- Linux
- eBPF
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to BPF Type Format (BTF), CO-RE compile-once run-everywhere portability, pahole-based type extraction, and the libbpf skeleton workflow for writing portable production eBPF programs."
more_link: "yes"
url: "/linux-bpf-type-format-btf-core-portability-pahole-libbpf-skeleton/"
---

BPF Type Format (BTF) is the mechanism that makes modern eBPF programs portable across Linux kernel versions without recompilation. Without BTF, every eBPF program had to be compiled against the exact kernel headers of the target system. BTF combined with CO-RE (Compile Once, Run Everywhere) eliminates this constraint, enabling the distribution of pre-compiled BPF objects that adapt to the running kernel at load time. This guide covers BTF internals, the pahole toolchain, and the complete libbpf skeleton workflow for production programs.

<!--more-->

# Linux BPF Type Format (BTF): CO-RE Portability, pahole, and libbpf Skeletons

## Section 1: What BTF Is and Why It Matters

### The Problem BTF Solves

Before BTF, a BPF program accessing `task_struct->pid` had to know the exact byte offset of `pid` within `task_struct` at compile time. Kernel struct layouts change between versions, between distributions, and even between kernel configurations. Programs compiled against kernel 5.15 headers would silently read garbage data or crash on 6.1.

BTF is a compact type description format embedded into the kernel image and into compiled BPF object files. It encodes struct layouts, enum values, function signatures, and type relationships using a type-indexed tree of descriptor records.

### BTF in the Kernel

```bash
# Check if the running kernel has BTF embedded
ls -lh /sys/kernel/btf/vmlinux

# Dump the size
wc -c /sys/kernel/btf/vmlinux

# Inspect BTF types with bpftool
bpftool btf dump file /sys/kernel/btf/vmlinux format c | grep -A 20 "struct task_struct "

# Or dump a specific type
bpftool btf dump file /sys/kernel/btf/vmlinux format c | \
  awk '/^struct task_struct \{/,/^};/' | head -50
```

### Generating vmlinux.h

`vmlinux.h` is a single giant header file containing ALL kernel types, generated from the BTF blob. It replaces dozens of individual kernel headers.

```bash
# Generate vmlinux.h for the running kernel
bpftool btf dump file /sys/kernel/btf/vmlinux format c > vmlinux.h
wc -l vmlinux.h  # typically 500,000+ lines

# For a kernel image (not the running kernel)
bpftool btf dump file /path/to/vmlinux format c > vmlinux.h
```

## Section 2: pahole — Type Layout Analysis

`pahole` (PAding HOLE analyzer) is the canonical tool for analyzing struct layouts and generating BTF.

### Installation

```bash
# Ubuntu/Debian
apt-get install dwarves

# RHEL/Rocky
dnf install dwarves

# Build from source for latest features
git clone https://git.kernel.org/pub/scm/devel/pahole/pahole.git
cd pahole
mkdir build && cd build
cmake -D__LIB=lib ..
make install
```

### Inspecting Struct Layouts

```bash
# Show layout of task_struct with padding holes
pahole -C task_struct /proc/kcore

# Show all structs in a compiled BPF object
pahole mybpf.bpf.o

# Show a specific struct from a compiled object
pahole -C mydata mybpf.bpf.o

# Count padding bytes in all structs (find poorly packed structs)
pahole --show_reorg_steps /proc/kcore 2>/dev/null | grep "Savings"
```

### Generating BTF with pahole

When clang compiles a BPF program with DWARF debug info, pahole converts DWARF to BTF:

```bash
# Compile BPF with DWARF
clang -g -O2 -target bpf -c mybpf.bpf.c -o mybpf.bpf.o

# Convert DWARF to BTF (done automatically by bpftool skeleton workflow)
pahole --btf_encode_detached mybpf.bpf.btf mybpf.bpf.o

# Verify BTF is embedded
bpftool btf dump file mybpf.bpf.o
```

### BTF Encoder Options for Production Builds

```makefile
# Makefile snippet for production BPF build with BTF
CLANG ?= clang
BPFTOOL ?= bpftool
PAHOLE ?= pahole

BPF_CFLAGS := -g -O2 -target bpf -D__TARGET_ARCH_x86
BPF_CFLAGS += -I./include -I/usr/include/bpf
BPF_CFLAGS += -mcpu=v3  # Use BTFv3 features
BPF_CFLAGS += -fno-stack-protector

%.bpf.o: %.bpf.c vmlinux.h
	$(CLANG) $(BPF_CFLAGS) -c $< -o $@
	# Encode BTF (newer clang handles this; older clang needs pahole)
	$(PAHOLE) --btf_encode_detached $(basename $@).btf $@

vmlinux.h:
	$(BPFTOOL) btf dump file /sys/kernel/btf/vmlinux format c > $@
```

## Section 3: CO-RE Internals

CO-RE relies on three components working together:

1. **BTF in the BPF object** — describes what the program *thinks* the kernel types look like (based on vmlinux.h at compile time)
2. **BTF in the running kernel** — describes what the types *actually* look like
3. **libbpf relocation engine** — patches byte offsets at load time using both BTF sources

### CO-RE Relocation Types

```c
// These macros trigger CO-RE relocations at load time:

// Field offset relocation — most common
pid_t pid = BPF_CORE_READ(task, pid);
// Equivalent to: pid = task->pid (with offset patched at load time)

// Field existence check — program adapts when field was added/removed
if (bpf_core_field_exists(task->exit_code)) {
    int code = BPF_CORE_READ(task, exit_code);
}

// Type size relocation
u32 size = bpf_core_type_size(struct task_struct);

// Enum value relocation (handles enum member renaming between kernels)
u32 state = BPF_CORE_READ_BITFIELD(task, __state);
```

### Complete CO-RE BPF Program Example

```c
// process_tracer.bpf.c
// Traces process creation with CO-RE portability

#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

#define TASK_COMM_LEN 16
#define MAX_FILENAME_LEN 512

// Event sent to userspace via ring buffer
struct process_event {
    u32 pid;
    u32 tgid;
    u32 ppid;
    u32 uid;
    u8  comm[TASK_COMM_LEN];
    u8  filename[MAX_FILENAME_LEN];
    u64 start_time;
    int retval;
};

// Ring buffer map for events
struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 256 * 1024); // 256KB
} events SEC(".maps");

// Per-CPU temporary storage to avoid stack overflow
struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(max_entries, 1);
    __type(key, u32);
    __type(value, struct process_event);
} tmp_storage SEC(".maps");

static __always_inline struct process_event *get_tmp_event(void) {
    u32 key = 0;
    return bpf_map_lookup_elem(&tmp_storage, &key);
}

SEC("tp/syscalls/sys_enter_execve")
int handle_execve_enter(struct trace_event_raw_sys_enter *ctx) {
    struct process_event *event = get_tmp_event();
    if (!event)
        return 0;

    struct task_struct *task = (struct task_struct *)bpf_get_current_task();

    // CO-RE reads — offsets patched at load time
    event->pid   = BPF_CORE_READ(task, pid);
    event->tgid  = BPF_CORE_READ(task, tgid);
    event->ppid  = BPF_CORE_READ(task, real_parent, tgid);
    event->uid   = bpf_get_current_uid_gid() & 0xffffffff;
    event->start_time = BPF_CORE_READ(task, start_time);

    bpf_get_current_comm(event->comm, sizeof(event->comm));

    // Read filename argument from syscall context
    const char *filename_ptr = (const char *)ctx->args[0];
    bpf_probe_read_user_str(event->filename, sizeof(event->filename), filename_ptr);

    // Store PID for exit probe correlation
    u64 pid_tgid = bpf_get_current_pid_tgid();
    bpf_map_update_elem(&tmp_storage, &(u32){0}, event, BPF_ANY);

    return 0;
}

SEC("tp/syscalls/sys_exit_execve")
int handle_execve_exit(struct trace_event_raw_sys_exit *ctx) {
    struct process_event *tmp = get_tmp_event();
    if (!tmp)
        return 0;

    struct process_event *event = bpf_ringbuf_reserve(&events, sizeof(*event), 0);
    if (!event)
        return 0;

    __builtin_memcpy(event, tmp, sizeof(*event));
    event->retval = ctx->ret;

    bpf_ringbuf_submit(event, 0);
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
```

## Section 4: libbpf Skeleton Workflow

The skeleton workflow generates C code from a compiled BPF object that handles loading, attaching, and managing maps without boilerplate.

### Step 1: Compile BPF Object

```bash
clang -g -O2 -target bpf \
  -D__TARGET_ARCH_x86 \
  -I./include \
  -c process_tracer.bpf.c \
  -o process_tracer.bpf.o
```

### Step 2: Generate Skeleton Header

```bash
bpftool gen skeleton process_tracer.bpf.o > process_tracer.skel.h
```

The generated skeleton contains:

```c
// process_tracer.skel.h (generated - do not edit)
// Key sections:

struct process_tracer_bpf {
    struct bpf_object_skeleton *skeleton;
    struct bpf_object *obj;
    struct {
        struct bpf_map *events;
        struct bpf_map *tmp_storage;
    } maps;
    struct {
        struct bpf_program *handle_execve_enter;
        struct bpf_program *handle_execve_exit;
    } progs;
    struct {
        struct bpf_link *handle_execve_enter;
        struct bpf_link *handle_execve_exit;
    } links;
};

static inline struct process_tracer_bpf *process_tracer_bpf__open(void);
static inline int process_tracer_bpf__load(struct process_tracer_bpf *obj);
static inline int process_tracer_bpf__attach(struct process_tracer_bpf *obj);
static inline void process_tracer_bpf__destroy(struct process_tracer_bpf *obj);
// ... (generated implementations)
```

### Step 3: Userspace Consumer Program

```c
// process_tracer.c — userspace side
#include <stdio.h>
#include <stdlib.h>
#include <signal.h>
#include <unistd.h>
#include <errno.h>
#include <bpf/libbpf.h>
#include "process_tracer.skel.h"

#define TASK_COMM_LEN 16
#define MAX_FILENAME_LEN 512

struct process_event {
    uint32_t pid;
    uint32_t tgid;
    uint32_t ppid;
    uint32_t uid;
    uint8_t  comm[TASK_COMM_LEN];
    uint8_t  filename[MAX_FILENAME_LEN];
    uint64_t start_time;
    int      retval;
};

static volatile bool running = true;

static void sig_handler(int sig) {
    running = false;
}

static int handle_event(void *ctx, void *data, size_t data_sz) {
    struct process_event *e = data;
    if (e->retval < 0)
        return 0;  // Skip failed execves

    printf("%-8d %-8d %-8d %-8d %-16s %s\n",
        e->pid, e->tgid, e->ppid, e->uid,
        e->comm, e->filename);
    return 0;
}

static int libbpf_print_fn(enum libbpf_print_level level,
                            const char *format, va_list args) {
    if (level == LIBBPF_DEBUG)
        return 0;
    return vfprintf(stderr, format, args);
}

int main(int argc, char **argv) {
    struct process_tracer_bpf *skel = NULL;
    struct ring_buffer *rb = NULL;
    int err;

    libbpf_set_print(libbpf_print_fn);

    signal(SIGINT,  sig_handler);
    signal(SIGTERM, sig_handler);

    // Open and configure BPF application
    skel = process_tracer_bpf__open();
    if (!skel) {
        fprintf(stderr, "Failed to open BPF skeleton\n");
        return 1;
    }

    // Load & verify BPF programs (CO-RE relocations applied here)
    err = process_tracer_bpf__load(skel);
    if (err) {
        fprintf(stderr, "Failed to load BPF skeleton: %d\n", err);
        goto cleanup;
    }

    // Attach tracepoints
    err = process_tracer_bpf__attach(skel);
    if (err) {
        fprintf(stderr, "Failed to attach BPF skeleton: %d\n", err);
        goto cleanup;
    }

    // Set up ring buffer polling
    rb = ring_buffer__new(bpf_map__fd(skel->maps.events), handle_event, NULL, NULL);
    if (!rb) {
        fprintf(stderr, "Failed to create ring buffer\n");
        err = -1;
        goto cleanup;
    }

    printf("%-8s %-8s %-8s %-8s %-16s %s\n",
        "PID", "TGID", "PPID", "UID", "COMM", "FILENAME");

    while (running) {
        err = ring_buffer__poll(rb, 100 /* timeout ms */);
        if (err == -EINTR) {
            err = 0;
            break;
        }
        if (err < 0) {
            fprintf(stderr, "Error polling ring buffer: %d\n", err);
            break;
        }
    }

cleanup:
    ring_buffer__free(rb);
    process_tracer_bpf__destroy(skel);
    return err < 0 ? -err : 0;
}
```

### Step 4: Build System Integration

```makefile
# Makefile for CO-RE BPF project
CLANG    ?= clang
BPFTOOL  ?= bpftool
CC       ?= gcc
LIBBPF   ?= /usr/lib/x86_64-linux-gnu/libbpf.a

ARCH     := $(shell uname -m | sed 's/x86_64/x86/' | sed 's/aarch64/arm64/')
BPF_CFLAGS := -g -O2 -target bpf -D__TARGET_ARCH_$(ARCH)
BPF_CFLAGS += -I./include -I/usr/include

USER_CFLAGS := -g -O2 -Wall
USER_LDFLAGS := -lbpf -lelf -lz

.PHONY: all clean

all: process_tracer

vmlinux.h:
	$(BPFTOOL) btf dump file /sys/kernel/btf/vmlinux format c > $@

process_tracer.bpf.o: process_tracer.bpf.c vmlinux.h
	$(CLANG) $(BPF_CFLAGS) -c $< -o $@

process_tracer.skel.h: process_tracer.bpf.o
	$(BPFTOOL) gen skeleton $< > $@

process_tracer: process_tracer.c process_tracer.skel.h
	$(CC) $(USER_CFLAGS) $< -o $@ $(USER_LDFLAGS)

clean:
	rm -f vmlinux.h *.bpf.o *.skel.h process_tracer
```

## Section 5: BTF Maps and Typed Maps

```c
// typed_maps.bpf.c — using BTF-annotated maps

#include "vmlinux.h"
#include <bpf/bpf_helpers.h>

// Connection tracking entry
struct conn_entry {
    __u32 saddr;
    __u32 daddr;
    __u16 sport;
    __u16 dport;
    __u8  proto;
    __u8  state;
    __u64 bytes_in;
    __u64 bytes_out;
    __u64 last_seen_ns;
};

// Connection key
struct conn_key {
    __u32 saddr;
    __u32 daddr;
    __u16 sport;
    __u16 dport;
    __u8  proto;
} __attribute__((packed));

// BTF-annotated hash map — bpftool and debuggers can decode entries
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 65536);
    __type(key, struct conn_key);
    __type(value, struct conn_entry);
} conn_table SEC(".maps");

// Per-CPU stats array
struct cpu_stats {
    __u64 packets_in;
    __u64 packets_out;
    __u64 bytes_in;
    __u64 bytes_out;
    __u64 drops;
};

struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(max_entries, 1);
    __type(key, __u32);
    __type(value, struct cpu_stats);
} cpu_stats SEC(".maps");
```

```bash
# With BTF-annotated maps, bpftool can pretty-print map contents
bpftool map dump name conn_table

# Output:
# [{
#     "key": {
#         "saddr": 167772161,
#         "daddr": 167772162,
#         "sport": 54321,
#         "dport": 443,
#         "proto": 6
#     },
#     "value": {
#         "saddr": 167772161,
#         ...
#         "bytes_in": 12345,
#         "last_seen_ns": 1728086400000000000
#     }
# }]
```

## Section 6: Kernel Version Detection and Conditional CO-RE

```c
// kernel_version.bpf.c — conditionally use newer kernel features

#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_core_read.h>

// Check if a field exists in this kernel version
static __always_inline int task_has_exit_signal(struct task_struct *task) {
    if (bpf_core_field_exists(task->exit_signal))
        return BPF_CORE_READ(task, exit_signal);
    return -1;
}

// Check if a newer field exists (added in kernel 5.14)
static __always_inline u64 get_task_runtime_ns(struct task_struct *task) {
    if (bpf_core_field_exists(task->se.sum_exec_runtime))
        return BPF_CORE_READ(task, se.sum_exec_runtime);
    // Fallback for older kernels
    return 0;
}

// Enum value portability — TCP_ESTABLISHED changed in some kernels
static __always_inline bool is_tcp_established(int state) {
    // BPF_CORE_READ_BITFIELD handles both old (0x01) and new enum values
    return state == BPF_CORE_ENUM_VALUE(enum tcp_state, TCP_ESTABLISHED);
}
```

## Section 7: Debugging BTF and CO-RE Issues

### BTF Dump and Inspection

```bash
# Show all BTF types in a compiled object
bpftool btf dump file process_tracer.bpf.o

# Show specific type by name
bpftool btf dump file process_tracer.bpf.o format c | \
  awk '/struct process_event/,/^};/'

# Verify CO-RE relocations were applied during load
# (requires kernel 5.15+ for map reloc info)
bpftool prog show name handle_execve_enter
bpftool prog dump xlated name handle_execve_enter

# Check for BTF ID used by a loaded program
bpftool prog show id 42 -p | jq '.btf_id'
bpftool btf dump id $(bpftool prog show id 42 -p | jq '.btf_id')
```

### Common CO-RE Failures

```bash
# Error: "cannot find field X in struct Y"
# Means the kernel struct no longer has this field
# Fix: add bpf_core_field_exists() check

# Error: "failed to find BTF for kernel"
# Means /sys/kernel/btf/vmlinux is missing
# Fix: ensure CONFIG_DEBUG_INFO_BTF=y and CONFIG_DEBUG_INFO=y
grep -E "CONFIG_DEBUG_INFO_BTF|CONFIG_DEBUG_INFO" /boot/config-$(uname -r)

# Error: "CO-RE relocations: failed relo #N"
# Enable libbpf verbose output
export LIBBPF_LOG_LEVEL=DEBUG
./process_tracer 2>&1 | grep -E "CO-RE|relo|BTF"

# Verify the kernel BTF supports the struct you need
bpftool btf dump file /sys/kernel/btf/vmlinux format c | \
  grep -c "struct task_struct"
```

### Building for Multiple Kernels (CI Pipeline)

```bash
#!/usr/bin/env bash
# build-multi-kernel.sh — builds and tests BPF on multiple kernel BTFs
set -euo pipefail

KERNELS=("5.15" "6.1" "6.6" "6.12")
BPF_OBJECT="process_tracer.bpf.o"

for kver in "${KERNELS[@]}"; do
    BTF_FILE="/var/lib/btfhub/ubuntu/22.04/x86_64/${kver}.btf"
    if [[ ! -f "${BTF_FILE}" ]]; then
        echo "WARNING: BTF file for ${kver} not found, skipping"
        continue
    fi

    echo "Testing CO-RE relocations against kernel ${kver}..."
    # bpftool can apply relocations against a specific BTF file
    bpftool gen object "${BPF_OBJECT}.${kver}" "${BPF_OBJECT}" \
      --btf "${BTF_FILE}" && echo "  OK: ${kver}" || echo "  FAIL: ${kver}"
done
```

## Section 8: BTF for Kernel Modules

```bash
# Check if a module has BTF
ls /sys/kernel/btf/

# Typical output:
# kvm  kvm_intel  nvme  nvme_core  vmlinux  xfs

# Load module BTF
bpftool btf dump file /sys/kernel/btf/xfs format c | grep "struct xfs_inode"

# BPF program accessing module types needs split BTF
# The module BTF references the vmlinux BTF for base types
```

```c
// module_aware.bpf.c — accessing XFS-specific types via module BTF
#include "vmlinux.h"
// XFS module types are auto-included via split BTF at load time
// No separate include needed when using bpftool skeleton workflow

SEC("fentry/xfs_file_read_iter")
int BPF_PROG(trace_xfs_read, struct kiocb *iocb, struct iov_iter *to) {
    // Accessing xfs_inode requires the xfs module BTF to be present
    struct file *file = iocb->ki_filp;
    struct inode *inode = file->f_inode;

    // BPF_CORE_READ handles cross-BTF (vmlinux + module) resolution
    u64 ino = BPF_CORE_READ(inode, i_ino);
    bpf_printk("xfs read: inode=%llu\n", ino);
    return 0;
}
```

## Section 9: Production Distribution of BPF Programs

### Using BTFHub for Pre-Built BTF Files

```bash
# BTFHub provides BTF files for common distro kernels
git clone https://github.com/aquasecurity/btfhub-archive /var/lib/btfhub

# Structure:
# /var/lib/btfhub/
#   ubuntu/22.04/x86_64/5.15.0-91-generic.btf
#   rhel/8/x86_64/4.18.0-477.el8.x86_64.btf
#   ...

# Embed BTF files in your distribution tarball
tar czf my-bpf-tool.tar.gz \
  my_tool \
  btf/ubuntu/22.04/x86_64/*.btf \
  btf/rhel/9/x86_64/*.btf
```

### Runtime BTF Selection

```c
// userspace_loader.c — selects correct BTF at runtime
#include <bpf/libbpf.h>
#include <sys/utsname.h>

static const char *find_btf_file(void) {
    struct utsname uts;
    uname(&uts);

    // Try running kernel first
    if (access("/sys/kernel/btf/vmlinux", R_OK) == 0)
        return NULL;  // NULL means "use running kernel BTF"

    // Construct path for btfhub file
    static char path[512];
    snprintf(path, sizeof(path),
        "/opt/my-tool/btf/%s.btf", uts.release);

    if (access(path, R_OK) == 0)
        return path;

    fprintf(stderr, "No BTF found for kernel %s\n", uts.release);
    return NULL;
}

int main(void) {
    struct bpf_object_open_opts opts = {
        .sz = sizeof(opts),
        .btf_custom_path = find_btf_file(),
    };

    struct my_tool_bpf *skel = my_tool_bpf__open_opts(&opts);
    // ... rest of load/attach flow
}
```

## Section 10: Testing Framework for CO-RE Programs

```bash
# test-core.sh — automated CO-RE correctness tests
#!/usr/bin/env bash
set -euo pipefail

# Run BPF selftests for CO-RE (requires kernel source)
cd /usr/src/linux-$(uname -r)/tools/testing/selftests/bpf
make -j$(nproc) && ./test_progs -t core_reloc -v

# Test with vmtest (runs BPF tests in a VM with a specific kernel)
# https://github.com/kernel-patches/vmtest
./vmtest.sh -k 6.1 ./test_progs -t core_reloc
```

## Summary

BTF and CO-RE represent the definitive solution to BPF portability. The production workflow is:

1. Compile BPF with `-g` (DWARF) using clang targeting the `bpf` architecture
2. Generate `vmlinux.h` via `bpftool btf dump` — this gives you all kernel types at compile time
3. Use `BPF_CORE_READ` instead of direct pointer dereferences for any kernel struct access
4. Generate a skeleton header with `bpftool gen skeleton` — this eliminates all libbpf boilerplate in userspace
5. At load time, libbpf patches all CO-RE relocations using the running kernel's BTF
6. For distribution, embed BTF files from BTFHub for kernels that lack built-in BTF

The pahole tool serves as a diagnostic companion — use it to verify struct layout assumptions and to convert DWARF to BTF in build pipelines where clang's built-in BTF emission is insufficient.
