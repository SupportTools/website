---
title: "Linux eBPF Verifier: Safety Guarantees and Common Pitfalls"
date: 2029-05-04T00:00:00-05:00
draft: false
tags: ["Linux", "eBPF", "Kernel", "Security", "Performance", "BTF", "Networking"]
categories:
- Linux
- eBPF
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical guide to the Linux eBPF verifier: verification algorithm, complexity limits, loop unrolling, bounded loops, helper function restrictions, BTF type checking, and practical patterns for writing verifier-friendly eBPF programs."
more_link: "yes"
url: "/linux-ebpf-verifier-safety-guarantees-pitfalls/"
---

The eBPF verifier is the security cornerstone of Linux's extended Berkeley Packet Filter subsystem. Before any eBPF program runs in the kernel, the verifier performs a static analysis pass that guarantees the program will terminate, will not read uninitialized memory, will not access memory out of bounds, and will not corrupt kernel data structures. Understanding the verifier's algorithm, its limits, and the patterns it rejects is essential for writing production eBPF programs in tools like Cilium, Falco, bpftrace, and custom observability agents.

<!--more-->

# Linux eBPF Verifier: Safety Guarantees and Common Pitfalls

## What the Verifier Guarantees

Before a program reaches the verifier, the kernel checks:
1. The program type is valid (`BPF_PROG_TYPE_*`)
2. The calling process has `CAP_BPF` (Linux 5.8+) or `CAP_SYS_ADMIN`
3. The program fits within the instruction limit

The verifier then guarantees:
- **Termination**: The program always terminates (no unbounded loops through kernel 5.2; bounded loops since 5.3)
- **Memory safety**: All memory accesses are within bounds and to initialized memory
- **Type safety**: Kernel pointers are used correctly (BTF-aware since kernel 5.2)
- **Helper safety**: BPF helper functions are called with correct argument types
- **Stack safety**: The 512-byte stack is never overflowed

## Verification Algorithm Overview

The verifier performs a depth-first search over all possible execution paths using abstract interpretation:

```
1. Parse bytecode → BPF instructions
2. Build CFG (control flow graph)
3. For each path through CFG:
   a. Track register state (type + value range) symbolically
   b. Track stack slot state (initialized / uninitialized / spilled register)
   c. Verify each instruction against tracked state
   d. If verification fails → reject with error message
4. If all paths pass → accept program
```

### Register State

Each register is tracked as one of:

```
NOT_INIT       -- register has not been written
SCALAR_VALUE   -- integer of known or unknown value
PTR_TO_CTX     -- pointer to the program's context (skb, pt_regs, etc.)
PTR_TO_MAP_KEY         -- pointer to a map key buffer
PTR_TO_MAP_VALUE       -- pointer to a map value
PTR_TO_MAP_VALUE_OR_NULL -- map lookup result, must be NULL-checked
PTR_TO_STACK   -- pointer into the BPF stack
PTR_TO_MEM     -- pointer to a bounded memory region
PTR_TO_PACKET  -- pointer into the network packet
PTR_TO_PACKET_END -- packet end pointer (for bounds checking)
PTR_TO_BTF_ID  -- pointer to a kernel struct with BTF type info
```

### Value Range Tracking

For SCALAR_VALUE registers, the verifier tracks:

```
smin_value, smax_value   -- signed range
umin_value, umax_value   -- unsigned range
var_off.value, var_off.mask  -- known bits (tnum)
```

This allows the verifier to determine that array accesses are in-bounds:

```c
// Verifier tracks that i is in [0, MAX_ENTRIES-1]
// so array[i] is provably safe
if (i >= MAX_ENTRIES)
    return 0;
// After this check: i in [0, MAX_ENTRIES-1]
u64 val = array[i];   // Safe
```

## Complexity Limits

### Instruction Limit

```c
#define BPF_COMPLEXITY_LIMIT_INSNS    1000000  // 1 million instructions verified
```

This is not a runtime instruction limit — it's the number of instructions the verifier explores. On a path with many branches and loops, the verifier may explore far more instructions than the program contains.

```bash
# Check verification stats
strace -e bpf bpftool prog load my_prog.o /sys/fs/bpf/my_prog 2>&1 | grep -A5 "BPF_PROG_LOAD"

# Or via libbpf verbose output
LIBBPF_LOG_LEVEL=debug bpftool prog load my_prog.o /sys/fs/bpf/my_prog
```

### Stack Depth Limit

```c
#define MAX_BPF_STACK  512  // bytes
```

Each function call in eBPF tail calls is counted separately. The verifier tracks the maximum stack frame used and rejects programs that exceed 512 bytes.

```c
// Bad: each local variable consumes stack
int large_function(struct xdp_md *ctx) {
    char buf1[128];   // 128 bytes
    char buf2[128];   // 256 bytes
    char buf3[128];   // 384 bytes
    char buf4[128];   // 512 bytes — limit!
    // buf5[128] would fail verification
}

// Better: use per-CPU maps for large buffers
struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(max_entries, 1);
    __type(key, u32);
    __type(value, char[4096]);
} scratch_map SEC(".maps");

int efficient_function(struct xdp_md *ctx) {
    u32 key = 0;
    char *buf = bpf_map_lookup_elem(&scratch_map, &key);
    if (!buf)
        return XDP_DROP;
    // Now we have 4096 bytes of scratch space
}
```

### Maximum Function Call Depth

```c
#define MAX_BPF_FUNC_REG_ARGS  5
#define MAX_BPF_FUNC_STACK_DEPTH  8  // Maximum call depth for static calls
```

## Loops: From Prohibition to Bounded Loops

### Pre-5.3: Loop Unrolling Only

Before kernel 5.3, loops were forbidden. The workaround was pragma unroll:

```c
// Forced loop unrolling (clang pragma)
#pragma unroll
for (int i = 0; i < 16; i++) {
    // The compiler unrolls this to 16 copies of the body
    // Verifier sees 16 sequential instruction blocks, not a loop
    process_byte(data[i]);
}
```

This works but generates large programs for large loop counts.

### Kernel 5.3+: Bounded Loops

The verifier can now verify loops if it can prove they terminate in a bounded number of iterations:

```c
// The verifier can prove this loop terminates
// because i is monotonically increasing toward MAX_ENTRIES
for (u32 i = 0; i < MAX_ENTRIES; i++) {
    u64 *val = bpf_map_lookup_elem(&my_map, &i);
    if (val && *val > threshold) {
        count++;
    }
}
```

### Loop Verification Pitfalls

```c
// BAD: verifier cannot prove termination
// (start could be > end after arithmetic overflow)
for (u32 i = start; i < end; i++) {  // REJECTION: unbounded
    process(i);
}

// GOOD: explicit bound check
u32 limit = min(end - start, MAX_ITERATIONS);
for (u32 i = 0; i < limit; i++) {    // ACCEPTED: provably bounded
    process(start + i);
}
```

```c
// BAD: loop with pointer arithmetic the verifier can't track
struct data_hdr *p = (struct data_hdr *)data;
while (p < (struct data_hdr *)data_end) {  // REJECTION
    process(p);
    p = p->next;   // verifier can't prove p->next < data_end
}

// GOOD: index-based with explicit bounds
for (int i = 0; i < MAX_HEADERS && data + sizeof(*p) <= data_end; i++) {
    struct data_hdr *p = (struct data_hdr *)(data + i * sizeof(*p));
    if ((void *)(p + 1) > data_end)
        break;
    process(p);
}
```

### bpf_loop (Kernel 5.17+)

`bpf_loop` is a helper that verifies loop safety without requiring the verifier to explore every iteration:

```c
struct loop_ctx {
    u64 sum;
    u64 threshold;
};

static long count_above_threshold(u32 index, struct loop_ctx *ctx) {
    u64 *val = bpf_map_lookup_elem(&values_map, &index);
    if (val && *val > ctx->threshold)
        ctx->sum++;
    return 0;  // 0 = continue, 1 = stop
}

int xdp_prog(struct xdp_md *xdp) {
    struct loop_ctx ctx = { .sum = 0, .threshold = 100 };
    bpf_loop(MAX_ENTRIES, count_above_threshold, &ctx, 0);
    // ...
}
```

The verifier treats `bpf_loop` as a single helper call and verifies only the callback, not the loop itself.

## Pointer Safety: NULL Checks and Bounds Checking

### Map Lookup Must Be NULL-Checked

```c
// BAD: using map lookup result without NULL check
u64 *counter = bpf_map_lookup_elem(&counters, &key);
(*counter)++;  // REJECTION: PTR_TO_MAP_VALUE_OR_NULL cannot be dereferenced

// GOOD: always NULL-check map lookups
u64 *counter = bpf_map_lookup_elem(&counters, &key);
if (!counter)
    return 0;
(*counter)++;  // ACCEPTED: PTR_TO_MAP_VALUE, known non-null
```

### Packet Bounds Checking

Every packet access must be guarded by bounds checks against `data_end`:

```c
SEC("xdp")
int xdp_parser(struct xdp_md *ctx) {
    void *data     = (void *)(long)ctx->data;
    void *data_end = (void *)(long)ctx->data_end;

    // BAD: no bounds check
    struct ethhdr *eth = data;
    u8 proto = eth->h_proto;  // REJECTION: unchecked packet access

    // GOOD: bounds check before access
    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return XDP_DROP;
    u16 proto = eth->h_proto;  // ACCEPTED

    // Advance to IP header
    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return XDP_DROP;

    // Access IP fields safely
    u8 ip_proto = ip->protocol;
    u32 saddr   = ip->saddr;

    return XDP_PASS;
}
```

### Pointer Arithmetic Restrictions

```c
// BAD: unbounded pointer arithmetic
void *p = data + offset;  // REJECTION if offset is unbounded scalar

// GOOD: bounded offset with explicit check
if (offset + sizeof(struct mydata) > (u32)(data_end - data))
    return XDP_DROP;
void *p = data + offset;  // ACCEPTED after bounds check

// GOOD: using bpf_skb_load_bytes for safe reads
u32 value;
if (bpf_skb_load_bytes(skb, offset, &value, sizeof(value)) < 0)
    return TC_ACT_OK;
```

## Helper Function Restrictions

### Context-Specific Helpers

Not all helpers are available in all program types. The verifier checks helper availability:

| Helper | kprobe | XDP | TC | Tracepoint | sk_msg |
|---|---|---|---|---|---|
| bpf_map_lookup_elem | Y | Y | Y | Y | Y |
| bpf_skb_load_bytes | N | N | Y | N | N |
| bpf_xdp_adjust_head | N | Y | N | N | N |
| bpf_probe_read_kernel | Y | N | N | Y | N |
| bpf_get_current_pid_tgid | Y | N | N | Y | N |
| bpf_perf_event_output | Y | Y | Y | Y | N |
| bpf_ringbuf_output | Y | Y | Y | Y | Y |

Calling a helper not available for the program type results in immediate rejection.

### Helper Argument Type Checking

```c
// Helper signature: bpf_probe_read_kernel(void *dst, u32 size, const void *src)
// All args must match expected types

u8 buf[16];

// BAD: size exceeds stack allocation
bpf_probe_read_kernel(buf, 64, ptr);  // REJECTION: size > sizeof(buf) = 16

// BAD: dst is NULL
bpf_probe_read_kernel(NULL, sizeof(buf), ptr);  // REJECTION: NULL not allowed

// GOOD:
bpf_probe_read_kernel(buf, sizeof(buf), ptr);   // ACCEPTED
```

### bpf_probe_read vs bpf_probe_read_kernel vs bpf_probe_read_user

```c
// Reading kernel memory (kprobes, tracepoints)
bpf_probe_read_kernel(&val, sizeof(val), kernel_ptr);

// Reading user memory (syscall probes, user-space tracing)
bpf_probe_read_user(&val, sizeof(val), user_ptr);

// DO NOT mix: using kernel read on user ptr may succeed but reads wrong memory
// DO NOT use deprecated bpf_probe_read (no longer distinguishes k/u)
```

## BTF Type Checking (CO-RE)

BTF (BPF Type Format) enables Compile-Once-Run-Everywhere (CO-RE) programs that work across kernel versions.

### BTF-Aware Pointer Access

Without BTF, structure offsets are hardcoded at compile time and break across kernel versions. With BTF, the BPF loader relocates field accesses:

```c
// CO-RE: field access via BPF_CORE_READ
// Offset of task_struct->pid is resolved at load time from the running kernel's BTF
SEC("kprobe/wake_up_new_task")
int trace_new_task(struct pt_regs *ctx) {
    struct task_struct *task = (struct task_struct *)PT_REGS_PARM1(ctx);

    // BAD: hardcoded offset, breaks across kernel versions
    pid_t pid = *(pid_t *)((char *)task + 2432);  // FRAGILE

    // GOOD: CO-RE relocation
    pid_t pid = BPF_CORE_READ(task, pid);          // PORTABLE
    pid_t tgid = BPF_CORE_READ(task, tgid);

    bpf_printk("new task pid=%d tgid=%d\n", pid, tgid);
    return 0;
}
```

### BTF Verifier Checks

With BTF, the verifier tracks the kernel type of every `PTR_TO_BTF_ID` register and enforces:

```c
// Verifier knows that task->files is of type struct files_struct*
struct files_struct *files = BPF_CORE_READ(task, files);

// Attempting to treat files as a different type is rejected
struct mm_struct *mm = (struct mm_struct *)files;  // REJECTION: type mismatch
```

## Verifier Error Messages

Understanding verifier error messages is essential for debugging:

### "R0 !read_ok"

```
0: (b7) r0 = 0
1: (95) exit
R0 !read_ok
```

Cause: Register 0 must contain the return value before `exit`. The program returned before setting `r0`.

### "invalid mem access 'map_value_or_null'"

```
12: (85) call bpf_map_lookup_elem#1
13: (79) r1 = *(u64 *)(r0 +0)
invalid mem access 'map_value_or_null'
```

Cause: Missing NULL check after `bpf_map_lookup_elem`.

Fix:
```c
u64 *val = bpf_map_lookup_elem(&my_map, &key);
if (!val)    // Add this NULL check
    return 0;
u64 v = *val;  // Now safe
```

### "R1 min value is negative, either use unsigned or 'var &= const'"

```
45: (1f) r0 -= r1
46: (7a) *(u64 *)(r0 +0) = 0
R1 min value is negative, either use unsigned or 'var &= const'
```

Cause: A signed integer is being used as a pointer offset, and the verifier cannot prove it is non-negative.

Fix:
```c
// BAD: signed offset
s32 offset = get_offset();
u8 *ptr = buf + offset;  // REJECTION

// GOOD: bounds-checked unsigned offset
u32 offset = (u32)get_offset();
if (offset >= sizeof(buf))
    return 0;
u8 *ptr = buf + offset;  // ACCEPTED
```

### "back-edge from insn X to Y"

```
; for (int i = 0; i < n; i++) {
back-edge from insn 23 to 15
```

Cause: The verifier found a backward jump (loop) that it cannot prove terminates.

Fix: Ensure the loop bound is a compile-time constant or add explicit bound checking.

## Writing Verifier-Friendly Code

### Pattern 1: Mask Before Use

```c
// Force value into known range with bitmask
u32 index = event->cpu & (MAX_CPUS - 1);  // Mask to [0, MAX_CPUS-1]
u64 *counter = cpu_counters + index;        // Safe array access
```

### Pattern 2: Per-CPU Maps for Large Storage

```c
// Avoid large stack allocations
struct large_ctx {
    char buffer[4096];
    u64  metrics[64];
    // ... more fields
};

struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(max_entries, 1);
    __type(key, u32);
    __type(value, struct large_ctx);
} ctx_map SEC(".maps");

SEC("xdp")
int prog(struct xdp_md *xdp) {
    u32 key = 0;
    struct large_ctx *ctx = bpf_map_lookup_elem(&ctx_map, &key);
    if (!ctx) return XDP_ABORTED;
    // Use ctx->buffer safely
}
```

### Pattern 3: Helper-Based String Operations

```c
// BAD: manual string copy (verifier struggles with loop over unknown length)
for (int i = 0; i < len; i++) buf[i] = src[i];

// GOOD: use bpf_probe_read_kernel_str
int len = bpf_probe_read_kernel_str(buf, sizeof(buf), src);
```

### Pattern 4: Avoid Conditional Pointer Aliasing

```c
// BAD: verifier must track both possibilities
void *p;
if (condition)
    p = buf_a;
else
    p = buf_b;
*(u32 *)p = val;  // Verifier may reject: cannot determine buffer size

// GOOD: explicit per-branch access
if (condition) {
    buf_a[0] = val;
} else {
    buf_b[0] = val;
}
```

### Pattern 5: Avoid Recursion

eBPF programs cannot call themselves recursively. Use tail calls for chaining:

```c
// Use BPF_MAP_TYPE_PROG_ARRAY for tail calls
struct {
    __uint(type, BPF_MAP_TYPE_PROG_ARRAY);
    __uint(max_entries, 8);
    __type(key, u32);
    __type(value, u32);
} prog_array SEC(".maps");

SEC("xdp")
int stage1(struct xdp_md *ctx) {
    // Process stage 1
    bpf_tail_call(ctx, &prog_array, 1);  // Jump to stage2
    return XDP_DROP;  // If tail call fails
}

SEC("xdp")
int stage2(struct xdp_md *ctx) {
    // Process stage 2
    return XDP_PASS;
}
```

## Debugging Verifier Rejections

### Enable Verifier Log

```c
// libbpf: enable verbose verifier output
struct bpf_object_open_opts opts = {
    .kernel_log_level = 1,      // 1=errors, 2=stats, 4=verbose
    .kernel_log_size  = 1 << 20, // 1MB log buffer
};
struct bpf_object *obj = bpf_object__open_opts("prog.o", &opts);
```

```bash
# bpftool with verbose verifier output
bpftool prog load my_prog.o /sys/fs/bpf/my_prog \
  type xdp \
  log_level 4 \
  2>&1 | head -200
```

### Reading the Verifier Log

The verifier log shows the register state after each instruction:

```
0: (61) r1 = *(u32 *)(r1 +4)
  ; ctx->data_end
  R1_w=pkt_end(id=0,off=0,imm=0) R10=fp0
1: (61) r2 = *(u32 *)(r6 +0)
  ; ctx->data
  R2_w=pkt(id=0,off=0,r=0,imm=0) R6_w=ctx(id=0,off=0,imm=0)
2: (bf) r3 = r2
  R2_w=pkt(id=0,off=0,r=0,imm=0) R3_w=pkt(id=0,off=0,r=0,imm=0)
3: (07) r3 += 14
  R3_w=pkt(id=0,off=14,r=0,imm=0)
4: (2d) if r3 > r1 goto pc+8
  R1_w=pkt_end(id=0,off=0,imm=0) R3_w=pkt(id=0,off=14,r=14,imm=0)
  ; after bounds check: r=14 means 14 bytes are verified accessible
```

The `r=14` in `pkt(id=0,off=14,r=14,imm=0)` means the verifier knows 14 bytes from the packet start are accessible.

## Kernel Version Compatibility

| Feature | Kernel Version |
|---|---|
| Basic verifier | 3.18 |
| Bounded loops | 5.3 |
| BTF CO-RE | 5.2 |
| bpf_loop helper | 5.17 |
| Struct ops | 5.6 |
| Signed division safety | 5.7 |
| 1M instruction limit (was 4096) | 5.2 |
| bpf_timer | 5.15 |
| Iterator programs | 5.15 |
| kfunc helpers (BTF-based) | 5.13 |

Always test on your target kernel version. Verifier behavior changes subtly between versions as new optimizations are added.
