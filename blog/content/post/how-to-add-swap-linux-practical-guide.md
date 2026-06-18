---
title: "How to Add Swap on Linux: A Practical Guide"
date: 2032-05-05T09:00:00-05:00
draft: false
tags: ["Linux", "Swap", "Memory", "swapfile", "fstab", "swappiness", "zram", "Kubernetes", "Sysadmin", "DevOps", "Performance"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A focused, practical guide to adding swap on Linux: create a swapfile, make it persistent in fstab, tune swappiness, verify it, remove it, plus zram and the Kubernetes angle."
more_link: "yes"
url: "/how-to-add-swap-linux-practical-guide/"
---

A server runs out of memory, a critical process gets killed by the OOM killer, and the postmortem ends with a one-line action item: "add swap." The task itself takes about ninety seconds. The judgment around it - how much, where, whether it helps or hurts, and what happens when the box is a Kubernetes node - is what separates a fix that quietly survives the next traffic spike from one that drags every latency-sensitive request to a crawl. This guide covers both: the exact commands to add swap correctly, and the small set of decisions that determine whether you should.

<!--more-->

This is the short, practical version. If you want the deep treatment of reclaim internals, cgroup accounting, and large-scale tuning, two companion articles go much further - see the [Going deeper](#going-deeper) section at the end. Everything here is meant to be copy-pasteable on a current Debian, Ubuntu, RHEL, or Rocky/Alma system using systemd.

## What Swap Actually Is

**Swap** is disk space the kernel uses as an overflow area for memory. When physical RAM fills up, the kernel can move (page out) memory pages that have not been touched recently to swap, freeing RAM for something more active. When those pages are needed again, they are read back in (paged in). Swap does not make a machine faster; it makes it *survive* memory demand that would otherwise trigger the **OOM killer**, at the cost of latency whenever pages have to travel to or from disk.

Two practical truths shape everything below:

- A small amount of swap lets the kernel evict genuinely idle pages - long-forgotten daemons, leaked-but-unreferenced allocations - and reclaim that RAM for page cache and active work. This is almost always a net positive.
- Heavy, sustained swapping (the system "thrashing") means the working set no longer fits in RAM. Swap is now masking a capacity problem and making everything slow. The answer there is more RAM or less load, not more swap.

Swap comes in two forms: a **swapfile** (a regular file on an existing filesystem) and a **swap partition** (a whole block device or partition). For the overwhelming majority of modern systems, a swapfile is the right choice.

It helps to be precise about the kind of memory swap affects. The kernel divides reclaimable memory into two broad categories: **file-backed pages** (page cache - the in-memory copies of files on disk) and **anonymous pages** (process heap, stack, and other allocations that have no file behind them). File-backed pages can always be dropped and re-read from their source file, so they cost nothing extra to reclaim. Anonymous pages have nowhere to go *unless* there is swap. Without swap, the only way the kernel can reclaim anonymous memory under pressure is to kill a process. That single fact - that swap is the kernel's only release valve for anonymous memory short of the OOM killer - is the entire reason a small swap area is valuable even on machines that "have plenty of RAM."

## The Fast Path: Add a Swapfile

This is the procedure to memorize. It creates a 4 GiB swapfile, secures it, formats it as swap, and activates it.

```bash
# 1. Allocate the file. fallocate is instant on filesystems that
#    support it (ext4, xfs) because it reserves blocks without writing.
sudo fallocate -l 4G /swapfile
ls -lh /swapfile
```

`fallocate` is the modern default, but it does not work everywhere. On some filesystems (notably older configurations, certain network filesystems, or when the swapfile would otherwise be sparse) the kernel rejects a sparse file as swap. If `swapon` later complains about a "skipping - it appears to have holes" error, recreate the file with `dd`, which writes every block:

```bash
# Fallback: write 4096 blocks of 1 MiB each = 4 GiB, fully populated.
# status=progress prints a live byte counter so you know it is moving.
sudo dd if=/dev/zero of=/swapfile bs=1M count=4096 status=progress
```

Why does `fallocate` sometimes fail when `dd` always works? `fallocate` asks the filesystem to reserve extents without writing data, which can leave the file with "holes" - ranges that are logically zero but have no physical blocks assigned yet. The kernel's swap subsystem refuses a file with holes because it needs a stable, fully mapped set of blocks to write pages into; a hole could otherwise force an allocation at the worst possible moment (under memory pressure). Older **Btrfs** versions and some copy-on-write or network filesystems are the usual culprits. `dd if=/dev/zero` writes every byte, guaranteeing every block is physically allocated, which is slower but always produces a swap-ready file. A modern middle ground on supported filesystems is `fallocate` followed by a quick verification with `swapon`; if it complains, fall back to `dd`.

Once the file exists, secure it, mark it as swap, and turn it on:

```bash
# 2. Only root should ever read or write the swapfile. A swapfile
#    readable by others is a memory-disclosure risk - it contains
#    whatever was paged out, including secrets.
sudo chmod 600 /swapfile

# 3. Write the swap signature/header into the file.
sudo mkswap /swapfile

# 4. Activate it immediately (no reboot required).
sudo swapon /swapfile
```

The `chmod 600` step is not optional. `mkswap` will warn you if the permissions are too open, but it will still format the file. Skipping it leaves a world-readable copy of paged-out memory on disk - effectively an offline dump of secrets, decrypted session data, and private keys that happened to be evicted. Owner-only permissions plus root ownership are the minimum bar.

Confirm it is live:

```bash
# swapon --show lists every active swap device with size and usage.
swapon --show
free -h
```

You should see `/swapfile` listed with type `file`, and the `Swap:` row in `free -h` should now show a non-zero total. At this point swap is active - but only until the next reboot.

### A Note on Encryption

If the host uses full-disk encryption (LUKS) for the root or data filesystem, a swapfile living on that filesystem is encrypted at rest along with everything else - paged-out secrets are protected. If the filesystem holding the swapfile is *not* encrypted, the contents of swap are readable by anyone with physical access to the disk. On laptops and any host where disk theft is part of the threat model, either place the swapfile on an encrypted filesystem or use a swap partition layered over `dm-crypt`. This is one of the few cases where a swap partition (with `crypttab` configured for encrypted swap) has a clear advantage over a plain swapfile.

## Making Swap Persistent

`swapon` activates swap for the current boot only. To have it come back automatically, add an entry to `/etc/fstab`:

```bash
# Append the swapfile to fstab. The fields are:
#   <device>  <mount point>  <type>  <options>  <dump>  <pass>
# Swap has no mount point ("none"), uses type "swap", default options
# "sw", and is excluded from dump (0) and fsck (0).
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

The six fields matter, so it is worth understanding each:

- **`<device>`** - the swapfile path or, for a partition, a stable identifier (UUID preferred).
- **`<mount point>`** - always `none` (or `swap`) for swap; it is not mounted into the directory tree.
- **`<type>`** - `swap`.
- **`<options>`** - `sw` is the conventional default. You can add `pri=N` to set priority (covered below) or `discard` to issue TRIM on SSDs, for example `sw,discard` or `sw,pri=10`.
- **`<dump>`** - `0`; the `dump` backup tool should never archive swap.
- **`<pass>`** - `0`; `fsck` must never check a swap area.

For a swap partition, prefer a stable identifier over a kernel device name like `/dev/sdb1`, which can change between boots. Use the UUID from `blkid`:

```bash
# Get the partition UUID, then reference it in fstab so the entry
# survives disk reordering.
blkid /dev/sdb1
# Example fstab line using the UUID:
# UUID=2d8f1b4a-... none swap sw 0 0
```

Validate the fstab change without rebooting. A typo here can make a server fail to boot:

```bash
# Turn off all swap, then re-read fstab and re-enable everything
# defined there. If swapon -a succeeds, your fstab entry is correct.
sudo swapoff -a
sudo swapon -a
swapon --show
```

If `swapon -a` activates the swapfile, the entry is valid and the system will mount it on every boot. This dry run is the single most important habit when editing `/etc/fstab`: a malformed swap line is usually non-fatal because most distributions tolerate a failed swap activation at boot, but a malformed entry combined with the wrong `<pass>` value or a stale device name can drop the system into emergency mode. Always confirm `swapon -a` succeeds before you trust the entry.

### The systemd swap unit alternative

On systemd systems, `/etc/fstab` swap entries are transparently converted into `*.swap` units at boot by `systemd-fstab-generator`, so the fstab approach above is fully systemd-native. If you prefer to manage swap as an explicit unit (useful in immutable or declaratively managed images), you can drop a unit file directly. The unit name must match the escaped path of the swap device:

```ini
# /etc/systemd/system/swapfile.swap
[Unit]
Description=Swapfile

[Swap]
What=/swapfile

[Install]
WantedBy=swap.target
```

```bash
# Enable and start the swap unit. systemd handles activation order.
sudo systemctl daemon-reload
sudo systemctl enable --now swapfile.swap
swapon --show
```

For most servers the fstab line is simpler and is what teams expect to find. Reach for an explicit `.swap` unit only when you are already managing the host declaratively and want swap to live alongside other units.

## Swapfile vs Swap Partition

The historical reason to prefer a dedicated swap partition was performance: a contiguous partition avoided filesystem overhead and fragmentation. On modern kernels (4.x and later) with modern filesystems on SSDs, that gap is negligible for normal workloads. The practical tradeoffs today:

- **Swapfile** - resize or remove it in seconds with no repartitioning, works on any existing filesystem, easy to script during provisioning. This is the default recommendation. The one real limitation: a swapfile on **Btrfs** requires care (the file must have copy-on-write disabled with `chattr +C` and not be snapshotted), and a swapfile cannot live on a network filesystem.
- **Swap partition** - useful when you want swap on a separate physical device for I/O isolation, when the root filesystem is one that does not support swapfiles cleanly, or when you need swap for **hibernation** (suspend-to-disk), which has stricter requirements. Setup mirrors the swapfile path minus the file creation:

```bash
# Format an existing empty partition as swap and activate it.
sudo mkswap /dev/sdb1
sudo swapon /dev/sdb1
blkid /dev/sdb1
```

A concise way to choose:

| Factor | Swapfile | Swap partition |
| --- | --- | --- |
| Setup speed | Seconds, no repartition | Requires a partition |
| Resize | Trivial (recreate file) | Requires repartitioning |
| Hibernation support | Possible but fiddly (resume offset) | Clean, well-supported |
| I/O isolation | Shares the host filesystem device | Can live on a dedicated disk |
| Btrfs / network FS | Restricted or unsupported | Works (it is a raw device) |
| Cloud / ephemeral hosts | Ideal - scriptable at provisioning | Awkward; partitions are fixed |

When in doubt, use a swapfile. The flexibility is worth more than the marginal, often unmeasurable, performance difference. The two situations that genuinely argue for a partition are hibernation (where the resume logic expects a block device and a known offset) and a desire to isolate swap I/O onto a separate physical disk so that heavy paging does not contend with database or log writes on the primary volume.

### Btrfs swapfiles specifically

If the filesystem is Btrfs, a plain `fallocate`/`dd` swapfile will be rejected because Btrfs swapfiles must not be copy-on-write and must not span multiple devices or be compressed. Create them deliberately:

```bash
# On Btrfs: create the file with no copy-on-write and no compression,
# then size it with fallocate. The file must be nodatacow before data.
sudo truncate -s 0 /swapfile
sudo chattr +C /swapfile
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

Keep the swapfile out of any subvolume that gets snapshotted; a snapshot of an active swapfile is both meaningless and a source of corruption risk.

## Sizing: Rules of Thumb

There is no universal formula, but there are sane defaults. The ancient "swap = 2x RAM" rule dates to an era of 256 MB machines and is actively harmful on a server with 128 GB of RAM - it would dedicate 256 GB of disk to a region that, if ever fully used, would mean the box is already unusable.

Reasonable starting points:

- **General-purpose servers (8-64 GB RAM):** 2-4 GB of swap. Enough to evict idle pages and give the kernel headroom before the OOM killer fires, without inviting thrashing.
- **Memory-constrained or small instances (less than 8 GB RAM):** swap equal to RAM, capped around 4 GB. Small boxes benefit most from the safety margin.
- **Large memory servers (greater than 64 GB):** a fixed 4-8 GB is plenty. The goal is graceful reclaim, not the ability to run twice your RAM in swap.
- **Hibernation laptops/workstations:** swap must be at least equal to RAM, since the entire memory image is written to swap on suspend-to-disk.
- **Databases and latency-critical services:** small swap (1-2 GB) plus low **swappiness** (see below). You want the OOM killer held off, but you do not want the database's hot pages paged out.

A compact sizing table by RAM and role:

| RAM | General server | Small / constrained | Database / latency-critical | Hibernation host |
| --- | --- | --- | --- | --- |
| < 2 GB | 1-2 GB (consider zram) | = RAM | 1 GB + low swappiness | = RAM |
| 2-8 GB | 2 GB | = RAM (cap 4 GB) | 1-2 GB | = RAM |
| 8-32 GB | 2-4 GB | 4 GB | 2 GB | = RAM (rarely used here) |
| 32-64 GB | 4 GB | n/a | 2-4 GB | = RAM if hibernating |
| > 64 GB | 4-8 GB fixed | n/a | 4 GB | = RAM if hibernating |

The principle: swap is insurance against transient spikes and a tool for evicting cold pages, not a substitute for RAM. If you find a server steadily consuming many gigabytes of swap, that is the signal to add RAM, not more swap.

## Tuning Swappiness

**Swappiness** is a kernel knob (0-200, default 60 on most distros) that biases how aggressively the kernel reclaims memory by swapping out anonymous pages versus dropping page cache. A higher value swaps sooner; a lower value keeps process memory in RAM longer and reclaims file cache first.

Check the current value and change it for the running system:

```bash
# Read the current value (60 on most distributions).
cat /proc/sys/vm/swappiness

# Lower it so the kernel prefers reclaiming page cache over swapping
# out application memory. Takes effect immediately.
sudo sysctl vm.swappiness=10
```

`sysctl` changes are lost on reboot. Make it persistent with a drop-in file:

```bash
# Persist swappiness across reboots via a sysctl drop-in.
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swappiness.conf
sudo sysctl --system
```

Guidance:

- **`vm.swappiness=10`** is a common, conservative choice for servers - swap is available as a safety net but the kernel avoids it until genuinely necessary. This is a good default for most application and database hosts.
- **`vm.swappiness=60`** (the distro default) is fine for general desktops and mixed workloads.
- **`vm.swappiness=1`** minimizes swapping without fully disabling it. Setting it to `0` disables anonymous-page swapping almost entirely on modern kernels, which can push borderline systems straight into the OOM killer - avoid `0` unless you know exactly why you want it.
- Values above 100 (a newer kernel feature) bias even harder toward swapping out anonymous memory, which is mostly relevant for compressed swap like zram, discussed below.

### vfs_cache_pressure

Swappiness has a companion knob that is easy to overlook: **`vm.vfs_cache_pressure`**. Where swappiness governs the anonymous-versus-file-cache reclaim balance, `vfs_cache_pressure` controls how aggressively the kernel reclaims the slab caches that hold directory entries (dentries) and inode objects - the metadata caches that make filesystem traversal fast.

```bash
# Default is 100. Read the current value.
cat /proc/sys/vm/vfs_cache_pressure

# Lower it to keep dentry/inode caches in memory longer. Useful on
# file servers, build hosts, and anything that walks large trees.
sudo sysctl vm.vfs_cache_pressure=50
```

- **`100`** (default) reclaims dentry/inode caches at a "fair" rate relative to page cache and anonymous memory.
- **Lower (50)** tells the kernel to prefer keeping filesystem metadata cached, which helps workloads that repeatedly `stat`, list, or open many files - NFS servers, CI build agents, web servers serving many small files.
- **Higher (200+)** reclaims metadata caches aggressively, freeing slab memory faster at the cost of re-reading metadata. Rarely needed; mostly relevant on memory-starved systems where slab growth is a problem.

Persist it the same way as swappiness:

```bash
# Persist both reclaim knobs together in one drop-in.
sudo tee /etc/sysctl.d/99-vm-tuning.conf >/dev/null <<'EOF'
vm.swappiness=10
vm.vfs_cache_pressure=50
EOF
sudo sysctl --system
```

### Verifying the tuning took effect

After applying a sysctl drop-in, confirm the live kernel actually reflects the new value - a typo in the file or a conflicting drop-in with a higher number can silently override you:

```bash
# Confirm the running kernel values match what you intended.
sysctl vm.swappiness vm.vfs_cache_pressure

# See which file set each value (drop-ins are applied in lexical order;
# the last one wins). Useful when a value is not what you expected.
grep -r -E 'swappiness|vfs_cache_pressure' /etc/sysctl.conf /etc/sysctl.d/ 2>/dev/null
```

If `sysctl vm.swappiness` reports something other than your intended value, a later-sorting drop-in (or a cloud-init/management-agent file) is overriding it. Drop-ins apply in lexical order, so a file named `99-swappiness.conf` beats `10-cloud.conf`, but a vendor file named `zz-vendor.conf` would beat both.

## Multiple Swap Areas and Priority

The kernel can use several swap areas at once, and you can control the order it fills them with the **priority** value. Higher priority is used first; equal priorities are striped (round-robin), which can roughly double swap throughput across two devices.

```bash
# Activate two swap devices with explicit priorities. The faster
# device (NVMe) gets the higher number so the kernel prefers it.
sudo swapon --priority 100 /dev/nvme0n1p2
sudo swapon --priority 10  /swapfile

# Confirm the priorities the kernel is using.
swapon --show
cat /proc/swaps
```

The classic use is tiering: put a small, high-priority swap area on the fastest device (NVMe, or a zram device) and a larger, low-priority overflow area on slower storage. The kernel exhausts the fast tier before touching the slow one. To persist priorities, add `pri=N` to the options field in `/etc/fstab`:

```bash
# fstab options with explicit priority - the swapfile is the
# low-priority overflow behind a faster device defined elsewhere.
# /swapfile none swap sw,pri=10 0 0
```

Equal-priority striping is the trick when you have two identical fast devices and want maximum paging bandwidth; set both to the same `pri=` value.

## Verifying and Monitoring Swap

After any change, confirm the state with a few quick commands:

```bash
# Active swap devices, their type (file/partition), size, and current use.
swapon --show

# Whole-system view including the Swap row.
free -h

# The kernel's raw view, including per-device priority.
cat /proc/swaps
```

For ongoing monitoring, the columns that matter are `si` (swap-in) and `so` (swap-out) from `vmstat`:

```bash
# Sample every 2 seconds. Sustained non-zero si/so means active
# swapping - a few blips during a memory spike are normal; constant
# traffic is thrashing and a sign the working set exceeds RAM.
vmstat 2
```

Total swap *used* is far less interesting than the *rate* of swap I/O. A server can sit with 500 MB of swap occupied by genuinely cold pages and never touch them again - that is healthy. The same server constantly reading pages back in (`si` consistently high) is in trouble regardless of the absolute number.

A few more lenses that help in an investigation:

```bash
# Per-process swap usage, largest first. Reads each process's status
# file and sums the VmSwap field, so it shows who is actually paged out.
for f in /proc/[0-9]*/status; do
  awk '/^Name:/{n=$2} /^VmSwap:/{if ($2+0 > 0) print $2, n}' "$f"
done | sort -rn | head -20

# System-wide swap totals straight from the kernel.
grep -E 'Swap(Total|Free|Cached)' /proc/meminfo
```

`SwapCached` in `/proc/meminfo` is worth knowing: it counts pages that have been read back into RAM but whose copy still exists in swap, so they can be evicted again without rewriting. A healthy `SwapCached` value means the kernel is reusing swap efficiently rather than churning. For trend monitoring on a fleet, scrape `node_memory_SwapFree_bytes` and `node_vmstat_pswpin`/`node_vmstat_pswpout` from the Prometheus node exporter and alert on the *rate* of pswpin/pswpout over time, not on used bytes.

## Resizing Swap Safely

There is no in-place resize for a swapfile; you turn it off, recreate it at the new size, and turn it back on. The only hazard is that `swapoff` must pull all currently paged-out data back into RAM, so make sure there is enough free memory first.

```bash
# 1. Confirm there is room in RAM to absorb whatever is in swap.
free -h

# 2. Deactivate the current swapfile.
sudo swapoff /swapfile

# 3. Recreate it at the new size (8 GiB here) and re-secure it.
sudo fallocate -l 8G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile

# 4. Reactivate. The fstab entry is unchanged because the path is the same.
sudo swapon /swapfile
swapon --show
```

For a swap partition, resizing means repartitioning, which is exactly the rigidity that makes swapfiles preferable. Adding a *second* swap area (a new swapfile) is often easier than resizing an existing one and lets you grow swap with zero downtime - the new area comes online with `swapon` while the old one keeps serving.

## Removing Swap

To disable and remove a swapfile cleanly, deactivate it first so the kernel migrates any paged-out data back into RAM, then remove the file and its fstab entry:

```bash
# 1. Deactivate. This moves paged-out data back to RAM, so make sure
#    there is enough free memory to absorb it before running this.
sudo swapoff /swapfile

# 2. Remove the fstab entry. The alternate delimiter (#) avoids
#    escaping the slashes in the path.
sudo sed -i '\#/swapfile#d' /etc/fstab

# 3. Delete the file.
sudo rm /swapfile
```

If `swapoff` hangs or fails with "Cannot allocate memory," the system does not have enough free RAM to pull all the swapped pages back in. Free up memory first, or remove swap during a quieter period. For a swap partition, run `swapoff /dev/sdb1`, remove its fstab line, and the partition is free to repurpose.

If you used an explicit systemd `.swap` unit instead of an fstab entry, disable that unit rather than editing fstab:

```bash
# Tear down a systemd-managed swap area.
sudo systemctl disable --now swapfile.swap
sudo rm /etc/systemd/system/swapfile.swap
sudo systemctl daemon-reload
sudo rm /swapfile
```

## zram and zswap: Compressed Alternatives

On RAM-constrained systems, compressed in-memory swap often beats disk-backed swap outright. Two related mechanisms:

**zram** creates a compressed block device in RAM and uses it as swap. Pages are compressed (typically 2:1 to 4:1) and kept in memory instead of written to disk, so "swapping" stays at memory speed. This is the standard approach on small VMs, containers, and resource-limited edge devices, and it is the default swap mechanism in Fedora and several other modern distributions.

```bash
# Manual zram setup. The zram-generator package (below) is the
# preferred, persistent way - this shows the underlying mechanism.
sudo modprobe zram
echo lz4 | sudo tee /sys/block/zram0/comp_algorithm
echo 2G | sudo tee /sys/block/zram0/disksize
sudo mkswap /dev/zram0
# High priority so the kernel prefers fast zram over any disk swap.
sudo swapon --priority 100 /dev/zram0
```

On systemd distributions, configure it declaratively with `systemd-zram-generator` instead of the manual steps:

```ini
# /etc/systemd/zram-generator.conf
[zram0]
zram-size = min(ram / 2, 4096)
compression-algorithm = zstd
swap-priority = 100
```

After installing the `zram-generator` (or `systemd-zram-generator`) package and writing that config, the device comes up at boot automatically. Verify and inspect compression effectiveness:

```bash
# Confirm zram is active as the highest-priority swap.
swapon --show

# Inspect compression ratio: original data size vs compressed size.
# A 3-4x ratio with zstd is common for typical anonymous memory.
zramctl
```

**zswap** is different: it is a compressed *cache in front of* a real disk-backed swap device. Pages are compressed in RAM first, and only spill to disk swap when the compressed pool fills. zswap needs an actual swapfile or partition to back it; zram does not. A minimal enable looks like:

```bash
# Enable zswap at runtime (also settable as a kernel boot parameter
# zswap.enabled=1). It requires a real swap device to back it.
echo 1 | sudo tee /sys/module/zswap/parameters/enabled
echo zstd | sudo tee /sys/module/zswap/parameters/compressor
echo z3fold | sudo tee /sys/module/zswap/parameters/zpool
```

Use zram when you want to avoid disk swap entirely on a small box, and zswap when you have disk swap and want to soften its latency cost. The deep dive linked below compares the two in detail for modern workloads.

## The Kubernetes Angle

Swap and Kubernetes have a complicated history. For years, the **kubelet** refused to start if swap was enabled on the node (`failSwapOn` defaulted to `true`), and the standard cluster-bootstrap instruction was simply "disable swap." The reasoning: swap defeats the kubelet's ability to enforce memory limits predictably, since a pod could exceed its RAM limit by silently spilling to swap, making the OOM killer's behavior and QoS guarantees harder to reason about.

That has changed. The **NodeSwap** feature graduated to stable in recent Kubernetes releases, allowing nodes to use swap in a controlled way. To opt in, the kubelet must be told not to fail on swap and to use the limited-swap behavior, which restricts swap to Burstable QoS pods proportional to their memory request:

```yaml
# /var/lib/kubelet/config.yaml on the node
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
failSwapOn: false
featureGates:
  NodeSwap: true
memorySwap:
  swapBehavior: LimitedSwap
```

After editing the kubelet config, restart the kubelet and confirm the node accepts swap:

```bash
# Apply the kubelet config change.
sudo systemctl restart kubelet

# The node should be Ready with swap present rather than refusing to start.
kubectl get nodes
# On the node, confirm swap is actually active and the kubelet did not abort.
swapon --show
journalctl -u kubelet --no-pager | grep -i swap | tail -20
```

How `LimitedSwap` allocates swap is worth understanding before enabling it. Only **Burstable** QoS pods are eligible. A container's swap limit is computed from its memory request as a proportion of node memory: roughly, the container may use swap up to its memory-request share of total node swap. **Guaranteed** QoS pods (where requests equal limits) and **BestEffort** pods get no swap, and neither do containers with a memory limit equal to node-allocatable. This design deliberately keeps the most latency-sensitive and the most unbounded workloads off swap, while letting moderate Burstable workloads ride out transient spikes.

Practical recommendations for clusters:

- **If you have not enabled NodeSwap, keep swap off on your nodes.** A mismatch - swap present but the kubelet expecting none - leads to inconsistent OOM behavior and confusing capacity planning. The traditional `swapoff -a` plus removing the fstab entry remains correct for those clusters.
- **`LimitedSwap` is the safe behavior** when you do enable it. It bounds how much swap any pod can use and keeps Guaranteed-QoS and system-critical workloads out of swap entirely. The alternative, `UnlimitedSwap`, lets workloads consume swap without bound and is rarely a good idea in shared clusters.
- **Do not put latency-critical workloads on swap-enabled nodes** unless you have measured the impact. Node swap is most valuable for absorbing transient memory spikes in batch or best-effort workloads, not for protecting tail latency on user-facing services. Consider a dedicated swap-enabled node pool with taints, scheduling only the workloads that benefit.
- **Monitor node-level `si`/`so`** the same way you would on any host. A swap-enabled node that starts thrashing affects every pod scheduled on it. Alert on `node_vmstat_pswpin`/`pswpout` rate per node.

For most production clusters today, the honest default is still "swap off on nodes" unless you have a specific, tested reason to enable NodeSwap and have configured `LimitedSwap` to match. The strongest case for enabling it is a workload class that has bursty, infrequent memory peaks - batch jobs, CI runners, certain JVM services during GC - where a small amount of swap turns an OOM kill into a brief slowdown.

## When Swap Helps and When It Hurts

A compact decision guide:

**Swap helps when:**

- You want a buffer against transient memory spikes before the OOM killer intervenes.
- The system has genuinely cold pages (idle daemons, one-time initialization memory) that can be evicted to free RAM for cache and active work.
- You are on a small/constrained instance where a little headroom prevents avoidable crashes - especially with zram.
- You need hibernation on a laptop or workstation.

**Swap hurts when:**

- The working set exceeds physical RAM and the system thrashes. Swap here just makes a too-small box feel broken instead of failing fast.
- You run latency-sensitive services and let hot pages get paged out - tail latency explodes when those pages must be read back from disk.
- It masks an under-provisioned system, delaying the real fix (more RAM or less load) while degrading performance the whole time.

The throughline: swap is a graceful-degradation and idle-reclaim tool, not extra RAM. Size it small, tune swappiness down on servers, watch the I/O rate rather than the used total, and treat sustained swapping as a capacity alarm.

## Going Deeper

This guide is deliberately the quick, correct path. For the full engineering treatment, two companion articles go much further:

- [Enterprise Linux Swap and Memory Management: Comprehensive Optimization Guide](/enterprise-linux-swap-memory-management-comprehensive-optimization-guide/) - reclaim internals, cgroup v2 memory accounting, per-workload tuning, and large-fleet strategy.
- [Linux Swap with zswap: Compressed Swap for Modern Workloads](/linux-swap-zswap-compressed-swap-modern-workloads/) - a detailed comparison of zram and zswap, compression algorithm tradeoffs, and tuning compressed swap for production.

## Conclusion

Adding swap on Linux is a ninety-second task wrapped in a set of judgment calls. Get both right and you have a server that degrades gracefully instead of getting killed mid-spike.

- **Create a swapfile** with `fallocate` (or `dd` if it has holes), `chmod 600`, `mkswap`, `swapon`. The permissions step is mandatory.
- **Persist it** with a correct `/etc/fstab` entry, and validate with `swapoff -a && swapon -a` before trusting it across reboots.
- **Prefer swapfiles** over partitions unless you need hibernation, I/O isolation, encrypted swap, or a filesystem that does not support them.
- **Size it small** - a few GB for most servers; ignore the obsolete 2x-RAM rule. Swap equal to RAM only for small boxes or hibernation.
- **Tune `vm.swappiness` to 10** on servers and databases, pair it with `vm.vfs_cache_pressure` for file-heavy hosts, and verify the live values took effect - never set swappiness to `0` unless you know why.
- **Use priority** to tier multiple swap areas: fast device high, slow overflow low; equal priorities stripe for bandwidth.
- **Resize and remove safely** - `swapoff` pulls pages back into RAM, so confirm free memory first.
- **Verify with `swapon --show` and `free -h`**, and monitor the swap I/O *rate* (`vmstat` `si`/`so`, node-exporter pswpin/pswpout), not the used total.
- **On Kubernetes**, keep swap off nodes unless you have enabled the stable NodeSwap feature with `LimitedSwap` and tested the impact; consider a tainted swap-enabled node pool for bursty workloads.
- **Reach for zram** on constrained systems for memory-speed compressed swap, and **zswap** when you have disk swap and want to soften its latency.
