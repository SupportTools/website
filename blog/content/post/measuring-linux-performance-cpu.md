---
title: "Measuring Linux Performance: CPU (and the Mistakes Almost Everyone Makes)"
date: 2032-04-30T09:00:00-05:00
draft: false
tags: ["Linux", "Performance", "CPU", "Observability", "Kubernetes", "cgroups", "Prometheus", "Troubleshooting", "SRE", "Cloud", "perf", "PSI"]
categories:
- Linux
- Performance
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A practical guide to measuring Linux CPU performance correctly: load average vs utilization, us/sy/wa/st, steal time, context switches, PSI, and cgroup/Kubernetes throttling."
more_link: "yes"
url: "/measuring-linux-performance-cpu/"
---

CPU is the metric people think they understand and almost universally measure wrong. Someone sees a load average of 12 on an eight-core box, declares the server "overloaded," and starts scaling out, when the real problem is a disk that cannot keep up. Someone else looks at 90% CPU utilization inside a container and panics, never noticing that the kernel was throttling the workload long before it touched that number. The tooling on a modern Linux host exposes a dozen different CPU-related signals, and most of them mean something subtly different from what their name suggests.

This article is the first in a five-part series on measuring Linux performance the right way. It focuses entirely on CPU: what the numbers actually represent, which tool to reach for, how virtualization and cgroups distort the picture, and the specific mistakes that send teams chasing the wrong bottleneck for hours. The goal is not to memorize flags but to build a mental model accurate enough that the numbers stop lying to you.

<!--more-->

> This is part of a series. The full set covers CPU, memory, disk/storage, and network, with a final recap of the common mistakes across all four. Links to the rest of the series are at the bottom of this post.

## The First and Biggest Mistake: Load Average Is Not CPU Utilization

The single most common error in Linux performance work is treating **load average** as a measure of how busy the CPU is. It is not. On Linux, load average counts the number of tasks that are either running on a CPU *or* waiting to run *or* blocked in uninterruptible sleep (the `D` state, almost always disk or network I/O). It is a measure of demand on the system, not a measure of CPU consumption.

Read the raw source directly so the definition is concrete.

```bash
# Read the three load-average figures plus the run-queue / total ratio
cat /proc/loadavg
# 2.31 1.94 1.78 3/812 44213

# Count online logical CPUs so the load average can be normalized
nproc
# 8

# A one-liner that divides the 1-minute load by the core count
awk '{print $1}' /proc/loadavg | xargs -I{} echo "scale=2; {} / $(nproc)" | bc
```

The three numbers are exponentially-damped moving averages over roughly 1, 5, and 15 minutes. The fourth field (`3/812`) is the number of currently runnable tasks over the total number of tasks, and the last field is the most recently created PID.

### A Worked Example: The Same Number on Three Different Machines

The reason load average misleads people is that the raw figure carries no information about capacity. Consider a 1-minute load average of `8.00` on three different hosts:

```text
Host A: 1 vCPU burstable cloud instance   load 8.00 -> normalized 8.00  (badly oversubscribed)
Host B: 8-core application server          load 8.00 -> normalized 1.00  (fully utilized, healthy)
Host C: 64-core database node              load 8.00 -> normalized 0.13  (almost idle)
```

The identical number `8.00` describes a machine that is on fire, a machine running at exactly its sweet spot, and a machine that is nearly asleep. The only operation that makes the figure comparable is dividing by `nproc`. A normalized load of `1.00` means demand exactly equals the number of cores; below `1.00` there is headroom; above `1.00` work is queueing. This is why every load-average panel worth keeping plots `load / nproc`, not the raw value, and why a single dashboard tile labeled "load: 8" with no core context is close to useless.

There is a second worked example that exposes the I/O conflation problem. Suppose `uptime` reports a 1-minute load of `30` on an 8-core box, and the on-call instinct is to scale out. Before doing anything, count how many of those runnable-or-blocked tasks are actually in uninterruptible sleep:

```bash
# Count tasks currently in the D (uninterruptible sleep) state, almost always disk/NFS I/O
ps -eo state,comm | awk '$1 ~ /D/ {n++} END {print n " tasks in D state"}'

# Cross-check with the run-queue figure (first number of the 4th loadavg field)
cut -d' ' -f4 /proc/loadavg
# 27/940   -> 27 tasks runnable-or-running right now
```

If most of the contributing tasks are in the `D` state, the load is being driven by I/O, not CPU, and `mpstat` will show the cores sitting mostly idle with high `%iowait`. Adding CPU capacity to that host changes nothing because the CPUs were never the constraint. This single distinction, demand versus CPU demand, is responsible for a large fraction of misdirected incident response.

Three things make load average dangerous to read naively:

- **It is not normalized to the number of cores.** A load average of 8 is a fully-saturated, healthy single-vCPU instance and a half-idle 16-core server. The figure means nothing until you divide it by `nproc`. As a rough rule of thumb, a normalized load (load divided by core count) near 1.0 means the machine is fully utilized; sustained values well above 1.0 mean tasks are queuing.
- **It conflates CPU demand with I/O demand.** Because Linux includes uninterruptible-sleep tasks, a host with a failing disk can show a load average of 30 while the CPUs sit 95% idle. The tasks are not waiting for CPU; they are stuck in disk I/O. Scaling out CPU does nothing here.
- **It is a lagging, smoothed signal.** A 30-second CPU spike barely moves the 1-minute average and is invisible in the 15-minute one. Load average is useful for spotting trends, not for catching short stalls.

The takeaway: load average tells you whether *something* is creating queueing pressure on the system. It does not tell you whether that something is CPU, and it does not tell you the magnitude relative to capacity. Use it as a first glance, then immediately confirm with a utilization breakdown.

### What "Runnable" Actually Means

When load average and the run queue refer to "runnable" tasks, they mean tasks in the kernel's `TASK_RUNNING` state: either executing on a CPU right now or sitting on a per-CPU run queue waiting for a turn. The Linux scheduler maintains a run queue per logical CPU, and the global picture is the sum across all of them. The fourth field of `/proc/loadavg` (`3/812` above) gives you the instantaneous count of runnable-or-running tasks as its numerator. That instantaneous number is often more actionable than the smoothed averages, because it is not delayed by the exponential decay. The smoothed averages are for trend-spotting; the instantaneous run-queue count and `vmstat`'s `r` column are for catching a problem happening right now.

## Reading the CPU Utilization Breakdown Correctly

When you actually want to know what the CPUs are doing, you need the per-mode breakdown that `top`, `mpstat`, `vmstat`, and `sar` all expose. The columns matter enormously, and several of them are routinely misread.

The standard fields are:

- **`%us` (user)** time spent executing user-space code. This is your application doing work.
- **`%sy` (system)** time spent in the kernel on behalf of processes: system calls, context switching, network stack, filesystem. High system time often points at syscall-heavy workloads, lock contention, or excessive context switching.
- **`%ni` (nice)** user time for processes whose scheduling priority has been lowered with `nice`.
- **`%id` (idle)** time the CPU did nothing.
- **`%wa` (iowait)** time the CPU was idle *while there was outstanding disk I/O*.
- **`%hi` / `%si` (hardware/software interrupts)** time servicing IRQs and softirqs, relevant on busy network hosts.
- **`%st` (steal)** time the hypervisor gave to other guests instead of this VM. Only meaningful on virtualized instances.
- **`%gu` (guest)** on a hypervisor host, time spent running guest VMs.

Here is the non-interactive way to capture this, which is what you want in scripts, runbooks, and SSH sessions where an interactive UI is awkward.

```bash
# Non-interactive top: one sample, machine-parseable
top -b -n1 | head -n5

# Per-core breakdown every 2 seconds, 3 samples, all CPUs
mpstat -P ALL 2 3
```

A representative `mpstat -P ALL` sample on an eight-core host under a moderately busy web workload looks like this:

```text
Linux 6.8.0-40-generic (web-07)   04/30/2032   _x86_64_   (8 CPU)

09:14:22 AM  CPU    %usr   %nice    %sys %iowait    %irq   %soft  %steal   %idle
09:14:24 AM  all   38.21    0.00   11.04    1.02    0.00    2.11    0.00   47.62
09:14:24 AM    0   71.50    0.00   18.00    0.50    0.00    4.50    0.00    5.50
09:14:24 AM    1   40.10    0.00   10.55    1.00    0.00    1.50    0.00   46.85
09:14:24 AM    2   12.06    0.00    6.03    2.01    0.00    1.01    0.00   78.89
09:14:24 AM    3   35.00    0.00    9.00    0.50    0.00    1.50    0.00   53.50
```

Notice CPU 0 is nearly saturated at 71.5% user plus 18% system while the aggregate "all" line reports a comfortable-looking 38% user. This is the per-core versus aggregate trap, covered below.

### User Versus System Time, and Why the Ratio Matters

The single most useful split in the breakdown is `%us` against `%sy`. User time is your application's own code running; system time is the kernel running on the application's behalf. The *ratio* between them is diagnostic, often more so than either absolute number.

- **High `%us`, low `%sy`** is the healthy shape for a compute-bound application. The work is happening in your code. If this is too high, the answer is profiling (`perf`) and algorithmic optimization, not kernel tuning.
- **High `%sy` relative to `%us`** is a red flag. The CPU is spending a large fraction of its cycles in the kernel rather than doing your application's work. Common causes are syscall-heavy code (a tight loop calling `read`/`write` with tiny buffers), excessive context switching, lock contention that lands in futex syscalls, heavy memory management (page faults, `madvise`, transparent huge page churn), or a misbehaving network/filesystem path. A web service that suddenly shifts from 60% user / 10% system to 30% user / 40% system is usually doing the same external throughput at a much higher kernel cost, and that delta is where the regression lives.
- **High `%si` (softirq)** points at the network stack or timer/RCU processing. On a host pushing serious packet rates, softirq time concentrates on whichever CPUs handle the NIC receive queues. If one core shows 40% `%soft` while the rest are idle, you have an IRQ-affinity or RSS (receive-side scaling) distribution problem, not a general CPU shortage.
- **High `%hi` (hardware IRQ)** is rarer and usually indicates a storm of device interrupts, sometimes a failing device or a driver without interrupt coalescing.

A quick way to attribute a sudden `%sy` jump to specific system calls is `strace -c` on the offending process, or `perf top` filtered to kernel symbols. The point is that "CPU is high" is never the end of the investigation; the user/system split tells you which half of the system to look in next.

### Capturing the Breakdown Without an Interactive UI

In runbooks and SSH sessions you want machine-parseable output rather than a live UI. The non-interactive forms below produce stable, greppable text:

```bash
# One mpstat sample of all CPUs, then exit (good for scripts and runbooks)
mpstat -P ALL 1 1

# Per-process CPU attribution, one 2-second sample
pidstat -u 2 1

# Snapshot of the run queue and the user/system/iowait/steal split
vmstat -w 1 1
```

Each of these returns after a fixed number of samples, which is what you want when piping into a log file or an incident timeline rather than watching a screen.

### The iowait Trap

The most damaging misreading in this whole category is treating `%wa` (**iowait**) as CPU work. It is the opposite. When a CPU reports iowait, it means the CPU is *idle* and has nothing else to run because the only pending tasks are blocked waiting for disk I/O to complete. The CPU is available; it just has nothing runnable.

This matters because high iowait is frequently misdiagnosed as a CPU problem. A monitoring dashboard that sums `%us + %sy + %wa` and calls it "CPU usage" will show a host pinned at 100% during a storage stall, and an on-call engineer will scale out compute that was never the constraint. The correct interpretation of high iowait is "the CPUs are starved because storage cannot keep up" which is a disk problem, addressed in [Measuring Linux Performance: Disk and Storage](/measuring-linux-performance-disk-storage/).

There is a further subtlety: iowait is per-CPU and somewhat arbitrary in how the kernel attributes it. On a busy multi-core machine, a single thread blocked on I/O can make iowait appear to bounce between cores. Treat iowait as a directional hint that storage may be the bottleneck, then confirm with actual disk metrics, never as a precise figure.

## Per-Core Versus Aggregate: Why Averages Hide Saturation

Aggregate CPU utilization is an average across all logical CPUs, and averages hide hot spots. A single-threaded process pinned to one core can saturate that core completely while the eight-core aggregate reads 12.5%. Every dashboard that shows one "CPU %" gauge per host is lying to you about this class of problem.

Single-threaded saturation is extremely common in practice:

- A legacy application that never learned to use more than one thread.
- A misconfigured worker pool with a concurrency of one.
- A lock so contended that only one thread makes progress at a time.
- An interrupt storm pinning a single CPU that handles a busy network queue.

The fix is to always look per-core when investigating a suspected CPU bottleneck. `mpstat -P ALL` is the cleanest tool for this; `htop` shows it visually with one bar per core; `top` reveals it if you press `1` to expand the per-CPU lines. If one core is at 100% and the rest are idle, no amount of horizontal scaling helps until the workload is parallelized or the hot path is fixed.

```bash
# Per-process CPU, refreshed every 2 seconds
pidstat -u 2

# System-wide view: run queue (r), context switches (cs), CPU split
vmstat 2 5
```

`pidstat -u` is the right tool to find *which* process owns the CPU time, and it can exceed 100% for a multi-threaded process (one full core equals 100%, so a process using four cores shows 400%). That is expected and is the clearest way to tell a multi-threaded workload from a single-threaded one.

When a process is multi-threaded but only one thread is hot (the classic contended-lock or single-busy-worker pattern), per-process CPU hides the imbalance the same way per-host CPU does. The `-t` flag breaks it down per thread:

```bash
# Per-thread CPU attribution for every thread of every process
pidstat -t -u 2 1
```

A representative `pidstat -t -u` sample for a process whose work is stuck on one thread:

```text
09:52:14 AM   UID      TGID       TID    %usr %system  %CPU   CPU  Command
09:52:16 AM  1000     14122         -    98.0     6.5 104.5     3  worker
09:52:16 AM  1000         -     14122     2.0     1.0   3.0     3  |__worker
09:52:16 AM  1000         -     14140    96.0     4.5 100.5     1  |__worker
09:52:16 AM  1000         -     14141     0.0     0.0   0.0     5  |__worker
```

The process-level line (TGID `14122`) shows `104.5%`, suggesting it uses just over one core. The per-thread breakdown reveals why: a single thread (TID `14140`) is pinned at `100.5%` while its siblings are idle. This process is effectively single-threaded under load, so giving it more cores or more replicas on the same node will not help; the contention or serialization inside the process must be fixed. This per-thread view is the bridge between "the process is busy" and "one specific thread is the bottleneck," and it frequently redirects an investigation away from infrastructure and toward the application's concurrency model.

## The Run Queue and Context Switches

Two of the most useful CPU saturation signals do not appear in a simple utilization percentage at all: the **run queue** length and the **context switch** rate. Both come from `vmstat`.

A typical `vmstat 2 5` capture on a host under CPU pressure:

```text
procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----
 r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
12  0      0 412300  88120 2933104    0    0     2    18 2204 9821 71 14 14  1  0
14  0      0 410884  88120 2933440    0    0     0     6 2410 11203 74 15 10  1  0
11  1      0 409120  88120 2933880    0    0     0    44 2188 9540 70 13 16  1  0
```

The columns that matter for CPU:

- **`r` (run queue)** the number of tasks currently runnable, meaning they want CPU right now. The critical comparison is `r` against the number of cores. If `r` is consistently larger than `nproc`, tasks are queuing for the CPU and you have genuine CPU saturation. An `r` of 12 on an eight-core box means roughly four tasks are always waiting their turn.
- **`cs` (context switches per second)** how often the scheduler swapped one task for another. A high and rising `cs` rate, especially with high `%sy`, points to scheduling overhead: too many threads, lock contention, or thundering-herd wakeups. There is no universal "bad" number; you compare against a known-good baseline for the same workload.
- **`in` (interrupts per second)** hardware interrupts, mostly relevant for network-heavy hosts.

The `r` column is, in many ways, a more honest CPU-saturation signal than utilization. Utilization tells you the CPUs are busy; the run queue tells you whether more work is waiting than the CPUs can serve. A host can sit at 100% utilization with `r` equal to `nproc` and be perfectly healthy (fully used, nothing queuing), or sit at 100% with `r` at three times `nproc` and be badly oversubscribed. The percentage cannot distinguish those two states; the run queue can.

A few `vmstat` columns outside the explicit CPU group still inform a CPU diagnosis and are worth reading together:

- **`b` (blocked)** counts tasks in uninterruptible sleep, the same `D`-state tasks that inflate load average. A persistently nonzero `b` alongside low `us`/`sy` and high `wa` is the unmistakable shape of an I/O bottleneck masquerading as load.
- **`si` / `so` (swap in / swap out)** should be zero on a healthy host. Nonzero swap activity means the kernel is paging, which burns system CPU and stalls processes; a "CPU problem" that is really memory pressure shows up here, and is the subject of [the memory article](/measuring-linux-performance-memory/).
- **The `cpu` group (`us sy id wa st`)** is the same breakdown discussed earlier, conveniently on the same line as the run queue and context-switch rate. Reading `r`, `cs`, and the `us`/`sy` split on one line is often enough to classify a CPU problem in a single `vmstat` sample.

The discipline with `vmstat` is to read the whole line as one picture: the run queue against core count, the context-switch rate against baseline, and the user/system/iowait/steal split together. Any one column in isolation can mislead; the line as a whole rarely does.

For a precise view of how long tasks actually wait before being scheduled, eBPF tooling gives a latency histogram rather than a coarse count.

```bash
# Histogram of scheduler run-queue latency (bcc/eBPF tools)
runqlat 5 1

# Context switches and interrupts per second, system-wide
vmstat -w 1 3 | awk '{print $12, $13}'
```

`runqlat` (from the bcc/eBPF toolkit) buckets the time each task spent waiting on the run queue. If the bulk of tasks are scheduled in microseconds you have ample CPU headroom; a fat tail in the milliseconds means tasks are queuing and users are feeling it. This is the difference between knowing the CPU is busy and knowing the busyness is causing latency.

A typical healthy `runqlat 5 1` histogram looks like this, with everything bunched at the low end:

```text
     usecs               : count     distribution
         0 -> 1          : 0        |                                        |
         2 -> 3          : 184      |****                                    |
         4 -> 7          : 1502     |************************************    |
         8 -> 15         : 1631     |****************************************|
        16 -> 31         : 412      |**********                              |
        32 -> 63         : 88       |**                                      |
        64 -> 127        : 11       |                                        |
       128 -> 255        : 2        |                                        |
```

Almost all wakeups are scheduled within tens of microseconds, which means the CPU is keeping up with demand. Contrast that with an oversubscribed host, where the distribution grows a fat tail well into the milliseconds:

```text
     usecs               : count     distribution
         8 -> 15         : 120      |***                                     |
        16 -> 31         : 240      |******                                  |
      1024 -> 2047       : 1380     |************************************    |
      2048 -> 4095       : 1510     |****************************************|
      4096 -> 8191       : 602      |***************                         |
```

When a significant population of tasks waits multiple milliseconds just to get onto a CPU, end-user latency degrades even though the utilization number alone might look merely "busy." The histogram is the proof that busyness has crossed into harmful queuing.

### Voluntary Versus Involuntary Context Switches

Not all context switches mean the same thing, and the distinction is one of the sharpest CPU-saturation signals available. A **voluntary** context switch happens when a task gives up the CPU on its own, typically because it blocked on I/O, a lock, or a sleep. An **involuntary** context switch happens when the scheduler forcibly preempts a still-runnable task because its time slice expired and other tasks are waiting. A rising rate of *involuntary* switches is a direct symptom of CPU contention: tasks want to keep running but are being kicked off because there is more demand than there are cores.

```bash
# Per-process voluntary and non-voluntary (involuntary) context switches
pidstat -w 2 1

# The same counters for a single process, from /proc
grep ctxt /proc/self/status
# voluntary_ctxt_switches:        842
# nonvoluntary_ctxt_switches:     17
```

A representative `pidstat -w` sample under CPU pressure:

```text
09:31:10 AM   UID       PID   cswch/s nvcswch/s  Command
09:31:12 AM  1000     14122     12.50   1840.00  worker
09:31:12 AM  1000     14130     11.00   1755.50  worker
09:31:12 AM     0       912    220.00      0.50  systemd
```

The `worker` processes show enormous `nvcswch/s` (non-voluntary context switches per second) relative to `cswch/s`. They are being preempted constantly, which is the signature of too many runnable threads chasing too few cores. The fix is to reduce concurrency (fewer worker threads), add cores, or pin work so the scheduler thrashes less, not to optimize the code, which is running fine when it gets the CPU.

### Scheduler Latency in Detail

For incident-grade detail on *why* a latency-sensitive process missed its deadline, `perf sched` records every scheduling event and reports how long each task waited between becoming runnable and actually running:

```bash
# Record all scheduler events for 5 seconds
perf sched record -- sleep 5

# Report the worst per-task scheduling latencies, sorted by maximum wait
perf sched latency --sort max | head -n 20
```

The output attributes wait time to individual tasks, so you can see, for example, that a request-handler thread routinely waited 8 ms to be scheduled while a batch job hogged the cores. That is the kind of evidence that justifies CPU isolation (`cpuset` cgroups, `isolcpus`, or Kubernetes CPU manager static policy) for the latency-sensitive workload. The coarser `sar -q` historical view complements this by recording run-queue length and load over time so you can correlate a latency complaint with a saturation window after the fact:

```bash
# Historical run-queue length, task counts, and load average (needs sysstat)
sar -q 1 3
```

### Per-Core Imbalance From Interrupts and Affinity

Saturation does not have to be uniform. A single core can be pinned by interrupt handling while the rest idle, which aggregate utilization completely hides. This is common on network-heavy hosts where one CPU services a busy NIC queue.

```bash
# Which CPUs are fielding interrupts, and from what devices
head -n 5 /proc/interrupts

# Per-CPU interrupt service time
mpstat -I CPU 2 1
```

If `/proc/interrupts` shows one CPU absorbing the vast majority of a NIC's interrupts, enabling RSS/RPS to spread receive processing across cores, or setting IRQ affinity with `irqbalance` or manual `smp_affinity`, rebalances the load. The measurement lesson is the same one that recurs throughout this article: an aggregate number can be calm while one core is the bottleneck, so always confirm per-core before concluding the host has CPU headroom.

## Steal Time: The Metric That Only Exists on Virtual Machines

On any virtualized or cloud instance, **steal time** (`%st`) is the field that most often explains "the server is slow but CPU looks fine." Steal time is the percentage of time the virtual CPU was ready to run but the hypervisor was busy running some other guest instead. From inside the guest, the work simply did not happen, even though the guest had something to do.

```bash
# Watch the steal column (st) on a cloud instance
mpstat 2 5 | awk 'NR>3 {print $NF, "steal%"}'

# sar can show steal time historically if sysstat collection is enabled
sar -u 1 3
```

Steal time matters for several reasons specific to cloud and on-prem virtualization:

- **It is invisible to in-guest application metrics.** The application sees latency and timeouts but no obvious cause, because from its perspective the CPU was simply not scheduled. Only `%st` reveals that the hypervisor took the cycles.
- **It is the signature of noisy neighbors.** On shared or burstable instance types, sustained steal of even a few percent means other tenants on the same physical host are contending for the CPU. On burstable instances (where CPU credits govern access), exhausted credits manifest as steal once throttling kicks in.
- **It changes the remediation.** High steal is not solved by optimizing your code or adding application replicas on the same host. It is solved by moving to a dedicated or larger instance type, or to a host with less contention.

A practical threshold: occasional single-digit steal is normal on shared instances. Sustained steal above roughly 10% on a latency-sensitive workload is a strong signal to change instance type. Always graph steal time on cloud fleets; it is the cheapest insurance against blaming the wrong layer.

A `sar -u` capture on a contended instance makes steal visible historically, which is invaluable because the noisy-neighbor pattern is often intermittent and gone by the time anyone investigates:

```text
12:00:01 AM     CPU     %user     %nice   %system   %iowait    %steal     %idle
12:10:01 AM     all     41.22      0.00      9.83      0.41     14.07     34.47
12:20:01 AM     all     38.90      0.00      9.10      0.38     19.62     31.99
12:30:01 AM     all     40.15      0.00      9.55      0.40      4.11     45.79
```

The 12:20 sample shows nearly 20% steal: for that ten-minute window, a fifth of the instance's CPU was handed to other tenants. The application would have logged elevated latency in that window with no in-guest explanation. Because `sar` keeps this history on disk, you can line it up against an SLO breach and prove the cause was the hypervisor, not your code. This is one of the strongest arguments for enabling `sysstat` collection across an entire cloud fleet.

A related distortion on burstable instance families (AWS T-series, GCP shared-core, Azure B-series) is **CPU credit exhaustion**. These instances run at full speed only while they have accumulated credits; once depleted, the hypervisor throttles them to a baseline, which shows up inside the guest as steal time. The remediation is not code optimization but either moving to a fixed-performance instance type or enabling unlimited/burst-billing mode. Treating credit-driven steal as a code problem leads to weeks of fruitless profiling.

## CPU Frequency Scaling Distorts Capacity Planning

A second virtualization-adjacent mistake is assuming a core's throughput is constant. Modern CPUs change clock frequency continuously through governors and turbo boost, and the same "100% utilization" can represent very different amounts of actual work depending on the current frequency. A core throttled to 1.2 GHz for thermal or power reasons does far less per second than the same core at 4.5 GHz turbo, yet both report 100% busy.

Check the running governor and live frequencies before trusting capacity assumptions:

```bash
# Current scaling governor per core (powersave, performance, schedutil, etc.)
cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor

# Live per-core frequency in kHz
grep "^cpu MHz" /proc/cpuinfo
```

On benchmarking hosts and latency-sensitive production nodes it is common to pin the governor to `performance` to remove this variable. On cloud instances the governor is often fixed by the provider, but thermal throttling and burst behavior still apply. The lesson for measurement: a utilization percentage is a fraction of available cycles, and the number of available cycles is not constant. When you compare utilization across time or across hosts, confirm the frequency story is comparable.

## sar and sysstat: The History Most Hosts Are Missing

Every tool discussed so far shows you the present. Incidents, however, are almost always investigated after the fact, once the spike has passed and the live tools show a calm system. The `sysstat` package solves this by recording system activity to disk on a schedule (typically every 10 minutes via `cron`, plus finer-grained on-demand sampling), and `sar` replays it. Enabling it everywhere is one of the cheapest, highest-leverage observability decisions a team can make.

```bash
# Enable and start the sysstat collector (Debian/Ubuntu shown)
# Set ENABLED="true" in /etc/default/sysstat, then:
systemctl enable --now sysstat

# CPU breakdown, live: 1-second samples, 3 of them
sar -u 1 3

# Today's recorded CPU history at the default 10-minute granularity
sar -u

# Run-queue length and load average, recorded
sar -q

# Context switch and process-creation rates, recorded
sar -w

# Read a specific prior day's data file (e.g. the 14th of the month)
sar -u -f /var/log/sysstat/sa14
```

The killer feature is `-f`: when an SLO breach happened at 03:12 last Tuesday, you can open that day's saved file and read the exact CPU breakdown, run-queue length, and steal time from the incident window, long after the live tools have forgotten it. A representative recorded `sar -u` day shows the texture of a workload over time:

```text
12:00:01 AM     CPU     %user     %nice   %system   %iowait    %steal     %idle
12:10:01 AM     all     22.41      0.00      6.12      0.30      0.08     71.09
12:20:01 AM     all     24.03      0.00      6.55      0.28      0.05     69.09
03:10:01 AM     all     78.92      0.00     14.20      1.10      9.41     -3.63
03:20:01 AM     all     19.88      0.00      5.40      0.25      0.06     74.41
Average:        all     31.07      0.00      8.04      0.42      1.22     59.25
```

The 03:10 row is the smoking gun: a batch job pushed user time to nearly 79%, system time to 14%, and notably steal to 9.4% (the host was contended at the hypervisor level during the same window). Without recorded history this evidence would simply not exist by the time anyone looked. The few megabytes of disk `sysstat` consumes per host are repaid the first time a post-incident review needs the CPU picture from before the page fired.

In a Kubernetes or cloud-native environment the same role is played by Prometheus retaining `node_cpu_seconds_total`, `container_cpu_*`, and the PSI and throttling series. The principle is identical: collect the time series continuously so the question "what did the CPU look like before the incident" always has an answer.

## Pressure Stall Information: The Modern Saturation Signal

The cleanest CPU-saturation signal on a current kernel is **Pressure Stall Information (PSI)**, available since Linux 4.20. PSI directly answers the question utilization cannot: for what fraction of time were runnable tasks stalled waiting for a CPU? Unlike load average, it is normalized and bounded between 0 and 100%; unlike utilization, it measures contention rather than busyness.

```bash
# CPU pressure stall information (kernel 4.20+)
cat /proc/pressure/cpu
# some avg10=4.21 avg60=3.88 avg300=2.40 total=18564321

# Per-cgroup CPU pressure on a cgroup v2 system
cat /sys/fs/cgroup/system.slice/some-service.service/cpu.pressure
```

The `some` line reports the percentage of time *at least one* task was stalled waiting for CPU, averaged over 10, 60, and 300 seconds. `total` is the cumulative stall time in microseconds since boot. A `some avg10` near zero means no CPU contention; a sustained value of 20 means tasks spent a fifth of their time waiting for a core, which is a clear, normalized saturation signal regardless of core count.

For CPU specifically, the kernel reports only the `some` line in `/proc/pressure/cpu` on most kernels, because by definition CPU pressure is about *some* task waiting; a `full` line (all non-idle tasks stalled simultaneously) is meaningful for memory and I/O pressure but less so for CPU. When you do see a `full` line on memory or I/O pressure, it indicates a far more severe stall where nothing was making progress, which is why memory and I/O PSI are covered in the later parts of this series.

The right way to use PSI operationally is to alert on a sustained `some avg10`. A short spike to 30 during a deploy is noise; a sustained value above, say, 20 for several minutes is a normalized, core-count-independent statement that tasks are waiting a fifth of their time for CPU. Because it is normalized, the same threshold works on a 2-core node and a 64-core node, which is exactly what load average fails to provide.

PSI's real power is that it is available per-cgroup, which makes it the ideal signal for containers and Kubernetes pods. Rather than guessing whether a pod is CPU-starved from its parent node's aggregate utilization, you can read the pressure on that pod's own cgroup. This is far more reliable than node-level utilization for diagnosing why a specific workload is slow. On a cgroup v2 system, each pod's slice exposes its own `cpu.pressure`:

```bash
# CPU pressure for a specific Kubernetes pod's cgroup slice (cgroup v2)
cat /sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/cpu.pressure
# some avg10=22.14 avg60=18.30 avg300=11.05 total=98231445
```

A pod showing `some avg10=22` is spending over a fifth of its runnable time waiting for CPU, which is a precise, defensible saturation signal for that workload alone, independent of what the rest of the node is doing. Crucially, PSI and CFS throttling answer different questions: PSI tells you the pod is waiting for a core (contention or undersized requests), while the throttling counters tell you the pod hit its own quota ceiling. A pod can show high throttling with low node-level PSI (it is being capped, not starved) or high PSI with no throttling (the node is oversubscribed and it has no limit). Reading both disambiguates the cause.

## CPU in cgroups and Kubernetes: Limits, Quota, and CFS Throttling

Containerized CPU measurement introduces a failure mode that does not exist on bare metal: a workload can be **throttled** by the kernel long before its utilization reaches anything alarming. This is the single most misunderstood aspect of Kubernetes CPU and the source of countless "the pod is slow but CPU is only 60%" tickets.

Kubernetes CPU **requests** and **limits** map onto Linux **CFS (Completely Fair Scheduler) bandwidth control**. A request sets the cgroup's CPU shares (relative weight under contention). A limit sets a hard **quota**: a maximum number of microseconds of CPU the cgroup may consume per scheduling **period** (100 ms by default). When the cgroup exhausts its quota within a period, every thread in it is *stopped* until the next period begins, even if the host has idle cores.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: payments
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api
  template:
    metadata:
      labels:
        app: api
    spec:
      containers:
        - name: api
          image: registry.support.tools/payments/api:1.8.2
          resources:
            requests:
              cpu: "500m"
              memory: "256Mi"
            limits:
              cpu: "1"
              memory: "512Mi"
```

A limit of `1` CPU means the cgroup gets 100 ms of CPU per 100 ms period. A multi-threaded process can burn that entire budget in 25 ms across four threads and then sit frozen for the remaining 75 ms of every period. From inside the container, average utilization might read a calm 25%, while p99 latency is wrecked by repeated 75 ms stalls. Average utilization is exactly the wrong metric here; the throttling counters are the right one.

On a cgroup v2 host, the limit and period are encoded together in a single `cpu.max` file, which is worth reading directly to confirm what the kernel is actually enforcing for a given pod:

```bash
# cgroup v2: the effective quota and period for a container's cgroup
cat /sys/fs/cgroup/kubepods.slice/cpu.max
# 100000 100000
```

The two numbers are quota and period in microseconds. `100000 100000` means 100 ms of CPU per 100 ms period, which is the `limits.cpu: "1"` from the manifest above. A value of `max 100000` means no limit is set (the quota is unbounded), in which case throttling cannot occur and the cgroup is governed only by its weight under contention. Reading `cpu.max` removes any ambiguity about whether a workload is even eligible to be throttled.

### Finding the Right cgroup, v1 Versus v2

A practical stumbling block is locating the exact cgroup for a given pod, and the layout differs between cgroup versions. First confirm which version the node runs:

```bash
# If this path exists and cgroup.controllers is present, the node is on cgroup v2 (unified)
stat -t /sys/fs/cgroup/cgroup.controllers >/dev/null 2>&1 && echo "cgroup v2" || echo "cgroup v1"
```

On a **cgroup v2** node, all controllers live under a single unified hierarchy rooted at `/sys/fs/cgroup`, and Kubernetes nests pod slices under `kubepods.slice` (further split into `kubepods-burstable.slice` and `kubepods-besteffort.slice` by QoS class). The throttling data is in each slice's `cpu.stat`, and the limit is in `cpu.max`. On a **cgroup v1** node, each controller has its own tree, so CPU bandwidth data lives under `/sys/fs/cgroup/cpu/` (or `cpu,cpuacct`), and the throttling fields appear inside `cpu.stat` there as `nr_periods`, `nr_throttled`, and `throttled_time` (note: nanoseconds on v1, microseconds on v2). The interpretation is identical across versions; only the path and the time unit differ.

The reliable shortcut, rather than hand-navigating the tree, is to let the runtime tell you the cgroup, or simply exec into the container and read `/sys/fs/cgroup/cpu.stat` from inside, where the container's own cgroup is mounted at the root of its view. That in-container read is version-agnostic from the operator's perspective and avoids guessing the slice path entirely.

The kernel exposes those counters in `cpu.stat`.

```bash
# cgroup v2: CFS throttling counters for a container's cgroup
cat /sys/fs/cgroup/kubepods.slice/cpu.stat
# usage_usec 9823145000
# user_usec 7120044000
# system_usec 2703101000
# nr_periods 184522
# nr_throttled 41003
# throttled_usec 88245110000

# Compute the throttled-period ratio
awk '/nr_periods/{p=$2} /nr_throttled/{t=$2} END{printf "throttled %.1f%%\n", (t/p)*100}' \
  /sys/fs/cgroup/kubepods.slice/cpu.stat
```

The fields that matter:

- **`nr_periods`** the number of enforcement periods elapsed.
- **`nr_throttled`** how many of those periods ended with the cgroup throttled.
- **`throttled_usec`** total microseconds threads were stopped due to quota exhaustion.

The single most useful derived number is the ratio `nr_throttled / nr_periods`. If 41,003 of 184,522 periods were throttled, this workload is stopped on roughly 22% of all scheduling periods. That is a serious latency problem invisible to utilization graphs. (On a cgroup v1 host the same data lives in `cpu.cfs_throttled_periods` and `cpu.stat` under `/sys/fs/cgroup/cpu/`, but the interpretation is identical.)

In Prometheus, the equivalent metrics from cAdvisor are `container_cpu_cfs_periods_total` and `container_cpu_cfs_throttled_periods_total`. A throttling alert that catches this class of problem before users do looks like this:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cpu-throttling
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: cpu.rules
      rules:
        - alert: ContainerCPUThrottlingHigh
          expr: |
            sum(rate(container_cpu_cfs_throttled_periods_total{container!=""}[5m])) by (namespace, pod, container)
              /
            sum(rate(container_cpu_cfs_periods_total{container!=""}[5m])) by (namespace, pod, container)
              > 0.25
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "CPU throttling on {{ $labels.namespace }}/{{ $labels.pod }}"
            description: "Container {{ $labels.container }} is throttled on more than 25% of CFS periods."
```

A few hard-won operational notes on Kubernetes CPU:

- **Throttling can occur well below the limit on bursty workloads.** Because quota is enforced per 100 ms period, a workload that needs short bursts of full-core CPU (request handlers, garbage collectors, JIT compilers) gets throttled even though its average is far under the limit. Raising the limit, widening the period, or removing the limit entirely (relying on requests for fairness) are the usual remedies, chosen per workload.
- **Requests, not limits, drive the scheduler's placement decisions.** Setting requests too low packs too many pods onto a node and creates contention that shows up as run-queue pressure and PSI on the node, not as throttling.
- **Measure inside the right cgroup.** Node-level utilization tells you almost nothing about whether a specific pod is throttled. Always go to the pod's `cpu.stat` or its `cpu.pressure`, or use the cAdvisor metrics scoped to that container.

### Diagnosing a Throttled Pod End to End

When a service owner reports "the pod is slow but CPU is only 60%," the fastest confirmation is to read the throttling counters from inside the running container, then corroborate with cAdvisor metrics. The in-container read works without any monitoring stack:

```bash
# Exec into the pod and read its own cgroup throttling stats
kubectl exec -n payments deploy/api -- sh -c 'cat /sys/fs/cgroup/cpu.stat'

# Read the same pod's CPU pressure (kernel 4.20+, cgroup v2)
kubectl exec -n payments deploy/api -- sh -c 'cat /sys/fs/cgroup/cpu.pressure'
```

If `nr_throttled / nr_periods` is high or `cpu.pressure`'s `some avg10` is well above zero, the pod is genuinely CPU-starved despite the modest average. From there, the cluster-wide view comes from cAdvisor through Prometheus, which lets you scope to the exact container and compute the throttled-period ratio as a rate:

```bash
# Sanity-check that cAdvisor is exposing the throttling series (from a node or debug pod)
curl -s http://localhost:8080/metrics | grep container_cpu_cfs_throttled
```

The corresponding PromQL, useful for ad-hoc queries before wiring an alert, is the ratio of throttled periods to total periods over a window:

```text
sum(rate(container_cpu_cfs_throttled_periods_total{namespace="payments", pod=~"api-.*"}[5m])) by (pod)
  /
sum(rate(container_cpu_cfs_periods_total{namespace="payments", pod=~"api-.*"}[5m])) by (pod)
```

A result of `0.22` means that pod was throttled in 22% of CFS periods over the last five minutes, which is the same number you derived from the raw `cpu.stat` ratio, now trended over time and across replicas. Seeing those two independent sources agree is the confirmation that closes the ticket: the workload needs a higher (or removed) CPU limit, not a code change.

### Right-Sizing Requests and Limits From the Data

The measurements above feed directly into sizing decisions. The general pattern for CPU-latency-sensitive services:

- **Set requests to the realistic steady-state usage** (often the p50 to p90 of observed cores) so the scheduler places pods accurately and the node is not oversubscribed.
- **Be deliberate about limits.** For latency-sensitive request handlers that burst, a tight CPU limit is frequently the cause of p99 pain. Many teams remove CPU limits entirely on such workloads and rely on requests plus node-level headroom for fairness, accepting that a misbehaving pod can briefly use more than its request when cores are free. Memory limits remain mandatory; CPU limits are a tunable tradeoff.
- **Validate the change with the throttling ratio.** After adjusting, the `container_cpu_cfs_throttled_periods_total` rate should drop toward zero. If it does not, the period (not just the quota) may need attention, or the workload genuinely needs more cores.

The discipline is to let the throttling counters and PSI, not average utilization, drive the numbers. Average utilization is the metric that hides this entire class of problem.

### When Pinning Beats Tuning: The CPU Manager Static Policy

For the most latency-sensitive workloads, even a well-sized limit leaves residual jitter because the pod's threads still migrate across cores and compete with other pods on the same cores. Kubernetes addresses this with the kubelet's **CPU manager static policy**, which grants exclusive whole cores to Guaranteed-QoS pods that request integer CPU. A pod with `requests.cpu == limits.cpu == 2` under the static policy gets two cores to itself, removing cross-pod interference and the cache-thrashing cost of migrations.

```bash
# Confirm the kubelet's CPU manager policy on a node
grep -i cpuManagerPolicy /var/lib/kubelet/config.yaml
# cpuManagerPolicy: static

# Inspect which cores the kubelet has assigned exclusively
cat /var/lib/kubelet/cpu_manager_state
```

The measurement payoff is visible directly in `perf sched latency` and `runqlat`: a pinned, exclusively-scheduled pod shows a far tighter run-queue-latency distribution because it is no longer waiting behind other tenants for a core. This is the production answer when profiling shows the code is fine but tail latency is driven by scheduling jitter rather than by the workload itself. It is a heavier hammer than adjusting limits and is reserved for workloads where p99 latency is a hard requirement, but when the scheduler-latency signals point at interference, it is the correct remedy.

## Reading top and htop Without Being Fooled

`top` is the tool everyone reaches for first, and it is the one most prone to producing a misleading first impression. A few habits make it trustworthy.

```bash
# Non-interactive top: one sample, header plus top processes, machine-parseable
top -b -n1 | head -n 12

# Per-thread view: one line per thread instead of per process
top -H -b -n1 | head -n 12
```

A representative `top -b -n1` header on a busy host:

```text
top - 09:41:18 up 23 days,  4:02,  2 users,  load average: 9.84, 8.11, 6.40
Tasks: 312 total,   4 running, 308 sleeping,   0 stopped,   0 zombie
%Cpu(s): 47.2 us, 12.1 sy,  0.0 ni, 36.4 id,  0.9 wa,  0.0 hi,  3.4 si,  0.0 st
MiB Mem :  32094.2 total,   1188.0 free,  18421.5 used,  12484.7 buff/cache
MiB Swap:   4096.0 total,   4096.0 free,      0.0 used.  12903.1 avail Mem

    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND
  14122 app       20   0 4821244 612880  18204 R 318.7   1.9  44:12.08 worker
   9931 app       20   0 1204880 142200  12044 S  41.0   0.4  12:55.71 api
```

Three things to read correctly here:

- **The `%Cpu(s)` line is an average across all cores by default.** Press `1` in interactive mode (or it is implicit in the per-core trap) to expand it into one line per logical CPU. Without that, a single saturated core is invisible.
- **`%CPU` for a process can exceed 100%.** The `worker` at `318.7%` is using more than three full cores; one core equals 100%. This is the clearest single indicator of a multi-threaded process and is exactly what you want to confirm a workload is actually parallel rather than pinned to one core.
- **The `st` field on the `%Cpu(s)` line is steal**, and the `wa` field is iowait. Glance at both before concluding the host is CPU-bound, for the reasons covered above.

`htop` presents the same data more legibly: one colored bar per core makes per-core imbalance obvious at a glance, the bar's color segments distinguish user (green), system (red), and other time, and pressing `H` toggles thread display while `F5` shows the process tree. For interactive triage `htop` is usually faster to read; for runbooks and scripts the non-interactive `top -b` or `mpstat` output is what you capture. Either way, the discipline is the same: expand to per-core, check steal and iowait, and let process `%CPU` over 100% tell you about parallelism.

## A Practical Toolbox, Mapped to the Question You Are Asking

Different questions call for different tools. The mistake is reaching for `top` for everything. Match the tool to the question:

- **"Is the system under pressure at all?"** `uptime` or `cat /proc/loadavg` for a first glance, then `cat /proc/pressure/cpu` for a normalized saturation read.
- **"What is the per-mode breakdown, and is one core hot?"** `mpstat -P ALL 2` for clean per-core numbers, or `htop` for an interactive view.
- **"Which process or thread is burning the CPU?"** `pidstat -u 2` for processes, `pidstat -t -u 2` for per-thread, or `top -H`.
- **"Are tasks queuing for CPU, and how badly?"** `vmstat 2` for the `r` column, `runqlat` for the latency distribution.
- **"Is the hypervisor stealing cycles?"** the `%st` column in `mpstat`, `top`, or `sar -u`.
- **"What was happening at 3 a.m. last Tuesday?"** `sar` from the `sysstat` package, which records historical CPU data to disk and is invaluable for post-incident analysis when the spike is long over.
- **"Where exactly in the code is the CPU going?"** `perf` for sampling profiles and flame graphs.

The historical-data point deserves emphasis. Live tools show you now; incidents are usually investigated later. Enabling `sysstat` collection (so `sar` has data) on every host costs almost nothing and repeatedly pays for itself when you need to see the CPU breakdown from before an outage.

## perf: From "the CPU Is Busy" to "This Function Is the Cost"

`perf` answers the question the utilization tools cannot: not *how much* CPU is being used, but *what* is using it, down to the function. When `%us` is high and you need to know which code path is responsible, the `perf` family is the definitive answer. It is the bridge from "the CPU is busy" to "this specific function in this specific service is the cost." Use it in three escalating steps: counters first (`perf stat`), then a live view (`perf top`), then a recorded profile and flame graph (`perf record`).

### perf stat: Counters Before Profiles

Before sampling stacks, `perf stat` gives a fast, low-overhead summary of hardware and software counters for a workload or the whole system. It is the right first `perf` command because it quantifies *what kind* of CPU problem you have before you spend time on a full profile:

```bash
# Whole-system counter summary over a 5-second window
perf stat -a -- sleep 5

# Focus on scheduling-cost counters when high %sy or context switching is suspected
perf stat -e context-switches,cpu-migrations,task-clock -a -- sleep 5
```

A representative `perf stat -a -- sleep 5` summary:

```text
 Performance counter stats for 'system wide':

         40,012.55 msec cpu-clock                 #    8.000 CPUs utilized
           742,118      context-switches          #   18.547 K/sec
            61,204      cpu-migrations            #    1.530 K/sec
           184,002      page-faults               #    4.599 K/sec
   142,883,491,002      cycles                    #    3.571 GHz
    98,114,772,330      instructions              #    0.69  insn per cycle
    19,884,113,002      branches                  #  496.95 M/sec
       412,889,001      branch-misses             #    2.08% of all branches

       5.001627843 seconds time elapsed
```

The most revealing line is **instructions per cycle (IPC)**, here `0.69`. A low IPC (well under 1.0) means the CPU is spending many cycles stalled rather than retiring instructions, often waiting on memory (cache misses) or mispredicted branches. A high IPC (2.0 or more) means the cores are working efficiently. Two hosts can both report "100% CPU" while one does three times the useful work per second because its IPC is far higher. This is the counterpart to the frequency-scaling point made earlier: utilization is a fraction of cycles, but cycles are not a fixed amount of work. When you suspect a workload is memory-bound rather than compute-bound, the IPC and branch-miss figures from `perf stat` are the evidence.

### perf top and perf record: Finding the Hot Code

`perf top` is the live, `top`-style view of which functions are currently consuming CPU, refreshed continuously. It is ideal for an interactive "what is eating the CPU right now" investigation:

```bash
# Live, continuously-updated profile of the hottest functions system-wide
perf top
```

A snapshot of `perf top` on a host where a JSON-heavy service dominates:

```text
Samples: 412K of event 'cpu-clock', 4000 Hz, Event count (approx.): 103000000000
Overhead  Shared Object        Symbol
  18.42%  api                  [.] encoding/json.(*decodeState).object
  11.07%  api                  [.] runtime.mallocgc
   7.93%  [kernel]             [k] copy_user_enhanced_fast_string
   5.21%  libc-2.31.so         [.] __memmove_avx_unaligned_erms
   4.88%  api                  [.] runtime.scanobject
```

This immediately points at JSON decoding and the allocator (`mallocgc`, `scanobject` are Go garbage-collection internals) as the cost centers. For a permanent, shareable artifact rather than a live view, `perf record` captures stacks to a file, which you then summarize or turn into a flame graph:

```bash
# Sample on-CPU stacks across the whole system for 10 seconds
perf record -F 99 -a -g -- sleep 10

# Summarize where CPU time went
perf report --stdio | head -n 20
```

The `-F 99` sets a 99 Hz sampling frequency (chosen to avoid lockstep with periodic timers), `-a` samples all CPUs, and `-g` captures call graphs so you see not just the hot function but the path that reached it.

### Flame Graphs: The Definitive On-CPU Picture

A flame graph turns thousands of stack samples into a single image where width is proportional to CPU time, making the dominant code paths obvious at a glance. The standard pipeline uses Brendan Gregg's FlameGraph scripts:

```bash
# Convert the recorded perf data into folded stacks, then render an SVG flame graph
perf script > out.perf
stackcollapse-perf.pl out.perf > out.folded
flamegraph.pl out.folded > flame.svg
```

In the resulting `flame.svg`, the x-axis is *not* time; it is the proportion of collected samples, sorted alphabetically so identical stacks merge into wide towers. A wide plateau near the top is a function that is itself on-CPU a lot (a leaf cost); a wide base that narrows upward is a call path that fans out. The practical workflow is to open the SVG, find the widest towers, and read down from the leaves to understand which call chain is expensive. This is the artifact to attach to a performance ticket: it converts "the service uses too much CPU" into "62% of CPU is in JSON deserialization on the hot request path," which is something an engineer can act on directly.

For workloads where the cost is *off*-CPU (threads blocked rather than burning cycles), the same flame-graph technique applies to scheduler or off-CPU profiling, but the on-CPU flame graph above is the right starting point whenever `%us` is the dominant signal.

## Three Misdiagnoses and What the Right Signal Was

The value of all this becomes concrete in the failure modes it prevents. Each of the following is a pattern seen repeatedly in production incident reviews.

**"Load average is 30, scale the deployment."** A node alerts on high load average and the reflex is to add replicas. The breakdown shows CPUs 90% idle with `%wa` at 40% and a queue of tasks in `D` state. The load was driven by a degraded EBS volume, not CPU. The right signal was `mpstat` showing idle CPUs plus high iowait, confirmed by the disk metrics in [the storage article](/measuring-linux-performance-disk-storage/). Adding compute replicas spread the same I/O across more pods and made the storage contention worse.

**"CPU is only 55%, the slowness must be the database."** A latency-sensitive API has a `limits.cpu` of `1`. Average utilization sits at 55%, so attention turns to downstream services. The throttling ratio (`nr_throttled / nr_periods`) is 0.31: the pod is stopped on nearly a third of all CFS periods because its bursty request handling exhausts the 100 ms quota in short windows. The right signal was the CFS throttling counters and the pod's `cpu.pressure`, both invisible on the average-utilization dashboard. Raising the limit removed the p99 latency entirely.

**"The VM is slow but CPU looks fine, it must be the application."** An application on a burstable cloud instance intermittently times out. In-guest CPU utilization looks moderate, and profiling the application finds nothing. `sar -u` history shows `%steal` spiking to 18% during exactly the bad windows: the instance had exhausted its CPU credits and the hypervisor was throttling it to baseline. The right signal was steal time over the incident window. Moving to a fixed-performance instance type resolved it; no application change was ever needed.

The common thread is that the first, most obvious number (load average, average utilization, in-guest CPU) was correct as a measurement but wrong as a diagnosis. The fix in every case was to confirm with a second, independent signal before acting.

## A Coherent Investigation Workflow

Putting the pieces together, an effective CPU investigation follows a deliberate order rather than staring at a single dashboard:

1. **Normalize the load.** Read `/proc/loadavg`, divide by `nproc`. A normalized load near or below 1.0 means CPU is probably not your bottleneck; look elsewhere.
2. **Check pressure.** `cat /proc/pressure/cpu`. Low `some avg10` confirms CPU is not contended regardless of what utilization shows.
3. **Get the breakdown.** `mpstat -P ALL 2`. Separate user from system, spot a hot single core, and check `%st` and `%wa` immediately so you do not mistake steal or iowait for CPU work.
4. **Check the run queue.** `vmstat 2`. Compare `r` to `nproc` for true saturation; watch `cs` for scheduling overhead.
5. **Find the owner.** `pidstat -u 2` to attribute the CPU to a process, then `perf` to attribute it to a function.
6. **In containers, check throttling.** Read the pod's `cpu.stat` ratio or the cAdvisor throttling metrics. Average utilization is not enough.

This sequence costs a few minutes and stops the two most expensive failure modes: scaling CPU to fix an I/O or steal problem, and ignoring throttling because aggregate utilization looked fine.

## Why Baselines Matter More Than Thresholds

A recurring theme across every signal in this article is that almost none of them has a universal "bad" value. A context-switch rate of 10,000/s is alarming on a quiet database node and unremarkable on a high-concurrency web tier. A `some avg10` PSI of 15 might be normal for a deliberately oversubscribed batch fleet and a crisis for a latency-SLO service. Even steal time has a different acceptable ceiling on a burstable dev instance than on a production payments node. The single most valuable thing an enterprise can do for CPU observability is to capture a **known-good baseline** for each workload class while it is healthy.

With a baseline in hand, the diagnostic question changes from "is this number bad in the abstract" to "has this number moved away from this workload's normal." That framing catches regressions that absolute thresholds miss entirely: a service whose user/system ratio quietly shifts from 6:1 to 2:1 after a deploy is doing far more kernel work for the same external throughput, and only a baseline reveals it. Concretely, this means:

- **Record the time series continuously** (`sysstat` on hosts, Prometheus for containers) so a baseline exists at all.
- **Alert on deviation and on the signals that have no good absolute value either way**: the CFS throttling ratio, PSI, and the run-queue-to-core ratio are the closest things to portable thresholds, which is exactly why they belong in standing alerts.
- **Annotate deploys and instance-type changes** so that when a metric shifts, the correlated change is obvious in the same view.

The teams that diagnose CPU problems fastest are not the ones with the most exotic tools; they are the ones who already know what healthy looks like for each service and can see, at a glance, what changed.

## Conclusion and Key Takeaways

CPU measurement on Linux is full of signals that sound interchangeable and are not. Getting it right is mostly a matter of knowing what each number actually counts and confirming with a second, independent signal before acting.

- **Load average is demand, not CPU utilization.** It is unnormalized and includes uninterruptible-sleep I/O. Always divide by core count and confirm with a utilization breakdown before drawing conclusions.
- **iowait means the CPU is idle waiting on storage**, not that the CPU is busy. Never sum it into "CPU usage." High iowait is a disk signal.
- **Look per-core, not just aggregate.** Averages hide single-threaded saturation, where one pinned core ruins latency while the host looks half-idle.
- **The run queue (`r` in `vmstat`) is the truest saturation signal.** Compare it to `nproc`; utilization alone cannot distinguish healthy full use from oversubscription.
- **Steal time explains slow VMs with clean-looking CPU.** Sustained `%st` means noisy neighbors or exhausted burst credits; the fix is a different instance type, not more replicas.
- **Frequency scaling makes utilization a moving target.** The same percentage represents different work at different clock speeds; check the governor when comparing.
- **The user/system split is diagnostic.** High `%sy` relative to `%us` points at syscalls, locks, or context switching, not at your application's own work; investigate the kernel side, not the algorithm.
- **Involuntary context switches signal contention.** A high `nvcswch/s` in `pidstat -w` means tasks are being preempted because demand exceeds cores; reduce concurrency or add capacity rather than optimize code that runs fine when scheduled.
- **Instructions-per-cycle reveals work hidden behind utilization.** Two hosts at 100% CPU can do very different amounts of useful work; low IPC from `perf stat` means cycles are stalling on memory, not retiring instructions.
- **PSI is the modern, normalized saturation metric**, available per-cgroup, and the best signal for containers. It answers a different question than throttling: PSI is "waiting for a core," throttling is "hit my own quota."
- **In Kubernetes, watch CFS throttling, not average utilization.** A workload can be stopped on a quarter of all scheduling periods while reporting modest average CPU. Alert on `nr_throttled / nr_periods` and the cAdvisor throttling metrics, and read `cpu.max` to confirm what the kernel is actually enforcing.
- **Profile with `perf` to find the cost, not just the amount.** `perf stat` for counters, `perf top` for a live view, `perf record` plus a flame graph for the definitive on-CPU picture down to the function.
- **Match the tool to the question**, and enable `sysstat` everywhere so `sar` can answer "what happened earlier" after the spike is gone. The same principle applies to Prometheus retention in clustered environments.

### Related posts in this series

- [Measuring Linux Performance: CPU](/measuring-linux-performance-cpu/) (this post)
- [Measuring Linux Performance: Memory](/measuring-linux-performance-memory/)
- [Measuring Linux Performance: Disk and Storage](/measuring-linux-performance-disk-storage/)
- [Measuring Linux Performance: Network](/measuring-linux-performance-network/)
- [Measuring Linux Performance: Recap and Common Mistakes](/measuring-linux-performance-recap-common-mistakes/)
