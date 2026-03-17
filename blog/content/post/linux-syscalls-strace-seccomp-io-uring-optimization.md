---
title: "Linux System Calls: strace Analysis, seccomp Allowlists, and Syscall Overhead Reduction"
date: 2030-04-26T00:00:00-05:00
draft: false
tags: ["Linux", "System Calls", "seccomp", "strace", "io_uring", "Performance", "Security"]
categories: ["Linux", "Performance", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-focused guide to profiling syscall overhead with strace and perf, building minimal seccomp allowlists for container security, leveraging io_uring for syscall batching, and exploiting vDSO to eliminate unnecessary kernel transitions."
more_link: "yes"
url: "/linux-syscalls-strace-seccomp-io-uring-optimization/"
---

Every interaction between a userspace process and the kernel crosses the syscall boundary. At low call rates, this boundary is invisible. At high call rates — tens of millions per second in database hot paths or network-intensive services — syscall overhead becomes the dominant performance factor, and its security implications in container environments become a critical attack surface.

This guide covers profiling the syscall layer with strace and perf, building minimal seccomp allowlists, using io_uring to batch system calls, and exploiting vDSO to eliminate kernel transitions entirely for supported operations.

<!--more-->

# Linux System Calls: strace Analysis, seccomp Allowlists, and Syscall Overhead Reduction

## Understanding Syscall Overhead

A system call on x86-64 Linux using the `syscall` instruction costs between 50 and 200 nanoseconds on modern hardware without Spectre/Meltdown mitigations. With KPTI (Kernel Page Table Isolation) enabled for Meltdown mitigation, each syscall triggers a page table switch, increasing the cost to 300-800 nanoseconds or more depending on TLB pressure.

At 10 million syscalls per second, this represents 3-8 milliseconds of pure syscall overhead per second per core — 0.3-0.8% of available CPU time consumed entirely by kernel entry/exit. For a database processing 100,000 IOPS with 4 syscalls per operation, this is 400,000 syscalls per second, or 120-320 microseconds of overhead per second per thread.

### Syscall Cost Breakdown

| Phase | Cost (approx.) |
|---|---|
| User → kernel transition (SYSCALL instruction) | 20-50 ns |
| KPTI page table switch | 50-150 ns |
| Kernel syscall dispatch | 5-15 ns |
| Actual syscall work | Variable |
| Kernel → user transition (SYSRET) | 20-50 ns |
| KPTI page table switch back | 50-150 ns |
| **Total overhead (no KPTI)** | **50-120 ns** |
| **Total overhead (with KPTI)** | **150-400 ns** |

## Profiling Syscalls with strace

### Basic syscall tracing

```bash
# Trace all syscalls for a command
strace -c nginx -g -p master -c /etc/nginx/nginx.conf 2>&1 | head -50

# Trace a running process by PID
strace -c -p 12345

# Summary output after 30 seconds
strace -c -p 12345 &
sleep 30
kill -INT %1
```

### Targeted strace Analysis

```bash
# Filter to specific syscalls only
strace -e trace=read,write,recv,send,recvfrom,sendto -c -p 12345

# Trace with timestamps and call duration
strace -T -tt -p 12345 2>&1 | head -100

# Find slow syscalls (> 1 millisecond)
strace -T -p 12345 2>&1 | awk -F '<' '/^[0-9]/ {t=$2+0; if(t > 0.001) print $0}'

# Show file descriptor activity
strace -e trace=file -p 12345 2>&1 | head -50

# Count network syscalls specifically
strace -e trace=network -c -p 12345

# Trace with signal handling
strace -e trace=signal,process -c -p 12345
```

### strace Output Analysis Script

```bash
#!/bin/bash
# analyze-syscalls.sh — analyze strace output for bottlenecks

PID=${1:?Usage: $0 <pid> [duration_seconds]}
DURATION=${2:-30}
OUTFILE="/tmp/strace-${PID}-$(date +%s).txt"

echo "Tracing PID $PID for ${DURATION}s..."
timeout "$DURATION" strace -c -p "$PID" 2>"$OUTFILE"

echo ""
echo "=== Top Syscalls by Time ==="
grep -E "^\s+[0-9]" "$OUTFILE" | sort -k2 -rn | head -15

echo ""
echo "=== Syscalls with Errors ==="
grep -E "errors=[1-9]" "$OUTFILE"

echo ""
echo "=== Total Syscall Count ==="
grep "calls" "$OUTFILE"
```

### Example strace Output for Redis

```
% time     seconds  usecs/call     calls    errors syscall
------ ----------- ----------- --------- --------- ----------------
 41.23    0.041234           2     20617           epoll_wait
 28.45    0.028450           1     28450           read
 15.32    0.015320           1     15320           write
  8.91    0.008910           1      8910           clock_gettime
  3.21    0.003210           2      1605           accept4
  1.44    0.001440           1      1440           close
  1.44    0.001440           1      1440           brk
------ ----------- ----------- --------- --------- ----------------
100.00    0.100004                 77782           total
```

The `clock_gettime` entries reveal that Redis is calling it ~9,000 times per second. This is a candidate for vDSO optimization (discussed below).

## Profiling Syscalls with perf

`perf` provides lower overhead than strace for production profiling:

```bash
# Count syscalls system-wide for 10 seconds
perf stat -e 'syscalls:sys_enter_*' -a -- sleep 10

# Count for a specific process
perf stat -e 'syscalls:sys_enter_read,syscalls:sys_enter_write,syscalls:sys_enter_epoll_wait' \
  -p 12345 -- sleep 10

# Trace specific syscall entries with timestamps
perf trace -p 12345 --duration 10

# Record for flame graph generation
perf record -g -e syscalls:sys_enter_read -p 12345 -- sleep 10
perf script | stackcollapse-perf.pl | flamegraph.pl > syscall-flamegraph.svg

# High-level syscall summary without strace overhead
perf top -e syscalls:sys_enter_write -p 12345
```

### Using bpftrace for Syscall Latency Histograms

```bash
# Install bpftrace
apt-get install -y bpftrace  # Debian/Ubuntu

# Histogram of read() latency for a specific PID
bpftrace -e '
tracepoint:syscalls:sys_enter_read /pid == 12345/ { @start = nsecs; }
tracepoint:syscalls:sys_exit_read  /pid == 12345/ {
  @latency_ns = hist(nsecs - @start);
  delete(@start);
}
END { print(@latency_ns); }
'

# Count syscalls by type for all processes
bpftrace -e 'tracepoint:raw_syscalls:sys_enter { @[comm, ksym(args->id)] = count(); }' \
  -c 'sleep 10' | sort -k3 -rn | head -20

# Identify processes making excessive open() calls
bpftrace -e '
tracepoint:syscalls:sys_enter_openat {
  @opens[comm] = count();
}
interval:s:10 {
  print(@opens);
  clear(@opens);
}
'
```

## Building Minimal seccomp Allowlists

### Understanding seccomp-bpf

seccomp (Secure Computing Mode) in BPF mode allows you to write a Berkeley Packet Filter program that evaluates every syscall before it reaches the kernel. For containers, this is a defense-in-depth control: even if an attacker achieves code execution inside a container, they cannot call syscalls that would allow container escape.

The Docker and containerd default seccomp profiles block 44 of approximately 350 syscalls. A tightly crafted allowlist for a specific application may only need 30-60 syscalls.

### Generating a Profile from strace

```bash
# Capture all syscalls used by your application
strace -f -e trace=all -o /tmp/syscall-trace.txt your-app --config ...

# Extract unique syscall names
grep -oP '(?<=^|\s)\w+(?=\()' /tmp/syscall-trace.txt | \
  grep -v "^[0-9]" | sort -u > /tmp/syscalls-used.txt

cat /tmp/syscalls-used.txt
```

### Generating a Profile from perf

```bash
# More lightweight than strace for long-running applications
perf trace -p $APP_PID 2>&1 | \
  grep -oP '^\s+\d+\.\d+\s+\(\d+\.\d+\s+ms\):\s+\K\w+' | \
  sort -u
```

### OCI seccomp Profile Format

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "architectures": ["SCMP_ARCH_X86_64", "SCMP_ARCH_X86", "SCMP_ARCH_X32"],
  "syscalls": [
    {
      "names": [
        "accept4",
        "access",
        "arch_prctl",
        "bind",
        "brk",
        "capget",
        "capset",
        "chdir",
        "chmod",
        "chown",
        "clone",
        "close",
        "connect",
        "dup",
        "dup2",
        "dup3",
        "epoll_create1",
        "epoll_ctl",
        "epoll_pwait",
        "epoll_wait",
        "eventfd2",
        "execve",
        "exit",
        "exit_group",
        "faccessat",
        "fadvise64",
        "fallocate",
        "fchmod",
        "fchown",
        "fcntl",
        "fdatasync",
        "flock",
        "fstat",
        "fstatfs",
        "fsync",
        "ftruncate",
        "futex",
        "getcwd",
        "getdents64",
        "getegid",
        "geteuid",
        "getgid",
        "getpeername",
        "getpid",
        "getppid",
        "getrandom",
        "getsockname",
        "getsockopt",
        "gettid",
        "gettimeofday",
        "getuid",
        "ioctl",
        "kill",
        "lseek",
        "lstat",
        "madvise",
        "memfd_create",
        "mmap",
        "mprotect",
        "mremap",
        "munmap",
        "nanosleep",
        "newfstatat",
        "openat",
        "pipe",
        "pipe2",
        "poll",
        "ppoll",
        "prctl",
        "pread64",
        "pselect6",
        "pwrite64",
        "read",
        "readlink",
        "readv",
        "recvfrom",
        "recvmsg",
        "rename",
        "rt_sigaction",
        "rt_sigprocmask",
        "rt_sigreturn",
        "sched_getaffinity",
        "sched_yield",
        "select",
        "sendfile",
        "sendmsg",
        "sendto",
        "set_robust_list",
        "set_tid_address",
        "setsockopt",
        "sigaltstack",
        "socket",
        "socketpair",
        "stat",
        "statfs",
        "statx",
        "symlink",
        "tgkill",
        "timer_create",
        "timer_delete",
        "timer_gettime",
        "timer_settime",
        "timerfd_create",
        "timerfd_settime",
        "umask",
        "uname",
        "unlink",
        "unlinkat",
        "wait4",
        "waitid",
        "write",
        "writev"
      ],
      "action": "SCMP_ACT_ALLOW"
    },
    {
      "names": ["clock_gettime", "clock_getres", "time", "gettimeofday"],
      "action": "SCMP_ACT_ALLOW",
      "comment": "Covered by vDSO — included for fallback"
    }
  ]
}
```

### Applying seccomp Profiles in Kubernetes

```yaml
# Pod-level seccomp via SecurityContext
apiVersion: v1
kind: Pod
metadata:
  name: secure-app
spec:
  securityContext:
    seccompProfile:
      type: Localhost
      localhostProfile: profiles/my-app-seccomp.json
  containers:
  - name: app
    image: my-app:latest
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      runAsNonRoot: true
      runAsUser: 1000
      capabilities:
        drop: ["ALL"]
```

The `localhostProfile` path is relative to the kubelet's seccomp profile directory, typically `/var/lib/kubelet/seccomp/`. Copy your profile there:

```bash
# On each node (via DaemonSet or configuration management)
mkdir -p /var/lib/kubelet/seccomp/profiles
cp my-app-seccomp.json /var/lib/kubelet/seccomp/profiles/
```

### seccomp with AUDIT Mode for Profile Development

```json
{
  "defaultAction": "SCMP_ACT_LOG",
  "architectures": ["SCMP_ARCH_X86_64"],
  "syscalls": [
    {
      "names": ["ptrace", "process_vm_readv", "process_vm_writev", "keyctl"],
      "action": "SCMP_ACT_ERRNO",
      "comment": "Always block these regardless of audit mode"
    }
  ]
}
```

With `SCMP_ACT_LOG`, syscalls not explicitly allowed are logged to the kernel audit log without being blocked. After running your application through its full test suite, collect the logged syscalls:

```bash
# Read seccomp audit events
ausearch -m SECCOMP | grep -oP 'syscall=\K\d+' | sort -u | \
  while read n; do
    python3 -c "import ctypes; print('$n', ctypes.cdll.LoadLibrary('libseccomp.so.2').seccomp_syscall_resolve_num_arch(0, $n).decode())"
  done
```

### seccomp-bpf Filter Performance

seccomp-bpf filters add overhead per syscall (the BPF program must execute). For a simple allowlist with ~100 entries:

```bash
# Measure seccomp overhead
perf stat -e 'seccomp:seccomp_ret_allow' -a -- sleep 10

# Compare application throughput with and without seccomp
# Without seccomp:
wrk -t 4 -c 100 -d 30s http://localhost:8080/

# With seccomp:
# Apply seccomp profile, then re-run wrk
```

Typical overhead: 0.5-3% CPU increase for syscall-heavy workloads. The security benefit far outweighs this for most applications.

## io_uring for Syscall Batching

io_uring is a Linux kernel interface (added in 5.1) that enables userspace to submit and complete I/O operations without crossing the syscall boundary for each operation. Instead, submissions are queued in a shared ring buffer and consumed by the kernel asynchronously.

### io_uring Architecture

```
Userspace                    Kernel
─────────────────────────────────────────────────────
   App                   io_uring kernel thread
    │                            │
    ├──[push SQE]──>  SQ Ring ──>│
    │                            │ ← polls ring (no syscall needed)
    │<──[read CQE]── CQ Ring <───┤
    │                            │
    │ io_uring_enter()   (only needed to notify when  │
    │   (optional)        kernel thread is sleeping)  │
```

### io_uring in Go with `iouring-go`

```go
// go.mod addition
// require github.com/iceber/iouring-go v0.0.0-20230403020409-d0dda141

package main

import (
	"fmt"
	"os"

	"github.com/iceber/iouring-go"
)

func ioUringReadExample() error {
	// Create io_uring with queue depth of 256
	iour, err := iouring.New(256)
	if err != nil {
		return fmt.Errorf("create io_uring: %w", err)
	}
	defer iour.Close()

	f, err := os.Open("/tmp/testfile")
	if err != nil {
		return err
	}
	defer f.Close()

	// Prepare multiple read requests
	buffers := make([][]byte, 4)
	results := make([]iouring.Request, 4)

	for i := range buffers {
		buffers[i] = make([]byte, 4096)
		offset := int64(i * 4096)
		results[i] = iouring.Pread(f, buffers[i], uint64(offset), nil)
	}

	// Submit all 4 reads with a single syscall (or zero syscalls in SQPOLL mode)
	ch, err := iour.SubmitRequests(results, nil)
	if err != nil {
		return fmt.Errorf("submit: %w", err)
	}

	// Wait for completions
	cqes := <-ch
	for i, cqe := range cqes {
		if cqe.Err() != nil {
			fmt.Printf("read %d failed: %v\n", i, cqe.Err())
			continue
		}
		fmt.Printf("read %d: got %d bytes\n", i, cqe.ReturnValue())
	}

	return nil
}
```

### SQPOLL Mode: Zero Syscall I/O

With `IORING_SETUP_SQPOLL`, a dedicated kernel thread polls the submission queue, allowing userspace to submit I/O with zero syscalls:

```go
// SQPOLL mode — kernel thread polls for submissions, no syscall needed
iour, err := iouring.New(256,
    iouring.WithSQPoll(),           // Enable kernel polling thread
    iouring.WithSQPollIdleTime(2000), // Thread sleeps after 2s idle
)
if err != nil {
    return fmt.Errorf("create sqpoll io_uring: %w", err)
}
```

Note: SQPOLL requires `CAP_SYS_NICE` or running as root in older kernels. In containers, ensure the seccomp profile allows `io_uring_setup`, `io_uring_enter`, and `io_uring_register`.

### Measuring io_uring vs Traditional I/O

```bash
# Install fio with io_uring support
apt-get install -y fio

# Benchmark traditional sync I/O
fio --name=sync-rw --ioengine=sync --rw=randread \
  --bs=4k --numjobs=4 --iodepth=1 --runtime=30 \
  --filename=/dev/nvme0n1 --direct=1

# Benchmark io_uring
fio --name=uring-rw --ioengine=io_uring --rw=randread \
  --bs=4k --numjobs=4 --iodepth=64 --runtime=30 \
  --filename=/dev/nvme0n1 --direct=1

# Benchmark io_uring with SQPOLL
fio --name=uring-sqpoll --ioengine=io_uring --sqthread_poll=1 \
  --rw=randread --bs=4k --numjobs=4 --iodepth=64 --runtime=30 \
  --filename=/dev/nvme0n1 --direct=1
```

Expected results for NVMe on modern hardware:
- sync: ~300K IOPS
- io_uring (iodepth=64): ~500K IOPS
- io_uring + SQPOLL: ~650K IOPS (near hardware limit)

## vDSO: Eliminating Kernel Transitions

The Virtual Dynamic Shared Object (vDSO) is a small shared library that the kernel maps into every process's address space. It contains kernel code that runs in userspace, eliminating the syscall transition for supported operations.

### What vDSO Provides

```bash
# Inspect vDSO symbols
objdump -T /proc/self/maps 2>/dev/null | grep vdso
# OR
cat /proc/self/maps | grep vdso

# Extract and inspect vDSO library
dd if=/proc/self/mem bs=1 skip=$((0x7fff...)) count=... of=/tmp/vdso.so
# Use vdsotest or examine with nm
nm /tmp/vdso.so 2>/dev/null
```

Common vDSO-accelerated syscalls:
- `clock_gettime(CLOCK_REALTIME)` and `clock_gettime(CLOCK_MONOTONIC)`
- `gettimeofday()`
- `time()`
- `getcpu()`

### Verifying vDSO Usage

```bash
# strace will show clock_gettime if vDSO is NOT used (kernel fallback)
strace -e trace=clock_gettime -c ./my-app

# If you see thousands of clock_gettime entries, either:
# 1. vDSO is disabled (rare but possible in hardened environments)
# 2. CLOCK_BOOTTIME or CLOCK_PROCESS_CPUTIME_ID is being used (no vDSO)
# 3. seccomp is causing vDSO to syscall fallback (see below)
```

### seccomp Interaction with vDSO

This is a critical production issue: if a seccomp filter is applied **after** vDSO is mapped, `clock_gettime` normally runs without a syscall. But if your seccomp filter is applied **before** process startup and blocks the vDSO's fallback path, or if the application uses a clock type not supported by vDSO, the application may crash or fall back to actual syscalls.

```bash
# Check if seccomp is blocking vDSO fallback
strace -e trace=clock_gettime,clock_getres -c -p $PID

# If you see thousands of these with seccomp enabled, check:
# 1. Does your seccomp profile allow clock_gettime?
# 2. Are you using CLOCK_BOOTTIME (requires actual syscall)?
```

```json
{
  "syscalls": [
    {
      "names": ["clock_gettime", "clock_getres", "gettimeofday"],
      "action": "SCMP_ACT_ALLOW",
      "comment": "Required for vDSO fallback path"
    }
  ]
}
```

### Go's time Package and vDSO

Go's `time.Now()` uses `clock_gettime(CLOCK_REALTIME)` via the vDSO. You can verify this:

```go
package main

import (
	"fmt"
	"time"
)

func main() {
	// This should use vDSO — zero syscall cost
	for i := 0; i < 10_000_000; i++ {
		_ = time.Now()
	}
	fmt.Println("Done — if fast, vDSO is working")
}
```

```bash
# Measure without vDSO (disabled via kernel parameter)
# vs with vDSO (normal operation)
go test -bench=BenchmarkTimeNow -benchtime=10s ./...
```

## Putting It Together: Hardened Container Profile

### Complete seccomp Profile for a Go Web Service

The following profile is derived from a Go HTTP service with PostgreSQL connections:

```bash
#!/bin/bash
# generate-seccomp.sh — generate seccomp profile from running container

CONTAINER_ID=${1:?Usage: $0 <container-id>}

# Run container with audit-only seccomp
docker run \
  --security-opt seccomp=audit-only.json \
  --name syscall-audit \
  "$CONTAINER_ID" \
  /app/server &

# Run tests against the service
sleep 5
./run-integration-tests.sh

# Collect audit log
docker logs syscall-audit 2>&1 | grep SECCOMP | \
  grep -oP 'syscall=\K\d+' | sort -u > /tmp/syscall-numbers.txt

# Convert numbers to names
while read num; do
  python3 -c "
import ctypes, ctypes.util
lib = ctypes.CDLL(ctypes.util.find_library('seccomp'))
lib.seccomp_syscall_resolve_num_arch.restype = ctypes.c_char_p
name = lib.seccomp_syscall_resolve_num_arch(0xC000003E, $num)
if name:
    print(name.decode())
"
done < /tmp/syscall-numbers.txt | sort -u
```

### Dockerfile with seccomp Integration

```dockerfile
FROM golang:1.24-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -o server ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /app/server /server
# Copy seccomp profile into image for reference
COPY seccomp-profile.json /etc/security/seccomp-profile.json
ENTRYPOINT ["/server"]
```

```yaml
# Kubernetes deployment with complete syscall hardening
apiVersion: apps/v1
kind: Deployment
metadata:
  name: secure-api
spec:
  template:
    spec:
      securityContext:
        seccompProfile:
          type: Localhost
          localhostProfile: profiles/secure-api.json
        runAsNonRoot: true
        runAsUser: 65534
      containers:
      - name: api
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop: ["ALL"]
        resources:
          requests:
            cpu: 500m
            memory: 256Mi
          limits:
            cpu: 2
            memory: 512Mi
```

## Key Takeaways

- Use `strace -c -p <pid>` for quick syscall frequency analysis; use `perf trace` for production profiling with lower overhead; use `bpftrace` for latency histograms and custom probes.
- The dominant syscall cost on modern x86-64 systems with KPTI is 150-400 ns per call — at millions of calls per second, this becomes a measurable CPU consumer.
- Build seccomp allowlists by running your application in `SCMP_ACT_LOG` mode through its full test suite, then convert audit log entries to syscall names. Start with Docker's default profile and subtract further from there.
- io_uring batches multiple I/O operations into a single syscall submission; with SQPOLL mode, the kernel thread polls the submission queue, reducing syscall count to near zero for I/O-bound workloads.
- vDSO provides zero-syscall implementations of `clock_gettime`, `gettimeofday`, and related calls; verify your seccomp profile allows the fallback path even if the vDSO normally handles these calls.
- Never allow these syscalls in a container seccomp profile unless explicitly required: `ptrace`, `process_vm_readv`, `process_vm_writev`, `keyctl`, `personality`, `add_key`, `request_key`.
