---
title: "Measuring Linux Performance: A Recap and the Mistakes Everyone Makes"
date: 2032-05-04T09:00:00-05:00
draft: false
tags: ["Linux", "Performance", "Observability", "USE Method", "Pressure Stall Information", "Prometheus", "Kubernetes", "Benchmarking", "System Administration", "Monitoring", "Troubleshooting"]
categories:
- Linux
- Performance
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "The capstone of our Measuring Linux Performance series: the cross-cutting mistakes engineers make on CPU, memory, disk, and network, plus a repeatable methodology built on the USE method, baselines, PSI, and Kubernetes-aware observability."
more_link: "yes"
url: "/measuring-linux-performance-recap-common-mistakes/"
---

Over the last four installments of this series we took apart the four classic resources every Linux system spends its life juggling: processors, memory, block storage, and the network. Each post went deep on the metrics, the tools, and the traps specific to that resource. This post does something different. It steps back and looks at the patterns that span all four, because the most expensive performance mistakes are rarely about not knowing which `iostat` column to read. They are about method: trusting a single number, skipping the baseline, benchmarking the wrong thing, and forgetting that a process on a modern Linux box almost never has the machine to itself. This is the recap, the index, and the field guide to not fooling yourself.

<!--more-->

## The Series at a Glance

If you are arriving here first, the four resource deep-dives stand on their own and are worth reading in full:

- [Measuring Linux Performance: CPU](/measuring-linux-performance-cpu/) covers utilization versus saturation, load average myths, run-queue depth, steal time, and why a CPU that looks busy is not the same as a CPU that is the bottleneck.
- [Measuring Linux Performance: Memory](/measuring-linux-performance-memory/) untangles the difference between used, available, cached, and committed memory, the lie that is "free memory," page cache behavior, and how the OOM killer decides who dies.
- [Measuring Linux Performance: Disk and Storage](/measuring-linux-performance-disk-storage/) digs into IOPS versus throughput versus latency, queue depth, the meaning of `%util` on modern multi-queue devices, and how filesystems and caches distort what you measure.
- [Measuring Linux Performance: Network](/measuring-linux-performance-network/) walks through bandwidth versus latency versus packets-per-second, retransmits, socket buffers, and the difference between a saturated link and a saturated application.

This recap assumes you have skimmed at least one of them. What follows is the connective tissue: a methodology that works regardless of which resource is misbehaving, and a catalog of the mistakes that recur no matter how senior the engineer.

### How the Four Parts Fit Together

It is tempting to treat the four resources as independent silos, each with its own tooling and its own on-call expert. In production they are anything but independent. A memory shortage turns into a disk problem the moment the kernel starts swapping. A disk problem turns into a CPU problem when threads pile up in uninterruptible sleep and the run queue swells with blocked work. A network problem masquerades as a CPU problem when softirq processing of a packet flood eats an entire core. The reason a single methodology can cover all four is precisely that the four are coupled: pressure in one resource leaks into the symptoms of the others, and the only reliable way to find the true source is to measure all four with the same disciplined loop rather than chasing whichever graph happened to turn red first.

The table below is the map for the rest of this post. Each row is a resource, each cell is a place the corresponding deep-dive goes into detail, and the right-hand column is the trap that the deep-dive exists to dismantle.

| Resource | Deep-dive | The metric people read | The metric that actually matters | The classic trap |
| --- | --- | --- | --- | --- |
| CPU | [Part 1: CPU](/measuring-linux-performance-cpu/) | load average, `%idle` | run-queue depth, PSI `cpu`, steal | "load is high so the CPU is the bottleneck" |
| Memory | [Part 2: Memory](/measuring-linux-performance-memory/) | `free` "used" / "free" | `MemAvailable`, swap rate, PSI `memory` | "free is low so we are out of RAM" |
| Disk | [Part 3: Disk and Storage](/measuring-linux-performance-disk-storage/) | `%util` | await, queue depth, PSI `io` | "%util is 99% so the disk is maxed" |
| Network | [Part 4: Network](/measuring-linux-performance-network/) | bandwidth (Mbps) | latency, retransmits, drops, PPS | "the link is not full so the network is fine" |

Keep this table open while you read. Every mistake in the catalog that follows is, at bottom, a case of reading the third column when you should have been reading the fourth.

## Mistake One: Trusting a Single Metric

The single most common performance mistake is reading one number, forming a conclusion, and acting on it. A high load average "means the CPU is overloaded." A 95% `%util` on a disk "means the disk is maxed out." A growing `used` memory figure "means we are running out of RAM." Every one of those sentences is wrong often enough to be dangerous.

**Load average** on Linux counts processes that are runnable *and* processes in uninterruptible sleep (state `D`), which usually means they are blocked on I/O. A load average of 16 on an 8-core box might be CPU saturation, or it might be sixteen threads all waiting on a slow NFS mount while the CPUs sit idle. You cannot tell from the load average alone.

```bash
# Load average says "high" -- but high because of what?
# Compare it against actual CPU run-queue and I/O wait.
uptime
# 14:32:01 up 9 days,  3:14,  2 users,  load average: 16.04, 15.71, 14.98

# r = runnable (CPU-bound), b = blocked on I/O (uninterruptible)
# wa = % time CPUs were idle waiting on I/O
vmstat 1 5
```

If `vmstat` shows a large `b` column and a high `wa`, your "CPU problem" is actually a storage or network problem wearing a CPU costume. The fix is never to read load average in isolation. Read it alongside run-queue depth, I/O wait, and per-device latency. The same discipline applies everywhere: a `%util` of 99% on an SSD that internally services dozens of requests in parallel does not mean the device is out of capacity, because the kernel computes `%util` as "time at least one request was in flight," which a parallel device can sustain at near-100% while barely breaking a sweat.

The rule that survives all four resources: **a metric is a hypothesis, not a verdict.** One number tells you where to look next. It never tells you that you are finished looking.

### The Companion Sin: Trusting Averages

Single-metric thinking has a twin that is just as expensive: trusting averages. An average smears the spikes that cause user pain into a flat line that looks fine. A node whose CPU averages 40% over a minute can have spent ten of those seconds completely pegged, and the requests that arrived during those ten seconds saw multi-second latency while the dashboard reported a comfortable 40%. Disk latency is the most dangerous place for this. A device with a one-millisecond average `await` can still be issuing a steady trickle of 500-millisecond outliers, and it is the outliers that page you, not the mean.

The defense is to reason in percentiles and in short windows, not averages over long ones. Where a tool gives you only an average, shorten the sampling interval until the spikes reappear; `iostat -x 1` tells a different story than `iostat -x 60`. Where you have histograms, alert on p99, not the mean. A flat average is the single most reassuring lie a monitoring system can tell you, and it tells it constantly.

## Mistake Two: No Baseline

You cannot know that something is slow if you do not know what fast looked like. "The database is using 70% CPU" is meaningless without the context that it normally uses 20% at this hour. Baselines are the difference between *measuring* and *guessing*, and the teams that skip them spend incidents arguing about whether a number is even abnormal.

A baseline is not a single snapshot. It is the normal range of a metric across the daily and weekly cycle of real traffic. The cheapest useful baseline is a few weeks of Prometheus retention and a dashboard that overlays "now" against "this time last week."

```promql
# Current CPU saturation (run-queue pressure) for a node,
# overlaid against the same metric one week ago.
node_pressure_cpu_waiting_seconds_total

# offset shifts the query window back in time so you can
# compare today's shape against last week's shape.
node_pressure_cpu_waiting_seconds_total offset 1w
```

When an alert fires, the first question is never "is this number big?" It is "is this number big *for this time of day, for this workload*?" Without a baseline you cannot answer that, and you will either chase phantom regressions or miss real ones buried inside a range you assumed was normal. Capture baselines before you need them; the worst time to discover you have no historical data is during the incident that would have used it.

## Mistake Three: Measuring Without Real Load

Synthetic benchmarks lie, and they lie in a specific, seductive way: they make the system look better than it is. A `dd` write test streams perfectly sequential data that any storage layer loves; your actual database does scattered 8K random writes interleaved with fsyncs. A `fio` run with a tiny working set fits entirely in cache and reports IOPS your real dataset will never see. A network throughput test with one fat TCP stream tells you nothing about the latency of ten thousand tiny request/response round-trips.

The mistake is not running benchmarks. The mistake is believing a benchmark that does not resemble production. If you must synthesize load, synthesize it honestly:

```bash
# BAD: sequential, cached, single-threaded -- flatters the device.
# This is the "my disk does 2 GB/s!" benchmark that means nothing
# for a transactional workload.
dd if=/dev/zero of=/data/test bs=1M count=4096

# BETTER: random 8K I/O, direct (bypass page cache), with a queue
# depth and a working-set size that resemble the real database.
fio --name=db-like \
    --filename=/data/fio-test \
    --rw=randrw --rwmixread=70 \
    --bs=8k --iodepth=16 --numjobs=4 \
    --direct=1 --size=20G --runtime=120 --time_based \
    --group_reporting
```

Even a faithful benchmark is a model, not the territory. Whenever possible, measure the real workload under real load. Shadow traffic, canary deployments, and load tests replayed from production access logs all beat a synthetic test that was designed, however unconsciously, to pass. When you do benchmark, write down the exact command, the dataset size, the cache state, and the hardware. A benchmark you cannot reproduce is an anecdote.

## A Methodology That Spans All Four Resources: The USE Method

The thread that ties the whole series together is a single repeatable loop. Brendan Gregg's **USE method** is the most reliable framework I know for not missing the obvious: for every resource, check **Utilization**, **Saturation**, and **Errors**.

- **Utilization** is the percentage of time the resource was busy. A disk at 80% utilization, a NIC pushing 80% of line rate, a CPU at 80%.
- **Saturation** is the degree to which work is queued because the resource could not keep up. This is the metric people forget, and it is usually the one that actually correlates with user pain. A disk can be at 100% utilization and perfectly healthy if nothing is waiting; it is the queue depth and wait time that signal trouble.
- **Errors** are the count of error events: dropped packets, failed allocations, I/O errors, retransmits. Errors are cheap to check and frequently the real story, yet they are routinely ignored in favor of the prettier utilization graphs.

The power of the method is that it is a checklist you cannot game. Walk every resource, fill in all three columns, and the bottleneck tends to announce itself. Here is the mapping for a Linux host, resource by resource:

| Resource | Utilization | Saturation | Errors |
| --- | --- | --- | --- |
| CPU | `%usr + %sys` busy time | run-queue length, PSI `cpu` | (rare) microcode/MCE events |
| Memory | used vs. total, page cache | swap activity, PSI `memory`, OOM kills | allocation failures |
| Disk | `%util` per device | queue depth (`aqu-sz`), await, PSI `io` | I/O errors in `dmesg` |
| Network | throughput vs. link speed | socket queue drops, retransmits | RX/TX errors, drops |

Notice that **saturation** is where Pressure Stall Information shows up three times. That is not an accident, and it is the single biggest upgrade to Linux performance measurement in the last decade.

### Walking the USE Method, Resource by Resource

The table is the summary; the discipline is in the walk. Here is what filling in each row actually looks like on a live host, and where the corresponding deep-dive picks up the thread.

**CPU.** Utilization is `%usr + %sys` from `mpstat -P ALL`, read per-core rather than as a single average, because one pegged core hidden inside a 32-core average is invisible until you look. Saturation is run-queue depth (`vmstat` column `r`) and `cpu` PSI. Errors are rare here but real: machine-check exceptions and throttling from thermal events show up in `dmesg`. The CPU deep-dive covers why the per-core view matters and how steal time fits in.

**Memory.** Utilization is not "used" memory; it is how much of `MemAvailable` is gone, plus how full the page cache is. Saturation is swap activity (`si`/`so` in `vmstat`) and `memory` PSI, with the `full` line being the strongest "we are thrashing" signal short of an OOM kill. Errors are allocation failures, visible as OOM-kill records in `dmesg`. The memory deep-dive explains why "free memory" is the wrong number to watch.

**Disk.** Utilization is `%util`, with the heavy caveat that on parallel NVMe and SSD devices it tops out at 100% long before the device is actually saturated. Saturation is the metric that does not lie on those devices: average queue depth (`aqu-sz`) and `await` from `iostat -x`, plus `io` PSI. Errors are I/O errors in `dmesg`. The disk deep-dive is largely a tour of why `%util` deceives and what to read instead.

**Network.** Utilization is throughput against link speed. Saturation is socket-buffer drops, TCP retransmits, and the qdisc backlog. Errors are RX/TX errors and drops from `ip -s link`. The network deep-dive separates a saturated link from a saturated application, which look identical if you only watch bandwidth.

The value of scripting the walk is that a checklist you cannot game beats a checklist you skim. Even a crude wrapper forces all three columns to be filled for the resource under suspicion:

```bash
# USE walk for one resource, scripted, so nothing gets skipped.
# Disk example: utilization, saturation (await/queue), errors.
DEV=sda

# Utilization: %util column.
iostat -x 1 1 | awk -v d="$DEV" '$1==d {print "util%="$NF}'

# Saturation: average queue depth and await from iostat -x.
iostat -x 1 1 | awk -v d="$DEV" '$1==d {print "aqu-sz="$(NF-2)" await reported above"}'

# Errors: kernel I/O errors are the cheapest, most ignored check.
dmesg -T | grep -iE 'I/O error|blk_update_request' | tail -n 5
```

Run the same three-column walk for CPU, memory, and network and the bottleneck stops hiding. The whole point of the USE method is that it makes "I forgot to check errors" impossible, and forgetting to check errors is how an afternoon disappears into profiling a healthy subsystem.

## Pressure Stall Information: The Saturation Metric You Were Missing

For most of Linux's history, saturation was something you inferred. You looked at run-queue depth and guessed how much CPU contention there was; you watched swap and guessed how much memory pressure existed. **Pressure Stall Information (PSI)**, available under `/proc/pressure/` on modern kernels, measures it directly. PSI answers the question that actually matters: "what percentage of time was work stalled waiting for this resource?"

```bash
# Each file reports the share of time tasks were stalled on a
# resource. "some" = at least one task stalled; "full" = all
# non-idle tasks stalled (the resource was a hard bottleneck).
cat /proc/pressure/cpu
# some avg10=4.21 avg60=3.84 avg300=2.97 total=99843211

cat /proc/pressure/memory
# some avg10=0.00 avg60=0.12 avg300=0.31 total=4821100
# full avg10=0.00 avg60=0.05 avg300=0.14 total=2210043

cat /proc/pressure/io
# some avg10=12.40 avg60=9.88 avg300=7.21 total=884213355
```

Read those `avg10` numbers as percentages over the last ten seconds. A `cpu some avg10` of 4 means tasks spent 4% of the last ten seconds waiting for CPU time that was not available. An `io some avg10` of 12 means real I/O contention. The `full` line for memory and I/O is especially valuable: it represents time when *everything* runnable was stalled, which is about as direct a definition of "this resource is the bottleneck" as you will find.

PSI is what makes the USE method's saturation column trustworthy instead of inferred. It is exported by `node_exporter`, so you can alert on it across a fleet:

```promql
# Alert when sustained CPU pressure indicates the node cannot keep
# up with runnable work -- a far better signal than load average.
avg_over_time(node_pressure_cpu_waiting_seconds_total[5m])

# Memory "full" pressure: time ALL tasks were stalled reclaiming
# memory. Sustained nonzero values precede OOM kills and thrashing.
rate(node_pressure_memory_stalled_seconds_total[5m]) > 0.1
```

If you take one new habit away from this entire series, make it this: stop inferring saturation and start measuring it with PSI.

## Mistake Four: Forgetting You Do Not Have the Machine to Yourself

Every classic Linux performance tool was designed for an era when a process ran on a physical machine it more or less owned. Almost nothing runs that way anymore. Your process shares a hypervisor with strangers, or a Kubernetes node with a dozen other pods, and the tools inside the box cannot see past the box's boundary. This causes two recurring, expensive misdiagnoses.

The first is **CPU steal time**. On a virtualized or oversubscribed host, the hypervisor can take CPU away from your guest to service another tenant. Your guest sees this as `st` time in `top` and `vmstat`. The application is slow, in-guest CPU utilization looks fine, and engineers burn hours profiling code that is not the problem. The CPU was simply not given to them.

```bash
# The "st" (steal) column is time the hypervisor ran someone else
# while your vCPU was runnable. Nonzero, sustained steal means the
# host is oversubscribed -- the fix is a bigger instance or a less
# crowded host, not a code change.
vmstat 1 5
# procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----
#  r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
#  4  0      0 812344  44120 998120    0    0     2    18  900 1700 70  8  4  0 18
```

That `st 18` is the whole story: 18% of the time, the CPU you were promised was busy running someone else's workload.

The second misdiagnosis comes from **cgroup limits in Kubernetes**, where the difference between what the node has and what your container is allowed is invisible to in-container tooling.

## Mistake Five: Container Metrics That Lie

Run `free` or `nproc` inside many containers and you will get the *node's* numbers, not the container's limits. The classic failure mode: a Java or Go process reads the host's 64 GB of RAM, sizes its heap accordingly, then gets OOM-killed the instant it exceeds the 2 GB cgroup memory limit nobody told it about. The application did nothing wrong. It was measuring the wrong machine.

The cgroup is the source of truth for what a container actually gets. On a cgroup v2 system:

```bash
# What the container is actually limited to (cgroup v2).
# "max" means unlimited; a number is the hard cap.
cat /sys/fs/cgroup/memory.max
# 2147483648    <- 2 GiB, regardless of node RAM

# Current usage against that limit.
cat /sys/fs/cgroup/memory.current

# CPU quota: "quota period" in microseconds. 200000 100000 means
# 2 CPUs worth of time per 100ms -- a 2-core limit even on a 64-core node.
cat /sys/fs/cgroup/cpu.max
# 200000 100000

# CPU throttling: nr_throttled rising means the container is hitting
# its CPU limit and being stalled, even though node CPU looks idle.
cat /sys/fs/cgroup/cpu.stat
```

CPU throttling is the container-era cousin of steal time. A pod can be slow, its in-container CPU usage can look unremarkable, the node can have spare cores, and yet the application is being throttled hard against its `cpu.max` quota. The signal lives in `nr_throttled` and `throttled_usec`, exported by cAdvisor and visible in Prometheus:

```promql
# Fraction of CPU periods in which the container was throttled.
# Sustained high values mean the CPU limit is too low for the load,
# even when node CPU utilization is comfortable.
rate(container_cpu_cfs_throttled_periods_total[5m])
  /
rate(container_cpu_cfs_periods_total[5m])

# Container memory usage approaching its limit -- the precursor to
# an OOM kill that node-level memory graphs will never explain.
container_memory_working_set_bytes
  /
container_spec_memory_limit_bytes
```

The discipline here is simple to state and easy to forget: **in a container, measure the cgroup, not the host.** When an in-container number disagrees with a host-level number, the cgroup is usually right about your fate.

## Mistake Six: Profiling Before You Have Localized

There is an order of operations to performance work, and reaching for a profiler too early breaks it. Profiling tells you *where in the code* time is spent. It cannot tell you that the real problem is a saturated disk, a throttled cgroup, or 18% steal time. Engineers who skip straight to flame graphs end up optimizing a function that was never the bottleneck while the actual constraint sits one layer down, untouched.

The correct sequence is resource-first, then code:

1. **Characterize the symptom.** Latency? Throughput? Errors? At what percentile, for which requests, since when?
2. **Walk the USE method** across CPU, memory, disk, and network. Find the resource that is saturated or erroring. Use PSI for saturation.
3. **Confirm the layer.** Is it the host, the hypervisor (steal), or the cgroup (throttling, memory limit)? In-box tools versus cgroup files versus hypervisor metrics.
4. **Only now profile,** and only the resource you have implicated. A CPU-bound, un-throttled, un-stolen process is a legitimate target for `perf` and a flame graph.

```bash
# Step 4, and not before: sample on-CPU time for a process you have
# already confirmed is genuinely CPU-bound (not throttled, not stolen).
perf record -F 99 -p "$(pgrep -n myapp)" -g -- sleep 30
perf script > out.perf
# Fold and render into a flame graph with Brendan Gregg's tools.
```

A flame graph of a process that is actually stalled on I/O is a beautiful, detailed picture of the wrong thing.

## Mistake Seven: Confusing Saturation With Utilization

This deserves its own heading because it is the conceptual error underneath half of the others. **Utilization** tells you how busy a resource is. **Saturation** tells you how much work is piled up waiting because the resource could not keep up. They are not the same axis, they do not move together, and the gap between them is where most production incidents live.

Two examples make the distinction concrete. A modern NVMe drive can sit at 100% utilization, by the kernel's definition of "at least one request in flight," while servicing dozens of requests in parallel with microsecond latency and zero queueing. Utilization is maxed; saturation is zero; the device is perfectly healthy. Conversely, a CPU can show 70% utilization while the run queue is deep and PSI reports significant `cpu` pressure, because the work that does run is constantly being preempted and rescheduled. Utilization looks like it has headroom; saturation says the opposite; users feel the latency.

The rule is simple and saves enormous amounts of wasted effort: **utilization tells you how busy, saturation tells you whether anyone is waiting, and only saturation reliably correlates with the latency your users experience.** When the two disagree, believe saturation. This is the entire reason PSI was added to the kernel, and the reason the USE method puts saturation in its own column instead of folding it into utilization.

## Mistake Eight: The Observer Effect

The act of measuring changes what you measure, and at high request rates the change is not negligible. A `strace` on a busy process can slow it by an order of magnitude because every syscall now traps into the tracer. A `tcpdump` on a saturated NIC adds copy overhead to every packet and can itself drop the very packets you are hunting. Continuous, high-frequency profiling steals the CPU cycles you are trying to account for. The classic failure mode is an engineer who attaches a heavy tracer, watches latency get worse, and concludes the workload is degrading on its own when the tracer is the new bottleneck.

The discipline is to prefer low-overhead, always-on instrumentation and to reach for heavyweight tracing only with eyes open. Counters in `/proc` and `/sys`, PSI, and eBPF-based tools like those in the `bcc` and `bpftrace` families are designed to be cheap and to run in production; `strace` and packet captures are scalpels, not stethoscopes. When you must use a heavyweight tool, scope it as tightly as possible, run it for the shortest window that captures the event, and treat any latency change that appears the instant you attach it as suspect until proven otherwise.

```bash
# Heavyweight tracing, scoped tightly: a single PID, a short window,
# and only the syscalls you care about -- not a blanket strace that
# multiplies the syscall cost of a busy process.
timeout 5 strace -f -e trace=read,write,fsync -c -p "$(pgrep -n myapp)"

# Prefer always-on counters for steady-state observation. These read
# kernel-maintained numbers and add effectively zero overhead.
grep . /proc/pressure/*
cat /proc/"$(pgrep -n myapp)"/io
```

If the number moves when you start watching it, you are measuring your own tooling. That is the observer effect, and on a busy box it is the difference between a diagnosis and a wild goose chase.

## A Tooling Cheat-Sheet

The series covers each tool in depth; this is the quick-reference card that ties metric to tool to interpretation. Pin it next to the USE table. The "looks healthy" and "looks like trouble" columns are deliberately about saturation and errors, not raw utilization, because those are the readings that actually decide whether you have a problem.

| Resource | Metric | Tool / source | Looks healthy | Looks like trouble |
| --- | --- | --- | --- | --- |
| CPU | run-queue depth | `vmstat 1` (`r`) | `r` near or below core count | `r` persistently above core count |
| CPU | saturation | `/proc/pressure/cpu` | `some avg10` near 0 | `some avg10` sustained above ~5 |
| CPU | steal | `vmstat 1` (`st`) | `st` at 0 | `st` sustained nonzero |
| CPU | per-core hot spot | `mpstat -P ALL 1` | even spread across cores | one core pegged, others idle |
| Memory | headroom | `free -h` (`available`) | available comfortably positive | available collapsing toward 0 |
| Memory | saturation | `/proc/pressure/memory`, `vmstat` `si`/`so` | PSI `full` at 0, no swap I/O | nonzero `full` PSI, sustained swap |
| Memory | OOM events | `dmesg -T` | no kill records | `Killed process` entries appearing |
| Disk | latency | `iostat -x 1` (`await`) | low and stable `await` | rising `await`, long tail |
| Disk | saturation | `iostat -x 1` (`aqu-sz`), `/proc/pressure/io` | shallow queue, low `io` PSI | deep queue, high `io` PSI |
| Disk | errors | `dmesg -T` | quiet | `I/O error`, `blk_update_request` |
| Network | retransmits | `ss -ti`, `nstat` | near-zero retransmit rate | climbing retransmits |
| Network | drops/errors | `ip -s link` | RX/TX errors and drops at 0 | nonzero, growing drops |
| Network | latency | `ss -ti` (rtt), app-level p99 | stable RTT and tail latency | rising tail latency |

The single most important habit this table encodes: when in doubt, read the saturation and error rows before the utilization rows. Utilization is the headline; saturation and errors are the story.

## Kubernetes-Aware Observability

Everything above applies to a bare host, but most of these systems now run on Kubernetes, and the cluster adds a layer that the in-box tools cannot see. The good news is that the same USE-and-PSI discipline maps cleanly onto cluster-level telemetry; you just read it from different exporters.

**`node_exporter`** runs as a DaemonSet and exposes the host's `/proc` and `/sys` counters as Prometheus metrics, including PSI. This is your node-level USE data, fleet-wide, with history. **cAdvisor**, built into the kubelet, exposes per-container resource usage and the cgroup throttling and memory-limit metrics that explain why a pod is slow when its node looks idle. Together they give you the host view and the container view side by side, which is exactly the pair of perspectives the steal-time and throttling mistakes demand.

Here are starting-point queries that map the USE columns onto a cluster. They are deliberately simple; the goal is to give you a thread to pull, not a finished dashboard.

```promql
# CPU saturation at the node level, fleet-wide. PSI beats load average
# as an alerting signal because it measures stall, not run-queue length.
rate(node_pressure_cpu_waiting_seconds_total[5m])

# Memory "full" pressure: time ALL tasks were stalled reclaiming
# memory. Sustained nonzero values precede OOM kills and thrashing.
rate(node_pressure_memory_stalled_seconds_total[5m]) > 0.1

# I/O saturation at the node level.
rate(node_pressure_io_stalled_seconds_total[5m])

# Container CPU throttling: fraction of CFS periods the container was
# throttled. High values mean the limit is too low even when the node
# has spare CPU -- the cgroup cousin of steal time.
rate(container_cpu_cfs_throttled_periods_total[5m])
  /
rate(container_cpu_cfs_periods_total[5m])

# Container memory headroom against its limit -- the precursor to an
# OOM kill that node-level memory graphs will never explain.
container_memory_working_set_bytes
  /
container_spec_memory_limit_bytes
```

The mapping back to the series is direct. Node PSI is the saturation column of the USE method, read at cluster scale. cAdvisor throttling and working-set-versus-limit are the container-era versions of "you do not own the machine." When a pod is slow, the resolution loop is the same one the whole series teaches: walk USE on the node with `node_exporter`, then check the cgroup with cAdvisor, then and only then look inside the application.

## A Measurement Checklist

Before you trust any performance measurement, run it past this list. Every item is a mistake from this post turned into a question you can answer yes or no.

- Did I corroborate the headline metric with at least one independent signal, or am I acting on a single number?
- Am I reading a percentile or a short-window sample, or am I being lulled by a long-window average?
- Do I have a baseline for this metric, at this time of day, for this workload?
- If I synthesized load, does the benchmark resemble production in working-set size, cache state, access pattern, and concurrency?
- Did I fill in all three USE columns for the suspect resource, including the errors column?
- Did I measure saturation directly with PSI, or am I inferring it from utilization?
- On a VM, did I check steal time? In a container, did I read the cgroup rather than the host?
- Did I localize to a resource and a layer before reaching for a profiler?
- Is the tool I am using cheap enough to run without changing the thing I am measuring?

If any answer is "no," you have found the next thing to do before you trust the result.

## The First Five Minutes of a Performance Incident

When the page fires and you do not yet know why, the first five minutes decide whether the next hour is methodical or panicked. The goal of these five minutes is not to fix anything; it is to localize the problem to a resource and a layer so that everything afterward is targeted. Resist the urge to start changing things. Measure first.

**Minute 1 — Characterize the symptom.** Before touching a single tool, answer: is this latency, throughput, or errors? At what percentile, for which requests, and since when? "The API is slow" is not a symptom; "p99 on `POST /checkout` jumped from 80ms to 4s at 14:05" is. The shape of the symptom tells you which resource to suspect first.

**Minute 2 — Read saturation across all four resources at once.** PSI is the fastest "which resource hurts" read on the box, and it covers three of the four resources in a single screen. Pair it with the per-resource saturation reads.

```bash
# First 60 seconds: a single screen of saturation signals.
# PSI under /proc/pressure is the fastest "which resource hurts" read.
grep . /proc/pressure/*

# Per-CPU saturation and steal in one shot.
mpstat -P ALL 1 3

# Block device latency and queue depth, NOT just %util.
iostat -x 1 3

# Memory headroom (available, not "free") and swap churn.
free -h
vmstat 1 3

# Network errors/drops and socket summary.
ss -s
ip -s link
```

**Minute 3 — Identify the layer.** Once a resource is implicated, decide whether the problem is the host, the hypervisor, or the cgroup. On a VM, check steal time. In a container, read the cgroup rather than the host.

```bash
# Hypervisor layer: is the host stealing CPU from this guest?
vmstat 1 3   # watch the "st" column

# Container layer: what is this pod actually allowed, and is it
# being throttled or pressed against its memory limit?
cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/cpu.stat
cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.current
```

**Minute 4 — Confirm with a second, independent signal.** Do not act on a single number. If PSI says I/O, confirm with `iostat -x` latency and `dmesg` errors. If it says CPU, confirm with run-queue depth and per-core spread. Corroboration before action is the rule that prevents the most expensive class of mistake.

**Minute 5 — Decide: mitigate or deep-dive.** With a resource and a layer identified, you either mitigate now (scale out, raise a limit, fail over) if the impact is severe, or open the corresponding deep-dive and run the targeted investigation. Either way, you are no longer guessing. Five disciplined minutes have turned "everything is slow" into "I/O saturation on this node's data volume, host layer, confirmed by queue depth and kernel errors," which is a problem you can actually solve.

## Putting It Together: A Triage Runbook

When something is slow and you do not yet know why, this is the order that has saved me the most time. It is the entire series compressed into a sequence.

```bash
# 1. Saturation at a glance, all resources, one screen.
#    PSI tells you which resource is stalling tasks RIGHT NOW.
grep . /proc/pressure/*

# 2. CPU: runnable vs blocked vs stolen.
vmstat 1 5

# 3. Disk: per-device latency and queue depth (not just %util).
iostat -x 1 5

# 4. Memory: available (not "free"), swap activity, OOM history.
free -h
dmesg -T | grep -i 'killed process'

# 5. Network: drops, retransmits, errors -- not just bandwidth.
ss -s
ip -s link

# 6. If containerized, check the cgroup before blaming the app.
cat /sys/fs/cgroup/cpu.stat /sys/fs/cgroup/memory.current
```

Six commands, in order, will localize the overwhelming majority of incidents to a resource and a layer. Everything after that is the targeted deep-dive in the corresponding post.

## Conclusion and Key Takeaways

The four deep-dives teach you the metrics. This recap teaches you the discipline that keeps those metrics from misleading you. The mistakes are remarkably consistent across CPU, memory, disk, and network, which is exactly why a single methodology can defend against all of them.

- **Never trust a single metric.** Load average, `%util`, and `used` memory are hypotheses about where to look next, not conclusions. Corroborate before you act.
- **Establish baselines before the incident.** A number is only abnormal relative to its normal range for that time and workload. Keep enough Prometheus history to overlay "now" against "last week."
- **Measure real load, and benchmark honestly.** Synthetic tests flatter systems. If you cannot test in production with shadow or canary traffic, at least model the working set, cache state, and access pattern faithfully and record the exact command.
- **Run the USE method on every resource.** Utilization, Saturation, Errors. The saturation column is the one people skip and the one that usually correlates with user pain.
- **Measure saturation directly with PSI.** `/proc/pressure/` and the `node_pressure_*` metrics replace inference with measurement for CPU, memory, and I/O contention.
- **Remember you do not own the machine.** Watch steal time on virtualized hosts and measure the cgroup, not the host, inside containers. Throttling and OOM kills hide from node-level graphs.
- **Localize before you profile.** Resource-first, then code. A flame graph of a process stalled on I/O optimizes the wrong layer.

Start anywhere in the series that matches your current fire: [CPU](/measuring-linux-performance-cpu/), [Memory](/measuring-linux-performance-memory/), [Disk and Storage](/measuring-linux-performance-disk-storage/), or [Network](/measuring-linux-performance-network/). But come back to this method, because the tools change and the mistakes do not.
