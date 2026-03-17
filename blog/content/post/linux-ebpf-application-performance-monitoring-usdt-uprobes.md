---
title: "Linux eBPF for Application Performance Monitoring: User-Space Probes with USDT and uprobes"
date: 2031-09-28T00:00:00-05:00
draft: false
tags: ["eBPF", "Linux", "Performance Monitoring", "USDT", "uprobes", "Observability"]
categories: ["Linux", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical guide to instrumenting production applications with Linux eBPF using USDT and uprobes, covering bpftrace, libbpf, and zero-overhead tracing patterns for latency, allocation, and I/O monitoring."
more_link: "yes"
url: "/linux-ebpf-application-performance-monitoring-usdt-uprobes/"
---

Traditional profiling inserts timing calls into application code or relies on sampling signals that miss fast events. eBPF offers a third path: instrument production applications with sub-microsecond precision, without modifying source code and with negligible overhead when probes are not firing. User-space probes—uprobes for arbitrary function tracing and USDT (User Statically Defined Tracing) for explicitly placed markers—let you observe the internal state of any running process from a privileged kernel context.

This guide covers the mechanics of user-space eBPF probes, practical tracing programs for common performance problems, and the toolchain from bpftrace one-liners to production libbpf programs embedded in your monitoring infrastructure.

<!--more-->

# Linux eBPF Application Performance Monitoring with USDT and uprobes

## How User-Space Probes Work

### uprobes

A uprobe is a kernel breakpoint injected at a specific virtual address within a running process's address space. When execution hits that address, the CPU traps to the kernel, which runs the eBPF program, collects data, and returns control to the process. The overhead is real—function calls that probe frequently can see 100–500 ns overhead—but for infrequently called functions or USDT markers this is negligible.

The kernel identifies uprobe targets by:
- Binary path (e.g., `/usr/bin/python3`)
- Symbol name (resolved via debug symbols or DWARF)
- Byte offset from the binary's load address

### USDT (User Statically Defined Tracing)

USDT markers are NOP instructions embedded in application code at compile time using a macro from `sys/sdt.h`. At rest they cost nothing—a single NOP. When an eBPF program attaches to them, the kernel patches the NOP with a breakpoint instruction. Arguments to the marker are passed through machine registers, visible to the eBPF program as probe arguments.

Runtimes that embed USDT markers: Python, Ruby, Node.js, Java (via JVM), PostgreSQL, MySQL, OpenSSL, GLibC, and most major system libraries.

### Kernel Requirements

```bash
# Check eBPF uprobe support
grep CONFIG_UPROBE_EVENTS /boot/config-$(uname -r)
# CONFIG_UPROBE_EVENTS=y

# Check BTF (needed for CO-RE programs)
ls /sys/kernel/btf/vmlinux

# Required kernel version: 4.17+ for uprobes in eBPF
# Recommended: 5.8+ for ring buffers, 5.11+ for full USDT argument access
uname -r
```

## Toolchain Overview

| Tool | Best For |
|---|---|
| `bpftrace` | One-liners, exploration, incident investigation |
| `BCC Python tools` | Moderate complexity, Python ecosystem |
| `libbpf + CO-RE` | Production daemons, portable across kernel versions |
| `Cilium eBPF (Go)` | Go-based production programs |

This guide focuses on bpftrace for exploration and libbpf/cilium-ebpf for production deployment.

## Prerequisites and Setup

```bash
# Ubuntu / Debian
apt-get install -y bpftrace linux-headers-$(uname -r) \
  libbpf-dev clang llvm

# RHEL / CentOS Stream
dnf install -y bpftrace kernel-devel libbpf-devel clang

# Verify bpftrace
bpftrace --version
bpftrace 0.21.x

# List USDT probes in a binary
bpftrace -l 'usdt:/usr/bin/python3:*' | head -20
# usdt:/usr/bin/python3:python:function__entry
# usdt:/usr/bin/python3:python:function__return
# usdt:/usr/bin/python3:python:line
# usdt:/usr/bin/python3:python:gc__start
# usdt:/usr/bin/python3:python:gc__done

# List uprobes (requires debug symbols or symbol table)
bpftrace -l 'uprobe:/lib/x86_64-linux-gnu/libc.so.6:malloc'
```

## Part 1: bpftrace for Exploration

### Tracing Python Function Calls

Python 3.6+ ships with USDT markers. The `function__entry` probe fires when any Python function is called.

```bash
# Trace every Python function call (high volume — use with caution in production)
bpftrace -e '
usdt:/usr/bin/python3:python:function__entry {
    printf("%-30s %s:%d\n",
        str(arg2),          // function name
        str(arg0),          // filename
        arg1                // line number
    );
}'
```

### Measuring Python Function Latency

```bash
# Measure latency of specific Python functions
bpftrace -e '
usdt:/usr/bin/python3:python:function__entry
/str(arg2) == "handle_request"/ {
    @start[tid] = nsecs;
}

usdt:/usr/bin/python3:python:function__return
/str(arg2) == "handle_request" && @start[tid]/ {
    @latency_us = hist((nsecs - @start[tid]) / 1000);
    delete(@start[tid]);
}

interval:s:10 {
    print(@latency_us);
    clear(@latency_us);
}'
```

### Tracing malloc and free for Memory Analysis

```bash
# Track allocation sizes by call site
bpftrace -e '
uprobe:/lib/x86_64-linux-gnu/libc.so.6:malloc {
    @allocs_by_size = lhist(arg0, 0, 65536, 512);
    @allocs_by_stack[ustack(5)] = count();
}

uretprobe:/lib/x86_64-linux-gnu/libc.so.6:malloc {
    @allocations[retval] = nsecs;
}

uprobe:/lib/x86_64-linux-gnu/libc.so.6:free {
    if (@allocations[arg0]) {
        @lifetime_us = hist((nsecs - @allocations[arg0]) / 1000);
        delete(@allocations[arg0]);
    }
}

interval:s:30 {
    printf("Allocation sizes:\n"); print(@allocs_by_size);
    printf("Allocation lifetimes (us):\n"); print(@lifetime_us);
}' -p $(pgrep my-service)
```

### PostgreSQL Query Latency via USDT

PostgreSQL ships with extensive USDT probes:

```bash
bpftrace -e '
usdt:/usr/lib/postgresql/15/bin/postgres:postgresql:query__start {
    @query_start[pid] = nsecs;
    @query_text[pid] = str(arg0);
}

usdt:/usr/lib/postgresql/15/bin/postgres:postgresql:query__done {
    if (@query_start[pid]) {
        $latency_ms = (nsecs - @query_start[pid]) / 1000000;
        if ($latency_ms > 100) {
            printf("SLOW QUERY (%dms): %.100s\n",
                $latency_ms, @query_text[pid]);
        }
        @query_latency_ms = hist($latency_ms);
        delete(@query_start[pid]);
        delete(@query_text[pid]);
    }
}

interval:s:60 {
    print(@query_latency_ms);
    clear(@query_latency_ms);
}'
```

### OpenSSL Handshake Monitoring

```bash
# Monitor TLS handshake duration and cipher selection
OPENSSL_PATH=$(ldconfig -p | grep libssl | head -1 | awk '{print $4}')

bpftrace -e "
uprobe:${OPENSSL_PATH}:SSL_do_handshake {
    @handshake_start[tid] = nsecs;
}

uretprobe:${OPENSSL_PATH}:SSL_do_handshake {
    if (@handshake_start[tid]) {
        \$latency_us = (nsecs - @handshake_start[tid]) / 1000;
        @tls_handshake_us = hist(\$latency_us);
        delete(@handshake_start[tid]);
    }
}

interval:s:30 {
    print(@tls_handshake_us);
    clear(@tls_handshake_us);
}"
```

## Part 2: Production libbpf Program in C

For production use, bpftrace one-liners are insufficient: you need persistent daemons, structured output, Prometheus metric export, and portability across kernel versions. libbpf with BPF CO-RE (Compile Once – Run Everywhere) provides this.

### Program: HTTP Latency Monitor via uprobes

This program attaches to a hypothetical Go HTTP server and measures handler latency.

```c
// http_latency.bpf.c
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

#define MAX_ENTRIES 10240
#define TASK_COMM_LEN 16

struct event {
    __u32 pid;
    __u64 latency_ns;
    char comm[TASK_COMM_LEN];
    char method[8];
    char path[128];
    __u16 status_code;
};

// Map to store per-goroutine start timestamps
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, MAX_ENTRIES);
    __type(key, __u64);    // goroutine ID
    __type(value, __u64);  // start timestamp
} start_ts SEC(".maps");

// Ring buffer for events
struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 1 << 24);  // 16 MB ring buffer
} events SEC(".maps");

// Histogram buckets for latency
struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, 32);
    __type(key, __u32);
    __type(value, __u64);
} latency_hist SEC(".maps");

// Attach to net/http.(*ServeMux).ServeHTTP entry
SEC("uprobe/serve_http")
int uprobe_serve_http_entry(struct pt_regs *ctx) {
    __u64 gid = bpf_get_current_pid_tgid();
    __u64 ts = bpf_ktime_get_ns();
    bpf_map_update_elem(&start_ts, &gid, &ts, BPF_ANY);
    return 0;
}

// Attach to net/http.(*ServeMux).ServeHTTP return
SEC("uretprobe/serve_http")
int uretprobe_serve_http_return(struct pt_regs *ctx) {
    __u64 gid = bpf_get_current_pid_tgid();
    __u64 *start = bpf_map_lookup_elem(&start_ts, &gid);
    if (!start) return 0;

    __u64 latency = bpf_ktime_get_ns() - *start;
    bpf_map_delete_elem(&start_ts, &gid);

    // Update histogram
    __u32 bucket = 0;
    __u64 ns = latency;
    while (ns > 1000 && bucket < 31) {
        ns /= 2;
        bucket++;
    }
    __u64 *count = bpf_map_lookup_elem(&latency_hist, &bucket);
    if (count) __sync_fetch_and_add(count, 1);

    // Emit detailed event for slow requests (> 10ms)
    if (latency > 10000000ULL) {
        struct event *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
        if (!e) return 0;

        e->pid = bpf_get_current_pid_tgid() >> 32;
        e->latency_ns = latency;
        bpf_get_current_comm(&e->comm, sizeof(e->comm));
        bpf_ringbuf_submit(e, 0);
    }

    return 0;
}

char LICENSE[] SEC("license") = "GPL";
```

### Loader and Exporter in Go (using cilium/ebpf)

```go
// cmd/http-monitor/main.go
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/cilium/ebpf"
	"github.com/cilium/ebpf/link"
	"github.com/cilium/ebpf/ringbuf"
	"github.com/cilium/ebpf/rlimit"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -cc clang HTTPLatency http_latency.bpf.c

var (
	httpLatencyHistogram = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "ebpf_http_request_duration_seconds",
			Help:    "HTTP request latency measured via eBPF uprobe",
			Buckets: prometheus.ExponentialBuckets(0.001, 2, 20),
		},
		[]string{"pid"},
	)
	slowRequestsTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "ebpf_http_slow_requests_total",
		Help: "Total HTTP requests exceeding 10ms threshold",
	})
)

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: http-monitor <pid> <binary-path>")
		os.Exit(1)
	}

	pid := os.Args[1]
	binaryPath := os.Args[2]

	// Remove memlock limit (required for older kernels)
	if err := rlimit.RemoveMemlock(); err != nil {
		slog.Error("removing memlock", "err", err)
		os.Exit(1)
	}

	// Load compiled BPF objects
	objs := HTTPLatencyObjects{}
	if err := LoadHTTPLatencyObjects(&objs, nil); err != nil {
		slog.Error("loading BPF objects", "err", err)
		os.Exit(1)
	}
	defer objs.Close()

	// Open the target binary
	ex, err := link.OpenExecutable(binaryPath)
	if err != nil {
		slog.Error("opening executable", "path", binaryPath, "err", err)
		os.Exit(1)
	}

	// Attach entry uprobe
	entryLink, err := ex.Uprobe(
		"net/http.(*ServeMux).ServeHTTP",
		objs.UprobeServeHttp,
		&link.UprobeOptions{PID: mustAtoi(pid)},
	)
	if err != nil {
		slog.Error("attaching entry uprobe", "err", err)
		os.Exit(1)
	}
	defer entryLink.Close()

	// Attach return uprobe
	returnLink, err := ex.Uretprobe(
		"net/http.(*ServeMux).ServeHTTP",
		objs.UretprobeServeHttp,
		&link.UprobeOptions{PID: mustAtoi(pid)},
	)
	if err != nil {
		slog.Error("attaching return uprobe", "err", err)
		os.Exit(1)
	}
	defer returnLink.Close()

	slog.Info("probes attached", "pid", pid, "binary", binaryPath)

	// Start ring buffer reader
	rd, err := ringbuf.NewReader(objs.Events)
	if err != nil {
		slog.Error("creating ringbuf reader", "err", err)
		os.Exit(1)
	}
	defer rd.Close()

	// Register metrics
	prometheus.MustRegister(httpLatencyHistogram, slowRequestsTotal)

	// Start Prometheus endpoint
	go func() {
		http.Handle("/metrics", promhttp.Handler())
		slog.Info("metrics server", "addr", ":9090")
		http.ListenAndServe(":9090", nil)
	}()

	// Drain ring buffer events
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	go func() {
		for {
			record, err := rd.Read()
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				slog.Warn("ringbuf read", "err", err)
				continue
			}

			var event HTTPLatencyEvent
			if err := parseEvent(record.RawSample, &event); err != nil {
				continue
			}

			latencySeconds := float64(event.LatencyNs) / 1e9
			httpLatencyHistogram.WithLabelValues(fmt.Sprint(event.Pid)).
				Observe(latencySeconds)
			slowRequestsTotal.Inc()

			slog.Info("slow request",
				"pid", event.Pid,
				"latency_ms", float64(event.LatencyNs)/1e6,
				"comm", nullTermString(event.Comm[:]),
			)
		}
	}()

	<-ctx.Done()
	slog.Info("shutting down")
}
```

## Part 3: USDT in Custom Applications

### Adding USDT Markers to a C Application

```c
// my_service.c
#include <sys/sdt.h>
#include <stdio.h>
#include <stdlib.h>

void process_request(int request_id, const char *method, const char *path) {
    // Fire USDT probe on entry — zero cost when no probe attached
    DTRACE_PROBE2(myservice, request__start, request_id, path);

    // ... do work ...

    int status = 200;
    long latency_us = 1234;

    DTRACE_PROBE3(myservice, request__done, request_id, status, latency_us);
}

int main() {
    for (int i = 0; i < 1000; i++) {
        process_request(i, "GET", "/api/v1/items");
    }
    return 0;
}
```

```makefile
# Compile with USDT markers
my_service: my_service.c
	gcc -O2 -g -o my_service my_service.c -lSystemTap-sdt-devel

# Verify USDT markers are embedded
readelf -n my_service | grep -A3 NT_STAPSDT
```

### Adding USDT to Go Applications

Go does not natively compile USDT markers, but the `go-usdt` package provides runtime marker insertion:

```go
// internal/tracing/usdt.go
package tracing

/*
#include <sys/sdt.h>

void probe_request_start(int request_id, const char* path) {
    DTRACE_PROBE2(goservice, request__start, request_id, path);
}

void probe_request_done(int request_id, int status, long latency_us) {
    DTRACE_PROBE3(goservice, request__done, request_id, status, latency_us);
}
*/
import "C"
import "unsafe"

// RequestStart fires the request__start USDT probe.
func RequestStart(requestID int, path string) {
	cs := C.CString(path)
	defer C.free(unsafe.Pointer(cs))
	C.probe_request_start(C.int(requestID), cs)
}

// RequestDone fires the request__done USDT probe.
func RequestDone(requestID, statusCode int, latencyMicros int64) {
	C.probe_request_done(
		C.int(requestID),
		C.int(statusCode),
		C.long(latencyMicros),
	)
}
```

### bpftrace Against Custom USDT Markers

```bash
# List probes in your binary
bpftrace -l 'usdt:./my_service:myservice:*'
# usdt:./my_service:myservice:request__start
# usdt:./my_service:myservice:request__done

# Measure per-request latency using USDT markers
bpftrace -e '
usdt:./my_service:myservice:request__start {
    @req_start[arg0] = nsecs;
}

usdt:./my_service:myservice:request__done {
    if (@req_start[arg0]) {
        $lat = (nsecs - @req_start[arg0]) / 1000;
        @latency_us = lhist($lat, 0, 100000, 1000);
        if (arg1 >= 500) {
            @errors_by_code[arg1] = count();
        }
        delete(@req_start[arg0]);
    }
}

interval:s:10 {
    printf("Request latency (us):\n");
    print(@latency_us);
    printf("Error codes:\n");
    print(@errors_by_code);
    clear(@latency_us);
    clear(@errors_by_code);
}'
```

## Part 4: Advanced Patterns

### Correlating Kernel and User-Space Events

```bash
# Combine uprobe and kprobe to trace the full I/O path
bpftrace -e '
// User space: application calls write()
uprobe:/lib/x86_64-linux-gnu/libc.so.6:write /pid == 12345/ {
    @write_start[tid] = nsecs;
    @write_size[tid] = arg2;
}

// Kernel: block I/O completion
kprobe:blk_account_io_done {
    if (@write_start[tid]) {
        $lat_us = (nsecs - @write_start[tid]) / 1000;
        @io_latency_us = hist($lat_us);
        @io_size_bytes = hist(@write_size[tid]);
        delete(@write_start[tid]);
        delete(@write_size[tid]);
    }
}

interval:s:15 {
    printf("Write-to-block-completion latency (us):\n");
    print(@io_latency_us);
    printf("Write sizes (bytes):\n");
    print(@io_size_bytes);
    clear(@io_latency_us);
    clear(@io_size_bytes);
}'
```

### Node.js V8 Garbage Collector Tracing

Node.js exposes GC events via USDT:

```bash
NODE_BIN=/usr/bin/node

bpftrace -e "
usdt:${NODE_BIN}:node:gc__start {
    @gc_start[tid] = nsecs;
    @gc_type[tid] = arg0;
}

usdt:${NODE_BIN}:node:gc__done {
    if (@gc_start[tid]) {
        \$duration_ms = (nsecs - @gc_start[tid]) / 1000000;
        @gc_by_type[@gc_type[tid]] = hist(\$duration_ms);
        if (\$duration_ms > 50) {
            printf('LONG GC: type=%d duration=%dms\n', @gc_type[tid], \$duration_ms);
        }
        delete(@gc_start[tid]);
        delete(@gc_type[tid]);
    }
}

interval:s:30 {
    // GC types: 1=Scavenge, 2=MarkSweepCompact, 4=IncrementalMarking
    printf('GC duration histogram by type:\n');
    print(@gc_by_type);
    clear(@gc_by_type);
}" -p \$(pgrep node)
```

### JVM (Java) USDT via perf-map-agent

Java requires a helper to expose JVM symbols to the kernel. Once jvmstat is enabled, JIT-compiled frames appear in stack traces:

```bash
# Enable JVM USDT via -XX options
java \
  -XX:+DTraceMethodProbes \
  -XX:+DTraceAllocProbes \
  -XX:+ExtendedDTraceProbes \
  -jar myapp.jar &

JVM_PID=$!

bpftrace -e "
usdt:/proc/${JVM_PID}/root/usr/lib/jvm/java-17/lib/server/libjvm.so:hotspot:method__entry {
    printf('%s.%s\n', str(arg1), str(arg3));
}" -p $JVM_PID
```

## Part 5: Kubernetes Integration

### eBPF Monitor as a DaemonSet

Deploy the eBPF monitor so it can instrument any pod on each node:

```yaml
# ebpf-monitor-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: ebpf-monitor
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: ebpf-monitor
  template:
    metadata:
      labels:
        app: ebpf-monitor
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
    spec:
      hostPID: true   # required to attach to host PIDs
      hostNetwork: true
      tolerations:
        - operator: Exists  # run on all nodes including masters
      containers:
        - name: ebpf-monitor
          image: registry.example.com/ebpf-monitor:v1.2.0
          securityContext:
            privileged: true    # required for uprobe attachment
            capabilities:
              add:
                - SYS_ADMIN
                - SYS_PTRACE
                - NET_ADMIN
          volumeMounts:
            - name: sys
              mountPath: /sys
              readOnly: true
            - name: debugfs
              mountPath: /sys/kernel/debug
            - name: modules
              mountPath: /lib/modules
              readOnly: true
          resources:
            requests:
              cpu: 100m
              memory: 64Mi
            limits:
              cpu: 500m
              memory: 256Mi
          ports:
            - name: metrics
              containerPort: 9090
      volumes:
        - name: sys
          hostPath:
            path: /sys
        - name: debugfs
          hostPath:
            path: /sys/kernel/debug
        - name: modules
          hostPath:
            path: /lib/modules
```

### Auto-Discovery of Probe Targets via Annotations

```go
// Auto-discover pods with uprobe annotations
// Pod annotation: ebpf.monitor/probe: "net/http.(*ServeMux).ServeHTTP"
func (m *Monitor) discoverTargets(ctx context.Context) error {
    pods, err := m.k8sClient.CoreV1().Pods("").List(ctx, metav1.ListOptions{
        LabelSelector: "ebpf.monitor/enabled=true",
    })
    if err != nil {
        return err
    }

    for _, pod := range pods.Items {
        probeTarget := pod.Annotations["ebpf.monitor/probe"]
        if probeTarget == "" {
            continue
        }
        // Resolve container PID in the host namespace
        pid, err := m.containerPID(pod.Name, pod.Namespace)
        if err != nil {
            slog.Warn("cannot resolve PID", "pod", pod.Name, "err", err)
            continue
        }
        m.attachProbe(ctx, pid, probeTarget)
    }
    return nil
}
```

## Overhead and Safety

### Overhead Benchmarks

| Probe Type | Overhead per invocation | Safe in production? |
|---|---|---|
| USDT (idle, no probe) | 0 ns (NOP) | Yes |
| USDT (probe attached) | ~200–400 ns | Yes for < 100k/s |
| uprobe (function entry) | ~400–800 ns | Yes for < 50k/s |
| `bpf_probe_read_user` | +50–100 ns per call | Depends on frequency |

### Safety Guidelines

1. Never use `bpf_probe_read_user` in hot paths — defer expensive reads to sampling programs
2. Keep maps small or use LRU eviction: `BPF_MAP_TYPE_LRU_HASH`
3. Test ring buffer backpressure — if the consumer is slow, the kernel drops events rather than blocking
4. Use `bpftrace`'s `-q` flag to suppress output during high-volume tracing
5. Always set a timer to detach probes if the monitor crashes

## Summary

eBPF user-space probes provide production-safe, zero-install application observability:

- **USDT markers** give you structured, pre-planned observation points at essentially zero cost when idle
- **uprobes** let you attach to any function in any binary without source changes
- **bpftrace** provides rapid exploration during incidents — a full latency histogram in under 30 seconds
- **libbpf/cilium-ebpf** provides portable production programs with Prometheus metric export
- **Kubernetes DaemonSets** with `hostPID` make cluster-wide application monitoring possible

The gap between what traditional APM agents can observe and what eBPF can observe is significant. With eBPF you can trace memory allocation patterns, GC pauses, kernel I/O latency, TLS handshake duration, and custom application events—all from a single kernel-attached program running alongside your workloads.
