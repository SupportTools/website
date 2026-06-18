---
title: "The Daily Linux Debugging Toolkit for Production and Kubernetes Environments"
date: 2032-04-20T09:00:00-05:00
draft: false
tags: ["Linux", "Debugging", "Kubernetes", "strace", "tcpdump", "perf", "eBPF", "bpftrace", "Observability", "SRE", "Troubleshooting"]
categories:
- Linux
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A practical, production-focused Linux debugging toolkit for SREs: strace, lsof, ss, tcpdump, sar, htop, perf, bpftrace, journalctl and how to run them inside containers and on Kubernetes nodes."
more_link: "yes"
url: "/linux-debugging-tools-daily-production-toolkit/"
---

When a production service degrades at 2 AM, the difference between a five-minute fix and a multi-hour outage is rarely raw intelligence. It is muscle memory with the right tools. An experienced SRE does not reach for a search engine when a pod is stuck in `CrashLoopBackOff` or a node's load average climbs to 200. They reach for `strace`, `ss`, `perf`, and a handful of other utilities that have been part of the Linux toolkit for decades.

This guide is a working reference for the debugging tools that earn their place in daily production operations. For each tool it covers the class of problem it solves, real invocations with realistic output, and, critically, how to run it inside a containerized or Kubernetes environment where the process you care about lives in a different namespace and may not even have a shell.

<!--more-->

## The Production Debugging Mindset

Before the tools, a few operating principles that shape how they get used in enterprise environments.

**Observability covers the known unknowns; these tools cover the unknown unknowns.** Dashboards and metrics tell you *that* latency increased. They rarely tell you *why* a single Go process is spinning on a futex or why a container can resolve DNS for one service but not another. The tools below are how you cross that gap.

**Reproduce in the same namespace as the failure.** A container shares the host kernel but has its own mount, network, PID, and UTS namespaces. Running `ss` on the node shows the host's sockets, not the pod's. Half of container debugging is getting your tool into the right namespace.

**Capture once, analyze offline.** Production windows are short and live debugging adds load. Prefer capturing a `tcpdump` pcap, a `perf record` data file, or a few seconds of `strace` output, then analyzing on a workstation. This minimizes time on a hot system.

**Know the overhead.** `strace` can slow a target process by an order of magnitude because every syscall traps into the tracer. `perf` and `bpftrace` are far lighter. Pick the lightest tool that answers the question.

## strace: Watching System Calls

`strace` intercepts and records the **system calls** a process makes and the signals it receives. When a program hangs, fails silently, or behaves differently in production than in staging, `strace` shows you exactly where it is talking to the kernel and what error it gets back.

### Core Invocations

Attach to a running process by PID and follow child processes:

```bash
# -f follows forks/threads, -t timestamps, -p attaches to a running PID
strace -f -t -p 4821
```

The single most useful invocation is the summary mode, which aggregates syscalls instead of printing every one:

```bash
# -c prints a summary table: time spent, call count, and errors per syscall
strace -f -c -p 4821
```

A typical summary looks like this and immediately points at where time and errors are concentrated:

```text
% time     seconds  usecs/call     calls    errors syscall
------ ----------- ----------- --------- --------- ----------------
 71.42    0.482310         118      4087        12 futex
 18.05    0.121903          29      4201           read
  6.31    0.042611          10      4198           write
  3.77    0.025470         212       120        96 connect
------ ----------- ----------- --------- --------- ----------------
100.00    0.675294                 12606       108 total
```

Here, 96 failed `connect` calls is a smoking gun for an upstream dependency that is refusing connections.

To trace only the calls you care about, filter with `-e`:

```bash
# Trace only network- and file-related syscalls, show full string arguments
strace -f -e trace=network,file -s 256 -p 4821
```

### A Concrete Failure: Permission Denied

A common production mystery is a process that "can't read its config" with no useful log line. `strace` makes the failing call obvious:

```bash
# Trace a one-shot command from launch instead of attaching
strace -f -e trace=openat ./config-loader 2>&1 | grep -i denied
```

```text
openat(AT_FDCWD, "/etc/app/secrets.yaml", O_RDONLY) = -1 EACCES (Permission denied)
```

The kernel is returning `EACCES` on a specific path. The root cause is now a file-permission or SELinux question, not a code question.

### strace in Containers and Kubernetes

`strace` relies on `ptrace`, which most container security profiles disable. To trace a process inside a pod you generally do not exec into the pod; you trace from the node or with a privileged debug container.

The cleanest modern approach is an **ephemeral debug container** sharing the target's process namespace:

```bash
# kubectl debug attaches a new container into a running pod, sharing its PID namespace
kubectl debug -it payments-api-7d9c8 \
  --image=nicolaka/netshoot \
  --target=payments-api \
  --profile=sysadmin -- bash
```

The `--profile=sysadmin` flag (Kubernetes 1.30+) grants the capabilities `strace` needs, including `SYS_PTRACE`. Inside, find the target PID and attach as usual.

On the node directly, find the container's main PID and trace it from the host:

```bash
# Find the PID of the container's process via crictl, then trace it from the host kernel
crictl inspect --output go-template --template '{{.info.pid}}' "$CONTAINER_ID"
strace -f -c -p "$HOST_PID"
```

## ltrace: Watching Library Calls

Where `strace` shows kernel boundary crossings, `ltrace` shows **dynamic library calls** a process makes. It is the right tool when a bug lives in how an application uses `libc`, `libssl`, or another shared library rather than in the kernel interface.

```bash
# Trace library calls plus syscalls, attach to a running PID
ltrace -f -S -p 4821
```

A frequent use is confirming which configuration or environment value a program actually reads at runtime:

```bash
# Show getenv() calls to see exactly which environment variables are consulted
ltrace -e 'getenv' ./app 2>&1 | head
```

```text
app->getenv("DATABASE_URL")     = "postgres://db.internal:5432/orders"
app->getenv("LOG_LEVEL")        = nil
app->getenv("HTTP_PROXY")       = nil
```

`ltrace` is less universally useful than `strace` because statically linked binaries (common with Go) expose no library calls to intercept. For Go services, skip straight to `strace`, `perf`, or `bpftrace`.

## lsof: What Files and Sockets Are Open

`lsof` lists **open files**, and on Linux nearly everything is a file: regular files, directories, sockets, pipes, and devices. It answers "what is process X touching" and "who is touching resource Y."

### Everyday Queries

```bash
# Which process is listening on port 8080?
lsof -nP -iTCP:8080 -sTCP:LISTEN
```

```text
COMMAND   PID   USER   FD   TYPE  DEVICE SIZE/OFF NODE NAME
web-srv  4821 appsvc    7u  IPv4 1839201      0t0  TCP *:8080 (LISTEN)
```

```bash
# Every file and socket a process has open
lsof -nP -p 4821
```

A classic production scenario is a filesystem that will not unmount or a disk that stays "full" after files were deleted. The deleted-but-still-open case is invisible to `du`:

```bash
# Find deleted files still held open (space not reclaimed until the FD closes)
lsof -nP +L1 | grep -i deleted
```

```text
COMMAND   PID   USER   FD   TYPE DEVICE  SIZE/OFF NLINK   NODE NAME
java     9120 appsvc   42w  REG  259,3 4831838208     0 524291 /var/log/app/server.log (deleted)
```

This shows a 4.8 GB log file deleted out from under a running JVM. Disk space will not return until that process is restarted or the file descriptor is closed.

### lsof in Containers

`lsof` reads from `/proc`, so running it on the node with the host PID gives full visibility into a container's open files. Inside a debug container with shared PID namespace, install it and target the process directly. The `netshoot` image ships with it preinstalled, which is one reason it is the standard Kubernetes debug image.

## ss: Modern Socket Statistics

`ss` replaces the deprecated `netstat` and is dramatically faster on busy hosts because it reads kernel socket state directly. It is the first tool to reach for any time you suspect a connection, port, or socket-buffer problem.

```bash
# All listening TCP sockets, numeric, with owning process
ss -tlnp
```

```text
State   Recv-Q  Send-Q  Local Address:Port   Peer Address:Port  Process
LISTEN  0       4096          0.0.0.0:8080        0.0.0.0:*      users:(("web-srv",pid=4821,fd=7))
LISTEN  0       128         127.0.0.1:9090        0.0.0.0:*      users:(("metrics",pid=4830,fd=3))
```

Investigate connection states to a specific backend, useful when you suspect connection pooling or leak problems:

```bash
# Show established connections to a database backend
ss -tnp state established dst 10.42.6.18
```

Count sockets by TCP state to spot a `TIME-WAIT` pileup or `CLOSE-WAIT` leak (the latter almost always means the application is not closing sockets):

```bash
# Summarize the TCP state distribution across all sockets
ss -tan | awk 'NR>1 {state[$1]++} END {for (s in state) print state[s], s}' | sort -rn
```

```text
8412 ESTAB
2190 TIME-WAIT
145 CLOSE-WAIT
12 LISTEN
```

A growing `CLOSE-WAIT` count is one of the most reliable early signals of a socket-leaking application.

### ss in Kubernetes

Network state is per-network-namespace, so where you run `ss` decides what you see. To inspect a pod's sockets, enter its network namespace with `nsenter` from the node:

```bash
# Get the container PID, then run ss inside that PID's network namespace
HOST_PID=$(crictl inspect --output go-template --template '{{.info.pid}}' "$CONTAINER_ID")
nsenter -t "$HOST_PID" -n ss -tlnp
```

Or, more portably, use an ephemeral debug container that shares the pod's network namespace by default:

```bash
# netshoot includes ss; sharing the pod network namespace shows the pod's sockets
kubectl debug -it orders-api-5f6b9 --image=nicolaka/netshoot -- ss -tanp
```

## tcpdump: Packet Capture

When the question is "what is actually crossing the wire," `tcpdump` is the authoritative answer. It captures packets at the interface level so you see exactly what was sent and received, regardless of what the application thinks happened.

### Capture, Then Analyze

The production-safe pattern is to capture to a file with a snap length and packet limit, then move the pcap to a workstation for analysis in Wireshark or `tshark`:

```bash
# Capture 5000 packets on eth0 to/from a host, write to a rotating-safe pcap file
tcpdump -i eth0 -c 5000 -s 128 -w /tmp/orders-capture.pcap host 10.42.6.18 and port 5432
```

Key flags: `-s 128` limits each packet to 128 bytes (headers only, lower overhead and smaller files), `-c 5000` stops after 5000 packets, and `-w` writes raw packets rather than parsing them inline.

For quick live inspection of an HTTP or DNS issue without writing a file:

```bash
# Watch DNS queries and responses live, with absolute timestamps
tcpdump -i any -n -tttt port 53
```

```text
2032-04-20 09:14:02.118734 IP 10.42.5.30.41122 > 10.43.0.10.53: 4823+ A? orders.svc.cluster.local. (42)
2032-04-20 09:14:02.118901 IP 10.43.0.10.53 > 10.42.5.30.41122: 4823 NXDOMAIN 0/1/0 (118)
```

That `NXDOMAIN` for an in-cluster service name immediately points at a DNS search-domain or CoreDNS problem.

### Filtering That Matters

Berkeley Packet Filter expressions keep captures small and relevant:

```bash
# TCP SYN packets only: see who is initiating connections (handshake debugging)
tcpdump -i eth0 -n 'tcp[tcpflags] & tcp-syn != 0 and tcp[tcpflags] & tcp-ack == 0'

# Capture only TCP resets, which indicate refused or aborted connections
tcpdump -i eth0 -n 'tcp[tcpflags] & tcp-rst != 0'
```

### tcpdump in Kubernetes

A pod almost never has `tcpdump` installed, and adding it bloats images and widens the attack surface. The ephemeral debug container sharing the pod's network namespace is the right pattern:

```bash
# Capture from inside the pod's network namespace and stream the pcap to a local file
kubectl debug -it web-frontend-8c4d6 --image=nicolaka/netshoot -- \
  tcpdump -i eth0 -s 128 -w - 'port 443' > /tmp/frontend-tls.pcap
```

Writing to `-` (stdout) and redirecting locally avoids needing a writable volume in the debug container. On the node, the `nsenter` equivalent works identically:

```bash
# Run tcpdump in the container's netns from the node
nsenter -t "$HOST_PID" -n tcpdump -i eth0 -c 1000 -w /tmp/pod-capture.pcap
```

## htop and Friends: Live Process Triage

`htop` is the interactive starting point for "the box is on fire, what is eating it." It shows per-core CPU, memory, and a sortable, filterable process list with a tree view.

```bash
# Launch htop filtered to a user, sorted by CPU
htop -u appsvc
```

Inside `htop`, press `F6` to change the sort column (sort by `PERCENT_MEM` to find memory hogs), `F5` for tree view to see process parentage, and `F4` to filter by name. Pressing `F2` lets you add columns such as `IO_RATE` for at-a-glance I/O attribution.

For scripted or non-interactive triage, `ps` remains essential. The single most useful one-liner finds the top memory consumers:

```bash
# Top 10 processes by resident memory, human-readable
ps -eo pid,ppid,rss,comm --sort=-rss | head -11
```

To understand process relationships without an interactive session, `pstree` is concise:

```bash
# Show the process tree with PIDs for a specific process and its children
pstree -p 4821
```

### Process Triage in Containers

On a Kubernetes node, `htop` shows every container's processes mixed together because they all share the host PID namespace from the kernel's perspective. To map a runaway PID back to a pod, look up its cgroup:

```bash
# Resolve a host PID to its owning pod/container via the cgroup path
cat /proc/4821/cgroup
```

```text
0::/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod3f2a.slice/cri-containerd-9ab3...scope
```

The pod UID in that path ties the process back to a specific Kubernetes pod, which you can confirm with `crictl pods` or `kubectl get pod -o wide`.

## sar and dstat: Historical and Live System Metrics

When you arrive after an incident, live tools are too late. **sar** (from the `sysstat` package) records system activity at intervals and keeps it on disk, so you can look back at what the system was doing during the spike.

```bash
# CPU utilization for today, in 10-minute intervals from the saved sar data
sar -u

# Memory and swap usage history
sar -r

# Per-device disk I/O history (find the disk that saturated)
sar -d -p

# Network interface throughput history
sar -n DEV
```

To inspect a specific historical window, point `sar` at a dated data file and pass start and end times:

```bash
# Replay CPU stats from a specific day's sar archive between 02:00 and 03:00
sar -u -f /var/log/sysstat/sa20 -s 02:00:00 -e 03:00:00
```

For live, all-in-one observation during an active incident, `dstat` (or its maintained successor `dool`) shows CPU, disk, network, and paging side by side on one refreshing line:

```bash
# Live CPU, disk, net, paging, and system stats every 2 seconds, with timestamps
dstat -tcdngy 2
```

```text
----system---- --total-cpu-usage-- -dsk/total- -net/total- ---paging-- ---system--
     time     |usr sys idl wai stl| read  writ| recv  send|  in   out | int   csw
20-04 09:20:31|  31   8  58   3   0|  12M   48M| 8.2M  6.1M|   0     0 |  21k   38k
20-04 09:20:33|  74  19   2   5   0|  98M  210M|  22M   14M| 1.2M  840k|  44k   91k
```

The jump in `wai` (I/O wait) alongside high disk writes and active paging tells a coherent story: memory pressure is forcing swap, which is saturating the disk and starving CPU.

### sar in Containers

`sar` data is per-host and inherently captures the whole node, which is exactly what you want for node-level capacity and saturation analysis. For per-container resource history, prefer cgroup metrics exposed through the kubelet and scraped into Prometheus; `sar` complements that by showing the host view the container scheduler does not.

## perf: CPU Profiling and Hardware Counters

When CPU is the bottleneck and you need to know *which functions* are burning it, `perf` is the canonical Linux profiler. It samples the CPU using hardware performance counters with low overhead, making it safe for production sampling.

### Sampling a Hot Process

```bash
# Sample on-CPU stacks for a process for 30 seconds at 99 Hz (avoids lockstep with timers)
perf record -F 99 -p 4821 -g -- sleep 30

# Summarize the recorded profile interactively
perf report --stdio | head -40
```

A condensed report shows where CPU time concentrates:

```text
# Overhead  Command   Shared Object        Symbol
# ........  ........  ...................  ......................
    38.21%  web-srv   web-srv              [.] json.Marshal
    19.07%  web-srv   libc.so.6            [.] __memmove_avx_unaligned
    11.44%  web-srv   web-srv              [.] runtime.mallocgc
```

This profile says nearly 40 percent of CPU is spent serializing JSON, with heavy allocation churn behind it: a clear optimization target.

For a quick top-style live view without recording a file:

```bash
# Live, continuously updating function-level CPU profile
perf top -p 4821
```

System-wide counters quickly characterize a workload as CPU-bound, memory-bound, or branch-misprediction-bound:

```bash
# Hardware counter summary for a command, including IPC and cache misses
perf stat -d ./batch-processor
```

### Flame Graphs

`perf` output becomes far more readable as a **flame graph**, which visually stacks call frequencies:

```bash
# Capture, fold stacks, and render an SVG flame graph
perf record -F 99 -p 4821 -g -- sleep 30
perf script | stackcollapse-perf.pl | flamegraph.pl > /tmp/web-srv-flame.svg
```

### perf in Kubernetes

`perf` needs access to kernel symbols and the target's address space, so run it on the node with the host PID, or in a debug container with the right capabilities. Symbol resolution requires the binary and its debug symbols be visible; on the node this works naturally because `perf` can read the container's filesystem through `/proc/<pid>/root`:

```bash
# Profile a container process from the node; perf resolves symbols via /proc/<pid>/root
perf record -F 99 -p "$HOST_PID" -g -- sleep 30
perf report --stdio
```

Ensure the node kernel allows profiling by checking `kernel.perf_event_paranoid`; a value of `2` or higher restricts what unprivileged and even some privileged collectors can sample:

```bash
# Inspect the perf access policy (lower is more permissive)
sysctl kernel.perf_event_paranoid
```

## bpftrace and eBPF: Surgical, Low-Overhead Tracing

`bpftrace` is the modern apex of Linux dynamic tracing. Built on **eBPF**, it runs small, verified programs in the kernel that attach to kprobes, tracepoints, and user probes with overhead low enough for production. It answers questions the other tools cannot, such as "show me the latency distribution of every read syscall" without modifying the application.

### One-Liners That Earn Their Keep

```bash
# Count syscalls by process name over the observation window
bpftrace -e 'tracepoint:raw_syscalls:sys_enter { @[comm] = count(); }'
```

```bash
# Histogram of read() sizes returned, in bytes, as a power-of-two distribution
bpftrace -e 'tracepoint:syscalls:sys_exit_read /args->ret > 0/ { @bytes = hist(args->ret); }'
```

```bash
# Trace every new process exec across the node, with arguments
bpftrace -e 'tracepoint:syscalls:sys_enter_execve { printf("%s %s\n", comm, str(args->filename)); }'
```

A particularly valuable production one-liner measures block I/O latency as a histogram, exposing tail latency that averages hide:

```bash
# Latency distribution of block I/O completions in microseconds
bpftrace -e '
tracepoint:block:block_rq_issue { @start[args->dev, args->sector] = nsecs; }
tracepoint:block:block_rq_complete /@start[args->dev, args->sector]/ {
  @usecs = hist((nsecs - @start[args->dev, args->sector]) / 1000);
  delete(@start[args->dev, args->sector]);
}'
```

```text
@usecs:
[64, 128)         412 |@@@@@@@@@@@@@@@@@@@@                                 |
[128, 256)       1043 |@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@|
[256, 512)        289 |@@@@@@@@@@@@@@                                      |
[512, 1K)          61 |@@@                                                 |
[1K, 2K)            9 |                                                    |
```

### bpftrace in Kubernetes

`bpftrace` traces the whole host kernel, so it sees every container automatically; the challenge is filtering to the workload you care about. Filter by PID or cgroup ID inside the probe. To deploy it across a fleet for ad hoc tracing, run a privileged DaemonSet or a privileged debug pod that mounts the host's kernel headers and `/sys`. A minimal privileged debug pod manifest:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: bpftrace-debug
  namespace: kube-system
spec:
  hostPID: true
  nodeName: worker-03
  containers:
    - name: bpftrace
      image: quay.io/iovisor/bpftrace:latest
      command: ["sleep", "3600"]
      securityContext:
        privileged: true
      volumeMounts:
        - name: sys
          mountPath: /sys
          readOnly: true
        - name: modules
          mountPath: /lib/modules
          readOnly: true
  volumes:
    - name: sys
      hostPath:
        path: /sys
    - name: modules
      hostPath:
        path: /lib/modules
  restartPolicy: Never
```

With `hostPID: true`, PIDs inside the pod match host PIDs, so you can filter probes by the exact process you pulled from `crictl` or `kubectl`.

## journalctl: Querying the systemd Journal

On any systemd-based host, `journalctl` is the front door to logs: kernel messages, service output, and structured metadata all in one queryable store. It is faster and more precise than tailing flat files because it filters on indexed fields.

```bash
# Follow logs for a single unit, like tail -f but unit-scoped
journalctl -u kubelet -f

# Logs since a relative time, with priority error and above only
journalctl --since "10 minutes ago" -p err

# Kernel ring buffer messages with human timestamps
journalctl -k --since "1 hour ago"
```

Bounding a query to an incident window and a unit is the daily workhorse:

```bash
# Everything kubelet logged during a specific outage window
journalctl -u kubelet --since "2032-04-20 02:00" --until "2032-04-20 02:30"
```

To investigate why a service keeps restarting, combine unit filtering with the boot identifier and machine-readable output for piping into other tools:

```bash
# JSON output for the current boot, filtered to a unit, for downstream parsing
journalctl -u containerd -b 0 -o json | jq -r 'select(.PRIORITY <= "3") | .MESSAGE'
```

### journalctl in Kubernetes

Container stdout/stderr flows to the container runtime and is surfaced by `kubectl logs`, not the journal. But the components that run the node, namely `kubelet`, `containerd` or `cri-o`, and the kernel, log to the journal. When a node is `NotReady` or pods will not start, `journalctl -u kubelet` on the node is frequently where the real error lives:

```bash
# On the node: kubelet errors that explain failed pod sandboxes or volume mounts
journalctl -u kubelet -p warning --since "15 minutes ago"
```

## dmesg: The Kernel Ring Buffer

`dmesg` prints the kernel ring buffer, which holds messages the kernel emits about hardware, drivers, the network stack, and, critically for containers, the **OOM killer** and cgroup events. When a container "just disappeared" with no application log, `dmesg` usually has the receipt.

```bash
# Human-readable timestamps, follow new messages
dmesg -wT
```

The single most common production use is confirming an out-of-memory kill:

```bash
# Find OOM killer activity and which process was reaped
dmesg -T | grep -i -E 'killed process|out of memory|oom'
```

```text
[Tue Apr 20 02:14:51 2032] Memory cgroup out of memory: Killed process 9120 (java) total-vm:6291456kB, anon-rss:4194304kB
```

That "Memory cgroup out of memory" line is the definitive signal that a container hit its memory limit and was killed by the kernel, which surfaces in Kubernetes as `OOMKilled` in the pod's last state. The `dmesg` line tells you the exact process and how much memory it held at death, which the Kubernetes event alone does not.

Other high-value `dmesg` searches:

```bash
# Filesystem errors, often the first sign of a failing disk
dmesg -T | grep -i -E 'ext4|xfs|i/o error|remount'

# Network-stack drops and conntrack table exhaustion (common under heavy pod churn)
dmesg -T | grep -i -E 'nf_conntrack|table full|netdev'
```

### dmesg in Kubernetes

The kernel ring buffer is per-node and shared across all containers, so read it on the node. A `nf_conntrack: table full` message during a traffic spike, for instance, is a node-level problem affecting every pod on that node, and only `dmesg` (or the corresponding metric) reveals it. Note that some hardened nodes restrict unprivileged `dmesg` via `kernel.dmesg_restrict`; read it as root or adjust the sysctl in controlled environments.

## Putting It Together: A Triage Workflow

Tools matter less than the order you apply them. A repeatable workflow for a degraded production service:

1. **Characterize the symptom at the node level.** Start with `htop` or `dstat -tcdngy 2` to classify the problem as CPU-bound, memory-bound, I/O-bound, or network-bound. If you arrived late, use `sar` to replay the incident window.
2. **Confirm whether the kernel intervened.** Run `dmesg -T | grep -i oom` and `journalctl -k -p err`. An OOM kill or disk error short-circuits the rest of the investigation.
3. **Localize to a process and namespace.** Map host PIDs to pods via `/proc/<pid>/cgroup`, and use `crictl` to tie containers to pods.
4. **Pick the matching deep tool.** CPU-bound goes to `perf` for a flame graph. Mysterious hangs or errors go to `strace -c`. Network problems go to `ss`, then `tcpdump`. Latency distributions and questions the point tools cannot answer go to `bpftrace`.
5. **Capture, then analyze offline.** Pull a pcap, a `perf.data`, or a bounded `strace` log off the system and analyze on a workstation to keep production load low.

## Conclusion

The tools in this guide have outlasted countless frameworks because they operate at the layer where production problems actually surface: the boundary between processes and the Linux kernel. In a containerized world they remain just as relevant, with one added skill required: getting the tool into the right namespace, whether through `kubectl debug`, `nsenter`, or `crictl`.

Key takeaways:

- **Match the tool to the bottleneck.** `htop`/`dstat`/`sar` to classify, `perf` for CPU, `strace`/`ltrace` for syscall and library behavior, `ss`/`tcpdump` for the network, `dmesg`/`journalctl` for the kernel and system services.
- **Namespaces decide what you see.** Run network tools in the pod's netns and process tools against host PIDs; `nsenter` and ephemeral debug containers bridge the gap.
- **Prefer low-overhead, capture-and-analyze patterns** in production. `perf` and `bpftrace` sample cheaply; `strace` is heavy, so scope it tightly with `-c` and `-e`.
- **`dmesg` and `journalctl` answer the "it just vanished" questions** that application logs cannot, especially OOM kills, disk errors, and conntrack exhaustion.
- **Build muscle memory before the incident.** Practice these invocations in staging so that at 2 AM you move straight from "something is wrong" to "here is what is wrong."
