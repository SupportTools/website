---
title: "Linux Observability with eBPF and bpftrace: Production Debugging Guide"
date: 2027-09-18T00:00:00-05:00
draft: false
tags: ["Linux", "eBPF", "bpftrace", "Observability", "Debugging"]
categories:
- Linux
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Using eBPF and bpftrace for production Linux observability — bpftrace one-liners, BCC tools, custom eBPF programs for latency profiling, syscall tracing, network flow analysis, and Kubernetes container-level observability."
more_link: "yes"
url: "/linux-observability-ebpf-bpftrace-guide/"
---

eBPF has transformed Linux observability by enabling safe, programmable kernel instrumentation without patching or loading kernel modules. Combined with bpftrace's high-level scripting language, engineers can trace syscall patterns, network flows, file I/O latency distributions, and CPU scheduler decisions at nanosecond resolution — all without restarting processes or incurring significant overhead. This guide covers production-grade eBPF and bpftrace usage across real operational scenarios including container-level Kubernetes observability.

<!--more-->

# Linux Observability with eBPF and bpftrace: Production Debugging Guide

## Section 1: Prerequisites and Installation

### Kernel Version Requirements

```bash
# Minimum kernel versions for key features:
# eBPF programs:           3.15+
# bpftrace:                4.9+ (5.2+ recommended for full feature set)
# BTF (BPF Type Format):   5.2+ — enables CO-RE (compile once, run everywhere)
# Ring buffer:             5.8+
# LSM programs:            5.7+

uname -r

# Check BTF availability (required for CO-RE)
ls -la /sys/kernel/btf/vmlinux

# Check BPF JIT (required for acceptable performance)
sysctl net.core.bpf_jit_enable
# Should return 1

# Enable BPF JIT hardening in production
sysctl -w net.core.bpf_jit_harden=2
```

### Installing bpftrace and BCC

```bash
# Ubuntu 22.04+ / Debian 12+
apt-get install -y bpftrace bpfcc-tools linux-headers-$(uname -r)

# RHEL 9 / Rocky Linux 9
dnf install -y bpftrace bcc-tools kernel-devel

# Verify installation
bpftrace --version
bpftrace -l 'tracepoint:syscalls:*' | head -20

# BCC tools directory
ls /usr/share/bcc/tools/
# biolatency  execsnoop  memleak  offcputime  opensnoop  profile  tcpconnect ...
```

---

## Section 2: bpftrace Language Fundamentals

### Probe Types Reference

```
# bpftrace probe types:
# kprobe:function        — kernel function entry
# kretprobe:function     — kernel function return
# tracepoint:cat:name    — stable kernel tracepoints (preferred)
# usdt:path:provider:name — userspace static probes
# uprobe:path:function   — userspace function entry
# uretprobe:path:function — userspace function return
# software:event         — software perf events (page-faults, cs, etc.)
# hardware:event         — hardware PMU events (cache-misses, etc.)
# interval:s:n           — timer fires every n seconds
# profile:hz:n           — samples all threads at n Hz
```

### Core Built-in Variables

```
# Key built-in variables available in every probe:
# pid      — process ID of the current thread
# tid      — thread ID
# uid      — user ID
# comm     — process name (up to 16 characters)
# nsecs    — nanoseconds since system boot
# elapsed  — nanoseconds since bpftrace started
# cpu      — current CPU number
# args     — tracepoint/USDT argument struct
# retval   — return value (kretprobe/uretprobe only)
# func     — current probe function name
# kstack   — kernel stack trace
# ustack   — user stack trace
```

### Quick One-Liners

```bash
# Count syscalls by process name
bpftrace -e 'tracepoint:raw_syscalls:sys_enter { @[comm] = count(); }'

# Trace all open() calls with filename
bpftrace -e 'tracepoint:syscalls:sys_enter_openat { printf("%s %s\n", comm, str(args->filename)); }'

# Block I/O size distribution
bpftrace -e 'tracepoint:block:block_rq_issue { @bytes = hist(args->bytes); }'

# TCP connections by destination port
bpftrace -e 'kprobe:tcp_connect { @[((struct sock*)arg0)->__sk_common.skc_dport] = count(); }'

# CPU run-queue latency (histogram in microseconds)
bpftrace -e '
tracepoint:sched:sched_wakeup { @ts[args->pid] = nsecs; }
tracepoint:sched:sched_switch {
  if (@ts[args->next_pid]) {
    @us = hist((nsecs - @ts[args->next_pid]) / 1000);
    delete(@ts[args->next_pid]);
  }
}'

# Process new file opens by path prefix
bpftrace -e 'tracepoint:syscalls:sys_enter_openat /str(args->filename) != ""/ { @[str(args->filename)] = count(); }'
```

---

## Section 3: Syscall Tracing in Production

### High-Rate Syscall Identification

```
#!/usr/bin/env bpftrace
// File: syscall-rate.bt
// Purpose: identify top syscalls by rate per process, refreshed every 5s

tracepoint:raw_syscalls:sys_enter
{
    @calls[comm, args->id] = count();
}

interval:s:5
{
    printf("\n=== Top syscalls (5s window) ===\n");
    print(@calls, 20);
    clear(@calls);
}
```

```bash
# Run the script
bpftrace syscall-rate.bt

# Sample output:
# @calls[nginx, 45]: 12543     (recvfrom)
# @calls[nginx, 44]: 12541     (sendto)
# @calls[postgres, 7]: 8920    (poll)
```

### Syscall Latency Distribution

```
#!/usr/bin/env bpftrace
// File: syscall-latency.bt
// Purpose: measure read/write syscall latency distribution

tracepoint:syscalls:sys_enter_read,
tracepoint:syscalls:sys_enter_write
{
    @start[tid] = nsecs;
}

tracepoint:syscalls:sys_exit_read,
tracepoint:syscalls:sys_exit_write
/@start[tid]/
{
    $latency_us = (nsecs - @start[tid]) / 1000;

    if (probe == "tracepoint:syscalls:sys_exit_read") {
        @read_us = hist($latency_us);
    } else {
        @write_us = hist($latency_us);
    }

    delete(@start[tid]);
}

END
{
    printf("\n=== Read latency (us) ===\n");
    print(@read_us);
    printf("\n=== Write latency (us) ===\n");
    print(@write_us);
}
```

### Slow Syscall Detection with Stack Traces

```
#!/usr/bin/env bpftrace
// File: slow-syscalls.bt
// Purpose: capture kernel+user stacks for syscalls exceeding 1ms threshold

tracepoint:raw_syscalls:sys_enter
{
    @entry[tid] = nsecs;
}

tracepoint:raw_syscalls:sys_exit
/@entry[tid] && (nsecs - @entry[tid]) > 1000000/
{
    $delta_ms = (nsecs - @entry[tid]) / 1000000;
    printf("SLOW syscall: comm=%s pid=%d duration=%dms syscall=%d\n",
           comm, pid, $delta_ms, args->id);
    printf("  Kernel:\n");
    print(kstack(8));
    printf("  User:\n");
    print(ustack(8));
    delete(@entry[tid]);
}
```

---

## Section 4: Network Flow Analysis

### TCP Connection Tracking

```
#!/usr/bin/env bpftrace
// File: tcp-connections.bt
// Purpose: trace new TCP connections with source/destination details

#include <linux/socket.h>
#include <net/sock.h>

kprobe:tcp_connect
{
    $sk = (struct sock *)arg0;
    $dport_raw = $sk->__sk_common.skc_dport;
    $dport = ($dport_raw >> 8) | (($dport_raw & 0xff) << 8);

    printf("CONNECT pid=%-6d comm=%-20s dport=%d\n",
           pid, comm, $dport);
}

kretprobe:inet_csk_accept
/retval/
{
    $sk = (struct sock *)retval;
    $lport = $sk->__sk_common.skc_num;
    printf("ACCEPT  pid=%-6d comm=%-20s lport=%d\n",
           pid, comm, $lport);
}

tracepoint:sock:inet_sock_set_state
/args->newstate == 1/
{
    printf("TCP_ESTABLISHED sport=%-6d dport=%-6d pid=%d\n",
           args->sport, args->dport, pid);
}
```

### Per-Process Network I/O Accounting

```
#!/usr/bin/env bpftrace
// File: net-io-accounting.bt
// Purpose: bytes sent and received per process (10-second windows)

kprobe:tcp_sendmsg
{
    @sent_bytes[pid, comm] = sum(arg2);
}

kretprobe:tcp_recvmsg
/retval > 0/
{
    @recv_bytes[pid, comm] = sum(retval);
}

interval:s:10
{
    time("%H:%M:%S ");
    printf("=== Network I/O (10s) ===\n");
    printf("Sent bytes by pid,comm:\n");
    print(@sent_bytes);
    printf("Recv bytes by pid,comm:\n");
    print(@recv_bytes);
    clear(@sent_bytes);
    clear(@recv_bytes);
}
```

### Packet Drop Analysis

```
#!/usr/bin/env bpftrace
// File: packet-drops.bt
// Purpose: trace kernel packet drops with drop reason codes

tracepoint:skb:kfree_skb
{
    @drops[args->reason] = count();
}

tracepoint:skb:kfree_skb
/args->reason > 0 && @drops[args->reason] % 500 == 0/
{
    printf("Drop reason %d accumulated %d\n",
           args->reason, @drops[args->reason]);
    print(kstack(5));
}

interval:s:30
{
    printf("\n=== Packet drops by reason code (30s) ===\n");
    print(@drops);
    clear(@drops);
}
```

### TCP Retransmit Tracking

```bash
# Use the BCC tcpretrans tool for real-time retransmit visibility
/usr/share/bcc/tools/tcpretrans

# Sample output:
# TIME     PID    IP LADDR:LPORT          T> RADDR:RPORT          STATE
# 14:23:01 1234  4  10.0.1.5:58234      R> 10.0.2.10:8080        ESTABLISHED
# 14:23:01 1234  4  10.0.1.5:58234      L> 10.0.2.10:8080        ESTABLISHED

# TCP connection lifetime summary
/usr/share/bcc/tools/tcplife -w

# TCP outbound connections
/usr/share/bcc/tools/tcpconnect

# TCP inbound connections
/usr/share/bcc/tools/tcpaccept
```

---

## Section 5: File I/O Latency Analysis

### Open Syscall Latency and Path Tracking

```
#!/usr/bin/env bpftrace
// File: file-open-trace.bt
// Purpose: trace openat() calls with path and latency

tracepoint:syscalls:sys_enter_openat
{
    @path[tid] = args->filename;
    @start[tid] = nsecs;
}

tracepoint:syscalls:sys_exit_openat
/@start[tid]/
{
    $latency_us = (nsecs - @start[tid]) / 1000;
    $path = str(@path[tid]);

    if ($latency_us > 100) {
        printf("SLOW open: %-20s pid=%-6d lat=%8dus  %s\n",
               comm, pid, $latency_us, $path);
    }

    @open_latency_us = hist($latency_us);
    @top_paths[$path] = count();

    delete(@start[tid]);
    delete(@path[tid]);
}

END
{
    printf("\n=== Open latency distribution (us) ===\n");
    print(@open_latency_us);
    printf("\n=== Top 20 opened paths ===\n");
    print(@top_paths, 20);
}
```

### Block I/O Latency Histogram

```
#!/usr/bin/env bpftrace
// File: bio-latency.bt
// Purpose: block I/O latency distribution by device and operation type

tracepoint:block:block_rq_issue
{
    @start[args->dev, args->sector] = nsecs;
}

tracepoint:block:block_rq_complete
/@start[args->dev, args->sector]/
{
    $latency_us = (nsecs - @start[args->dev, args->sector]) / 1000;

    @io_latency_us[args->dev, args->rwbs] = hist($latency_us);

    if ($latency_us > 10000) {
        printf("HIGH latency I/O: dev=%d op=%s lat=%dus\n",
               args->dev, args->rwbs, $latency_us);
    }

    delete(@start[args->dev, args->sector]);
}

interval:s:60
{
    printf("\n=== Block I/O latency (us) per device/operation ===\n");
    print(@io_latency_us);
    clear(@io_latency_us);
}
```

### BCC biolatency Tool

```bash
# Block I/O latency histogram for all devices
/usr/share/bcc/tools/biolatency -D

# Sample output:
# Tracing block device I/O... Hit Ctrl-C to end.
# disk = sda
#      usecs               : count     distribution
#          0 -> 1          : 0        |                                        |
#          2 -> 3          : 5        |                                        |
#          4 -> 7          : 12       |                                        |
#          8 -> 15         : 128      |**                                      |
#         16 -> 31         : 1024     |*******************                     |
#         32 -> 63         : 2048     |***************************************|

# Slow filesystem operations
/usr/share/bcc/tools/ext4slower 5    # operations > 5ms
/usr/share/bcc/tools/xfsslower 5
/usr/share/bcc/tools/nfsslower 5

# File open snoop
/usr/share/bcc/tools/opensnoop -T
```

---

## Section 6: CPU Scheduler Analysis

### Run-Queue Latency

```
#!/usr/bin/env bpftrace
// File: runq-latency.bt
// Purpose: measure time threads wait in the run queue before execution

tracepoint:sched:sched_wakeup,
tracepoint:sched:sched_wakeup_new
{
    @qstart[args->pid] = nsecs;
}

tracepoint:sched:sched_switch
{
    if (@qstart[args->next_pid]) {
        $latency_us = (nsecs - @qstart[args->next_pid]) / 1000;
        @runq_latency_us = hist($latency_us);

        if ($latency_us > 1000) {
            printf("HIGH runq lat: pid=%d comm=%s lat=%dus cpu=%d\n",
                   args->next_pid, args->next_comm, $latency_us, cpu);
        }

        delete(@qstart[args->next_pid]);
    }
}

END
{
    printf("\n=== Run queue latency distribution (us) ===\n");
    print(@runq_latency_us);
}
```

### Off-CPU Time Analysis

```
#!/usr/bin/env bpftrace
// File: offcpu.bt
// Purpose: measure time threads are blocked off-CPU, with stack traces

tracepoint:sched:sched_switch
/args->prev_state == 1/
{
    @offcpu_start[args->prev_pid] = nsecs;
    @offcpu_kstack[args->prev_pid] = kstack(10);
}

tracepoint:sched:sched_switch
{
    if (@offcpu_start[args->next_pid]) {
        $duration_us = (nsecs - @offcpu_start[args->next_pid]) / 1000;

        if ($duration_us > 500) {
            @offcpu_us[@offcpu_kstack[args->next_pid]] = sum($duration_us);
        }

        delete(@offcpu_start[args->next_pid]);
        delete(@offcpu_kstack[args->next_pid]);
    }
}

interval:s:30
{
    printf("\n=== Top off-CPU kernel stacks (total blocked us) ===\n");
    print(@offcpu_us, 10);
    clear(@offcpu_us);
}
```

### BCC runqlat and Profile Tools

```bash
# Run-queue latency histogram in milliseconds
/usr/share/bcc/tools/runqlat -m

# CPU time distribution (on-CPU vs off-CPU)
/usr/share/bcc/tools/cpudist -O 1   # off-CPU distribution for 1 second

# CPU profiler — samples all threads at 99 Hz for 30 seconds
/usr/share/bcc/tools/profile -F 99 -a 30

# Off-CPU time with kernel stacks for a specific PID
/usr/share/bcc/tools/offcputime -K -p $(pgrep myapp) 10

# Wakeup latency for a specific process
/usr/share/bcc/tools/wakeuptime -p $(pgrep myapp) 10
```

---

## Section 7: Memory Analysis

### Memory Leak Detection

```bash
# Detect user-space memory leaks in a running process
/usr/share/bcc/tools/memleak -a -p $(pgrep myapp)

# Sample output:
# [10:45:23] Top 10 stacks with outstanding allocations:
#         112 bytes in 7 allocations from stack
#                 __strdup+0x1f [libc-2.35.so]
#                 parse_config+0x87 [myapp]
#                 init_server+0x123 [myapp]

# Detect kernel memory leaks
/usr/share/bcc/tools/memleak -a

# Trace malloc/free activity
bpftrace -e '
uprobe:/lib/x86_64-linux-gnu/libc.so.6:malloc { @[ustack(5)] = sum(arg0); }
uprobe:/lib/x86_64-linux-gnu/libc.so.6:free   { @frees = count(); }
END { print(@); }'
```

### Page Fault Analysis

```
#!/usr/bin/env bpftrace
// File: page-faults.bt
// Purpose: track major and minor page faults per process

software:major-faults:1
{
    @major_faults[comm, pid] = count();
}

software:minor-faults:1
{
    @minor_faults[comm] = count();
}

interval:s:10
{
    printf("\n=== Page faults (10s) ===\n");
    printf("Major faults (disk I/O required):\n");
    print(@major_faults, 10);
    printf("Minor faults (allocation/CoW):\n");
    print(@minor_faults, 10);
    clear(@major_faults);
    clear(@minor_faults);
}
```

---

## Section 8: Kubernetes Container-Level Observability

### Filtering by Container via cgroup

```bash
# Find the cgroup ID for a Kubernetes pod
POD_NAME="my-app-7d4f9b8c6-xk2rm"
NAMESPACE="production"

# Get container ID from kubectl
CONTAINER_ID=$(kubectl get pod -n "${NAMESPACE}" "${POD_NAME}" \
  -o jsonpath='{.status.containerStatuses[0].containerID}' \
  | sed 's|containerd://||')

# Find cgroup path
find /sys/fs/cgroup -name "*.scope" | xargs grep -l "${CONTAINER_ID}" 2>/dev/null | head -1

# Get cgroup ID number
stat -fc '%i' "/sys/fs/cgroup/kubepods/burstable/pod${POD_UID}/${CONTAINER_ID}"
```

### Container-Scoped bpftrace Scripts

```
#!/usr/bin/env bpftrace
// File: container-syscall-trace.bt
// Usage: CONTAINER_CGROUPID=<id> bpftrace container-syscall-trace.bt
// Purpose: trace syscalls only within a specific container's cgroup

tracepoint:raw_syscalls:sys_enter
/cgroup == $CONTAINER_CGROUPID/
{
    @container_syscalls[args->id] = count();
}

interval:s:5
{
    printf("\n=== Container syscalls (5s) ===\n");
    print(@container_syscalls, 20);
    clear(@container_syscalls);
}
```

```bash
# Run with target container cgroup
CGID=$(bpftrace -e 'BEGIN { printf("%llu\n", cgroupid("/sys/fs/cgroup/kubepods/burstable/pod12345/abc123")); exit(); }')
bpftrace -e "
tracepoint:raw_syscalls:sys_enter /cgroup == ${CGID}/ {
  @[args->id] = count();
}
interval:s:10 { print(@); clear(@); }
"
```

### Kubernetes Pod Network Tracing

```
#!/usr/bin/env bpftrace
// File: k8s-pod-network.bt
// Purpose: trace TCP connections for pods in a specific network namespace

#include <net/sock.h>
#include <linux/nsproxy.h>
#include <linux/ns_common.h>

kprobe:tcp_connect
{
    $sk = (struct sock *)arg0;
    $netns_inum = $sk->__sk_common.skc_net.net->ns.inum;

    // Filter by network namespace inum
    // Find with: ip netns identify $(cat /proc/$(pgrep myapp)/ns/net | tr -d '[]' | awk -F: '{print $2}')
    if ($netns_inum == $1) {
        $dport_raw = $sk->__sk_common.skc_dport;
        $dport = ($dport_raw >> 8) | (($dport_raw & 0xff) << 8);
        printf("POD CONNECT: pid=%-6d comm=%-20s dport=%d netns=%u\n",
               pid, comm, $dport, $netns_inum);
    }
}
```

### Falco-Compatible Container Audit Script

```
#!/usr/bin/env bpftrace
// File: container-exec-audit.bt
// Purpose: audit container process executions for security monitoring

tracepoint:sched:sched_process_exec
{
    printf("EXEC pid=%-6d ppid=%-6d cgroup_id=%-12lu comm=%s\n",
           pid,
           curtask->real_parent->tgid,
           cgroupid("/sys/fs/cgroup"),
           str(args->filename));
}

tracepoint:syscalls:sys_enter_connect
{
    printf("CONN pid=%-6d cgroup_id=%-12lu comm=%s\n",
           pid,
           cgroupid("/sys/fs/cgroup"),
           comm);
}
```

---

## Section 9: Integrating eBPF with Prometheus

### Deploying ebpf_exporter on Kubernetes

```yaml
# ebpf-exporter-daemonset.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ebpf-exporter-config
  namespace: monitoring
data:
  config.yaml: |
    programs:
      - name: runqlat
        metrics:
          histograms:
            - name: ebpf_runqlat_seconds
              help: Run queue latency distribution
              table: runqlat
              bucket_type: exp2
              bucket_min: 0
              bucket_max: 26
              bucket_multiplier: 0.000001
        kprobes:
          finish_task_switch: tracepoint__sched__sched_switch
        tracepoints:
          sched:sched_wakeup: tracepoint__sched__sched_wakeup
          sched:sched_wakeup_new: tracepoint__sched__sched_wakeup
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: ebpf-exporter
  namespace: monitoring
  labels:
    app: ebpf-exporter
spec:
  selector:
    matchLabels:
      app: ebpf-exporter
  template:
    metadata:
      labels:
        app: ebpf-exporter
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9435"
    spec:
      hostPID: true
      hostNetwork: true
      containers:
      - name: ebpf-exporter
        image: cloudflare/ebpf_exporter:2.3.0
        args:
        - --config.dir=/etc/ebpf_exporter
        - --web.listen-address=:9435
        ports:
        - containerPort: 9435
          name: metrics
          protocol: TCP
        securityContext:
          privileged: true
        volumeMounts:
        - name: config
          mountPath: /etc/ebpf_exporter
        - name: sys
          mountPath: /sys
          readOnly: true
        - name: debug
          mountPath: /sys/kernel/debug
          readOnly: true
      volumes:
      - name: config
        configMap:
          name: ebpf-exporter-config
      - name: sys
        hostPath:
          path: /sys
      - name: debug
        hostPath:
          path: /sys/kernel/debug
      tolerations:
      - operator: Exists
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: ebpf-exporter
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: ebpf-exporter
  endpoints:
  - port: metrics
    interval: 30s
    path: /metrics
```

### Grafana Dashboard Query Examples

```
# Run-queue latency P99 (using ebpf_exporter histogram)
histogram_quantile(0.99,
  rate(ebpf_runqlat_seconds_bucket[5m])
)

# Block I/O latency P95 per device
histogram_quantile(0.95,
  rate(ebpf_bio_latency_seconds_bucket[5m])
) by (device)

# TCP connection rate per pod
rate(ebpf_tcp_connections_total[1m]) by (pod, namespace)
```

---

## Section 10: Production Troubleshooting Recipes

### Diagnosing Latency Spikes

```bash
#!/usr/bin/env bash
# latency-investigation.sh — comprehensive latency spike investigation

TARGET_PID="${1:-$(pgrep myapp | head -1)}"
DURATION=60

echo "Investigating latency for PID ${TARGET_PID} for ${DURATION}s"

# 1. Run-queue latency
echo "[1] Sampling run-queue latency..."
timeout "${DURATION}" /usr/share/bcc/tools/runqlat -m -p "${TARGET_PID}" &

# 2. Off-CPU time
echo "[2] Sampling off-CPU time..."
timeout "${DURATION}" /usr/share/bcc/tools/offcputime -p "${TARGET_PID}" &

# 3. Block I/O latency
echo "[3] Sampling block I/O..."
timeout "${DURATION}" /usr/share/bcc/tools/biolatency -D &

# 4. TCP retransmits
echo "[4] Monitoring TCP retransmits..."
timeout "${DURATION}" /usr/share/bcc/tools/tcpretrans &

wait
echo "Investigation complete"
```

### Diagnosing High System CPU

```bash
# Find which kernel functions are consuming CPU time
perf top -a --stdio

# Profile kernel-space only
perf record -F 99 -a --call-graph fp -e cpu-clock -- sleep 30
perf report --stdio --no-children | head -60

# With bpftrace — sample kernel stacks at 99 Hz
bpftrace -e '
profile:hz:99
/kstack/
{
    @[kstack(10)] = count();
}
interval:s:30
{
    print(@, 15);
    clear(@);
}'
```

### Common eBPF Errors in Production

```bash
# Error: "failed to create BPF map: operation not permitted"
# Resolution: requires CAP_BPF or CAP_SYS_ADMIN
# For container deployments, add to securityContext:
#   capabilities:
#     add: ["SYS_ADMIN"]

# Error: "cannot use kprobe, not a valid function name"
# Resolution: function may be inlined; use tracepoints instead
bpftrace -l "tracepoint:net:*"
bpftrace -l "kprobe:tcp_*" | grep -i send

# Error: "map creation failed: key too large"
# Resolution: reduce struct size used as map key; use a hash index

# Measure probe overhead
bpftrace -e 'kprobe:tcp_sendmsg { @c = count(); }' &
BPID=$!
# Run application workload comparison here
kill ${BPID}

# Verify JIT compilation (reduces overhead)
sysctl net.core.bpf_jit_enable
# If 0, enable: sysctl -w net.core.bpf_jit_enable=1
```

### Kubernetes Node Debugging Workflow

```bash
#!/usr/bin/env bash
# k8s-node-debug.sh — eBPF-based Kubernetes node investigation

NODE="${1:-$(kubectl get nodes -o name | head -1 | cut -d/ -f2)}"

echo "Deploying privileged debug pod to node ${NODE}..."

kubectl run ebpf-debug \
  --image=debian:bookworm \
  --overrides="{
    \"spec\": {
      \"nodeName\": \"${NODE}\",
      \"hostPID\": true,
      \"hostNetwork\": true,
      \"containers\": [{
        \"name\": \"ebpf-debug\",
        \"image\": \"debian:bookworm\",
        \"command\": [\"sleep\", \"3600\"],
        \"securityContext\": {\"privileged\": true},
        \"volumeMounts\": [{
          \"name\": \"sys\",
          \"mountPath\": \"/sys\"
        }]
      }],
      \"volumes\": [{
        \"name\": \"sys\",
        \"hostPath\": {\"path\": \"/sys\"}
      }]
    }
  }" \
  --restart=Never

kubectl wait --for=condition=Ready pod/ebpf-debug --timeout=60s

kubectl exec -it ebpf-debug -- bash -c "
apt-get update -qq && apt-get install -y -qq bpftrace bpfcc-tools 2>/dev/null
echo 'eBPF tools ready. Running syscall rate trace for 30s...'
bpftrace -e 'tracepoint:raw_syscalls:sys_enter { @[comm] = count(); } interval:s:30 { print(@); exit(); }'
"

kubectl delete pod ebpf-debug --force 2>/dev/null
```

eBPF and bpftrace provide a uniquely powerful lens into Linux kernel behavior with minimal overhead and production safety. The scripts in this guide cover the full range from quick one-liner diagnosis to sustained container-level observability integrated with Prometheus. Systematic application of these tools replaces guesswork with data-driven diagnosis for the most challenging production latency, throughput, and security investigation scenarios.
