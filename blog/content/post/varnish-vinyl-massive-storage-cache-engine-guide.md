---
title: "Varnish Vinyl: Building a Massive, Persistent Cache Tier Beyond the RAM Wall"
date: 2032-04-25T09:00:00-05:00
draft: false
tags: ["Varnish", "Vinyl", "Caching", "Performance", "Storage", "HTTP", "DevOps", "Kubernetes", "SRE", "System Administration", "Linux", "Edge"]
categories:
- Caching
- Performance
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to large-scale Varnish caching with the Vinyl persistent storage engine: how it differs from malloc, file, and MSE, plus sizing, eviction, warmup, and varnishstat monitoring."
more_link: "yes"
url: "/varnish-vinyl-massive-storage-cache-engine-guide/"
---

The default Varnish cache lives entirely in RAM. That is a feature when your hot set fits in memory and a hard ceiling the moment it does not. A media catalog, a multi-tenant SaaS asset library, or a status-page fleet absorbing a traffic spike can easily want a working set measured in hundreds of gigabytes or several terabytes. Buying that much RAM per node is expensive, and the cache evaporates on every restart. The **Vinyl storage engine** changes the economics: it backs the object store with disk, survives clean restarts, and lets a single node hold far more than its memory budget. This guide covers when to reach for Vinyl, how it compares to `malloc`, the legacy `file` backend, and the older Massive Storage Engine, and how to size, tier, warm, and monitor it in production in front of Kubernetes-hosted applications.

<!--more-->

## The RAM Wall and Why It Matters

Varnish's default storage backend is **malloc**, an in-process arena allocated from anonymous memory. It is fast, simple, and the right choice for the common case where your cacheable working set is a few gigabytes. The trade-off is built into the name: every cached object competes for the same pool of process memory, and that pool is bounded by the RAM you are willing to dedicate to the cache.

Two limits emerge from that design, and both show up at scale.

The first is **capacity**. If you tell Varnish `-s malloc,16g` but your origin serves 400 GB of cacheable assets that are accessed across a long tail, Varnish can only ever hold 16 GB at a time. Everything else is a miss that falls through to the origin. As your catalog grows, your hit ratio quietly erodes, and the origin and its database take load that the cache was supposed to absorb. You can buy more RAM, but RAM is the most expensive byte in the rack, and you eventually hit per-socket and per-board limits.

The second is **durability**. malloc storage is anonymous memory. A process restart, a deploy, an OOM kill, or a node reboot wipes it. A cold cache means a **thundering herd** against your origin while the cache refills, precisely when the system is already stressed (a deploy window, a failover, an autoscaling event). For a 16 GB cache that warms in seconds this is a non-event. For a multi-terabyte cache, a cold start can take hours and may overwhelm the backend before the cache is useful again.

Vinyl addresses both: capacity by spilling to disk, and durability by persisting the index and objects across clean restarts.

## A Short History of Varnish Storage Backends

It helps to understand the lineage, because each backend was a response to the limits of the one before it.

**malloc** was the original and remains the default. Objects live in process memory; the operating system never sees them as files. It is the fastest backend per request and the simplest to reason about, and it is still the correct answer whenever the working set fits comfortably in RAM with headroom for transient allocations.

**file** was the first attempt at "cache larger than RAM." It `mmap`s a single large file and uses it as the object arena. The important and frequently misunderstood detail is that the `file` backend is **not persistent**: the contents are meaningless after a restart, and Varnish does not attempt to reattach to them. Worse, its real performance is governed entirely by the kernel page cache. Under memory pressure the kernel evicts pages unpredictably, and the backend is prone to fragmentation over long uptimes. The `file` backend is best treated as legacy. It exists, it works, and it will disappoint you in production.

**MSE**, the Massive Storage Engine, was Varnish Software's commercial answer for petabyte-class, persistent caching. It introduced the concepts that matter at scale: a separate index ("book") kept apart from the bulk object data ("store"), real persistence across restarts, and fine-grained control over how disk regions are laid out. MSE proved the model but lived behind the enterprise license.

**Vinyl** is the modern persistent, disk-backed storage engine that brings the MSE design principles to a broader audience. It keeps a compact index that maps cached objects to their location in a large data file, persists both across clean restarts, and is built to hold datasets far larger than node memory while keeping the hot path fast. If you previously evaluated MSE or hit the `file` backend's limits, Vinyl is the backend to standardize on.

The table below summarizes the practical differences.

| Backend | Persistent | Larger than RAM | Index location | Typical use |
| --- | --- | --- | --- | --- |
| `malloc` | No | No | In RAM | Default; hot set fits in memory |
| `file` | No | Yes (page-cache bound) | In RAM | Legacy; avoid for new deployments |
| MSE | Yes | Yes (petabyte class) | Separate book file | Commercial enterprise tier |
| `vinyl` | Yes | Yes | Separate book file | Modern large, persistent caches |

The summary table is the thirty-second version. The decision in practice turns on the trade-offs each backend forces, and those are worth spelling out before you commit a fleet to one of them.

| Dimension | `malloc` | `file` | `vinyl` / MSE |
| --- | --- | --- | --- |
| Per-hit latency | Microseconds (RAM) | Variable (page cache) | Sub-millisecond (NVMe), RAM speed for hot pages |
| Capacity ceiling | Node RAM | Disk size, page-cache bound | Disk size |
| Restart behavior | Always cold | Always cold | Warm after clean shutdown |
| Index overhead | Folded into the arena | In RAM | Separate, sized book file |
| Failure under pressure | Predictable LRU eviction | Unpredictable page eviction, fragmentation | LRU over disk regions |
| Operational complexity | Lowest | Low but deceptive | Higher: two files, sizing discipline |
| Cost per cached GB | High (RAM) | Low (disk) but fragile | Low (disk) and durable |

The pattern to internalize is that `malloc` optimizes for latency at the cost of capacity and durability, `file` trades latency predictability for capacity but gives you nothing on durability, and Vinyl is the only option that delivers capacity and durability together while keeping latency close to RAM for the part of the working set that matters. The complexity tax Vinyl charges (two files, deliberate sizing, clean-shutdown discipline) is the price of that combination, and the rest of this guide is largely about paying it correctly.

## How Vinyl Is Structured on Disk

Vinyl splits its state into two artifacts, and understanding the split is the key to sizing and operating it.

The **data file** (sometimes called the store) holds the cached object bodies and their headers. This is the large file, sized to the total cache capacity you want, typically hundreds of gigabytes to terabytes.

The **book file** holds the index: the metadata that maps each cached object's hash to its offset and length inside the data file, plus housekeeping structures Vinyl uses to manage free space and eviction. The book is far smaller than the data file but it is not negligible, and it is the structure that makes persistence possible. On a clean shutdown Vinyl flushes the book; on the next start it reads the book back and reattaches to the still-valid object bodies in the data file. That reattachment is what gives you a warm cache after a restart instead of a cold one.

Keep two operational facts in mind. First, persistence is guaranteed only across a **clean** shutdown. A hard crash, a `SIGKILL`, or yanked power can leave the book inconsistent with the data file, in which case Vinyl discards what it cannot trust and starts cold. Second, the data file should live on fast local storage. The whole point of Vinyl is to trade a small latency increase (an SSD read instead of a RAM read) for a massive capacity increase. Put the data file on an NVMe SSD; never put it on spinning disk or a network filesystem if you care about tail latency.

## Configuring Storage Backends

Every storage backend is declared with the `-s` flag on the `varnishd` command line (or, in practice, through your systemd unit or container args). You can repeat `-s` to declare multiple named stores. Start by inspecting what a running instance is using.

```bash
# Inspect the storage backends a running Varnish instance is using.
# Each -s argument from the startup command appears as a named store.
varnishadm storage.list
```

The default malloc store is a single capped arena. Sizes accept `k`, `m`, `g`, and `t` suffixes.

```bash
# Default malloc store: a single in-process arena capped at the given size.
# Everything lives in anonymous memory; nothing survives a restart.
varnishd \
  -a :80 \
  -f /etc/varnish/default.vcl \
  -s malloc,16g
```

The legacy `file` backend takes a path and a size. It is shown here for completeness and for migration context, not as a recommendation.

```bash
# The legacy file backend: one mmap'd file on disk used as a cache arena.
# It is NOT persistent and the kernel page cache governs real performance.
varnishd \
  -a :80 \
  -f /etc/varnish/default.vcl \
  -s file,/var/lib/varnish/cache.bin,500g
```

Vinyl takes a path to a configuration file rather than inline parameters, because it has more knobs than a single size can express (data file path, book file path, and tuning).

```bash
# Vinyl: a disk-backed, persistent store. The data file holds objects and the
# book file holds the index. Objects survive a clean restart.
varnishd \
  -a :80 \
  -f /etc/varnish/default.vcl \
  -s vinyl,/etc/varnish/vinyl.cfg
```

A minimal Vinyl configuration file declares the book and the data file with explicit sizes. Use absolute paths and size both files to fixed values so they do not grow unpredictably.

```ini
# /etc/varnish/vinyl.cfg
# The "book" is the persistent index; keep it small but generously sized.
# The "store" is the bulk object data file; size it to total cache capacity.
env: {
    id = "edge";
};

books: ( {
    id   = "book1";
    file = "/data/varnish/vinyl.bok";
    size = "12G";

    stores: ( {
        id   = "store1";
        file = "/data/varnish/vinyl.dat";
        size = "750G";
    } );
} );
```

The book holds index entries, so its size scales with the **number** of cached objects, not their total bytes. A cache of many small objects needs a proportionally larger book than a cache of a few large ones. A practical starting point is to allocate roughly 1 to 2 percent of the data file size to the book and adjust based on the `g_space` figures Vinyl reports (covered below). Running the book out of space stops Vinyl from indexing new objects even when the data file has room.

For a large, disk-backed cache that fronts a busy origin, a more complete configuration spreads the object data across multiple stores within a single book and pins the files to fixed sizes. Splitting the data file into several stores lets you place them on separate NVMe devices for aggregate throughput and gives Vinyl more freedom to manage free-space layout. The example below provisions a two-terabyte cache across two NVMe devices behind one index.

```ini
# /etc/varnish/vinyl-large.cfg
# A large persistent cache: one index book, two object stores on separate
# NVMe devices. Sizes are fixed so the files never grow under load.
env: {
    id            = "edge-prod";
    # Default behavior for objects that no VCL rule routes explicitly.
    default_stores = "store-a,store-b";
};

books: ( {
    id   = "book1";
    file = "/data/nvme0/varnish/vinyl.bok";
    # ~1.5% of total object capacity; sized for a small-object workload.
    size = "32G";

    stores: (
        {
            id   = "store-a";
            file = "/data/nvme0/varnish/store-a.dat";
            size = "1T";
        },
        {
            id   = "store-b";
            file = "/data/nvme1/varnish/store-b.dat";
            size = "1T";
        }
    );
} );
```

Keeping the book on the same fast device as one of the stores is fine; the book is small and its access pattern is dominated by the page cache. What you must not do is place either file on a network filesystem or a spinning disk: the book's random-access updates and the stores' read-heavy pattern both punish high-latency media.

## Sizing the Data and Book Files

Sizing is where teams either set Vinyl up for years of quiet operation or sign up for recurring incidents. Work through it deliberately.

First, **measure the cacheable working set**, not the total origin size. The working set is the volume of distinct objects requested over a meaningful window (say, the busiest 24 hours). Pull this from access logs: the sum of distinct cacheable object sizes that received a request. Your data file should comfortably exceed this so that the long tail stays resident and you are not constantly evicting objects that will be requested again tomorrow.

The estimate does not need to be perfect; it needs to be grounded in real traffic rather than guessed. If your origin already logs response sizes, you can approximate the distinct cacheable working set straight from the access log. The script below treats the first request for each path as a new distinct object and sums those sizes, which is a reasonable proxy for the bytes Vinyl would need to hold.

```bash
# Estimate the distinct cacheable working set from an access log.
# Assumes a combined-style log where field 7 is the path and field 10 the
# response size in bytes. Adjust the field numbers to match your format.
awk '
  $9 == 200 {                      # only successful, cacheable responses
    path = $7
    if (!(path in seen)) {         # first time we have seen this object
      seen[path] = 1
      total += $10                  # add its body size once
      objects++
    }
  }
  END {
    printf "distinct cacheable objects: %d\n", objects
    printf "working-set bytes:          %.2f GB\n", total / 1024 / 1024 / 1024
    if (objects > 0)
      printf "average object size:        %.1f KB\n", total / objects / 1024
  }
' /var/log/nginx/access.log
```

Run that across your busiest day and you have the two numbers sizing depends on: the distinct working-set bytes that drive the data file, and the object count plus average size that drive the book.

Second, **estimate the object count** to size the book. Divide the working-set bytes by the average object size to get a count, then size the book so it never approaches full. If your average object is 40 KB and your data file is 750 GB, a full data file holds on the order of 19 million objects, and the book must have index headroom for all of them plus churn.

A worked example makes the relationship concrete. Suppose the working-set script reports 600 GB of distinct cacheable bytes across 15 million objects, an average of roughly 40 KB each. You want headroom above the measured working set so the long tail survives day-to-day churn, so you provision a data file at 750 GB rather than the bare 600 GB. The book must index every object the data file can hold, not just today's 15 million; a full 750 GB data file at the same average size holds about 19 million objects. Sizing the book at 12 GB gives roughly 630 bytes of index budget per object at full capacity, comfortably above Vinyl's per-object overhead, with margin for the housekeeping structures and for periods when the average object size dips and the object count climbs. Now flip the workload: the same 750 GB serving an average object of 4 KB would hold closer to 190 million objects, and the same 12 GB book would be dangerously tight. That is the small-object trap, and it is the single most common Vinyl sizing mistake. When in doubt about the size distribution, size the book for the smaller average you might plausibly hit, not the one you measured on a quiet day.

Third, **pre-create the files at fixed sizes** before first start. Allocating up front avoids the fragmentation and runtime stalls that come from growing a busy data file, and it surfaces an out-of-disk condition immediately instead of mid-incident.

```bash
# Pre-create the Vinyl data and book files at fixed sizes before first start.
# Sizing them up front avoids fragmentation and surprises under load.
fallocate -l 750g /data/varnish/vinyl.dat
fallocate -l 12g  /data/varnish/vinyl.bok
chown varnish:varnish /data/varnish/vinyl.dat /data/varnish/vinyl.bok
chmod 0600 /data/varnish/vinyl.dat /data/varnish/vinyl.bok
```

Fourth, **leave the operating system room to breathe**. Vinyl still uses RAM for in-flight requests, working memory, and the kernel page cache that accelerates reads of hot regions in the data file. Do not size the data file to consume the entire disk and do not let Varnish's resident memory crowd out the page cache. A node with 32 GB of RAM serving a 750 GB Vinyl store is a perfectly reasonable shape; a node with 4 GB of RAM serving the same store will thrash.

The following table gives rough starting points by deployment shape. Treat them as a place to begin measuring, not as prescriptions.

| Deployment shape | Node RAM | Data file | Book file | Notes |
| --- | --- | --- | --- | --- |
| Small persistent cache | 16 GB | 200 GB | 4 GB | Single node, modest catalog |
| Media / asset library | 32 GB | 750 GB | 12 GB | NVMe required; long tail |
| Large multi-tenant edge | 64 GB | 2 TB | 32 GB | Many small objects raise book size |
| Tiered hot + cold | 64 GB | 2 TB | 32 GB | Plus an 8 GB malloc hot store |

## RAM Versus SSD: The Performance Trade-off

The honest framing of Vinyl is that you are trading a small amount of per-request latency for a large amount of capacity and durability. A malloc hit is a memory read measured in microseconds. A Vinyl hit for an object not currently in the page cache is an SSD read, which on modern NVMe is still well under a millisecond but is not free. For the vast majority of cacheable web traffic, an SSD-served hit is dramatically faster than a miss to the origin, so the trade is overwhelmingly favorable. The objects you serve most often stay resident in the kernel page cache and are effectively RAM speed anyway; only the long tail pays the SSD cost.

Three factors decide whether that trade feels good in production:

- **Disk choice.** NVMe SSDs are mandatory for a hot Vinyl tier. SATA SSDs are tolerable for archival or low-QPS caches. Spinning disk and network storage are not viable for a latency-sensitive edge cache.
- **Page-cache headroom.** The more free RAM the kernel has for page cache, the more of your hot data file is served at memory speed. This is why you do not pin every gigabyte of RAM to the Varnish process.
- **Object size distribution.** Large objects amortize the per-read overhead well. Caches dominated by tiny objects spend proportionally more time in index lookups and benefit most from a fast book file and a generous page cache.

The practical conclusion: put the data file on NVMe, give the kernel real page-cache headroom, and Vinyl will feel close to a pure-RAM cache for everything that matters while holding ten or twenty times more data.

## Tuning Runtime Parameters for Large Caches

Vinyl's storage configuration is only half the picture. The `varnishd` runtime parameters (set with `-p` on startup or with `varnishadm param.set` at runtime) carry defaults tuned for a small RAM cache, and several of them matter more as the cache grows. The defaults will not hurt a 16 GB malloc instance; they can quietly throttle a multi-terabyte Vinyl tier.

The parameters worth reviewing for a large cache:

- **`thread_pools`** and **`thread_pool_max`** govern how many worker threads can run concurrently. A disk-backed cache spends more wall-clock time per request waiting on storage than a pure-RAM cache does, so the same request rate needs more in-flight threads to stay busy. Raise `thread_pool_max` if `MAIN.threads_limited` is non-zero.
- **`nuke_limit`** caps how many objects Varnish will evict to make room for a single new object. On a large cache fronting variable object sizes, the default can be too low: storing one large object may need to evict many small ones, and hitting the limit causes the fetch to fail rather than complete. Raise it if you see fetch failures correlated with eviction.
- **`workspace_backend`** and **`workspace_client`** size the per-transaction scratch memory. Large caches in front of complex VCL (header manipulation, ESI, many backends) can exhaust the default workspace and return 503s that look like backend errors but are really workspace overflows. Watch `MAIN.ws_*_overflow` counters.
- **`thread_pool_stack`** matters when you run thousands of threads, because each thread reserves stack; the product of stack size and thread count is real committed memory that competes with the page cache.

```bash
# Start Varnish with runtime parameters tuned for a large disk-backed cache.
# These raise thread headroom and the per-fetch eviction limit; measure
# before and after with varnishstat rather than copying values blindly.
varnishd \
  -a :80 \
  -f /etc/varnish/default.vcl \
  -s cold=vinyl,/etc/varnish/vinyl-large.cfg \
  -p thread_pools=4 \
  -p thread_pool_max=5000 \
  -p nuke_limit=1000 \
  -p workspace_backend=128k \
  -p workspace_client=128k
```

Treat every one of these as a hypothesis to test, not a fact to apply. Set a value, watch the corresponding counter under real load, and keep the change only if the counter moves in the right direction. Over-provisioning threads, for instance, can waste memory that the page cache would have used to keep your data file hot, which is a net loss even though "more threads" sounds like more capacity.

## Tiered Caching: Hot malloc in Front of Cold Vinyl

You do not have to choose between speed and capacity. Declaring multiple named stores lets you keep a small, very fast malloc tier for the hottest objects and a large persistent Vinyl tier for everything else.

```bash
# Tiered storage: a small fast RAM store plus a large persistent disk store.
# Name the stores so VCL can route objects to a specific backend.
varnishd \
  -a :80 \
  -f /etc/varnish/default.vcl \
  -s hot=malloc,8g \
  -s cold=vinyl,/etc/varnish/vinyl.cfg
```

Named stores can be targeted from VCL so that small, extremely hot objects land in RAM while large or long-tail objects go to disk. A simple policy routes by object size in `vcl_backend_response`.

```vcl
# /etc/varnish/default.vcl (excerpt)
# Route small, hot objects to the RAM store and everything else to disk.
sub vcl_backend_response {
    if (beresp.http.Content-Length ~ "^[0-9]{1,5}$") {
        # Bodies up to ~99 KB go to the fast in-memory store.
        set beresp.storage = storage.hot;
    } else {
        # Larger bodies and the long tail go to the persistent disk store.
        set beresp.storage = storage.cold;
    }
}
```

This pattern gives you the latency profile of malloc for the objects served most often and the capacity and durability of Vinyl for the rest. It also means a restart leaves the large cold tier warm; only the small hot tier needs to refill, which it does in seconds.

## Eviction Behavior

Both malloc and Vinyl evict with a variant of **LRU** (least recently used) when their store is full and a new object needs space. The mechanics differ in where the pressure shows up. With malloc, eviction frees process memory. With Vinyl, eviction frees regions of the data file and updates the book accordingly. Either way, the object that has gone longest without a request is the first to go.

The signal to watch is the **LRU nuke counter**. Every time Varnish evicts a live object to make room, it increments `MAIN.n_lru_nuked`. A small, steady nuke rate is healthy: it means the cache is full and doing its job. A high or climbing nuke rate means objects are being evicted faster than your working set wants, which is the symptom of an undersized store. The fix is more data-file capacity, not more origin capacity.

```bash
# Watch live hit/miss and eviction counters. -1 prints once and exits.
varnishstat -1 -f MAIN.cache_hit -f MAIN.cache_miss -f MAIN.n_lru_nuked
```

Distinguish nuking from **expiry**. An object removed because its TTL elapsed is not a sign of memory pressure; it is normal lifecycle. An object nuked while still fresh is pressure. When you see frequent nuking of objects that should still be useful, grow the data file rather than shortening TTLs, which would only push more load to the origin.

## Warming the Cache After a Cold Start

Vinyl's persistence means most restarts do not start cold, but some events still do: the first deploy of a node, a hard crash that invalidated the book, or scaling out a new replica. For those cases, deterministic **warmup** turns a slow, origin-pounding ramp into a controlled fill.

The approach is to replay the most valuable URLs against the edge before sending real traffic to a freshly started node. Generate the URL list from your access logs (the top paths by request count over the last day) and feed it to a warmup loop.

```bash
# Warm the cache deterministically after a cold start by replaying top URLs.
# Read one path per line and issue a cache-filling GET against the edge.
while IFS= read -r path; do
  curl -s -o /dev/null -w '%{http_code} %{time_total}s %{url_effective}\n' \
    "https://edge.internal.example.com${path}"
done < /var/lib/varnish/top-urls.txt
```

In a Kubernetes deployment, run warmup before the pod is added to the load balancer by gating the readiness probe on a warmup completion marker, or by running the warmup loop as a startup step that flips a readiness file only after a target hit ratio is reached. The goal is the same in both worlds: a node should not take production traffic until its cache holds enough of the working set to protect the origin.

After a clean restart, confirm Vinyl actually reattached instead of starting cold.

```bash
# Confirm Vinyl reattached to its on-disk objects after a clean restart.
# A non-zero "happy" object count means persistence worked.
varnishadm storage.list
varnishstat -1 -f 'VINYL.store.g_objects'
```

It is worth being precise about what "reattachment" does and does not give you. On a clean start, Vinyl reads the book, validates that it is consistent with the data file, and exposes the still-fresh objects as cache hits immediately, without re-fetching them from the origin. Objects whose TTL elapsed while the process was down are not served stale; they are treated as expired and refetched on demand, which is correct behavior. Reattachment is therefore not "the cache resumes exactly as it was" so much as "every object that was both cached and still fresh at shutdown is available without an origin round trip." For a large catalog that is the difference between a transparent restart and an hours-long, origin-pounding refill.

In Kubernetes, gate the readiness probe on warmup completion so the pod does not receive traffic until it can protect the origin. A startup script that warms the cache and only then writes a readiness marker, paired with a readiness probe that checks for that marker, accomplishes this cleanly.

```yaml
# Readiness probe gated on a warmup marker file. The startup process replays
# top URLs and writes /tmp/warm only after a target hit ratio is reached, so
# the pod stays out of the load balancer until its cache can shield the origin.
readinessProbe:
  exec:
    command:
      - "cat"
      - "/tmp/warm"
  initialDelaySeconds: 10
  periodSeconds: 10
  failureThreshold: 30
```

## Operational Monitoring with varnishstat

`varnishstat` is the primary instrument for a Vinyl deployment. Beyond the global hit/miss counters, each store reports its own gauges so you can see capacity and pressure per backend.

```bash
# Per-store gauges: g_bytes is bytes in use, g_space is free bytes remaining.
# The field prefix is SMA.<name> for malloc and the store name for Vinyl.
varnishstat -1 -f 'SMA.*' -f 'VINYL.*'
```

The fields that belong on a Vinyl dashboard, and what each one tells you:

| Metric | Meaning | What to alert on |
| --- | --- | --- |
| `MAIN.cache_hit` / `MAIN.cache_miss` | Hit and miss counts | Compute hit ratio; alert if it drops |
| `MAIN.n_lru_nuked` | Live objects evicted for space | Rising rate means the store is too small |
| `MAIN.n_expired` | Objects removed at TTL | Normal lifecycle; for context only |
| `SMA.hot.g_bytes` / `g_space` | RAM store used / free | Free approaching zero is expected when full |
| `VINYL.store.g_bytes` / `g_space` | Data file used / free | Free near zero with high nuking means undersized |
| `VINYL.book.g_space` | Book index free space | Near zero stops new object indexing |
| `MAIN.backend_busy` | Requests waiting on the origin | Spikes during cold cache or undersized cache |

Two compound signals are worth building explicitly. The **hit ratio** is `cache_hit / (cache_hit + cache_miss)`; a sustained drop usually means either capacity loss (rising nukes) or a content change that broke caching (a new query parameter, a `Set-Cookie` leak). The **book pressure** signal watches `VINYL.book.g_space`: because the book can fill before the data file when you cache many small objects, a low book free space with plenty of data-file space is a distinct failure mode that argues for a larger book, not a larger store.

Wire these into Prometheus via the `varnish_exporter`, which scrapes `varnishstat` counters and exposes them for alerting and Grafana dashboards. The same gauges that you read interactively become the basis for capacity alerts long before a store fills.

A small set of Prometheus alerting rules turns those gauges into pages before an incident. The rules below fire on a sustained hit-ratio drop, a climbing nuke rate, and book exhaustion, the three signals that most often precede a Vinyl problem.

```yaml
# Prometheus alerting rules for a Vinyl-backed Varnish tier.
# Metric names assume the varnish_exporter naming; adjust prefixes if yours differ.
groups:
  - name: varnish-vinyl
    rules:
      - alert: VarnishHitRatioLow
        # Hit ratio over 10m has fallen below 85%, computed from counter rates.
        expr: |
          sum(rate(varnish_main_cache_hit[10m]))
            /
          (sum(rate(varnish_main_cache_hit[10m])) + sum(rate(varnish_main_cache_miss[10m])))
            < 0.85
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "Varnish hit ratio below 85% for 15m"
      - alert: VarnishLRUNukingHigh
        # Sustained eviction of live objects: the store is too small for the working set.
        expr: rate(varnish_main_n_lru_nuked[10m]) > 50
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "Varnish evicting live objects at a high rate"
      - alert: VarnishBookSpaceLow
        # The index book is nearly full; new objects will stop being cached.
        expr: varnish_vinyl_book_g_space < 1073741824
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Vinyl book free space below 1 GiB"
```

When a counter tells you *that* something is wrong but not *why*, `varnishlog` is the tool that answers the second question. Unlike `varnishstat`, which aggregates, `varnishlog` streams the full per-transaction record: the request, the VCL decisions, the backend fetch, and crucially the cache disposition. Filtering on the `Hit` and `Miss` tags shows you exactly which URLs are missing, and the `Storage` tag shows which named store served or stored each object.

```bash
# Show only the URL and cache hit/miss disposition for live traffic.
# Useful for confirming whether a hit-ratio drop is a specific URL pattern.
varnishlog -g request -i ReqURL -i Hit -i VCL_call

# Watch which named store objects land in, to confirm tiering routing works.
# Every backend fetch logs a Storage tag naming the store it was written to.
varnishlog -g request -i Storage -i BereqURL
```

The combination is the standard workflow: `varnishstat` and the Prometheus alerts tell you a store is under pressure or the hit ratio slipped, and `varnishlog` tells you which requests and which store are responsible so you fix the right thing.

## Capacity Planning and Hardware

Sizing the files is a software exercise; the node they run on is a hardware one, and the two have to agree. A Vinyl tier that is well sized in `vinyl.cfg` but provisioned on the wrong hardware will still disappoint.

**Storage is the first decision.** The data file's read pattern is random and latency-sensitive, which is exactly the workload NVMe SSDs are built for and exactly the workload spinning disk is worst at. For a hot, latency-sensitive edge cache, NVMe is not optional. SATA SSDs are acceptable for archival or low-QPS caches where an extra hundred microseconds per read does not matter. Consumer SSDs are a false economy at scale: a busy cache writes constantly as objects are admitted and evicted, and consumer-grade flash with low endurance ratings (measured in drive writes per day) wears out fast under that churn. Specify data-center-class drives with endurance ratings that match your write volume, and monitor SMART wear indicators as part of fleet health.

**RAM is the second decision, and it is about the page cache more than the cache process.** Vinyl's resident memory footprint is modest: the process needs working memory for in-flight requests and a slice of the book. The rest of the node's RAM should be free for the kernel page cache, because that is what keeps the hot region of the data file at memory speed. A useful planning heuristic is to provision enough RAM that the kernel can hold the genuinely hot subset of the working set (often a small fraction of the total) in page cache, plus headroom for the malloc hot tier if you run one. Sizing RAM to the *entire* data file defeats the purpose of Vinyl; sizing it so the kernel can cache nothing defeats Vinyl's performance.

**CPU and network round out the node.** TLS termination, compression, and ESI processing are CPU-bound; a cache that does all three needs cores in proportion to its request rate. Network capacity has to exceed the peak egress the cache serves, which on a high-hit-ratio edge tier can be many times the origin's bandwidth precisely because the cache is doing its job. Plan the NIC for the cache's output, not the origin's.

The capacity-planning loop is the same one good operators run for any stateful tier: measure the working set, size the files with headroom, provision hardware that matches the access pattern, then watch the saturation signals (`g_space`, nuke rate, page-cache hit rate, SSD wear) and grow before any of them reaches a wall. Vinyl rewards this discipline with years of quiet operation; it punishes the absence of it with cold caches and origin overload at the worst possible moment.

## A Caching-Tier Architecture in Front of Kubernetes Origins

Before the deployment mechanics, it helps to see where a persistent Varnish tier sits in the request path and what it is protecting. In a Kubernetes-hosted application, the layers from the client inward typically run: a CDN at the global edge, then a regional Varnish caching tier, then the cluster ingress controller, then the application Services and pods, then the data stores those pods depend on. Each layer absorbs load so the layer behind it sees less.

The Varnish tier earns its place by being the durable, high-capacity buffer between the CDN's relatively small per-pop cache and the cluster's finite ingress and application capacity. A CDN handles geographic distribution and absorbs the bulk of static traffic, but its per-location cache is comparatively small and its origin-shield behavior varies. The regional Varnish tier, backed by terabytes of Vinyl storage, holds the full working set and shields the cluster from the long tail of requests that miss at the CDN. That shielding is the entire point: the application pods and especially the databases behind them have hard concurrency and connection limits, and a cold or undersized cache exposes those limits directly to internet traffic.

This is where Vinyl's two defining properties pay off in architecture terms. Capacity beyond RAM means a single regional tier can hold a working set far larger than any one node's memory, so the cluster sees a high, stable hit ratio rather than a hit ratio that erodes as the catalog grows. Persistence across restarts means a deploy, a node reboot, or a rolling update of the Varnish tier itself does not drop the shield and let a thundering herd through to the cluster. A RAM-only cache fronting Kubernetes recreates the exact failure it was meant to prevent every time it restarts; a Vinyl-backed tier holds the line through the restart.

The design rule that follows is to treat the Varnish tier as a real, capacity-planned layer with its own SLOs (hit ratio, origin offload, tail latency), not as an afterthought bolted in front of ingress. The remaining sections cover how to run that tier as a first-class Kubernetes workload.

## Deploying Vinyl in Front of Kubernetes Applications

A persistent Varnish tier fits naturally as an edge cache in front of Kubernetes Services, absorbing read traffic and shielding the cluster's ingress and application pods. Because Vinyl needs durable local disk and a stable identity to reattach to its data file, a `StatefulSet` with local NVMe `PersistentVolumeClaims` is the right primitive rather than a `Deployment` with ephemeral storage.

```yaml
# StatefulSet running Vinyl-backed Varnish as a shared edge cache tier
# in front of Kubernetes-hosted application Services.
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: varnish-edge
  namespace: edge-cache
spec:
  serviceName: varnish-edge
  replicas: 3
  selector:
    matchLabels:
      app: varnish-edge
  template:
    metadata:
      labels:
        app: varnish-edge
    spec:
      terminationGracePeriodSeconds: 60
      containers:
        - name: varnish
          image: registry.internal.example.com/varnish:9.1-vinyl
          args:
            - "-a"
            - ":80"
            - "-f"
            - "/etc/varnish/default.vcl"
            - "-s"
            - "hot=malloc,4g"
            - "-s"
            - "cold=vinyl,/etc/varnish/vinyl.cfg"
          ports:
            - name: http
              containerPort: 80
          resources:
            requests:
              cpu: "2"
              memory: 6Gi
            limits:
              memory: 8Gi
          volumeMounts:
            - name: vinyl-data
              mountPath: /data/varnish
            - name: vinyl-config
              mountPath: /etc/varnish/vinyl.cfg
              subPath: vinyl.cfg
      volumes:
        - name: vinyl-config
          configMap:
            name: varnish-vinyl-config
  volumeClaimTemplates:
    - metadata:
        name: vinyl-data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: local-nvme
        resources:
          requests:
            storage: 800Gi
```

Several details make this production-grade rather than a demo. The `terminationGracePeriodSeconds` of 60 gives `varnishd` time to flush the book on shutdown so the next start reattaches warm; too short a grace period turns every rolling update into a cold start. The local NVMe `storageClassName` keeps the data file fast and pins each pod's data to a node, which is what makes persistence meaningful. The memory `limit` is set above the malloc hot store plus working memory but leaves the node's remaining RAM for the kernel page cache that accelerates the Vinyl data file. The `ConfigMap`-mounted `vinyl.cfg` keeps the storage layout in source control and consistent across replicas.

One caveat specific to local-storage StatefulSets: because each pod's cache is pinned to a node, draining a node for maintenance loses that replica's warm cache until it is rescheduled and re-warmed. Account for this in your maintenance runbooks by warming a node after it returns, and by keeping enough replicas that losing one does not push the origin past its headroom.

## Troubleshooting Common Issues

A handful of failure modes account for most Vinyl incidents. Knowing the signature of each shortens diagnosis.

**Cache starts cold after every restart.** The book is not being flushed cleanly. Confirm `varnishd` receives `SIGTERM` and is given time to shut down (check the systemd unit's `TimeoutStopSec` or the pod's `terminationGracePeriodSeconds`). A `SIGKILL` or an OOM kill always forces a cold start because the book cannot be trusted. Verify with `varnishadm storage.list` and the object-count gauge immediately after a planned restart.

**Hit ratio is good but tail latency is poor.** The data file is being read from disk rather than page cache because the node lacks RAM headroom. Check free memory and the kernel page-cache size; either add RAM, reduce the malloc hot store, or move colder content off the node. Confirm the data file is on NVMe and not accidentally on a slower volume.

**New objects stop being cached while the data file has free space.** The book is full. Inspect `VINYL.book.g_space`; if it is near zero, the index cannot hold more entries even though object bytes have room. This is the small-object signature. Enlarge the book file and restart, or reconsider whether very small objects belong in the hot malloc store instead.

**Nuke rate climbs steadily under normal traffic.** The store is undersized for the working set. Read `MAIN.n_lru_nuked` over time and grow the data file. Resist the temptation to lower TTLs, which only redirects pressure to the origin.

**Permission or path errors at startup.** `varnishd` cannot open or create the data or book file. Confirm the files exist, are owned by the `varnish` user, and that the configured paths match the mounted volume. Pre-creating the files with the correct ownership, as shown earlier, avoids this entirely.

**Book and data file out of sync after a crash.** If a hard crash left the book inconsistent with the data file, Vinyl discards what it cannot trust and starts cold rather than risk serving corrupt objects. This is the safe behavior, but it surprises operators who expected persistence to survive any restart. The fix is not to recover the old book; it is to prevent the unclean shutdown in the first place by giving `varnishd` enough grace time and ensuring it is not OOM-killed. If a node crashes repeatedly, treat the cold starts as a symptom and chase the crash, not the cache.

**Tail latency spikes that track a single device.** On a multi-store layout spread across several NVMe devices, a single failing or thermally throttled drive shows up as latency spikes for the fraction of requests served from that store. Correlate `varnishlog` `Storage` tags against per-device latency from the host's disk metrics; a store on a degrading device is a hardware replacement, not a cache tuning problem. Multi-store layouts make this isolatable, which is one of their underrated benefits.

**Hit ratio drops with no change in capacity.** When nukes are flat and the data file has free space but the hit ratio still falls, the cause is almost always a caching regression rather than a sizing problem: a new query parameter creating cache-key explosion, a `Set-Cookie` on a response that made it uncacheable, or a `Cache-Control` change at the origin. Use `varnishlog` to inspect the misses; the URLs and headers will show the pattern. Growing the store does nothing here, because the objects were never cacheable in the first place.

## Key Takeaways

Vinyl turns Varnish from a RAM-bounded accelerator into a large, durable cache tier you can build a serving strategy around. The decisions that matter:

- **Use malloc when the working set fits in RAM**; reach for Vinyl when capacity or durability across restarts is the constraint. Avoid the legacy `file` backend for new deployments.
- **Vinyl's persistence requires clean shutdowns.** Give `varnishd` enough grace time to flush the book, or every restart starts cold.
- **Size the data file to your cacheable working set and the book to your object count.** Many small objects need a proportionally larger book; running the book out of space stops new caching even with data-file room to spare.
- **Put the data file on NVMe and leave RAM for page cache.** The hot path stays near memory speed while the long tail pays a sub-millisecond SSD cost instead of an origin round trip.
- **Tier a small malloc hot store in front of a large Vinyl cold store** to get RAM latency for the hottest objects and disk capacity and durability for everything else.
- **Watch `MAIN.n_lru_nuked`, the hit ratio, and `VINYL.book.g_space`.** Rising nukes mean grow the store; low book space means grow the book; a falling hit ratio means investigate capacity or a caching regression.
- **Tune runtime parameters for the disk-backed shape.** A Vinyl tier needs more in-flight threads and a higher `nuke_limit` than a small RAM cache; change one parameter at a time and confirm the matching `varnishstat` counter moves the right way.
- **Provision hardware to match the access pattern.** Data-center NVMe for the random read pattern, RAM headroom for the page cache rather than the process, and a NIC sized to the cache's egress, not the origin's.
- **Treat the Varnish tier as a planned layer with its own SLOs.** Sitting between the CDN and the cluster ingress, it shields finite application and database capacity from the long tail; its persistence is what keeps that shield up through a restart instead of dropping a thundering herd onto the cluster.
- **Use `varnishlog` to answer "why," not just "what."** When `varnishstat` or a Prometheus alert flags a problem, the per-transaction log shows which URLs and which store are responsible, separating a sizing problem from a caching regression.
- **Deploy as a StatefulSet on local NVMe** when fronting Kubernetes apps, and warm new or rebuilt nodes before they take production traffic so a cold cache never reaches the origin unprotected.
