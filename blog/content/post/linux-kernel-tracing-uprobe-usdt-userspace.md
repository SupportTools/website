---
title: "Linux Kernel Tracing: Uprobe and USDT Probes for Userspace"
date: 2029-09-11T00:00:00-05:00
draft: false
tags: ["Linux", "eBPF", "Uprobe", "USDT", "Tracing", "Observability", "bpftrace"]
categories: ["Linux", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux uprobe and USDT (Statically Defined Tracing) probes for userspace observability: uprobe mechanics, bpftrace syntax, tracing Go binaries without USDT support, and OpenTelemetry eBPF integration."
more_link: "yes"
url: "/linux-kernel-tracing-uprobe-usdt-userspace/"
---

Kernel tracing probes are not limited to kernel functions. Uprobes and USDT (User Statically Defined Tracing) probes bring the same dynamic instrumentation capability to userspace binaries — without recompiling applications, without adding sidecar processes, and with negligible performance impact when probes are inactive. This post covers the mechanics of uprobes, USDT probe conventions, bpftrace syntax for both, the workaround for tracing Go binaries (which lack native USDT support), and integration with OpenTelemetry's eBPF instrumentation layer.

<!--more-->

# Linux Kernel Tracing: Uprobe and USDT Probes for Userspace

## Uprobe Mechanics

A uprobe is a software breakpoint inserted into a userspace binary at a specific virtual address. The kernel intercepts execution at that address, invokes the probe handler, then resumes execution. The uprobe mechanism works as follows:

1. The kernel reads the target binary and calculates the virtual address of the instrumentation point
2. It inserts a breakpoint instruction (`int3` on x86-64, `brk` on ARM64) at that address in the process's memory mapping
3. When the CPU executes the breakpoint, it traps into the kernel
4. The kernel runs the uprobe handler (an eBPF program or perf event handler)
5. The original instruction is restored and execution continues

This is similar to how debuggers work, but uprobes are managed by the kernel and can instrument all processes running the same binary simultaneously.

### Uprobe vs Kprobe

| Property | kprobe | uprobe |
|---|---|---|
| Target | Kernel functions | Userspace functions |
| Address space | Kernel | Per-process |
| Applies to | All processes | Processes with matching binary |
| Overhead (active) | ~100ns | ~100-300ns |
| Overhead (inactive) | None | None |
| Requires debug symbols | No (function name lookup) | For function names; raw address works without |

## bpftrace Uprobe Syntax

bpftrace provides the `uprobe` and `uretprobe` probe types for attaching to userspace function entry and return.

### Basic Uprobe Attachment

```bash
# Attach to a function entry point by name
# Requires the binary to have function symbols (not stripped)
bpftrace -e 'uprobe:/usr/bin/python3:PyObject_Call { printf("Python function called\n"); }'

# Attach by offset from binary start (works with stripped binaries)
bpftrace -e 'uprobe:/usr/bin/nginx:0x12345 { printf("offset probe hit\n"); }'

# Attach to return from a function
bpftrace -e 'uretprobe:/usr/lib/libc.so.6:malloc {
    printf("malloc returned: %p\n", retval);
}'

# Attach to a specific PID only
bpftrace -p 12345 -e 'uprobe:/usr/bin/myapp:processRequest {
    printf("processRequest called, args[0]=%d\n", arg0);
}'
```

### Examining Function Arguments

uprobe handlers can access function arguments through the `arg0` through `arg9` built-ins (x86-64 calling convention: arg0-arg5 are registers RDI, RSI, RDX, RCX, R8, R9):

```bash
# Trace nginx request handling with URL capture
bpftrace -e '
uprobe:/usr/sbin/nginx:ngx_http_process_request
{
    $req = (struct ngx_http_request_s *)arg0;
    printf("nginx request: method=%d uri_len=%d\n",
        $req->method,
        $req->uri.len);
}'

# Monitor PostgreSQL query execution with query text
bpftrace -e '
uprobe:/usr/lib/postgresql/15/bin/postgres:exec_simple_query
{
    printf("pg query: %s\n", str(arg0));
}'

# Trace Redis command dispatch
bpftrace -e '
uprobe:/usr/bin/redis-server:call
{
    printf("redis cmd: %s\n", str(((struct redisCommand *)arg0)->name));
}'
```

### Measuring Function Latency

```bash
# Measure latency of any userspace function
bpftrace -e '
uprobe:/usr/bin/myapp:handleHTTPRequest
{
    @start[tid] = nsecs;
}
uretprobe:/usr/bin/myapp:handleHTTPRequest
/@start[tid]/
{
    $duration = nsecs - @start[tid];
    @latency_us = hist($duration / 1000);
    delete(@start[tid]);
}
interval:s:10
{
    print(@latency_us);
    clear(@latency_us);
}'
```

## USDT: User Statically Defined Tracing

USDT probes are probe points compiled into applications at specific locations. Unlike uprobes (which can be attached anywhere), USDT probes are explicit markers the application developer places at meaningful semantic boundaries.

### USDT Probe Format

When an application includes USDT probes, they appear as `nop` instructions in the binary with associated ELF metadata. The `nop` means USDT probes have zero overhead when no tracer is attached.

```bash
# List USDT probes in a binary
tplist -l /usr/bin/python3
# b'/usr/bin/python3' b'python':b'import__find__load__start'
# b'/usr/bin/python3' b'python':b'import__find__load__done'
# b'/usr/bin/python3' b'python':b'function__entry'
# b'/usr/bin/python3' b'python':b'function__return'
# b'/usr/bin/python3' b'python':b'line'
# b'/usr/bin/python3' b'python':b'gc__start'
# b'/usr/bin/python3' b'python':b'gc__done'

# Or with readelf for ELF-based inspection
readelf -n /usr/bin/python3 | grep "stapsdt"
```

### Attaching to USDT Probes with bpftrace

The bpftrace USDT syntax uses `usdt:binary:provider:probe`:

```bash
# Trace Python function entry/return
bpftrace -e '
usdt:/usr/bin/python3:python:function__entry
{
    printf("Python func entry: file=%s line=%d func=%s\n",
        str(arg0), arg1, str(arg2));
}
usdt:/usr/bin/python3:python:function__return
{
    printf("Python func return: file=%s line=%d func=%s\n",
        str(arg0), arg1, str(arg2));
}'

# Trace JVM garbage collection
bpftrace -e '
usdt:/usr/lib/jvm/java-17-openjdk/lib/server/libjvm.so:hotspot:gc__begin
{
    printf("GC began at %lu ns\n", nsecs);
}
usdt:/usr/lib/jvm/java-17-openjdk/lib/server/libjvm.so:hotspot:gc__end
{
    printf("GC ended at %lu ns\n", nsecs);
}'

# Monitor Node.js HTTP requests via USDT probes
bpftrace -e '
usdt:/usr/bin/node:node:http__server__request
{
    printf("HTTP request: url=%s method=%s\n",
        str(arg0), str(arg1));
}'
```

### Adding USDT Probes to C/C++ Applications

```c
/* app.c */
#include <sys/sdt.h>

void processRequest(const char *method, const char *url, int status) {
    /* USDT probe fires here with the specified arguments */
    DTRACE_PROBE3(myapp, request__start, method, url, status);

    /* ... process request ... */

    DTRACE_PROBE2(myapp, request__done, url, status);
}

/* Build with USDT support */
// gcc -o myapp app.c -lsystemtap-sdt
```

```bash
# Verify probes are embedded
readelf -n myapp | grep stapsdt
# Notes at offset 0x... with length 0x...:
#   Owner         Data size       Description
#   stapsdt       0x...           NT_STAPSDT (SystemTap probe descriptors)
#     Provider: myapp
#     Name: request__start
#     Location: 0x..., Base: 0x..., Semaphore: 0x...
#     Arguments: -4@%rdi -4@%rsi -4@%rdx

# Now trace it
bpftrace -e '
usdt:./myapp:myapp:request__start
{
    printf("request: method=%s url=%s\n", str(arg0), str(arg1));
}'
```

## Tracing Go Binaries: The Challenge

Go binaries have a significant limitation for uprobe tracing: **Go does not support USDT probes natively** (as of Go 1.23). The reasons:

1. Go uses a non-standard calling convention (args on stack, not registers, in older versions)
2. Go 1.17+ switched to register-based calling convention, but without USDT instrumentation points
3. Go's stack-growing mechanism (goroutine stacks) makes frame pointer assumptions unreliable
4. Go lacks `sys/sdt.h` equivalent in its standard library

### Uprobe-Based Go Binary Tracing

Despite lacking USDT, uprobes work on Go binaries with some caveats:

```bash
# List function symbols in a Go binary (not stripped)
nm -D mygoapp | grep ' T '
# Note: Go function names contain dots, which need escaping in bpftrace

# Attach uprobe to a Go function entry
# Go function names are mangled: github.com/user/pkg.FunctionName becomes:
# github.com/user/pkg.FunctionName (with dots and slashes)

# Use the full mangled name in bpftrace
bpftrace -e '
uprobe:./mygoapp:"main.processRequest"
{
    printf("processRequest called\n");
}'

# For package functions:
bpftrace -e '
uprobe:./mygoapp:"github.com/myorg/myapp/handlers.HandleHTTP"
{
    printf("HandleHTTP called\n");
}'
```

### Go Register-Based Calling Convention

Since Go 1.17, function arguments are passed in registers (RAX, RBX, RCX, RDI, RSI, R8, R9, R10, R11 on amd64). This differs from the C calling convention that bpftrace's `arg0`-`arg9` assumes:

```bash
# Go calling convention (amd64, Go 1.17+):
# arg0: AX (RAX)
# arg1: BX (RBX)
# arg2: CX (RCX)
# arg3: DI (RDI)
# arg4: SI (RSI)
# arg5: R8
# arg6: R9
# arg7: R10
# arg8: R11

# bpftrace's arg0 maps to C's arg0 (RDI on amd64, which is Go's arg3)
# To read Go's first argument, use register() builtin:

bpftrace -e '
uprobe:./mygoapp:"main.processRequest"
{
    # Go arg0 is in AX, not arg0 (which bpftrace maps to RDI)
    printf("first Go arg: %d\n", reg("ax"));
}'
```

### A Practical Go Tracing Script

```bash
#!/usr/bin/env bpftrace
// Trace Go HTTP handler execution times
// Works with go1.17+ register-based calling convention

uprobe:/usr/local/bin/mygoapp:"net/http.(*ServeMux).ServeHTTP"
{
    // In Go's calling convention, the first arg (receiver) is in AX
    // Second arg (ResponseWriter) is in BX
    // Third arg (*Request) is in CX
    @start[tid] = nsecs;
    @tid_to_goroutine[tid] = reg("cx");
}

uretprobe:/usr/local/bin/mygoapp:"net/http.(*ServeMux).ServeHTTP"
/@start[tid]/
{
    $dur = nsecs - @start[tid];
    @http_latency_us = hist($dur / 1000);
    delete(@start[tid]);
    delete(@tid_to_goroutine[tid]);
}

interval:s:30
{
    print(@http_latency_us);
    clear(@http_latency_us);
}
```

### Go-Specific Uprobe Tools

The `bpf-go` project and Pixie provide Go-aware uprobe tooling:

```bash
# Install pixie for automatic Go application tracing
px deploy

# Pixie automatically discovers Go HTTP/gRPC services and traces them
# without manual probe specification
px live px/http_data

# Or use gops for Go runtime inspection (not eBPF, but useful complement)
go install github.com/google/gops@latest
gops $(pgrep mygoapp)
```

## OpenTelemetry eBPF Auto-Instrumentation

OpenTelemetry's eBPF-based auto-instrumentation layer uses uprobes to instrument Go, Python, and Node.js applications automatically, generating distributed traces without code changes.

### OpenTelemetry Go Auto-Instrumentation

```yaml
# Deploy as a DaemonSet in Kubernetes
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: otel-ebpf-agent
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: otel-ebpf-agent
  template:
    metadata:
      labels:
        app: otel-ebpf-agent
    spec:
      hostPID: true          # Required: access to host PID namespace
      hostNetwork: true      # Required: access to network interfaces
      containers:
        - name: otel-ebpf-agent
          image: ghcr.io/open-telemetry/opentelemetry-go-instrumentation/autoinstrumentation-go:v0.14.0
          securityContext:
            privileged: true  # Required for eBPF program loading
            capabilities:
              add:
                - SYS_ADMIN   # eBPF map and program management
                - SYS_PTRACE  # uprobe attachment
                - NET_ADMIN   # Network tracing
          env:
            - name: OTEL_EXPORTER_OTLP_ENDPOINT
              value: "http://otel-collector:4317"
            - name: OTEL_GO_AUTO_TARGET_EXE
              value: "/usr/local/bin/mygoapp"
            - name: OTEL_SERVICE_NAME
              value: "my-go-service"
          volumeMounts:
            - name: kernel-debug
              mountPath: /sys/kernel/debug
            - name: proc
              mountPath: /proc
      volumes:
        - name: kernel-debug
          hostPath:
            path: /sys/kernel/debug
        - name: proc
          hostPath:
            path: /proc
      tolerations:
        - operator: Exists
```

### What OpenTelemetry eBPF Instruments

The Go auto-instrumentation library attaches uprobes to:

```
net/http.(*Transport).roundTrip     -> HTTP client spans
net/http.(*ServeMux).ServeHTTP      -> HTTP server spans
google.golang.org/grpc.(*ClientConn).Invoke -> gRPC client spans
google.golang.org/grpc.(*Server).handleStream -> gRPC server spans
database/sql.(*DB).QueryContext     -> Database spans
```

It reconstructs trace context across goroutines by tracking goroutine IDs and their parent relationships through uprobe data.

## Writing eBPF Programs for Uprobes

For complex tracing scenarios, write the eBPF program in C and load it with `libbpf`:

```c
// uprobe_tracer.c
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

struct event {
    u32 pid;
    u64 timestamp;
    u64 duration_ns;
    char func_name[64];
};

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 256 * 1024);
} events SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 10240);
    __type(key, u32);
    __type(value, u64);
} start_times SEC(".maps");

// Uprobe: fires on function entry
SEC("uprobe/main_handleRequest")
int BPF_UPROBE(uprobe_entry)
{
    u32 tid = bpf_get_current_pid_tgid();
    u64 ts = bpf_ktime_get_ns();
    bpf_map_update_elem(&start_times, &tid, &ts, BPF_ANY);
    return 0;
}

// Uretprobe: fires on function return
SEC("uretprobe/main_handleRequest")
int BPF_URETPROBE(uretprobe_return)
{
    u32 tid = bpf_get_current_pid_tgid();
    u64 *start = bpf_map_lookup_elem(&start_times, &tid);

    if (!start)
        return 0;

    struct event *e = bpf_ringbuf_reserve(&events, sizeof(struct event), 0);
    if (!e) {
        bpf_map_delete_elem(&start_times, &tid);
        return 0;
    }

    e->pid = tid >> 32;
    e->timestamp = *start;
    e->duration_ns = bpf_ktime_get_ns() - *start;
    __builtin_memcpy(e->func_name, "handleRequest", 14);

    bpf_ringbuf_submit(e, 0);
    bpf_map_delete_elem(&start_times, &tid);
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
```

### Loading the eBPF Program with Go

```go
package main

import (
    "bytes"
    "encoding/binary"
    "fmt"
    "log"
    "os"
    "os/signal"

    "github.com/cilium/ebpf"
    "github.com/cilium/ebpf/link"
    "github.com/cilium/ebpf/ringbuf"
)

//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -cc clang uprobe_tracer uprobe_tracer.c

type Event struct {
    PID        uint32
    Timestamp  uint64
    DurationNS uint64
    FuncName   [64]byte
}

func main() {
    if len(os.Args) < 2 {
        log.Fatal("Usage: tracer <binary_path>")
    }
    binaryPath := os.Args[1]

    // Load pre-compiled eBPF programs
    objs := uprobe_tracerObjects{}
    if err := loadUprobe_tracerObjects(&objs, nil); err != nil {
        log.Fatalf("Loading objects: %v", err)
    }
    defer objs.Close()

    // Open the target executable
    ex, err := link.OpenExecutable(binaryPath)
    if err != nil {
        log.Fatalf("Opening executable: %v", err)
    }

    // Attach uprobe to function entry
    up, err := ex.Uprobe("main.handleRequest", objs.UprobeEntry, nil)
    if err != nil {
        log.Fatalf("Attaching uprobe: %v", err)
    }
    defer up.Close()

    // Attach uretprobe to function return
    urp, err := ex.Uretprobe("main.handleRequest", objs.UretprobeReturn, nil)
    if err != nil {
        log.Fatalf("Attaching uretprobe: %v", err)
    }
    defer urp.Close()

    // Read events from ring buffer
    rd, err := ringbuf.NewReader(objs.Events)
    if err != nil {
        log.Fatalf("Creating ringbuf reader: %v", err)
    }
    defer rd.Close()

    // Handle signals
    stopper := make(chan os.Signal, 1)
    signal.Notify(stopper, os.Interrupt)

    go func() {
        <-stopper
        rd.Close()
    }()

    fmt.Println("Tracing... Press Ctrl+C to stop")
    for {
        record, err := rd.Read()
        if err != nil {
            break
        }

        var event Event
        if err := binary.Read(bytes.NewReader(record.RawSample), binary.LittleEndian, &event); err != nil {
            continue
        }

        funcName := string(bytes.TrimRight(event.FuncName[:], "\x00"))
        fmt.Printf("PID %d | %s | duration=%v μs\n",
            event.PID,
            funcName,
            float64(event.DurationNS)/1000)
    }
}
```

## Performance Overhead Analysis

```bash
# Benchmark uprobe overhead
# Method: run target application with and without probes

# Without probes
wrk -t4 -c100 -d30s http://localhost:8080/api/test
# Requests/sec: 45,230

# With uprobe attached to handler function
bpftrace -e 'uprobe:/usr/local/bin/server:"main.handleRequest" { @c++ }' &
sleep 1  # Let probe attach
wrk -t4 -c100 -d30s http://localhost:8080/api/test
# Requests/sec: 44,891

# Overhead: (45230 - 44891) / 45230 = 0.75%

# With complex probe (string reading, map operations)
bpftrace -e '
uprobe:/usr/local/bin/server:"main.handleRequest"
{
    @start[tid] = nsecs;
    @path[tid] = str(reg("cx"));  # Read URL string
}
uretprobe:/usr/local/bin/server:"main.handleRequest"
{
    @lat[str(@path[tid])] = hist((nsecs - @start[tid]) / 1000);
    delete(@start[tid]);
    delete(@path[tid]);
}' &
sleep 1
wrk -t4 -c100 -d30s http://localhost:8080/api/test
# Requests/sec: 43,100

# Overhead with complex probe: ~4.7%
# Still acceptable for production debugging
```

## Summary

Uprobes and USDT probes give operators powerful zero-modification observability into production applications:

- Uprobes insert breakpoints at specific binary addresses; USDT probes are pre-placed `nop` instructions with ELF metadata
- bpftrace syntax: `uprobe:/path/to/bin:function_name` and `usdt:/path/to/bin:provider:probe`
- Go binaries lack native USDT support; use uprobes with register-aware argument reading (`reg("ax")` for first arg)
- Go 1.17+ uses register-based calling: AX=arg0, BX=arg1, CX=arg2, DI=arg3, SI=arg4
- OpenTelemetry's eBPF auto-instrumentation automates Go/HTTP/gRPC tracing via uprobes in Kubernetes
- uprobe overhead is typically 1-5% under production load — acceptable for temporary debugging
- Use `tplist` to discover available USDT probes in any binary
- Complex eBPF programs can be written in C and loaded with `cilium/ebpf` for production tracing infrastructure
