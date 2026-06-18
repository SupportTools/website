---
title: "Measuring Linux Performance: Disk and Storage Done Right"
date: 2032-05-02T09:00:00-05:00
draft: false
tags: ["Linux", "Performance", "Storage", "iostat", "fio", "NVMe", "SSD", "Kubernetes", "CSI", "blktrace", "Observability", "SRE"]
categories:
- Linux
- Performance
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "Measure Linux disk and storage performance correctly: IOPS, throughput, latency, the %util trap on NVMe and multi-queue devices, iostat fields, fio benchmarking, and CSI/Kubernetes storage."
more_link: "yes"
url: "/measuring-linux-performance-disk-storage/"
---

Storage is where most Linux performance investigations go wrong, and they go wrong in a predictable way. An engineer opens `iostat`, sees a device reporting `%util` at 99 percent, declares the disk saturated, and files a ticket to buy faster hardware. On a single spinning disk in 2005 that reasoning was sound. On an NVMe drive, a RAID array, an iSCSI LUN, or a cloud block volume in 2032, it is almost always wrong. The number that drove the decision does not mean what the engineer thought it meant.

This is the third post in a five-part series on measuring Linux performance without fooling yourself. It focuses on disk and storage: how to read `iostat` correctly, why `%util` is the single most misinterpreted metric in the toolkit, how to separate IOPS from throughput from latency, how to benchmark honestly with `fio`, and how all of this changes when your storage lives behind a CSI driver in Kubernetes.

<!--more-->

## This Series

Measuring Linux performance is a discipline, and each subsystem has its own traps. This series walks through them one at a time:

- [Measuring Linux Performance: CPU](/measuring-linux-performance-cpu/)
- [Measuring Linux Performance: Memory](/measuring-linux-performance-memory/)
- **Measuring Linux Performance: Disk and Storage (this post)**
- [Measuring Linux Performance: Network](/measuring-linux-performance-network/)
- [Measuring Linux Performance: Recap and Common Mistakes](/measuring-linux-performance-recap-common-mistakes/)

## Three Numbers That Are Not Interchangeable

Before any tool, fix the vocabulary. Storage performance is described by three independent quantities, and conflating them is the root cause of most bad capacity decisions.

**IOPS** (I/O operations per second) counts discrete requests regardless of their size. A workload doing four-kilobyte random reads is measured in IOPS. Databases, message queues, and metadata-heavy filesystems live and die by IOPS.

**Throughput** (or bandwidth) measures bytes moved per second, typically in MB/s or GB/s. A backup job streaming a large file or a video pipeline is a throughput workload. The same device can be IOPS-bound or throughput-bound depending entirely on the access pattern.

**Latency** is how long a single request takes to complete, measured in milliseconds or microseconds. Latency is what a *user* actually feels. A device can deliver enormous IOPS and throughput while individual requests are slow, because it achieves those aggregate numbers through deep parallelism.

These are independent. A SATA SSD will plateau around 500-550 MB/s of throughput not because the flash is slow but because the SATA bus tops out there; that same drive may still deliver tens of thousands of IOPS. An NVMe drive may push millions of IOPS at four kilobytes yet saturate its PCIe lanes long before that on large sequential transfers. Always state which of the three you are measuring before you draw a conclusion.

A useful sanity identity ties them together:

```text
throughput (bytes/s) = IOPS x average_request_size (bytes)
```

If someone quotes "the disk does 1 GB/s" without a block size, the number is meaningless. One gigabyte per second at 4 KB blocks is roughly 244,000 IOPS; at 1 MB blocks it is fewer than 1,000 IOPS. The hardware demands are not remotely comparable: the first is a metadata-storm workload that hammers the device's command-processing path, the second is a streaming workload that barely touches it.

### Worked Example: The Same Volume, Three Verdicts

Consider a single cloud block volume provisioned for 16,000 IOPS and 500 MB/s, attached to a database node. Three teams measure it on the same afternoon and reach three different conclusions, all technically correct and all incomplete.

The OLTP team runs the transactional workload: 4 KB random reads and writes. They observe roughly 15,800 IOPS and `r_await` creeping from 0.7 ms to 4 ms. At 4 KB, 16,000 IOPS is only `16000 x 4096 = 65.5 MB/s`, nowhere near the 500 MB/s throughput cap. They are **IOPS-bound** and the fix is more provisioned IOPS.

The analytics team runs a large sequential scan: 1 MB reads. They observe roughly 480 MB/s and only about 480 IOPS. They are nowhere near the IOPS cap but pinned against the **throughput** ceiling. Buying more IOPS would do nothing; they need more provisioned bandwidth or a different volume type.

The reporting team runs a nightly `fsync`-heavy export: small writes that each force durability. They observe a few hundred IOPS, trivial throughput, and `w_await` of 8 ms. They are neither IOPS- nor throughput-bound; they are **latency-bound** by the per-operation round trip to the network-backed volume. The fix is batching writes or a lower-latency volume class, not more of either ceiling.

Three workloads, one device, three different bottlenecks and three different remedies. This is why "the disk is slow" is never an actionable statement until you have decided which of the three numbers is the one that ran out.

## Reading iostat Without Lying to Yourself

`iostat` from the `sysstat` package is the default first look at block-device activity. Run it with extended statistics, a device filter, and an interval so you see steady-state behavior rather than the misleading average-since-boot first sample.

```bash
# -x extended stats, -d device report, -m output in MB/s,
# 2-second interval, 3 samples. The FIRST sample is the
# average since boot and should be ignored.
iostat -xdm 2 3
```

A representative second sample for a busy NVMe device looks like this:

```text
Device   r/s     w/s     rMB/s   wMB/s  rrqm/s wrqm/s %rrqm %wrqm \
nvme0n1  4821.0  1290.5  18.83   37.41  0.00   142.0  0.00  9.92

  r_await w_await aqu-sz rareq-sz wareq-sz svctm  %util
  0.18    0.94    4.31   4.00     29.68    0.00   97.6
```

Every field, read left to right, because skipping any of them is how people end up trusting `%util` alone:

- **`r/s` and `w/s`** are read and write IOPS, *after* merging. Here the device is doing about 6,100 completed operations per second combined.
- **`rMB/s` and `wMB/s`** are throughput. Reads average 4 KB (`rareq-sz`), writes average ~30 KB (`wareq-sz`) because adjacent writes were merged.
- **`rrqm/s` and `wrqm/s`** are requests merged per second *before* hitting the device. The 142 merges/s on writes is why `w/s` is lower than the application's raw write rate: the I/O scheduler coalesced adjacent requests.
- **`%rrqm` and `%wrqm`** are the percentage of requests that were merged. The 9.92 percent write-merge rate tells you the workload has spatial locality the scheduler can exploit; a number near zero means purely random I/O with no merge opportunity, which is harder on the device.
- **`r_await` and `w_await`** are the average time, in milliseconds, each read or write spent in the system *including queue time plus device service time*. This is the latency number that matters. Reads complete in 0.18 ms, writes in 0.94 ms; both are excellent for NVMe.
- **`aqu-sz`** (average queue size, older name `avgqu-sz`) is the mean number of requests outstanding over the interval, computed as the time-integral of the queue length. It is the single best concurrency signal `iostat` gives you. At 4.31 the device is doing real parallel work but is nowhere near the depth a modern NVMe drive can absorb.
- **`rareq-sz` and `wareq-sz`** are the average request size in kilobytes for reads and writes. These let you reconstruct the access pattern: 4 KB reads scream "random small-block," 128 KB+ requests indicate sequential streaming. They are also the `request_size` term in the throughput identity above.
- **`svctm`** is the deprecated service-time estimate, reporting `0.00` here (covered below).
- **`%util`** is the percentage of wall-clock time during which at least one request was in flight.

The relationship between `aqu-sz`, `await`, and throughput is the heart of correct interpretation, and it follows Little's Law: `aqu-sz = (r/s + w/s) x average_await_in_seconds`. You can sanity-check `iostat` against itself with it. Here `(4821 + 1290.5) x ((0.18 + 0.94)/2 / 1000)` lands near the reported queue size once you weight by the read/write split. The practical use is directional: when `aqu-sz` rises but IOPS stop rising, `await` is climbing to compensate, which is the textbook signature of an approaching saturation point.

Notice what got the most attention historically: `%util` at 97.6 percent. And notice the latencies: sub-millisecond, with a shallow queue. This device is *not* in trouble. The next section explains why those two facts coexist.

For automated collection, emit JSON instead of parsing columns, which is far more robust in monitoring agents and breaks less across `sysstat` versions:

```bash
# JSON output for a single device, one sample. Pipe to jq or a
# metrics agent instead of scraping fixed-width columns.
iostat -xdmo JSON nvme0n1 1 1
```

```text
{"sysstat": {"hosts": [{"statistics": [{"disk": [
  {"disk_device": "nvme0n1", "r/s": 4821.0, "w/s": 1290.5,
   "rMB/s": 18.83, "wMB/s": 37.41, "r_await": 0.18,
   "w_await": 0.94, "aqu-sz": 4.31, "util": 97.6}
]}]}]}}
```

## The %util Trap

`%util` answers exactly one question: what fraction of the observation window had at least one I/O outstanding? For a single mechanical disk that could service one request at a time, that fraction was a fair proxy for saturation. If the disk was busy 100 percent of the time, it had no spare capacity, full stop.

Modern storage breaks the assumption that underpinned that proxy. An NVMe drive exposes **multiple hardware queues** (one or more per CPU) and can have hundreds or thousands of requests in flight simultaneously. A RAID array spreads I/O across many spindles or SSDs. A cloud block volume is a distributed system behind a network. For all of these, "at least one request was outstanding the entire interval" tells you the device was never *idle*. It tells you nothing about whether it was *saturated*.

A concrete illustration: imagine an NVMe drive that can comfortably sustain 500,000 IOPS. Send it a steady trickle of 2,000 IOPS, one request handed off the instant the previous completes. There is always exactly one request in flight, so `%util` reads 100 percent. The drive is running at 0.4 percent of its real capacity. The metric is not lying; it is answering a question nobody should be asking of this hardware.

What to use instead of `%util` on parallel storage:

1. **Latency (`r_await`, `w_await`).** Saturation shows up as latency climbing above the device's historic baseline. Know your baseline per device and per workload; "good" latency for a local NVMe drive (tens of microseconds) is wildly different from a network-backed cloud volume (single-digit to low double-digit milliseconds).
2. **Queue depth (`aqu-sz`).** Compare against the device's effective concurrency. When queue depth keeps rising while throughput stops rising, you have found the saturation point.
3. **The IOPS/throughput ceiling.** Compare measured `r/s + w/s` and `rMB/s + wMB/s` against the device's known limits (datasheet for local disks, the provisioned IOPS/throughput for a cloud volume).

For multi-queue (`blk-mq`) devices the kernel computes `%util` from a single aggregate busy-time counter, so it cannot exceed 100 percent even when dozens of queues are active in parallel. That is the mathematical reason the number caps out and stops being informative. Treat `%util` as a binary "is this device doing anything at all" indicator on anything newer than a single rotational disk, and never as a saturation gauge.

### Queue Depth and Parallelism Are the Real Capacity Story

The reason `%util` fails on modern hardware is the same reason understanding queue depth is essential: parallelism. A spinning disk has effectively one server (one set of heads), so the useful queue depth is one and `%util` was a fine saturation proxy. Modern storage is a parallel system with many servers, and its throughput rises with offered concurrency up to a point, then flattens.

You can see the device's structural parallelism in sysfs. The number of hardware submission queues and the per-queue request budget bound how much in-flight work the device can hold:

```bash
# How many hardware queues the multi-queue block layer set up,
# the per-queue depth, the scheduler, and the device's own
# advertised queue count. More queues = more achievable parallelism.
ls /sys/block/nvme0n1/mq/
cat /sys/block/nvme0n1/queue/nr_requests
cat /sys/block/nvme0n1/queue/scheduler
```

```text
0  1  2  3  4  5  6  7
1023
[none] mq-deadline
```

Eight directories under `mq/` means eight hardware queues; `[none]` as the active scheduler is normal and correct for fast NVMe, where the device firmware reorders better than the kernel can. The capacity question is therefore "how deep can I drive the queue before latency degrades," and that is a curve you discover by benchmarking, not a single number you read off a dashboard.

This is the bridge between measurement and `fio`: when you benchmark you sweep `iodepth` and watch where the IOPS curve bends and the latency curve takes off. That knee is the device's real operating ceiling. `%util` will read 100 percent across the entire sweep and tell you nothing about where the knee is.

### What Happened to svctm

Older `iostat` reported `svctm` (service time), an estimate of per-request service time excluding queueing. On modern multi-queue devices the kernel can no longer compute it meaningfully, so `iostat` reports `0.00` and the field is deprecated. Do not build alerts on `svctm`. Use `r_await` and `w_await`, which include the full request lifetime and are what the application experiences.

## Per-Process Attribution: Who Is Doing the I/O

`iostat` tells you a device is busy. It does not tell you *which process* is responsible. Three tools close that gap.

`iotop` gives a top-like live view, sorted by I/O. Run it in batch mode so the output is greppable and scriptable:

```bash
# -b batch mode, -o only show processes doing I/O,
# -P aggregate per-process (not per-thread),
# -d 2 refresh every 2 seconds, -n 3 stop after 3 iterations.
iotop -boP -d 2 -n 3
```

```text
Total DISK READ:  72.41 M/s | Total DISK WRITE:  18.02 M/s
Current DISK READ: 72.41 M/s | Current DISK WRITE: 17.88 M/s
    PID  PRIO  USER   DISK READ  DISK WRITE  COMMAND
   3471  be/4  postgres 61.20 M/s   2.11 M/s  postgres: parallel worker
   3398  be/4  postgres 11.21 M/s   0.04 M/s  postgres: checkpointer
   1029  be/4  root      0.00 B/s  15.87 M/s  [kworker/u16:2-flush]
```

The `[kworker/...-flush]` line is worth recognizing: it is the kernel writeback thread flushing dirty page cache to disk. Application writes often appear here, asynchronously, rather than against the process that issued them. That asymmetry is a frequent source of confusion when attributing write load.

`pidstat -d` from `sysstat` gives the same per-process accounting in a form that is easy to log over time:

```bash
# -d disk statistics, per-process, every 2 seconds, 3 samples.
pidstat -d 2 3
```

```text
07:42:10  UID    PID   kB_rd/s   kB_wr/s kB_ccwr/s iodelay  Command
07:42:12  999   3471  62668.00   2160.00      0.00      11  postgres
07:42:12  999   3398  11480.00     40.00      0.00       3  postgres
07:42:12    0   1029      0.00  16252.00      0.00       0  kworker
```

The `iodelay` column is underused gold: it is the time (in clock ticks) the task spent blocked waiting on I/O. A process with high `iodelay` is stalling on storage even if its raw byte rates look modest, which points at a latency problem rather than a bandwidth problem.

For historical analysis, `sar -d` reads the archived `sysstat` data so you can answer "what did the disk look like at 3 AM last Tuesday" without having been logged in:

```bash
# -d block-device activity, -p human-readable names,
# from the archive for the given day (sa12 = the 12th).
sar -d -p -f /var/log/sysstat/sa12
```

This is the foundation of after-the-fact incident analysis: if `sysstat` collection is enabled (the `sa1`/`sa2` cron jobs), you already have a per-device history of `await` and `%util` that long predates the page that woke you up.

## Pressure Stall Information: Is I/O Hurting Anyone

Per-device counters describe the hardware. **Pressure Stall Information (PSI)**, exposed under `/proc/pressure/`, describes the *impact* on work: how much time tasks lost because they were stalled waiting on a resource. For storage, read `/proc/pressure/io`.

```bash
cat /proc/pressure/io
```

```text
some avg10=18.42 avg60=12.07 avg300=4.31 total=99213847
full avg10=11.90 avg60=7.84  avg300=2.55 total=61204417
```

The `some` line is the share of time at least one task was stalled on I/O; the `full` line is the share of time *every* runnable task was stalled, meaning no useful work happened at all. The `avg10`/`avg60`/`avg300` values are percentages over the trailing 10, 60, and 300 seconds.

PSI reframes the question from "is the disk busy" to "is the disk *causing pain*." A device at 100 percent `%util` with `io` pressure near zero is busy but harmless. A device with rising `full` pressure is actively starving the system regardless of what `%util` says. On Kubernetes nodes this is one of the most honest top-level signals you can scrape, and the kubelet uses the same mechanism for resource-pressure eviction decisions.

## Caching Will Fool Your Benchmark

The single biggest reason a storage benchmark produces a number you cannot reproduce in production is the **page cache**. Linux aggressively caches file data in RAM. A read that hits the page cache never touches the disk and completes in nanoseconds; a read that misses pays the full device latency. Reads that are served from cache and writes that are merely buffered (not yet flushed) make a slow disk look fast.

Three consequences follow:

- **A repeated read of the same file is measuring RAM, not storage.** Run a benchmark twice and the second run is faster purely because of cache warming.
- **Buffered writes return before data is durable.** A write `returns` when it lands in the page cache; the actual disk write happens later via writeback. To measure durable write performance you must force `fsync`/`O_DIRECT`.
- **`free -h` and the device counters disagree on purpose.** The application "wrote 1 GB" but `iostat` shows far less, because writeback is still draining dirty pages to disk.

To measure the disk and not the cache, drop caches before a read test (on a non-production host) and use direct or synchronous I/O for writes:

```bash
# Flush dirty pages, then drop page cache, dentries, and inodes.
# Do this ONLY on test systems; it evicts everyone's cached data.
sync
echo 3 > /proc/sys/vm/drop_caches
```

The cleaner approach is to bypass the cache at the I/O layer using `fio` with `direct=1`, which is exactly what the next section does.

### Writeback Is Why Your Write Spike Arrives Late

The page cache does not only inflate read benchmarks; it reshapes *when* write load hits the disk, which routinely confuses incident timelines. An application can write a burst of data, return immediately because the data only reached dirty page cache, and the actual device write storm can arrive seconds later when the kernel's writeback machinery flushes. The `iostat` spike and the application log entry that caused it can be tens of seconds apart.

The behavior is governed by the dirty-page tunables, and knowing them explains the lag:

```bash
# How much dirty page cache the kernel tolerates before forcing
# writeback. Ratios are percent of RAM; *_bytes (if set) override.
sysctl vm.dirty_ratio vm.dirty_background_ratio \
       vm.dirty_expire_centisecs vm.dirty_writeback_centisecs
```

```text
vm.dirty_ratio = 20
vm.dirty_background_ratio = 10
vm.dirty_expire_centisecs = 3000
vm.dirty_writeback_centisecs = 500
```

`dirty_background_ratio` is the level at which the kernel *begins* flushing in the background; `dirty_ratio` is the hard ceiling at which writing processes are *blocked* until flushing catches up. On a host with a lot of RAM, the default percentages allow a very large pool of dirty pages, so a write-heavy job can run for a while with almost no device activity and then trigger a sudden, large writeback that looks like an unexplained I/O spike with no concurrent application cause. When you investigate, watch the dirty-page total directly:

```bash
# Live view of dirty and writeback pages, in kB. A large, growing
# Dirty value means a writeback spike is queued and coming.
grep -E '^(Dirty|Writeback):' /proc/meminfo
```

This is why the `[kworker/...-flush]` thread shows up in `iotop` owning writes the application "finished" long ago, and why correlating a device spike with the workload requires looking at the dirty-page pipeline, not just the instantaneous process I/O.

## Benchmarking Honestly with fio

`fio` (Flexible I/O Tester) is the standard for storage benchmarking because it lets you describe the *exact* workload you care about: block size, read/write mix, queue depth, sync semantics, and whether the cache is bypassed. The mistake to avoid is benchmarking a workload that does not resemble your application and then being surprised when production behaves differently.

Define jobs in a file rather than a long command line so the test is reproducible and reviewable:

```ini
; random-read-4k.fio - models a latency-sensitive OLTP read workload
[global]
ioengine=libaio      ; asynchronous I/O via Linux AIO
direct=1             ; bypass the page cache - measure the device
runtime=60           ; run for 60 seconds
time_based           ; honor runtime even if the file is fully read
group_reporting      ; aggregate stats across all jobs
filename=/mnt/data/fio-testfile
size=4G              ; working set; keep it larger than RAM cache

[randread-4k]
rw=randread          ; random reads
bs=4k                ; 4 KB blocks - the classic IOPS test
iodepth=32           ; 32 requests in flight (matters for NVMe)
numjobs=4            ; 4 parallel workers
```

Run it and read the result:

```bash
fio random-read-4k.fio
```

The summary that matters:

```text
randread-4k: (groupid=0, jobs=4): err= 0: pid=8123:
  read: IOPS=386k, BW=1509MiB/s (1583MB/s)(88.4GiB/60001msec)
    slat (nsec): min=1100, max=98201, avg=2884.10
    clat (usec): min=42, max=4821, avg=327.41, stdev=88.62
     lat (usec): min=45, max=4830, avg=330.29, stdev=88.71
    clat percentiles (usec):
     | 50.00th=[  318], 95.00th=[  453], 99.00th=[  586],
     | 99.90th=[  791], 99.99th=[ 1287]
```

Read it like this:

- **`IOPS=386k` and `BW=1509MiB/s`** are the headline throughput numbers, but they are aggregates and the least interesting part.
- **`clat`** (completion latency) is the time from submission to completion. The *average* of 327 us is fine, but averages hide tail behavior.
- **The percentiles are the point.** The p50 is 318 us, p99 is 586 us, p99.99 is 1287 us. The tail latency is what causes user-visible stalls and timeouts. A device with a great average but a long tail will produce intermittent, hard-to-diagnose latency spikes. Always report and alert on p99/p99.9, never on the mean.

For a write test that reflects database durability, change the engine and add `fsync`:

```ini
; sync-write-fsync.fio - models durable, fsync-heavy writes
[global]
ioengine=libaio
direct=1
runtime=60
time_based
group_reporting
filename=/mnt/data/fio-testfile
size=4G

[randwrite-sync]
rw=randwrite
bs=8k                ; many databases use 8 KB pages
iodepth=1            ; durability-bound workloads are often serial
fsync=1              ; fsync after every write - measure durability
```

A common and expensive mistake is benchmarking with `direct=0` (cached) or without `fsync`, getting a beautiful number, provisioning hardware against it, and then watching production fall over because the real workload forces durability the benchmark never did.

### Warm Up Before You Measure

Two things make the first seconds of any storage benchmark unrepresentative, and skipping a warmup is the most common reason two engineers running "the same test" get different numbers.

First, SSDs and especially cloud volumes have an initialization or "first write" penalty: a freshly provisioned cloud volume often must lazily fetch or zero blocks on first access, so cold reads are dramatically slower than steady-state. Second, the device's internal caches, the host's queues, and any provisioned-burst credits all need to reach equilibrium. Measuring through that transient pollutes the result.

`fio` solves this with `ramp_time`, which runs the workload for a warmup period whose statistics are discarded, then begins the measured window:

```ini
; iodepth-sweep.fio - find the latency/throughput knee with a warmup
[global]
ioengine=libaio      ; asynchronous submission so iodepth is real
direct=1             ; bypass the page cache
runtime=60           ; measured window, per job
ramp_time=15         ; warmup discarded from the stats - critical
time_based
group_reporting
filename=/mnt/data/fio-testfile
size=8G              ; larger than RAM so reads cannot all cache

[qd1]
rw=randread
bs=4k
iodepth=1            ; serial - measures pure per-request latency

[qd8]
rw=randread
bs=4k
iodepth=8            ; moderate concurrency

[qd32]
rw=randread
bs=4k
iodepth=32           ; deep queue - find where IOPS stops scaling
```

Running these three jobs and plotting IOPS against `iodepth` reveals the knee directly. If IOPS roughly triples from `qd1` to `qd8` but barely moves from `qd8` to `qd32` while p99 latency doubles, the device's useful operating point is around queue depth 8 for this block size. That is the number you size production concurrency against, and it is invisible to `%util`.

### Sequential Throughput Recipe

The 4 KB random test answers the IOPS question. A separate, deliberately different job answers the throughput question, because a device that is excellent at one can be mediocre at the other:

```ini
; seq-read-throughput.fio - models a backup or analytics scan
[global]
ioengine=libaio
direct=1
runtime=60
ramp_time=10
time_based
group_reporting
filename=/mnt/data/fio-testfile
size=16G             ; large enough to sustain a long sequential run

[seqread-1m]
rw=read              ; sequential reads
bs=1M                ; large blocks - this is a bandwidth test
iodepth=8            ; modest depth is enough to saturate bandwidth
numjobs=1            ; one streaming reader, like a real scan
```

Reporting both the random-4K result and the sequential-1M result, side by side, is the honest way to characterize a device. A single headline number always hides one of the two.

### Reproducibility Checklist

For a `fio` result to be trustworthy and comparable, pin down the variables that silently change the answer:

- **`direct=1`** unless you are deliberately measuring the cache. Cached results are not device results.
- **`size` larger than RAM** for read tests, or the page cache absorbs the working set and you measure memory.
- **`ramp_time`** long enough to clear the cold-start transient, especially on cloud volumes.
- **The same filesystem and mount options** production uses, on the same device class.
- **State the block size, queue depth, and read/write mix** with every number. A bare "200k IOPS" is uncomparable.
- **Report p99/p99.9**, not just the mean, because that is what governs user-visible behavior.

You can run any of these as a self-contained command instead of a file when iterating quickly, which is convenient but harder to review and version:

```bash
# The qd32 random-read job expressed inline. A jobfile is preferable
# for anything you intend to keep, compare, or commit to a repo.
fio --name=randread-qd32 --ioengine=libaio --direct=1 --bs=4k \
    --iodepth=32 --numjobs=4 --rw=randread --runtime=60 \
    --ramp_time=15 --time_based --group_reporting --size=8G \
    --filename=/mnt/data/fio-testfile
```

## Going Deeper: blktrace and biolatency

When summary statistics are not enough, two tools expose the block layer directly.

`blktrace` records every event in the block I/O path (queue, merge, dispatch, complete) and `blkparse` renders it. This is how you investigate odd merging behavior, scheduler decisions, or requests that vanish for milliseconds:

```bash
# Trace nvme0n1 to a file, then parse it. Ctrl-C to stop tracing.
blktrace -d /dev/nvme0n1 -o trace
blkparse -i trace -o parsed.txt
```

For latency *distribution* without the per-event volume of `blktrace`, the eBPF tool `biolatency` (from `bcc-tools` or `bpftrace`) prints a histogram of block I/O completion times with negligible overhead:

```bash
# Sample for 10 seconds, then print one histogram.
biolatency 10 1
```

```text
     usecs               : count     distribution
         0 -> 1          : 0        |                              |
         2 -> 3          : 0        |                              |
        16 -> 31         : 142      |***                           |
        32 -> 63         : 1893     |****************************  |
        64 -> 127        : 1204     |******************            |
       128 -> 255        : 318      |****                          |
       256 -> 511        : 41       |                              |
       512 -> 1023       : 9        |                              |
      1024 -> 2047       : 3        |                              |
```

A histogram is strictly more informative than an average. A bimodal distribution, two clusters of latency, often reveals a cache-hit population and a cache-miss population, or a healthy path and a path that occasionally hits a slow backing store. An average would smear those two realities into one misleading middle number.

`biolatency` has flags that turn it from a curiosity into a diagnostic. Split the histogram per device and by operation flag so you can see, for example, that writes are bimodal while reads are tight:

```bash
# -D one histogram per disk, -F split by I/O flag (read/write/sync),
# -m milliseconds. Sample 5 seconds. Pinpoints which device and
# which operation type owns the slow tail.
biolatency -D -F -m 5 1
```

When a histogram shows a slow tail but you need the offending *request* (which sector, which process, how long), `biosnoop` traces individual block I/Os with their issuing PID and completion latency:

```bash
# Per-I/O trace: timestamp, process, device, sector, bytes, latency.
# Run briefly during an incident, then grep for the slow lines.
biosnoop
```

```text
TIME(s)   COMM         PID    DISK    T SECTOR     BYTES  LAT(ms)
0.000000  postgres     3471   nvme0n1 R 8419328    8192     0.21
0.004113  postgres     3471   nvme0n1 R 8421376    8192     0.19
0.009882  kworker/u16  1029   nvme0n1 W 1048576    131072  14.87
```

That 14.87 ms write, against sub-millisecond reads, is exactly the kind of outlier a histogram tells you *exists* and `biosnoop` tells you *who and where*. Pairing the two, distribution first to confirm there is a tail, then per-I/O trace to attribute it, is the most efficient deep-dive path the modern toolkit offers, and the eBPF overhead is low enough to run on production nodes briefly.

## When the Device Itself Is the Problem

Performance work assumes healthy hardware, but a degrading device produces exactly the symptom this post is about: rising latency that no workload change explains. Before provisioning around a latency regression, rule out a dying drive. For NVMe, the health log is authoritative:

```bash
# SMART/health log for an NVMe device. Watch media_errors,
# percentage_used (wear), and especially critical_warning.
nvme smart-log /dev/nvme0n1
```

```text
critical_warning      : 0
temperature           : 41 C
percentage_used       : 7%
data_units_written    : 1,204,318
media_errors          : 0
num_err_log_entries   : 0
```

A non-zero `critical_warning`, climbing `media_errors`, or a drive at high `percentage_used` (wear-leveling exhaustion) all manifest as latency that looks like a software problem until you check. SATA and SAS devices expose the same information through `smartctl -a /dev/sdX`. On cloud volumes you usually cannot read SMART, which is itself a reason to lean harder on provisioned-cap analysis and the provider's own device-health signals. The rule is simple: a latency regression with no workload change and no provisioning cap in sight should send you to the device health log before the capacity-planning spreadsheet.

## Storage in Kubernetes

Everything above applies to a bare node, but in Kubernetes the storage a pod sees is rarely the storage the kernel sees, and that indirection introduces its own measurement traps.

### Find the Real Device Behind the Volume

A pod mounts a **PersistentVolume** provisioned by a **CSI** driver. Depending on the driver that volume might be a local disk, an LVM logical volume, an iSCSI LUN, an NFS export, or a cloud block device attached over the network. The first job is to follow the chain from the pod's mount down to the kernel block device so you know what you are actually measuring.

```bash
# From inside the pod or on the node, find what backs the mount.
findmnt /var/lib/postgresql/data
```

```text
TARGET                      SOURCE                                          FSTYPE OPTIONS
/var/lib/postgresql/data    /dev/nvme2n1[/pvc-8f3a...]                       ext4   rw,relatime
```

Once you have the device, run `iostat -xdm` against it on the node exactly as you would on bare metal. The device-level numbers are real; the trap is interpreting them without knowing whether `nvme2n1` is a local SSD (microsecond latency) or a network-attached cloud volume (millisecond latency that includes a network round trip).

The chain is often longer than one hop. CSI drivers that use LVM, dm-crypt, or multipath insert device-mapper layers between the filesystem and the physical device, and `iostat` reports each layer separately. A `dm-7` showing high `await` may simply be inheriting latency from the `nvme2n1` beneath it, so you must resolve the full stack before deciding where the latency is introduced:

```bash
# Walk the device-mapper tree, then resolve a specific dm device
# down to its physical backing devices. -s shows the dependency
# chain (inverse of the default parent->child view).
dmsetup ls --tree
lsblk -s /dev/dm-7
```

```text
crypt-pvc-8f3a (253:7)
 └─vg_data-pool (253:3)
    └─ (259:2)        # nvme2n1

NAME        MAJ:MIN RM SIZE RO TYPE  MOUNTPOINT
dm-7        253:7    0  50G  0 crypt
└─dm-3      253:3    0 200G  0 lvm
  └─nvme2n1 259:2    0 1.8T  0 disk
```

Now you know an encrypted LVM volume sits on a local NVMe disk. If `dm-7` (the crypt layer) shows higher `await` than `nvme2n1`, the cost is in encryption, not the disk. Measuring the wrong layer here sends teams chasing a hardware problem that is actually a CPU-bound `dm-crypt` bottleneck.

### Provisioned Limits Are the Saturation Point

Cloud block storage is provisioned with explicit IOPS and throughput ceilings, and many providers also throttle by volume size. A volume can hit its provisioned IOPS limit while the underlying media has plenty of headroom; the throttle is enforced in the virtualization layer, not the disk. On such a volume the meaningful saturation test is not `%util` or even latency in isolation, it is "are we hitting the provisioned IOPS/throughput cap?" Compare measured `r/s + w/s` against the number you paid for. When you hit the cap, latency rises because requests queue behind the throttle, which can look exactly like a hardware problem but is fixed by provisioning more, not by buying faster.

### Noisy Neighbors

Multiple pods on the same node share the node's I/O bandwidth and, for local storage, the same physical device. A batch job doing heavy sequential writes can starve a latency-sensitive database pod sharing the disk, a classic **noisy neighbor** problem. Symptoms: a pod's `r_await`/`w_await` climbs without any change to its own workload, and PSI `io` pressure on the node rises.

The kernel can arbitrate this with the **io** cgroup v2 controller, and Kubernetes increasingly exposes it. You can confirm whether limits are in force by reading the cgroup directly on the node:

```bash
# Inspect the io controller for a pod's cgroup (cgroup v2).
# max means unlimited; numbers are per-device rbps/wbps/riops/wiops.
cat /sys/fs/cgroup/kubepods.slice/.../io.max
```

```text
259:0 rbps=max wbps=52428800 riops=max wiops=2000
```

If the line shows `max` across the board, that pod has no I/O limit and is free to monopolize the device. For latency-sensitive workloads on shared local storage, set explicit `io.max` limits (via the container runtime or a node-level policy) or, better, schedule those workloads onto dedicated nodes or dedicated volumes.

For attribution that is already grouped per pod, read `io.stat` from each pod's cgroup instead of summing PIDs by hand. cgroup v2 accounts every byte and every operation a pod issued, broken out per device, which is the cleanest per-pod I/O accounting the node offers:

```bash
# Per-device I/O accounting for one pod's cgroup (cgroup v2).
# rbytes/wbytes are cumulative bytes; rios/wios are operation counts.
cat /sys/fs/cgroup/kubepods.slice/kubepods-besteffort.slice/\
kubepods-besteffort-pod<UID>.slice/io.stat
```

```text
259:2 rbytes=104857600 wbytes=8388608 rios=25600 wios=1024 \
      dbytes=0 dios=0
```

Sampling `io.stat` twice a few seconds apart and differencing gives you per-pod IOPS and throughput on device `259:2` directly, with no thread-level guessing. To go the other direction, from a noisy PID back to its pod, read the process's cgroup membership and match the pod UID:

```bash
# Map every postgres PID to the cgroup (and therefore pod) it
# belongs to, so a noisy PID from iotop/pidstat resolves to a pod.
for pid in $(pgrep -f postgres); do
  echo "PID $pid -> $(cat /proc/"$pid"/cgroup)"
done
```

Per-pod attribution at the node level still uses `iotop -boP` and `pidstat -d` for the live per-process view, but `io.stat` plus the cgroup mapping is what turns "some process is hammering the disk" into "the analytics pod in namespace `reporting` is hammering the disk," which is the statement an on-call engineer can actually act on.

### Filesystem and Mount Options Still Matter

The CSI driver hands you a block device; the filesystem on top of it is still yours to tune. The journaling mode (`data=ordered` vs `data=writeback` on ext4), `relatime` vs `noatime`, and the discard/`fstrim` strategy all affect measured I/O. A volume that mysteriously does more writes than the application issued is often paying for `atime` updates or aggressive journaling. Measure with the same mount options production uses, never with defaults you would not ship.

## A Repeatable Investigation Procedure

When storage is suspected, work top-down so you do not jump to the disk before confirming the disk is even involved:

1. **Confirm impact with PSI.** `cat /proc/pressure/io`. If `full` pressure is low, storage is probably not the bottleneck no matter how busy a device looks.
2. **Find the busy device.** `iostat -xdm 2`. Read `r/s`, `w/s`, `rMB/s`, `wMB/s`, and especially `r_await`/`w_await`. Ignore `%util` as a saturation signal.
3. **Classify the workload.** Is latency high, IOPS at a ceiling, or throughput at a ceiling? The three demand different fixes.
4. **Attribute it.** `iotop -boP` or `pidstat -d` to find the responsible process, then map to a pod in Kubernetes.
5. **Check the ceiling.** Compare against datasheet limits (local) or provisioned IOPS/throughput (cloud). Confirm you are not simply hitting a paid-for cap.
6. **Rule out the hardware.** If latency rose with no workload or provisioning change, read the device health log (`nvme smart-log` or `smartctl -a`) before planning capacity.
7. **Look at the distribution if needed.** `biolatency -D -F` for a per-device latency histogram, `biosnoop` to attribute the slow tail to a PID and sector, `blktrace` for full per-request forensics.
8. **Reproduce in isolation.** Model the workload with `fio` using `direct=1`, a `ramp_time` warmup, and the right `fsync`/`iodepth`, and verify the fix moves the p99, not just the average.

## Conclusion

Storage performance measurement fails when a single number is trusted out of context, and `%util` is the number that fails most often. Reading the disk correctly is mostly about asking the right question of the right metric.

Key takeaways:

- **IOPS, throughput, and latency are independent.** State which you are measuring and always pair a byte rate with a block size, because `throughput = IOPS x request_size`.
- **`%util` is not saturation on modern storage.** On NVMe, RAID, network, and multi-queue (`blk-mq`) devices it caps at 100 percent and only tells you the device was not idle. Use latency (`r_await`/`w_await`), queue depth (`aqu-sz`), and the device's known ceiling instead.
- **`svctm` is deprecated.** It reports `0.00` on multi-queue devices; rely on `await` values that include queue time.
- **Caching will lie to your benchmark.** Use `fio` with `direct=1` and the correct `fsync` semantics, and drop caches only on test hosts. A repeated read measures RAM, not the disk.
- **Tail latency is the truth.** Report p99/p99.9 from `fio` and `biolatency` histograms; averages hide the spikes users feel.
- **Queue depth, not `%util`, reveals capacity.** Sweep `iodepth` in `fio` and find the knee where IOPS stops scaling and latency takes off; that knee is the device's real operating ceiling, and `aqu-sz` in `iostat` is your live read on it.
- **Warm up every benchmark.** Use `ramp_time` to discard the cold-start transient, and keep the working set larger than RAM, or you measure cache and burst credits instead of the device.
- **Writeback delays the write spike.** Buffered writes hit the disk seconds after the application "finished" via `[kworker/...-flush]`; correlate device spikes with `/proc/meminfo` dirty pages and the `vm.dirty_*` tunables, not just instantaneous process I/O.
- **PSI (`/proc/pressure/io`) measures pain, not activity.** A busy device with low `io` pressure is harmless; rising `full` pressure is real harm.
- **Rule out a dying device.** A latency regression with no workload or provisioning change belongs in `nvme smart-log`/`smartctl` before the capacity spreadsheet.
- **In Kubernetes, follow the whole chain.** Trace the PV through any device-mapper layers (`findmnt`, `dmsetup ls --tree`, `lsblk -s`) to the real block device, interpret latency against whether it is local or network-backed, watch for provisioned-cap throttling, attribute load per pod with cgroup `io.stat`, and contain noisy neighbors with the `io` cgroup controller or dedicated volumes.

The next post in the series turns to the network, where, much like storage, the obvious metric (bandwidth utilization) is rarely the one that explains the latency your users are complaining about.

### Related posts in this series

- [Measuring Linux Performance: CPU](/measuring-linux-performance-cpu/)
- [Measuring Linux Performance: Memory](/measuring-linux-performance-memory/)
- [Measuring Linux Performance: Disk and Storage (this post)](/measuring-linux-performance-disk-storage/)
- [Measuring Linux Performance: Network](/measuring-linux-performance-network/)
- [Measuring Linux Performance: Recap and Common Mistakes](/measuring-linux-performance-recap-common-mistakes/)
