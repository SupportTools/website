---
title: "Measuring Linux Performance the Right Way: Memory"
date: 2032-05-01T09:00:00-05:00
draft: false
tags: ["Linux", "Performance", "Memory", "Kubernetes", "cgroups", "OOM", "Observability", "Prometheus", "Troubleshooting", "SRE", "DevOps"]
categories:
- Performance
- Linux
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Part 2 of the Measuring Linux Performance series: how to read free, available, buffers, page cache, RSS, PSS, swap, the OOM killer, and Kubernetes memory limits without drawing the wrong conclusions."
more_link: "yes"
url: "/measuring-linux-performance-memory/"
---

A monitoring dashboard shows a production node sitting at 96% memory utilization. The on-call engineer pages the team, someone scales the node pool, and an hour later the same graph looks identical. Nothing was wrong. The number that triggered the page was counting page cache as "used," and the kernel was doing exactly what it is supposed to do: keeping recently read files in RAM so the next read is free. The incident was real only in the sense that someone believed a metric that does not mean what it appears to mean.

Memory is the single most misread resource on a Linux box. CPU saturation is at least intuitive, and disk space either fits or it does not. Memory, by contrast, is layered, lazily allocated, shared between processes, and aggressively cached by the kernel, so almost every naive measurement overstates the problem. This article is the second part of a five-part series on measuring Linux performance correctly, and its goal is narrow and practical: teach you which memory numbers to trust, which to ignore, and how the same rules change once your workload runs inside a container with a cgroup limit.

<!--more-->

> **This post is part of a series: Measuring Linux Performance the Right Way.** Each part takes one resource and shows how to measure it without drawing the wrong conclusion. Links to the other parts are at the end of this article.

## The One Idea That Fixes Most Memory Mistakes

Before any tool, internalize a single sentence that the Linux kernel community has repeated for two decades:

> **Free memory is wasted memory.**

RAM that sits idle does no work. The kernel knows this, so it fills otherwise-empty memory with the **page cache**: copies of file data read from disk, and pages waiting to be written back. The moment a process needs that memory, the kernel reclaims clean cache pages instantly and hands them over. From the application's point of view the memory was always available; from a dashboard's point of view it looked "used."

This is why a healthy, well-utilized Linux server almost always reports very little free memory. A server with gigabytes of genuinely free RAM is usually a server that was just rebooted or one that is badly over-provisioned. The metric that actually tells you whether the system is under memory pressure is not *free*; it is **available**, and the difference between those two words is the root cause of more false alarms than any other memory mistake.

## Reading `free` Correctly

The `free` command is where most people start and where most people go wrong. Run it with human-readable units and the wide layout that splits buffers from cache:

```bash
# free -w -h shows separate "buffers" and "cache" columns instead of
# lumping them together, which makes the numbers far easier to reason about.
free -w -h
```

A representative output from a busy 32 GB application server looks like this:

```text
               total        used        free      shared     buffers       cache   available
Mem:            31Gi        9.4Gi       412Mi       1.1Gi       284Mi        21Gi        20Gi
Swap:          4.0Gi       128Mi       3.9Gi
```

Walk the columns the way the kernel means them, not the way they read in English:

- **total** is physical RAM the kernel can see, after firmware reservations.
- **used** is memory genuinely consumed by processes and kernel structures that is *not* reclaimable cache. On modern `free` (procps-ng) this already excludes buffers and cache.
- **free** is memory that is completely untouched. As discussed, a low number here is normal and good. This server has only 412 MiB free, and that is fine.
- **buffers** and **cache** together are the page cache and block-device buffers. Here that is roughly 21 GiB, almost all reclaimable.
- **shared** is mostly `tmpfs` and shared memory segments.
- **available** is the kernel's own estimate of how much memory a new workload could claim *without swapping*, factoring in which cache pages are cheaply reclaimable. This is the number you alert on.

The trap is the **used + free mental model**. If you compute `used / total`, you get `9.4 / 31 = 30%`, which is correct. If you instead compute `(total - free) / total` you get `(31 - 0.4) / 31 = 99%`, which is the false-alarm number that pages people at 3 a.m. Many homegrown scripts and a surprising number of legacy monitoring agents do exactly the latter. The correct memory-pressure signal is:

```text
memory pressure ratio = 1 - (available / total)
```

For this server that is `1 - (20 / 31) = 35%`, which matches reality. The system has 20 GiB it can reclaim or allocate before it starts hurting.

### Free Versus Available: How the Kernel Computes the Number

The single most important distinction in this entire article is **free versus available**, so it is worth seeing exactly why they differ. `free` is a trivial counter: it is the number of pages on the kernel's free list, pages the kernel is holding in reserve and not using for anything. `available` is a *prediction*. It is the kernel's answer to the question, "if I started a new process right now and it asked for memory, how much could I give it without pushing the system into swap?"

That prediction is not simply `free + cache`. Naively adding all of the page cache to free memory would overstate availability, because some cached pages are expensive or impossible to reclaim. The kernel's estimator, introduced in 3.14 and surfaced as `MemAvailable`, does something smarter. It starts from free memory, adds the reclaimable portion of the page cache (roughly the file-backed pages on the inactive and active lists), adds reclaimable slab (`SReclaimable`), and then subtracts a safety margin: each memory zone keeps a low watermark of pages it will never hand out, so the kernel discounts those. The arithmetic lives in the kernel's `si_mem_available()` function, and the exact formula has been tuned over many releases. The practical consequence is that you should never try to reproduce it by hand. Read `MemAvailable` and trust it.

A concrete way to internalize the relationship: on the 32 GB server above, `free` is 412 MiB and `available` is 20 GiB. The 19.6 GiB gap is almost entirely reclaimable page cache. If an application suddenly tried to allocate 15 GiB, the kernel would silently drop 15 GiB of clean cache pages and satisfy the request without a single swap operation. The application would see the memory it needed; a dashboard watching `free` would have screamed for hours beforehand about a crisis that could never happen.

### A One-Line Pressure Check You Can Script

Because the right ratio is `1 - available/total`, you can compute it directly from `/proc/meminfo` without parsing `free` output, which is fragile across procps versions:

```bash
# Compute memory pressure as a percentage straight from /proc/meminfo.
# Uses MemTotal and MemAvailable only, so it is stable across distros and
# immune to the "used vs free" confusion that breaks naive scripts.
awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{printf "memory pressure: %.1f%%\n", (1 - a/t) * 100}' /proc/meminfo
```

```text
memory pressure: 35.4%
```

This is the number to graph and alert on. It rises only when genuinely unreclaimable memory grows, and it stays calm no matter how much cache the kernel accumulates.

### Buffers, Cache, and What "Reclaimable" Really Means

The `buffers` and `cache` columns deserve a closer look, because people often assume they are the same thing or that all of it is freely droppable. They are neither.

- **buffers** is block-device buffer cache: raw disk blocks cached by the kernel, typically filesystem metadata such as directory entries and inode tables. It is small on most systems and almost entirely reclaimable.
- **cache** (the `Cached` field in `/proc/meminfo`) is the page cache: the contents of files that have been read or written. This is usually the largest single consumer of "non-free" RAM and the source of nearly all the confusion.

Within that cache, two distinctions matter. First, **dirty versus clean**. A clean cache page is an exact copy of what is on disk, so the kernel can drop it instantly with zero I/O. A dirty page has been modified and not yet written back, so reclaiming it requires a disk write first. The kernel tracks these as `Dirty` and `Writeback` in `/proc/meminfo`, and a large, persistent `Dirty` value means reclaim is no longer free, it costs I/O. Second, **`Shmem` versus file cache**. Pages backed by `tmpfs`, POSIX shared memory, or anonymous shared mappings show up under `Cached`, but they are not backed by any file on disk, so they cannot simply be dropped, only swapped. That is why subtracting `Shmem` from `Cached` gives a better estimate of the truly droppable file cache.

There is also **reclaimable slab** (`SReclaimable`), kernel data structures such as the dentry and inode caches that the kernel can shrink under pressure, as opposed to `SUnreclaim`, slab the kernel needs and will not give back. `MemAvailable` already folds `SReclaimable` into its estimate, which is one more reason to trust it over hand arithmetic.

## Where the Numbers Come From: `/proc/meminfo`

Every memory tool on Linux is ultimately formatting `/proc/meminfo`. Reading it directly removes ambiguity, because the kernel exposes the exact fields the tools summarize:

```bash
# /proc/meminfo is the source of truth. grep the fields that matter most
# for pressure analysis; values are in kibibytes unless noted otherwise.
grep -E "^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree|Dirty|Writeback|SReclaimable|AnonPages|Mapped|Shmem):" /proc/meminfo
```

```text
MemTotal:       32839572 kB
MemFree:          422180 kB
MemAvailable:   21218304 kB
Buffers:          291840 kB
Cached:         21884112 kB
SwapTotal:       4194300 kB
SwapFree:        4063612 kB
Dirty:             18244 kB
Writeback:             0 kB
SReclaimable:    1184320 kB
AnonPages:       8731904 kB
Mapped:           742208 kB
Shmem:           1148228 kB
```

The fields that drive real decisions:

- **MemAvailable** is the kernel's reclaimable estimate. It already accounts for `SReclaimable` (reclaimable slab) and the cheap part of the page cache, so you do not have to add fields by hand. Prefer it over any arithmetic you might invent.
- **AnonPages** is anonymous memory: heap, stack, and other allocations not backed by a file. This is the memory that *cannot* be dropped; it can only be swapped. When anonymous memory grows without bound, you have a genuine leak or an under-sized box.
- **Dirty** and **Writeback** are page-cache pages that have been modified and not yet flushed to disk. A persistently large `Dirty` value points at write pressure, which is really a storage problem wearing a memory costume; that thread continues in the disk part of this series.
- **Cached** minus **Shmem** approximates the truly droppable file cache, because `tmpfs`/`Shmem` pages count as cache but are not reclaimable without losing data.

A few more `/proc/meminfo` fields earn their place in an investigation, even if you do not graph them continuously:

- **Active** and **Inactive** (and their `(anon)`/`(file)` splits) describe the kernel's LRU lists. The reclaim machinery prefers to evict from the inactive lists first. A large `Inactive(file)` is good news: it is reclaimable cache the kernel will drop before it touches anything that hurts. A large and growing `Active(anon)` is the warning sign, because active anonymous memory is the hardest thing for the kernel to free.
- **Committed_AS** and **CommitLimit** track the overcommit accounting. `Committed_AS` is the total amount of memory the kernel has *promised* to all processes, even pages they have reserved but never faulted in. When `Committed_AS` approaches or exceeds physical RAM plus swap, the system has overcommitted, and the next large allocation may fail or trigger the OOM killer. This pairs with `sar`'s `%commit` column discussed later.
- **KReclaimable** and **Slab** quantify kernel memory. On systems running many containers or heavy filesystem workloads, slab can quietly grow into the gigabytes; if `MemAvailable` is lower than you expect and the page cache is small, suspect slab.
- **HugePages_Total** and **AnonHugePages** matter for databases and JVMs that use huge pages. Reserved huge pages are carved out of available memory whether or not anything uses them, so a host that "lost" several gigabytes with no obvious consumer may have huge pages reserved at boot.

When you want a clean rollup of the kernel's own classification rather than the field-by-field view, `vmstat -s` prints the same numbers in labeled, human-oriented prose:

```bash
# vmstat -s dumps a labeled, one-metric-per-line summary of memory and paging
# counters since boot. Useful for a quick orientation without grepping fields.
vmstat -s | head -n 20
```

```text
     32839572 K total memory
      9842560 K used memory
      9120256 K active memory
     18203648 K inactive memory
       422180 K free memory
       291840 K buffer memory
     21884112 K swap cache
      4194300 K total swap
       130688 K used swap
      4063612 K free swap
```

## Overcommit: Why Allocation Succeeds but Touching Memory Kills You

A persistent source of confusion is that a process can successfully allocate far more memory than the machine has, and only later get killed when it actually uses it. This is by design. Linux **overcommits** memory: `malloc()` (and the `mmap()` underneath it) reserves address space and returns success without reserving any physical pages. Physical RAM is allocated lazily, page by page, only when the process first *writes* to each page and triggers a page fault. A program can allocate a 100 GiB array on a 32 GiB box and the allocation will succeed; the trouble starts when it begins filling that array.

This decouples two events that intuition conflates. Allocation almost never fails, so a clean `malloc()` tells you nothing about whether the memory exists. The reckoning comes at fault time, and if the system cannot find a physical page, the OOM killer runs. That is why an application can pass all its allocation checks and still die under load.

The behavior is governed by `vm.overcommit_memory`, which has three modes:

```bash
# Inspect the overcommit policy and the heuristic's accounting. Mode 0 is the
# default heuristic; 1 always overcommits; 2 enforces a strict CommitLimit.
sysctl vm.overcommit_memory vm.overcommit_ratio
grep -E "^(CommitLimit|Committed_AS):" /proc/meminfo
```

```text
vm.overcommit_memory = 0
vm.overcommit_ratio = 50
CommitLimit:    20614036 kB
Committed_AS:   12648448 kB
```

- **Mode 0 (heuristic, the default):** the kernel allows reasonable overcommit and rejects only allocations it judges wildly unreasonable. This works well for general workloads.
- **Mode 1 (always overcommit):** every allocation succeeds. Used by workloads that legitimately map huge sparse regions (some databases, some scientific code) and know they will never touch most of it.
- **Mode 2 (strict):** the kernel refuses to commit more than `CommitLimit`, computed as swap plus `overcommit_ratio` percent of RAM. Here allocations can fail with `ENOMEM`, but the system will essentially never invoke the OOM killer. This trades the abruptness of OOM kills for the burden of handling allocation failures, and it suits systems where a failed `malloc` is preferable to a surprise `SIGKILL`.

The two fields to watch are `Committed_AS` (total memory promised) against `CommitLimit` (the ceiling under mode 2, and a useful reference even under mode 0). When `Committed_AS` exceeds physical RAM plus swap, the system has promised more than it can deliver, and the next wave of page faults may trigger OOM kills. This is the accounting behind `sar`'s `%commit` column, and watching it trend toward and past 100% is an early, leading indicator of trouble that no point-in-time usage gauge provides.

## Proving the Page Cache Is Reclaimable

If you do not yet believe that cache is free for the taking, demonstrate it on a non-production host. The kernel exposes a knob to drop clean caches:

```bash
# On a TEST system only: flush dirty pages, then drop the clean page cache
# so you can watch "available" stay high while "cache" collapses.
sync && echo 1 > /proc/sys/vm/drop_caches
```

Run `free -w -h` immediately before and after. The `cache` column drops by gigabytes, `free` rises by the same amount, and `available` barely moves, because the kernel already counted that cache as available. Never run `drop_caches` on production to "fix" memory: you only force the kernel to re-read from disk on the next access, trading a phantom memory number for real I/O latency.

## Per-Process Memory: VSZ, RSS, and PSS

Aggregate node memory tells you whether the box is healthy. To find *which* process is responsible, you need per-process accounting, and this is where three acronyms cause endless confusion.

- **VSZ (Virtual Set Size)** is the total size of a process's virtual address space: everything it has mapped, including memory it has reserved but never touched, shared libraries, and memory-mapped files. VSZ is almost useless as a pressure signal. A Go or Java process routinely reserves tens of gigabytes of virtual address space while using a small fraction of it. Alerting on VSZ produces nothing but noise.
- **RSS (Resident Set Size)** is the amount of physical RAM the process currently occupies. It is far more meaningful than VSZ, with one important caveat: **RSS double-counts shared memory**. If twenty PHP workers share the same 80 MB of read-only library pages, each one reports that 80 MB in its RSS, so summing RSS across processes wildly overstates true usage.
- **PSS (Proportional Set Size)** fixes the double-counting. Shared pages are divided evenly among the processes sharing them, so summing PSS across every process on the system approximates real physical usage. PSS is the right per-process number when you care about who is actually consuming the box.

Look at RSS quickly with `ps`:

```bash
# ps sorted by resident size. VSZ and RSS are in kibibytes. Use this for a
# fast "who is biggest" answer, remembering RSS overcounts shared pages.
ps -eo pid,user,vsz,rss,comm --sort=-rss | head -n 10
```

```text
  PID USER       VSZ   RSS COMMAND
 1834 app    9472128 4192256 java
 2210 postgres 412160 982144 postgres
 2784 app    1284992 318208 cache-worker
 1190 root    742208  88320 containerd
  933 www-data 298112  81344 php-fpm
```

Notice the Java process: 9.4 GiB of virtual address space, 4 GiB resident. The VSZ would have you believe it is using three times its real footprint.

For accurate totals, use `smem`, which reads `/proc/<pid>/smaps` and reports PSS and USS (Unique Set Size: the memory that would be freed if this process died):

```bash
# smem reports PSS and USS so shared pages are not double-counted. Sort by
# PSS (column 6 here) to find the processes truly responsible for usage.
smem -t -k -c "pid user command swap uss pss rss" | sort -k6 -h | tail -n 15
```

```text
  PID User     Command                 Swap      USS      PSS      RSS
  933 www-data php-fpm: pool www          0    24.1M    41.8M    81.3M
 2784 app      cache-worker               0   298.4M   312.7M   318.2M
 2210 postgres postgres: writer        2.0M   784.2M   861.0M   982.1M
 1834 app      java -jar app.jar          0     3.9G     4.0G     4.1G
-------------------------------------------------------------------------
                                       2.0M     5.0G     5.2G     5.5G
```

The `php-fpm` worker is a perfect example: 81 MiB RSS but only 42 MiB PSS, because half its pages are shared with sibling workers. Multiply that gap across forty workers and an RSS-based capacity plan over-provisions the host by gigabytes.

You can also read a single process's accounting directly, which is invaluable when scripting or debugging one PID:

```bash
# Per-process rollup including PSS for a single process. /proc/<pid>/status
# gives the headline VmRSS/VmSize/VmSwap; smaps_rollup adds Pss.
grep -E "^(VmRSS|VmSize|VmSwap|RssAnon|RssFile)" /proc/self/status
cat /proc/self/smaps_rollup
```

`RssAnon` versus `RssFile` is the useful split here: anonymous resident memory is the part that can only grow or swap, while file-backed resident memory can be dropped under pressure.

### Why PSS Is the Honest Number for Shared Memory

To see why PSS matters in practice, picture a PHP-FPM pool with forty worker processes. Each worker `fork()`s from a parent, so they share the same code pages, the same loaded extensions, and a large block of read-only opcode cache. Suppose each worker maps 60 MiB of shared pages and has 20 MiB of its own private heap.

- **RSS-based estimate:** every worker reports `60 + 20 = 80 MiB`, so summing across forty workers gives `40 x 80 = 3200 MiB`. That number says the pool needs 3.2 GiB.
- **Reality:** the 60 MiB of shared pages exists exactly once in physical RAM. True usage is `60 + (40 x 20) = 860 MiB`.

RSS overstated the footprint by nearly four times. A capacity plan built on summed RSS would provision a host almost four times larger than necessary, and a Kubernetes memory limit set from summed RSS would be wildly generous. **PSS** corrects this by attributing each shared page proportionally: a page shared by forty processes contributes `1/40` of its size to each process's PSS. Sum PSS across all processes and you get a figure that closely tracks actual physical consumption, because every physical page is counted exactly once in aggregate.

The trade-off is cost. RSS is a single counter the kernel already maintains, so reading it is nearly free. PSS requires walking `/proc/<pid>/smaps`, examining every virtual memory area and its sharing count, which is far more expensive. That is why `top` and `ps` default to RSS and why `smem` warns that it is slow on systems with thousands of processes. For continuous monitoring, sample PSS periodically rather than every few seconds; for a one-time capacity question, the cost is irrelevant.

There is one more per-process number worth knowing: **USS (Unique Set Size)**, the memory that belongs to this process alone and nothing else. USS is the amount of RAM that would actually be freed if you killed this single process, because shared pages survive as long as any other process still maps them. When triaging "which process can I kill to recover the most memory," USS is the correct answer, not RSS or PSS.

### Interactive Monitoring With `top` and `htop`

For live watching rather than scripted collection, `top` is universally available and, configured correctly, perfectly adequate. By default `top` sorts by CPU; press `M` (capital) to sort by resident memory, or launch it presorted:

```bash
# Launch top sorted by memory (%MEM/RES), batch mode, one iteration, so the
# output is captured rather than interactive. Drop -b -n1 for live use.
top -b -o %MEM -n 1 | head -n 12
```

```text
top - 14:21:08 up 37 days,  4:12,  2 users,  load average: 1.84, 1.62, 1.55
MiB Mem :  32070.7 total,    412.3 free,   9612.1 used,  22046.3 buff/cache
MiB Swap:   4096.0 total,   3968.4 free,    127.6 used.  20721.0 avail Mem
    PID USER      PR  NI    VIRT    RES    SHR S  %MEM     TIME+ COMMAND
   1834 app       20   0    9.0g   4.0g  18432 S  12.8  41:02.11 java
   2210 postgres  20   0  402.5m 958.9m   8192 S   2.9  18:44.07 postgres
   2784 app       20   0    1.2g 310.7m   6144 R   1.0   3:51.62 cache-worker
```

Read `top`'s memory header the same way you read `free`: the `buff/cache` figure is reclaimable, and `avail Mem` is the number that matters, not `used`. The per-process `RES` column is RSS, so it carries the same shared-page caveat as `ps`. `htop`, if installed, shows the same data with a clearer memory bar that visually separates used, buffers, and cache, which helps newcomers internalize that the bar being "full" of cache is not a problem. Neither tool reports PSS, so for accurate per-process attribution you still drop back to `smem`.

### A Caveat on `smem` Accuracy and Cost

`smem` is the right tool for PSS, but know its limits. It reads `/proc/<pid>/smaps` for every process, which is slow on a host with thousands of processes and which requires privilege to see processes you do not own; run it with `sudo` for a complete picture. Its numbers are also a point-in-time snapshot of a moving target, so on a busy system two consecutive runs will differ slightly, which is expected, not a bug. For a quick visual on a workstation, `smem --pie name` renders memory by command, but for capacity work prefer the tabular `-t` output and sum the PSS column. Finally, `smem` is a userspace Python tool and not always installed; on a minimal node you may need to fall back to summing `Pss:` lines straight from smaps:

```bash
# Total PSS for a single PID without smem, by summing the Pss lines in smaps.
# Output is in kibibytes. Works anywhere /proc is mounted, no extra packages.
awk '/^Pss:/{sum += $2} END {printf "PSS total: %d kB\n", sum}' /proc/1834/smaps
```

```text
PSS total: 4093184 kB
```

## Swap Is Not the Enemy; Swapping Is

Swap is the most over-feared concept in Linux memory. The presence of used swap on a dashboard triggers a reflex to disable swap entirely, which is almost always the wrong move. The distinction that matters is between **swap occupancy** (how much is sitting in swap) and **swap activity** (how fast pages are moving in and out).

Swap occupancy is harmless on its own. The kernel will proactively move long-idle anonymous pages to swap to free RAM for the page cache, even when there is no shortage, controlled by the `vm.swappiness` tunable. Those pages may sit in swap for days without being touched, costing nothing. A server showing 200 MB of swap used and zero swap I/O is perfectly healthy.

Swap *activity* is the real signal. When the working set no longer fits in RAM, the kernel constantly evicts pages to swap and faults them back in, a thrashing pattern that destroys latency. Watch the `si` (swap in) and `so` (swap out) columns of `vmstat`:

```bash
# vmstat samples every 2 seconds, 5 times. Watch si/so (swap in/out, in KB/s)
# and the wa column (CPU waiting on I/O). Sustained nonzero si/so is thrashing.
vmstat 2 5
```

```text
procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----
 r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
 1  0 131072 421888 291840 21884    0    0    12    48  820 1640  8  2 89  1  0
 2  1 131072 418304 291840 21902    0    0     8   220  910 1880  9  3 87  1  0
 3  4 998400 102400 180224 14208 4096 8192  1024  9600 4200 9800 14 18 12 56  0
 5  6 1820672  98304 142336 11264 9216 12288 2048 14400 5800 14200 11 24  5 60  0
```

The first two samples are a calm system: swap used is steady and `si`/`so` are zero. The last two samples are an emergency: `si` and `so` are in the thousands of KB/s, `wa` (I/O wait) has jumped above 50%, and run-queue (`r`) and blocked (`b`) counts are climbing. That is thrashing. The fix is more RAM or less working set, never just turning off the metric.

Set `vm.swappiness` deliberately. The default of 60 favors swapping anonymous pages fairly aggressively; database and latency-sensitive hosts often set it to `10` so the kernel prefers dropping cache over swapping application memory, while still keeping swap as a safety valve against the OOM killer.

### Understanding and Tuning `vm.swappiness`

`vm.swappiness` is widely misunderstood as "how much the kernel uses swap." It is more precise to read it as the kernel's *relative preference* when it must reclaim memory: should it reclaim anonymous pages (which means swapping them out) or file-backed cache pages (which means dropping them)? A swappiness of 0 tells the kernel to avoid swapping anonymous memory until it has almost nothing else left; a swappiness of 100 tells it to treat anonymous and file pages as equally fair game. The default of 60 leans modestly toward swapping.

```bash
# Read the current swappiness, then set it conservatively for a database or
# latency-sensitive host. The sysctl change is live; the /etc/sysctl.d entry
# makes it survive reboots.
cat /proc/sys/vm/swappiness
sysctl -w vm.swappiness=10
echo 'vm.swappiness = 10' | sudo tee /etc/sysctl.d/99-swappiness.conf
```

```text
60
vm.swappiness = 10
```

Guidance by workload type:

- **Databases and latency-sensitive services:** set swappiness to `1` or `10`. These workloads usually want their entire working set resident; swapping a hot index page out and faulting it back in adds milliseconds of latency to a query that should take microseconds. Keep a small swap device anyway, so the kernel has somewhere to put genuinely idle pages and a buffer before the OOM killer fires.
- **General-purpose and batch hosts:** the default of `60` is fine. These systems benefit from the kernel freely trading idle anonymous memory for cache.
- **Never set swappiness to 0 expecting "no swap."** A value of 0 does not disable swap; it tells the kernel to avoid swapping anonymous memory until it is nearly out of options, which under real pressure means the OOM killer may fire sooner. If you truly want no swap, remove the swap device, but understand you are removing the kernel's last buffer before it starts killing processes.

One subtlety changed with cgroup v2: each cgroup has its own effective swappiness, and the global `vm.swappiness` acts as the default. Inside a container you can observe but usually not override this; the platform sets it. That is why a database in a pod may swap differently than the same database on bare metal even with identical `vm.swappiness`, because the cgroup hierarchy and the pod's memory limit reshape the reclaim decision.

## Distinguishing a Leak From a Working Set

"The application is leaking memory" is a frequent claim and an infrequent reality. Much of what gets reported as a leak is simply a process whose working set is larger than someone expected, or a runtime that grows its heap to a steady plateau and stays there. A genuine leak has a distinctive shape: **monotonic, unbounded growth of anonymous memory over time, independent of load.**

The signal to watch is anonymous resident memory, because that is the memory that cannot be reclaimed without the process freeing it. File-backed memory and cache fluctuate harmlessly; `RssAnon` climbing without end is the fingerprint of a leak. Sample it periodically and look at the trajectory, not a single reading:

```bash
# Sample a process's anonymous RSS every 30 seconds. A flat or oscillating
# line is a healthy working set; a steadily rising line that never plateaus,
# even when load is constant, is the signature of a leak.
for i in $(seq 1 10); do
  ts=$(date +%H:%M:%S)
  anon=$(awk '/^RssAnon:/{print $2}' /proc/1834/status)
  printf "%s RssAnon=%s kB\n" "$ts" "$anon"
  sleep 30
done
```

```text
14:30:00 RssAnon=3981312 kB
14:30:30 RssAnon=4001920 kB
14:31:00 RssAnon=4022784 kB
14:31:30 RssAnon=4043520 kB
14:32:00 RssAnon=4064128 kB
```

Roughly 20 MiB of growth every 30 seconds, holding steady under constant load, is a leak; over an hour that is more than 2 GiB. Contrast this with a healthy JVM or Go service, which grows quickly after startup as it warms caches and then plateaus. The discriminating question is always: *does it stop growing when the load stops?* If yes, it is a working set. If it climbs regardless, it is a leak, and the next step is application-level profiling (a heap profiler for the JVM, `pprof` for Go, `valgrind` or `jemalloc` profiling for native code), which is beyond the scope of this measurement-focused article but begins with the confidence that the OS-level numbers point at a real problem.

In containers, the same shape appears as `anon` in `memory.stat` growing toward `memory.max` until the pod is OOMKilled, restarts, and begins the climb again. A pod with a perfectly regular OOMKilled-and-restart sawtooth, every few hours like clockwork, is almost always leaking, not under-provisioned. Raising the limit only lengthens the sawtooth; it does not fix it.

## Pressure Stall Information: The Modern Pressure Signal

`vmstat` and `free` are snapshots. The kernel's **Pressure Stall Information (PSI)** interface, available since kernel 4.20, answers a sharper question: *for what fraction of the last interval was real work stalled waiting on memory?* This is the closest Linux gets to a direct "is memory hurting me" number.

```bash
# /proc/pressure/memory reports the share of time tasks stalled on memory.
# "some" = at least one task stalled; "full" = all non-idle tasks stalled.
cat /proc/pressure/memory
```

```text
some avg10=0.00 avg60=0.12 avg300=0.34 total=1842934
full avg10=0.00 avg60=0.04 avg300=0.11 total=612031
```

The `avg10`, `avg60`, and `avg300` figures are percentages over the last 10, 60, and 300 seconds. A `some avg60` that is consistently above zero means at least one task is regularly waiting on memory reclaim; `full` rising means the entire workload is periodically frozen on memory. PSI is far more actionable than absolute byte counts because it reports impact, not inventory. Alert on `some avg300` crossing a small threshold (for example, 5) and you catch real pressure long before the OOM killer fires, while ignoring the cache-is-full noise that fools `used`-based alerts.

The same interface exists per-cgroup, which makes it the single best per-pod pressure signal in Kubernetes. Each cgroup directory exposes its own `memory.pressure` file:

```bash
# Per-cgroup memory PSI. Inside a container this is the pod's own stall time;
# nonzero "some" here means THIS workload is waiting on reclaim, independent
# of whatever the rest of the node is doing.
cat /sys/fs/cgroup/memory.pressure
```

```text
some avg10=0.00 avg60=2.41 avg300=3.07 total=29481103
full avg10=0.00 avg60=1.88 avg300=2.55 total=20114777
```

A pod whose cgroup `some avg300` is climbing is actively struggling to keep its working set resident within its limit, even if `container_memory_working_set_bytes` has not yet touched the ceiling. Watching cgroup PSI catches a pod that is thrashing its own page cache against its limit, a state that raw usage gauges miss entirely because usage simply sits pinned at the limit while the kernel churns. If your monitoring stack scrapes cgroup PSI, alert on it; it is the earliest honest warning that a limit is too tight.

## When the Kernel Runs Out: the OOM Killer

When memory is genuinely exhausted and swap cannot save the situation, the kernel invokes the **OOM (Out Of Memory) killer**. It scores every process by an `oom_score` (roughly, how much memory it uses, adjusted by `oom_score_adj`), and kills the highest scorer to recover RAM. This is a last resort, and it is abrupt: the victim receives `SIGKILL` with no chance to clean up.

Find OOM events in the kernel log:

```bash
# Search the kernel ring buffer / journal for OOM kill events. Each kill logs
# the victim, its RSS, and the cgroup it belonged to.
journalctl -k --grep "Out of memory|oom-kill" --no-pager | tail -n 20
```

```text
kernel: cache-worker invoked oom-killer: gfp_mask=0x...
kernel: oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=...
kernel: Memory cgroup out of memory: Killed process 2784 (cache-worker)
        total-vm:1284992kB, anon-rss:1042432kB, file-rss:8192kB
kernel: oom_reaper: reaped process 2784 (cache-worker)
```

The crucial detail in this log is `constraint=CONSTRAINT_MEMCG`. The node was not out of memory at all; a single **cgroup** hit its own limit, and the kernel killed a process to keep that cgroup within bounds. That distinction is the bridge to the part of memory analysis that trips up the most teams in 2032: containers.

### How the OOM Killer Chooses Its Victim

The OOM killer is not random and it is not "the biggest process," though that is a useful first approximation. The kernel computes an `oom_score` for each candidate process. The base of that score is the process's memory footprint as a fraction of available memory (within the relevant scope, system-wide or per-cgroup), expressed on a scale from 0 to 1000. A process using half the available memory scores roughly 500. The kernel then applies the per-process `oom_score_adj`, an integer from `-1000` to `+1000` that you can set to bias the decision. The adjustment is added to the normalized score, so `+1000` makes a process the preferred victim regardless of size, and `-1000` makes it effectively immune.

You can read both the raw score and the adjustment from `/proc`:

```bash
# oom_score is the kernel's current kill-priority for a PID (higher = killed
# first). oom_score_adj is the tunable bias. Replace 1834 with a real PID.
cat /proc/1834/oom_score
cat /proc/1834/oom_score_adj
```

```text
667
0
```

To protect a critical process, lower its adjustment; to nominate a sacrificial one, raise it. For example, an init system or a node agent you never want killed should sit near `-1000`, while a batch worker that is safe to lose can sit at a positive value:

```bash
# Make a critical daemon (PID 1190) nearly immune, and mark a disposable
# batch worker (PID 2784) as the preferred victim. Requires privilege.
echo -1000 > /proc/1190/oom_score_adj   # protect: essentially never kill
echo  800  > /proc/2784/oom_score_adj   # sacrifice this one first
```

Two cautions. First, `oom_score_adj` does not change how much memory a process uses; it only changes who dies when the kernel must kill something. Protecting everything is self-defeating, because the kernel will still kill *someone*, and if you have shielded the actual memory hog, it may take down an innocent neighbor. Second, in Kubernetes you generally do not set this by hand. The kubelet assigns `oom_score_adj` automatically based on the pod's QoS class: Guaranteed pods get the most protection, Burstable pods an intermediate value scaled by their request, and BestEffort pods the least, so they are killed first under node memory pressure. Overriding it manually inside a container fights the platform and usually backfires.

### Distinguishing a cgroup Kill From a Node Kill

The `constraint=` field in the OOM log is the single most important piece of evidence, because it tells you whether you are dealing with a node-level shortage or a per-container limit:

- `constraint=CONSTRAINT_NONE` means the whole node ran out of memory and swap. The fix is more RAM, fewer workloads on the node, or finding the leak.
- `constraint=CONSTRAINT_MEMCG` means a cgroup hit its `memory.max`. The node may have had gigabytes free. The fix is the container's limit or the workload's footprint, never the node.

Confusing the two is the most common diagnostic error in container memory incidents. A team sees "OOM" in the logs, assumes the node is undersized, and adds nodes, while the real problem is a single pod with a limit set too low for its working set. Always read `constraint=` first.

## Memory Inside Containers and Kubernetes

Everything above describes a whole machine. Inside a container, the rules shift in ways that silently invalidate host-level tools, because a container's memory is governed by a **cgroup** (control group), not by the node's total RAM.

The first failure mode is informational. Older programs, and `free` itself, read `/proc/meminfo`, which reports the *node's* memory, not the container's. A container limited to 1 GiB on a 64 GiB node will see 64 GiB from `free`. Runtimes that size their heaps or thread pools from "available memory" can therefore wildly over-allocate and then get OOM-killed. Modern JVMs (with `-XX:+UseContainerSupport`, on by default) and recent Go runtimes read cgroup limits instead, but plenty of tooling still does not.

Read the container's actual limits from the cgroup v2 interface, which is what the kernel enforces:

```bash
# cgroup v2 memory controller, as seen from inside the container.
# memory.current = bytes in use now; memory.max = the hard limit (or "max").
cat /sys/fs/cgroup/memory.current
cat /sys/fs/cgroup/memory.max
cat /sys/fs/cgroup/memory.stat
```

```text
734003200
1073741824
anon 698351616
file 25165824
kernel_stack 1310720
slab 8388608
file_dirty 0
inactive_file 18874368
active_file 6291456
```

Here the container is using 734 MB (`memory.current`) of its 1 GiB hard cap (`memory.max`, `1073741824` bytes). The `memory.stat` breakdown is the gold standard for diagnosing container memory: `anon` is the unreclaimable application memory that pushes you toward an OOM kill, while `file` and `inactive_file` are reclaimable cache that the kernel will drop before killing anything.

### Page Cache Is Charged to the Container

The most surprising fact about container memory is that **the page cache counts against your limit**. When a process inside a container reads or writes a file, the resulting page-cache pages are charged to that container's cgroup, not to some shared system pool. This is correct behavior, since the kernel must attribute the memory to someone, but it produces a class of false alarms unique to containers.

Consider a log-processing pod with a 1 GiB limit that streams through a 5 GiB log file. As it reads, the kernel fills the page cache with that file's contents, and `memory.current` climbs toward 1 GiB even though the application's own heap is tiny. A dashboard tracking raw usage shows the pod pinned at its limit and apparently about to die. It is not. When the cgroup approaches `memory.max`, the kernel reclaims that file cache within the cgroup first, exactly as it would system-wide. The pod keeps running; only the cache churns.

This is why `memory.stat` is indispensable inside containers. Break the current usage into its parts:

```bash
# Inside a container: separate reclaimable cache from unreclaimable anon.
# anon + slab + kernel_stack is roughly what cannot be reclaimed; the file
# fields are cache the kernel will drop before it OOM-kills the cgroup.
awk '/^(anon|file|inactive_file|active_file|slab|kernel_stack) /{print}' /sys/fs/cgroup/memory.stat
```

```text
anon 698351616
file 25165824
inactive_file 18874368
active_file 6291456
slab 8388608
kernel_stack 1310720
```

In this snapshot the container uses 734 MB total, but only about 707 MB (`anon` plus `slab` plus `kernel_stack`) is unreclaimable. The 25 MB of `file` is cache that does not count toward an OOM kill in any meaningful way. If `anon` alone were approaching `memory.max`, that would be a real emergency; here it is comfortably below.

### Working Set: the Number Kubernetes Actually Watches

Kubernetes does not evict or OOM-kill a pod based on `memory.current` directly. It uses the **working set**, defined as total usage minus the cache that can be reclaimed under pressure (specifically, `memory.current` minus `inactive_file`). This is the value exposed as `container_memory_working_set_bytes`, the metric you should base every container memory alert and dashboard on.

The common Kubernetes mistake mirrors the node-level one exactly. Teams alert on `container_memory_usage_bytes`, which includes reclaimable cache, see it pinned near the limit, and conclude the pod is about to die, when in fact the kernel would simply drop cache. The working set is the honest signal: if `container_memory_working_set_bytes` approaches `memory.max`, the pod is genuinely close to an OOM kill, because the kernel has no reclaimable cache left to give back.

A correct alerting rule compares working set to the configured limit:

```yaml
groups:
  - name: memory.rules
    rules:
      # Fire when a container's WORKING SET (not raw usage) sustains above 90%
      # of its memory limit, the real precursor to an OOMKilled event.
      - alert: ContainerMemoryNearLimit
        expr: |
          max by (namespace, pod, container) (
            container_memory_working_set_bytes{container!=""}
          )
          /
          max by (namespace, pod, container) (
            kube_pod_container_resource_limits{resource="memory"}
          )
          > 0.9
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Container {{ $labels.pod }} working set above 90% of its memory limit"
```

### Requests, Limits, and OOMKilled

A Kubernetes pod declares two memory numbers, and they do different jobs:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: cache-worker
spec:
  containers:
    - name: app
      image: registry.example.com/cache-worker:1.4.2
      resources:
        requests:
          # Scheduling guarantee: the scheduler reserves this much on a node.
          memory: "512Mi"
          cpu: "250m"
        limits:
          # Hard ceiling: exceed the working set here and the container is
          # OOMKilled by the kernel, then restarted by the kubelet.
          memory: "1Gi"
          cpu: "1000m"
```

The **request** is used only for scheduling; it reserves capacity so the scheduler places the pod on a node that can hold it. The **limit** is the cgroup `memory.max`. When a container's working set exceeds its limit, the kernel OOM-kills the offending process inside that container, the kubelet records the container state as **OOMKilled** (exit code 137), and the pod restarts. Because the kill is per-container and per-cgroup, the node itself can have plenty of free RAM while a pod dies repeatedly. That is exactly the `CONSTRAINT_MEMCG` log line shown earlier.

Two practical rules follow. First, set memory **requests equal to limits** for any workload you want predictable, since unlike CPU, memory is incompressible and there is no throttling: a container either has the page or it does not. Equal request and limit puts the pod in the Guaranteed QoS class and removes the risk of the node overcommitting memory and triggering node-level OOM eviction. Second, size the limit from the observed **working set under real load**, not from a guess, and not from RSS. The Vertical Pod Autoscaler in recommendation-only mode is a clean way to gather that data without letting it change anything:

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: cache-worker-vpa
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: cache-worker
  # "Off" means: observe and recommend memory/CPU, but never mutate pods.
  # Read the recommendations with `kubectl describe vpa cache-worker-vpa`.
  updatePolicy:
    updateMode: "Off"
```

### Diagnosing an OOMKilled Pod

When a pod is restarting and you suspect memory, the diagnosis follows a fixed sequence. Start with the pod's container statuses, where the kubelet records exactly why the last container died:

```bash
# Show the last termination reason and exit code for every container in a pod.
# Reason "OOMKilled" with exitCode 137 is the unambiguous memory-kill signature.
kubectl get pod cache-worker-7d9f8 -o jsonpath='{range .status.containerStatuses[*]}{.name}{": "}{.lastState.terminated.reason}{" (exit "}{.lastState.terminated.exitCode}{")"}{"\n"}{end}'
```

```text
app: OOMKilled (exit 137)
```

Exit code 137 is `128 + 9`, that is, the process was terminated by signal 9 (`SIGKILL`), which is how the OOM killer ends its victim. `kubectl describe pod` shows the same information in context, along with the restart count and the events that surrounded each kill:

```bash
# describe surfaces Last State, Restart Count, and recent Events together,
# which is usually enough to confirm an OOM loop at a glance.
kubectl describe pod cache-worker-7d9f8 | grep -A5 "Last State"
```

```text
    Last State:     Terminated
      Reason:       OOMKilled
      Exit Code:    137
      Started:      Tue, 18 Jun 2032 01:58:04 +0000
      Finished:     Tue, 18 Jun 2032 01:58:41 +0000
```

The trap at this stage is to assume every exit 137 is the pod overrunning its own limit. It is not always. Exit 137 also appears when the *node* is under memory pressure and the kubelet evicts pods, or when a node-level OOM kill catches a process that happened to be in a container. The way to tell them apart is to read the kernel log on the node and check the `constraint=` field, exactly as shown earlier:

```bash
# Confirm whether the kill was a per-container limit (CONSTRAINT_MEMCG) or a
# node-wide shortage (CONSTRAINT_NONE). Run on the node hosting the pod.
journalctl -k --since "5 minutes ago" --grep "oom-kill|Out of memory" --no-pager
```

If the log shows `CONSTRAINT_MEMCG` naming your container's cgroup, the limit is too low for the working set: raise the limit or shrink the workload. If it shows `CONSTRAINT_NONE`, the node is oversubscribed: your *requests* are too low relative to actual usage, letting the scheduler pack more onto the node than it can hold. Those are opposite fixes, which is why reading the constraint is not optional.

### A Recurring OOMKilled Pattern: the JVM and the Container Limit

A specific failure mode is common enough to call out. A Java service runs fine on a developer's laptop, then gets OOMKilled minutes after deploying to Kubernetes with a 2 GiB limit. The cause is almost always a JVM that sized its heap from the *node's* memory rather than the *container's* limit, or an `-Xmx` set higher than the limit leaves room for off-heap memory. The JVM's heap plus metaspace plus thread stacks plus native buffers can exceed the limit even when the heap alone fits, and the kernel kills the process the instant the working set crosses `memory.max`. The remedy is to let the JVM read the cgroup limit (modern JVMs do this by default with `-XX:+UseContainerSupport`) and to set `-XX:MaxRAMPercentage` so the heap leaves headroom for non-heap memory, rather than pinning `-Xmx` to nearly the full limit. The same lesson applies to any runtime that auto-sizes from "available" memory: inside a container, "available" must mean the cgroup limit, never `/proc/meminfo`.

## Watching Trends Over Time with `sar`

Everything so far is real-time. To answer "was the box under memory pressure during last night's batch job," you need historical data, and `sar` from the `sysstat` package collects it automatically when enabled:

```bash
# sar -r reports memory utilization. Live mode: 1-second interval, 3 samples.
# For history, run `sar -r -f /var/log/sysstat/saYYYYMMDD` against the archive.
sar -r 1 3
```

```text
12:30:01     kbmemfree  kbavail kbmemused  %memused kbbuffers  kbcached  kbcommit  %commit  kbactive   kbinact
12:30:02        421888 21218304   9842560     29.97    291840  21884112  12648448    34.16   9120256  18203648
12:30:03        419456 21214208   9845760     29.98    291840  21885440  12648448    34.16   9122304  18205184
12:30:04        420160 21215872   9844224     29.97    291840  21884800  12648448    34.16   9121536  18204672
```

The `%memused` column here uses the misleading `used` definition, so read `kbavail` (kibibytes available) instead, and watch `%commit`: that is committed virtual memory as a percentage of RAM plus swap, and when it climbs past 100% the system has promised more memory than it can physically back, which is the precursor to OOM events. Historical `sar` data turns "the pod restarted at 2 a.m." into "the working set crossed the limit at 1:58 a.m. during the nightly import," which is the difference between guessing and knowing.

## Building Honest Dashboards and Alerts

Everything in this article reduces to one operational rule: graph and alert on the signals that mean something, and stop graphing the ones that do not. In a Prometheus and Grafana environment fed by `node_exporter` and `cAdvisor`/`kube-state-metrics`, that translates to a small set of queries that you should standardize across the fleet.

For node-level memory pressure, compute the same `1 - available/total` ratio the kernel hands you, never `1 - free/total`:

```text
# Node memory pressure as a fraction. Uses MemAvailable, so it stays calm
# while the page cache is full and only rises on genuine, unreclaimable use.
1 - (
  node_memory_MemAvailable_bytes
  /
  node_memory_MemTotal_bytes
)
```

For container memory, alert on working set against the configured limit, which is the rule shown earlier with `container_memory_working_set_bytes`. Add a companion alert on the swap-thrashing signal at the node level, because sustained paging is invisible to a usage gauge:

```text
# Sustained page-in/page-out at the node level. node_vmstat_pgpgin/pgpgout
# are cumulative, so rate() over 5m exposes the thrashing the byte counts hide.
rate(node_vmstat_pgpgin[5m]) + rate(node_vmstat_pgpgout[5m]) > 50000
```

If your `node_exporter` is recent enough to expose PSI (the `node_pressure_memory_*` series), prefer it for the primary memory alert, since it reports stall time, not inventory:

```text
# Memory PSI: fraction of time tasks stalled waiting on memory over 5m.
# A small sustained value here is a truer emergency than any usage percentage.
rate(node_pressure_memory_waiting_seconds_total[5m]) > 0.10
```

The deletions matter as much as the additions. Retire any panel or alert built on `node_memory_MemFree_bytes` as a health signal, on `container_memory_usage_bytes` as a limit-proximity signal, or on summed per-process RSS as a capacity signal. Each of those is a documented source of false pages, and removing them from your dashboards is the most effective single change most teams can make to reduce memory-related noise.

## A Practical Decision Order

When you are handed a "high memory" alert, work the problem in this order rather than reacting to the first big number you see:

1. **Check `available`, not `used`.** Run `free -w -h` and compute `1 - available/total`. If that is low, the alert is almost certainly counting cache. Close it.
2. **Check PSI.** `cat /proc/pressure/memory`. If `some avg300` is near zero, there is no real pressure regardless of what the byte counts say.
3. **Check for swapping, not swap.** `vmstat 2 5` and look at `si`/`so`. Steady occupancy is fine; sustained activity is thrashing.
4. **If pressure is real, find the owner by PSS.** Use `smem` sorted by PSS, not `ps` sorted by RSS, so shared pages do not mislead you.
5. **In a container, switch frames entirely.** Read `memory.current`, `memory.max`, and `memory.stat` from the cgroup, and base your judgment on the working set, not `/proc/meminfo` and not raw usage.
6. **Confirm the OOM cause.** `journalctl -k` and check `constraint=`. `CONSTRAINT_MEMCG` means a cgroup limit, not a node shortage, and the fix is the limit or the workload, not the node.
7. **Decide leak versus working set.** If a process or pod keeps growing, sample `RssAnon` (or cgroup `anon`) over time. Unbounded anonymous growth under steady load is a leak that more RAM will not fix; a plateau is just the working set.
8. **Fix the dashboard, not just the incident.** If the alert that paged you was built on `free`, `container_memory_usage_bytes`, or summed RSS, the durable fix is replacing that signal with `MemAvailable`, working set, and PSI so the false page never recurs.

## Conclusion

Memory measurement on Linux is mostly a matter of refusing to trust the obvious number. The kernel deliberately fills RAM with reclaimable cache, so "used" and "free" describe the kernel's housekeeping, not your application's health. Once you anchor on the right signals, the false alarms disappear and the real problems become unmistakable.

Key takeaways:

- **Free memory is wasted memory.** Low free with high `available` is a healthy, well-utilized system, not an emergency.
- **Alert on `MemAvailable` and PSI**, never on `total - free`. PSI's `some`/`full` percentages report actual stall time, which is the closest thing to a direct pressure signal.
- **Use PSS, not RSS, for per-process accounting.** RSS double-counts shared pages and inflates capacity plans; `smem` gives you the honest proportional number.
- **Fear swapping, not swap.** Occupancy is harmless; sustained `si`/`so` activity is thrashing. Tune `vm.swappiness` for the workload instead of disabling swap.
- **Inside containers, abandon node-level tools.** Read the cgroup (`memory.current`, `memory.max`, `memory.stat`) and judge by the **working set** (`container_memory_working_set_bytes`), which is what Kubernetes uses to OOM-kill.
- **Set memory requests equal to limits** for predictable pods, size limits from observed working set under load, and check `constraint=` in OOM logs to tell a cgroup kill from a node shortage.
- **Page cache counts against a container's limit**, so a pod streaming a large file can look pinned at its limit while being perfectly healthy; read `memory.stat` and judge by `anon`, not by raw `memory.current`.
- **A regular OOMKilled sawtooth is a leak, not under-provisioning.** Unbounded anonymous growth means more memory only delays the next kill; profile the application instead of raising the limit.
- **Tune dashboards, not just incidents.** Retire `free`-based, raw-usage, and summed-RSS panels in favor of `MemAvailable`, `container_memory_working_set_bytes`, and PSI; that one change removes most memory false alarms across a fleet.

### Related posts in this series

- [Measuring Linux Performance the Right Way: CPU](/measuring-linux-performance-cpu/)
- [Measuring Linux Performance the Right Way: Memory](/measuring-linux-performance-memory/) (this post)
- [Measuring Linux Performance the Right Way: Disk and Storage](/measuring-linux-performance-disk-storage/)
- [Measuring Linux Performance the Right Way: Network](/measuring-linux-performance-network/)
- [Measuring Linux Performance the Right Way: Recap and Common Mistakes](/measuring-linux-performance-recap-common-mistakes/)
