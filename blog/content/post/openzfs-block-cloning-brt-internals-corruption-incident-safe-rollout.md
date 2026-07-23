---
title: "OpenZFS Block Cloning in Production: BRT Internals, the 2.2 Corruption Incident, and Safe Rollout"
date: 2026-07-29T09:00:00-05:00
draft: false
tags: ["ZFS", "OpenZFS", "Linux", "Storage", "Block Cloning", "BRT", "Reflink", "Deduplication", "Filesystems", "Data Integrity", "Replication"]
categories:
- Linux
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "How OpenZFS block cloning works, what the Block Reference Table actually stores, why the 2.2.0 rollout corrupted data, and how to enable, verify, and monitor reflink copies safely in production."
more_link: "yes"
url: "/openzfs-block-cloning-brt-internals-corruption-incident-safe-rollout/"
---

Copying a 21 GiB virtual machine image on a pool with block cloning enabled finishes in about a quarter of a second and consumes no additional space. The copy is a real, independent file: it has its own inode, its own permissions, and its own future. It simply points at the same on-disk blocks as the original until one of them is modified. This is **block cloning**, the OpenZFS implementation of what XFS, Btrfs, and Windows ReFS call a reflink, and it is one of the highest leverage storage features available to anyone running VM fleets, container image caches, or backup pipelines.

It is also the feature that shipped enabled by default in OpenZFS 2.2.0, silently corrupted files for a subset of users, got emergency-disabled in 2.2.1, and then spent the better part of two years switched off by default while the project rebuilt confidence in it. That history is not a reason to avoid block cloning. It is a reason to understand exactly what it does, which version floor is safe, how to verify it is actually engaging, and where the savings quietly evaporate. This guide covers the mechanism, the incident, and the operational practices that make it safe to turn on.

<!--more-->

## What Block Cloning Actually Is

Block cloning creates additional references to blocks that already exist on disk. When a file is cloned, ZFS does not read the source data and it does not write the destination data. It allocates new file metadata, points that metadata at the existing block pointers, and increments a reference count for each block involved. The result is two files that share physical storage.

Divergence is handled by the copy-on-write machinery ZFS already uses everywhere else. Writing to a cloned region allocates a fresh block for the writer, updates that file's block pointer, and decrements the shared reference count. The other file is untouched. There is no fragile linkage to break and no risk that modifying one file mutates another.

The performance characteristics follow directly from the mechanism. A conventional copy of a 21 GiB image on a pool capable of 750 MB/s takes roughly 28 seconds and is bounded by I/O throughput. The same copy performed as a clone completes in roughly a quarter of a second, because the only work is metadata. Deploying ten VM images from a template drops from over five minutes to a few seconds.

### Block Cloning Is Not zfs clone

The naming collision here is genuinely unfortunate and causes real confusion in incident channels. The two features are unrelated:

| Property | `zfs clone` | Block cloning |
| --- | --- | --- |
| Granularity | Entire dataset | Individual file or byte range |
| Requires a snapshot | Yes | No |
| Invoked by | `zfs clone` command | Standard copy syscalls |
| Creates a dependency | Yes, on the origin snapshot | No |
| Visible as | A new dataset in `zfs list` | An ordinary file |
| Pool feature flag | None, it is core ZFS | `feature@block_cloning` |

A `zfs clone` dataset is permanently tied to its origin snapshot until promoted, and that origin snapshot cannot be destroyed while the clone exists. Block cloning has no such entanglement. Once the clone exists, the two files are peers, and either can be deleted independently.

### Block Cloning Is Not Deduplication

This distinction matters more, because both features reduce space usage by making multiple logical blocks share one physical block. The difference is *when the system learns the blocks are identical*.

Classic ZFS deduplication maintains a **Deduplication Table (DDT)** and consults it on every single write. Each incoming block must be hashed and that hash checked against every other block hash in the pool before the write can complete. That lookup sits directly in the synchronous write path, the table must be substantially resident in ARC to avoid random-read amplification, and the memory footprint scales with the number of unique blocks in the pool. This is why dedup has a reputation for destroying pool performance and why the standard advice for a decade has been to use compression instead.

Block cloning maintains a **Block Reference Table (BRT)** and never performs a hash lookup. The caller has already told ZFS that these blocks are duplicates, because the caller explicitly asked for a clone of specific blocks. There is nothing to search for. The BRT is a refcount table, not a content index, so it only holds entries for blocks that are actually cloned, and it is consulted on free rather than on write.

The practical consequence: block cloning gives a meaningful slice of what people wanted from dedup, for the specific workloads where copies are explicit, without any of dedup's write-path cost. It does not deduplicate data that happens to be identical by coincidence. Two independently written copies of the same file remain two copies.

## The Block Reference Table

The BRT is per-pool on-disk metadata that maps a physical block address to a reference count. Its lifecycle is straightforward:

1. A clone operation adds or increments BRT entries for every block in the cloned range.
2. Reads consult nothing extra. A cloned block pointer is an ordinary block pointer.
3. Freeing a block consults the BRT. If the refcount is above one, the entry is decremented and the block stays allocated. If it reaches zero, the entry is removed and the block is genuinely freed.

The pool feature reflects this lifecycle. `feature@block_cloning` moves from `enabled` to `active` when the first block is cloned, and returns to `enabled` when the last cloned block is freed. This is unusual among ZFS feature flags, most of which are one-way doors, and it has a practical consequence for portability. While the feature is `active`, the pool is still importable by an implementation that lacks it, but read-only, because the feature is marked read-only compatible. Once every cloned block is freed and the feature drops back to `enabled`, it is inactive and the pool imports read-write again anywhere.

```bash
# Feature state on a pool that has never cloned a block
zpool get feature@block_cloning tank
# NAME  PROPERTY                VALUE                   SOURCE
# tank  feature@block_cloning   enabled                 local

# After the first clone, the same command reports "active"
```

Because the BRT is consulted on free rather than on write, its performance profile is the inverse of the DDT's. Bulk deletion of cloned data is the operation that touches it hardest. On pools with very large BRTs, warming it into ARC ahead of a heavy delete is worthwhile:

```bash
# Prefetch the block reference table into ARC (OpenZFS 2.4.0 and later)
zpool prefetch -t brt tank
```

The BRT is also much smaller than a DDT for equivalent savings, because it holds one entry per *cloned* block rather than one entry per *unique* block in the pool. A pool with a hundred terabytes of data and one terabyte of cloned VM images carries a BRT sized for the terabyte, not the hundred.

## Triggering a Clone

Nothing in ZFS is called "clone this file". Block cloning is engaged through standard filesystem interfaces, which means existing tools get it for free once the feature is on.

### cp with reflink

GNU coreutils exposes the behavior through `--reflink`:

```bash
# Clone if possible, silently fall back to a full copy if not.
# This is the coreutils 9.x default behavior for cp.
cp --reflink=auto /tank/images/base-ubuntu-24.04.qcow2 \
                  /tank/images/web01.qcow2

# Clone or fail. Use this when a silent full copy would be a bug,
# for example in a provisioning script with tight time budgets.
cp --reflink=always /tank/images/base-ubuntu-24.04.qcow2 \
                    /tank/images/web02.qcow2

# Never clone. Force a real byte-for-byte copy onto fresh blocks.
cp --reflink=never /tank/images/base-ubuntu-24.04.qcow2 \
                   /tank/images/web03.qcow2
```

The shift to `--reflink=auto` as the coreutils 9.x default is important context for the corruption incident covered later. It meant that upgrading a distribution changed `cp` from "never clone" to "clone whenever the filesystem supports it", with no change to any script or command line.

### copy_file_range and the FICLONE ioctl

Applications reach the same path directly. `copy_file_range(2)` is the portable interface and will clone when the filesystem supports it:

```c
// copy_file_range: kernel-side copy that ZFS services with block cloning
// when source and destination are on the same pool.
#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv) {
    int src = open(argv[1], O_RDONLY);
    int dst = open(argv[2], O_WRONLY | O_CREAT | O_TRUNC, 0644);

    struct stat st;
    fstat(src, &st);

    off_t remaining = st.st_size;
    while (remaining > 0) {
        ssize_t copied = copy_file_range(src, NULL, dst, NULL, remaining, 0);
        if (copied <= 0) {
            perror("copy_file_range");
            return 1;
        }
        remaining -= copied;
    }

    close(src);
    close(dst);
    return 0;
}
```

The `FICLONE` and `FICLONERANGE` ioctls are the explicit, non-falling-back interface. `FICLONE` clones an entire file; `FICLONERANGE` clones a byte range. Both fail outright rather than degrading to a copy, which makes them the right choice when the caller needs to know whether cloning happened:

```c
// FICLONE: explicit whole-file clone. Fails rather than falling back.
#include <fcntl.h>
#include <linux/fs.h>
#include <stdio.h>
#include <sys/ioctl.h>
#include <unistd.h>

int main(int argc, char **argv) {
    int src = open(argv[1], O_RDONLY);
    int dst = open(argv[2], O_WRONLY | O_CREAT | O_TRUNC, 0644);

    if (ioctl(dst, FICLONE, src) == -1) {
        perror("FICLONE");
        return 1;
    }

    close(src);
    close(dst);
    return 0;
}
```

### Snapshot restores and network file copies

Two more paths engage block cloning without any explicit request, and both are high value:

```bash
# Restoring a file from a snapshot clones rather than copies, so the
# restored file costs metadata rather than 40 GiB. Plain cp only takes
# this path on coreutils 9.x and later, where --reflink=auto is the
# default. On older coreutils, pass --reflink=auto explicitly.
cp --reflink=auto /tank/vm/.zfs/snapshot/nightly-2026-07-28/db01.qcow2 \
                  /tank/vm/db01-restored.qcow2
```

Server-side copy operations over NFS (the `COPY` operation in NFSv4.2) and SMB (`FSCTL_SRV_COPYCHUNK` and offloaded data transfer) also land on the clone path. A Windows client copying a file within an SMB share backed by ZFS never pulls the data across the wire at all.

## Preconditions and Silent Fallbacks

Block cloning is not always possible, and when it is not, the behavior depends on which interface was used. `cp --reflink=auto` and `copy_file_range` fall back to a real copy without comment. `cp --reflink=always` and the `FICLONE` ioctls fail with an error. Knowing the preconditions is what separates "the feature is broken" from "the feature declined, correctly".

**Same pool.** Cloning is a refcount on a physical block address. Block addresses are pool-scoped. Cross-pool copies always fall back, even between two datasets on the same host.

**Matching recordsize.** Cloning across datasets requires the source and destination datasets to agree on `recordsize`. A clone from a dataset with `recordsize=1M` into one with `recordsize=128K` cannot work, because the block boundaries do not line up.

```bash
# Verify before writing a provisioning script that depends on cloning
zfs get -o name,value recordsize tank/templates tank/vm
# NAME            VALUE
# tank/templates  1M
# tank/vm         1M
```

**Compatible encryption.** Both datasets must be unencrypted, or both encrypted with the same key. Cloning a block from an unencrypted dataset into an encrypted one would require re-encrypting it, which means writing it, which defeats the entire point.

**Block alignment.** Only whole, aligned blocks can be cloned, and the two interfaces diverge sharply here. `FICLONERANGE` requires the offset and length to be block-aligned and fails with `EINVAL` when they are not, the sole exception being a length that runs to end of file. `copy_file_range` and `cp --reflink=auto` are permissive: they clone the aligned interior and fall back to a real copy for the ragged edges, which is why a copy can be partially cloned and report savings smaller than the file size. For whole-file copies this is a non-issue except for the tail block.

**Source data must be on disk.** A block that exists only as dirty data in memory has no physical address to reference. This is the case the `zfs_bclone_wait_dirty` tunable governs, discussed below.

To determine after the fact whether a copy actually cloned, compare pool allocation before and after, or watch the BRT counters:

```bash
# Snapshot the counters, do the copy, compare
zpool get -Hp -o value bclonesaved tank
cp --reflink=auto /tank/images/base.qcow2 /tank/images/derived.qcow2
zpool get -Hp -o value bclonesaved tank
```

If `bclonesaved` did not move, no cloning happened, regardless of how fast the copy appeared to be.

## Enabling and Verifying

There are two independent gates, and both must be open. Checking only one is the most common reason a working configuration appears not to work.

### Gate one: the pool feature

```bash
# Check current state
zpool get feature@block_cloning tank

# Enable on an existing pool. This is a one-way transition from
# "disabled" to "enabled" and is safe: it is read-only compatible,
# so a pool that has never cloned a block remains importable
# by implementations without the feature.
zpool set feature@block_cloning=enabled tank
```

Pools created by a recent OpenZFS build have the feature enabled already. Pools carried forward from older releases, or created with an explicit `-o compatibility=` setting, may not.

### Gate two: the module parameter

`zfs_bclone_enabled` is the runtime kill switch added during the corruption incident. When it is `0`, clone requests behave as though the pool feature were absent, even when the feature is enabled and active.

```bash
# Check the live value. Do this before trusting any documented default:
# the default differed across the 2.2.x, 2.3.x, and 2.4.x branches
# and across distribution packages.
cat /sys/module/zfs/parameters/zfs_bclone_enabled

# Enable for the current boot
echo 1 > /sys/module/zfs/parameters/zfs_bclone_enabled

# Persist across reboots
cat > /etc/modprobe.d/zfs.conf <<'EOF'
options zfs zfs_bclone_enabled=1
EOF

# Rebuild the initramfs if ZFS is loaded early in boot.
# Debian and Ubuntu:
update-initramfs -u -k all

# RHEL, Rocky, and AlmaLinux:
dracut --force --regenerate-all
```

On FreeBSD the same knob is a sysctl:

```sh
# Runtime
sysctl vfs.zfs.bclone_enabled=1

# Persistent
echo 'vfs.zfs.bclone_enabled=1' >> /etc/sysctl.conf
```

### The wait-dirty tradeoff

`zfs_bclone_wait_dirty` controls what happens when the `FICLONE` and `FICLONERANGE` ioctls encounter blocks that have not yet been flushed to disk:

```bash
cat /sys/module/zfs/parameters/zfs_bclone_wait_dirty
```

At `1`, the clone operation waits for dirty data to reach disk before proceeding. This makes cloning reliable even for a file that was just written and immediately cloned, which is the common pattern in build pipelines and image-preparation scripts. The cost is latency: for small files, waiting for a transaction group can be slower than simply copying the bytes.

At `0`, the clone fails immediately when it encounters dirty blocks. Under write-heavy load this produces intermittent, load-dependent failures that look like flakiness in whatever tool issued the clone. Leave this at `1` unless there is a measured reason not to, and expect that reason to be narrow.

## Measuring Savings

Three pool properties report block cloning activity:

```bash
zpool get bcloneused,bclonesaved,bcloneratio tank
# NAME  PROPERTY      VALUE   SOURCE
# tank  bcloneused    21.2G   -
# tank  bclonesaved   212G    -
# tank  bcloneratio   11.00x  -
```

- `bcloneused` is the physical space occupied by blocks that have more than one reference. In the example above, 21.2 GiB of unique blocks are shared.
- `bclonesaved` is the space that would have been consumed had every clone been a full copy. Here, eleven copies of a 21.2 GiB image avoided 212 GiB of allocation.
- `bcloneratio` is the average number of references per cloned block, expressed as a ratio.

Two reporting characteristics regularly cause confusion.

**These are pool-level only.** There is no per-dataset equivalent. A dataset heavy with clones and a dataset with none look identical in `zfs list`, and `used` on a cloned file reports its logical size. Attributing savings to a specific workload requires measuring pool-level counters before and after, or bookkeeping outside ZFS.

**Space accounting lags the transaction group.** Freed space from cloning is not reflected until the relevant TXGs commit. Creating many clones back to back can therefore produce `ENOSPC` on a pool with plenty of real free space, because the allocator has not yet caught up. The fix is to let the pool settle between batches:

```bash
#!/usr/bin/env bash
# Provision eight VM disks from a template without tripping the
# transaction-group accounting lag on a tight pool.
set -euo pipefail

TEMPLATE=/tank/templates/base-ubuntu-24.04.qcow2
TARGET_DIR=/tank/vm

for host in web01 web02 web03 web04 db01 db02 cache01 cache02; do
    cp --reflink=always "$TEMPLATE" "${TARGET_DIR}/${host}.qcow2"
    zpool sync tank
done

zpool get bcloneused,bclonesaved,bcloneratio tank
```

On a pool with comfortable headroom the `zpool sync` per iteration is unnecessary overhead. On a pool running above 80 percent it is the difference between a clean provisioning run and a confusing mid-loop failure.

A minimal exporter-friendly check for monitoring:

```bash
#!/usr/bin/env bash
# Emit block cloning metrics in Prometheus textfile-collector format.
# Drop in /var/lib/node_exporter/textfile_collector/zfs_bclone.prom
set -euo pipefail

COLLECTOR_DIR=/var/lib/node_exporter/textfile_collector

# Stage the temp file inside the collector directory so the final
# rename is a same-filesystem atomic replace. A file staged in /tmp
# would cross filesystems and node_exporter could read it half-written.
OUT=$(mktemp "${COLLECTOR_DIR}/.zfs_bclone.prom.XXXXXX")
trap 'rm -f "$OUT"' EXIT

{
    echo '# HELP zfs_bclone_used_bytes Physical bytes held by cloned blocks.'
    echo '# TYPE zfs_bclone_used_bytes gauge'
    echo '# HELP zfs_bclone_saved_bytes Bytes avoided by cloning instead of copying.'
    echo '# TYPE zfs_bclone_saved_bytes gauge'

    for pool in $(zpool list -H -o name); do
        used=$(zpool get -Hp -o value bcloneused "$pool")
        saved=$(zpool get -Hp -o value bclonesaved "$pool")
        printf 'zfs_bclone_used_bytes{pool="%s"} %s\n' "$pool" "$used"
        printf 'zfs_bclone_saved_bytes{pool="%s"} %s\n' "$pool" "$saved"
    done
} > "$OUT"

# mktemp creates the file 0600. node_exporter usually runs as its own
# user and must be able to read the collector file, so widen the mode
# before the atomic rename into place.
chmod 0644 "$OUT"
mv "$OUT" "${COLLECTOR_DIR}/zfs_bclone.prom"
trap - EXIT
```

Alerting on `zfs_bclone_saved_bytes` going flat is a useful canary: it catches the case where a kernel upgrade reset `zfs_bclone_enabled` to `0` and every provisioning copy silently reverted to a full copy.

## The 2.2.0 Corruption Incident

Block cloning shipped in OpenZFS 2.2.0, enabled by default. Within weeks, users reported files containing repeated data or long runs of zeroes where real content should have been. The report that anchored the investigation is [issue #15526](https://github.com/openzfs/zfs/issues/15526), filed by Terin Stock.

### Root cause

The bug was not in the block cloning code. It was in `dnode_is_dirty()`, the function that determines whether a dnode has pending changes that must be flushed before its on-disk state can be trusted. The check was incorrect, and had been incorrect for years. A read that raced with a write could observe a dnode as clean when it was not, and act on stale on-disk state.

That latent defect had an estimated hit rate somewhere around one in tens of millions of file copies, which is rare enough to be invisible in practice and to be attributed to hardware when it did occur. Block cloning changed the arithmetic in two ways. First, the clone path exercises exactly the dnode-state check that was wrong, on every operation. Second, coreutils 9.x had recently changed `cp` to default to `--reflink=auto`, so ordinary `cp` invocations on ordinary systems began taking that path without anyone opting in. Machines with high core counts and concurrent I/O hit the race most often.

### Timeline and fixes

| Version | Change |
| --- | --- |
| 2.2.0 | Block cloning shipped, enabled by default |
| 2.2.1 | `zfs_bclone_enabled` introduced and defaulted to `0`, disabling the feature |
| 2.2.2 | Root-cause fix for the dirty-dnode check |
| 2.1.14 | Same root-cause fix backported to the 2.1 branch |
| 2.2.3 | Fix for a separate panic on `sync` during BRT operations (issue #15768) |
| 2.4.0 | `block_cloning_endian` feature, `zpool prefetch -t brt`, zvol encryption-key check, fix for read corruption after clone-after-truncate |

The critical detail for anyone auditing an older fleet: **the corruption was possible without block cloning**. The dirty-dnode bug affected 2.1.x and 2.2.0 through 2.2.1 regardless of whether the feature was in use, just at a far lower rate. Disabling `zfs_bclone_enabled` reduced exposure dramatically but did not eliminate it. Only the 2.2.2 and 2.1.14 fixes did that.

### The long road back

`zfs_bclone_enabled` stayed at `0` by default well past the root-cause fix. [Issue #16189](https://github.com/openzfs/zfs/issues/16189), opened in May 2024, asked the project to define the criteria for flipping it back. The default remained off through the 2.2.x line while additional edge cases were found and fixed, and current OpenZFS documentation now records a default of `1` for both `zfs_bclone_enabled` and `zfs_bclone_wait_dirty`.

Because that default moved at different points across branches and because distribution packagers sometimes carried their own value, do not infer the state of any given machine from a version number. Read the parameter.

```bash
# The only authoritative answer for a given host
printf '%-24s %s\n' \
    zfs_version "$(cat /sys/module/zfs/version)" \
    bclone_enabled "$(cat /sys/module/zfs/parameters/zfs_bclone_enabled)" \
    bclone_wait_dirty "$(cat /sys/module/zfs/parameters/zfs_bclone_wait_dirty)"
```

### Auditing an exposed pool

If a pool ran 2.2.0 or 2.2.1 with cloning active, or ran any 2.1.x below 2.1.14, the corruption is silent by construction. Scrub will not find it: the corrupted data was written correctly from ZFS's point of view, checksums match the bad content, and there is no redundancy mismatch to detect.

Detection requires comparing against an independent source of truth:

```bash
#!/usr/bin/env bash
# Compare live files against a known-good snapshot taken before the
# exposure window. Reports content divergence that a scrub cannot see.
set -euo pipefail

DATASET=tank/vm
MOUNTPOINT=/tank/vm
REFERENCE_SNAPSHOT=pre-upgrade-2023-10-01

SNAPDIR="${MOUNTPOINT}/.zfs/snapshot/${REFERENCE_SNAPSHOT}"

if [ ! -d "$SNAPDIR" ]; then
    echo "Reference snapshot ${REFERENCE_SNAPSHOT} not present on ${DATASET}" >&2
    exit 1
fi

divergent=0
while IFS= read -r -d '' snapfile; do
    relative="${snapfile#"${SNAPDIR}/"}"
    live="${MOUNTPOINT}/${relative}"

    [ -f "$live" ] || continue

    if ! cmp -s "$snapfile" "$live"; then
        echo "DIVERGENT: ${relative}"
        divergent=$((divergent + 1))
    fi
done < <(find "$SNAPDIR" -type f -print0)

echo "Files differing from reference snapshot: ${divergent}"
```

Divergence is expected for anything legitimately modified since the snapshot, so this is a triage tool rather than a verdict. For files that should be immutable (base images, archived artifacts, published packages) any divergence at all is a finding. Where an external checksum manifest exists, verifying against it is strictly better than the snapshot comparison.

## Replication: Where Clones Stop Being Free

This is the single most expensive misunderstanding available with block cloning, and it deserves more attention than the corruption history.

**The BRT is pool-local and does not travel in a send stream.** A cloned block is a reference to a physical address in the source pool. That address is meaningless on the receiving side. `zfs send` therefore materializes every clone as independent data, and `zfs receive` writes it out in full.

The consequences compound:

- A dataset showing `bcloneratio 11.00x` produces a send stream sized for the fully expanded data, not the cloned footprint.
- A backup target sized from the source pool's `ALLOC` figure will be far too small.
- A restore-in-place operation that clones a 40 GiB image from a snapshot costs nothing locally and instantly adds 40 GiB of allocation on every replication target downstream.

A worked example. A pool holds roughly 254 GiB of logical data across a VM dataset. Of that, 233 GiB is eleven references to a shared 21.2 GiB base image, which occupies 21.2 GiB physically and saves 212 GiB:

```bash
zpool list -o name,size,alloc,free tank
# NAME  SIZE   ALLOC  FREE
# tank  500G   43.1G  457G

zpool get bcloneused,bclonesaved,bcloneratio tank
# NAME  PROPERTY      VALUE   SOURCE
# tank  bcloneused    21.2G   -
# tank  bclonesaved   212G    -
# tank  bcloneratio   11.00x  -

# The source pool allocates 43.1 GiB. The send stream carries 254 GiB.
zfs send -nvP tank/vm@nightly-2026-07-28 | tail -1
# size  254G
```

A 100 GiB backup target that looks generous against 43.1 GiB of source allocation fails partway through the receive. Always use `zfs send -nvP` to get the real stream size, and size replication targets from that number rather than from source allocation or `bcloneratio`.

Two operational rules follow:

1. **Never plan capacity for a replication target from the source pool's allocated size** when block cloning is active. Use the dry-run stream size.
2. **Treat clone-based restores on a replicated dataset as a capacity event.** Restoring six images from snapshots is free locally and adds their full combined size to every downstream target on the next replication cycle. If the backup target is tight, restore to a non-replicated dataset instead.

## Production Rollout Guidance

### Version floor

Do not enable block cloning below OpenZFS 2.2.3. That floor covers the dirty-dnode root-cause fix from 2.2.2 and the BRT sync panic fix from 2.2.3. Prefer running on a currently maintained branch: as of mid-2026 that means 2.4.x for current and 2.3.x for LTS, with 2.4.0 and later carrying additional clone fixes including the read-corruption-after-truncate case and the zvol encryption-key check.

### Staged enablement

```bash
# 1. Confirm the module parameter state on every host in the fleet
#    before assuming a uniform configuration.
for host in $(cat /etc/ansible/zfs-hosts); do
    printf '%-20s %s %s\n' "$host" \
        "$(ssh "$host" cat /sys/module/zfs/version)" \
        "$(ssh "$host" cat /sys/module/zfs/parameters/zfs_bclone_enabled)"
done

# 2. Enable the pool feature on a non-production pool first
zpool set feature@block_cloning=enabled lab

# 3. Verify a clone actually engages and saves the space it claims
dd if=/dev/urandom of=/lab/testfile bs=1M count=2048 status=none
zpool sync lab
before=$(zpool get -Hp -o value bclonesaved lab)
cp --reflink=always /lab/testfile /lab/testfile.clone
zpool sync lab
after=$(zpool get -Hp -o value bclonesaved lab)
echo "bclonesaved delta: $(( (after - before) / 1024 / 1024 )) MiB"

# 4. Verify divergence behaves correctly: writing to the clone must
#    not alter the original.
dd if=/dev/urandom of=/lab/testfile.clone bs=1M count=64 conv=notrunc status=none
zpool sync lab
cmp /lab/testfile /lab/testfile.clone && echo "UNEXPECTED: files still identical"
```

Step 4 is not paranoia theater. It is a five-second check that the copy-on-write divergence path is behaving, and it is exactly the property that failed in the 2.2.0 incident.

### Workloads that win

- **VM and container image fanout.** Provisioning many instances from a golden image is the canonical case. Space and time both collapse to metadata.
- **Snapshot restores.** Recovering a large file from `.zfs/snapshot/` costs nothing until the restored copy diverges.
- **Synthetic full backups.** Constructing a full backup by cloning the previous full and applying an incremental avoids rewriting unchanged data.
- **Build and CI workspaces.** Cloning a populated dependency tree per job instead of copying or re-fetching it.

### Workloads that do not

- **Anything where the copies immediately and completely diverge.** Cloning then rewriting every block costs a BRT entry and a free, for zero benefit.
- **Datasets with aggressive replication and tight target capacity.** The savings do not survive the send stream, and the restore-as-capacity-event dynamic makes the target's usage hard to predict.
- **Small files.** With `zfs_bclone_wait_dirty=1`, waiting for a TXG to clone a 40 KiB file is slower than copying it. Cloning pays off on large files.
- **Pools running above 85 percent.** The transaction-group accounting lag turns burst cloning into intermittent `ENOSPC`.

### Ongoing checks

- Export `bcloneused` and `bclonesaved` to monitoring, and alert on `bclonesaved` flatlining, which indicates the feature silently stopped engaging.
- Include `zfs_bclone_enabled` in configuration management and assert its value, so a kernel or package upgrade cannot quietly reset it.
- Recheck send-stream sizes with `zfs send -nvP` after any change to cloning usage, and reconcile against backup target free space.
- Track the OpenZFS release notes for the branch in use. Block cloning has received fixes in every minor release since 2.2, and that pace is a reason to stay current rather than a reason to stay away.

## Conclusion

Block cloning is the highest-value ZFS space feature for workloads built on copies, and it carries a history that is worth understanding rather than fearing.

- **It is reflink, not dedup and not `zfs clone`.** The BRT is a refcount table consulted on free, with no hash lookup on the write path, which is why it avoids every performance problem that made classic dedup unusable.
- **Two gates must both be open:** the `feature@block_cloning` pool feature and the `zfs_bclone_enabled` module parameter. Read the live parameter value rather than inferring it from a version number, because the default moved across branches and packagers.
- **The 2.2.0 corruption was a latent dirty-dnode bug, not a flaw in cloning itself.** It affected 2.1.x and early 2.2.x with or without cloning; the feature simply made a one-in-tens-of-millions race routine. The real fix landed in 2.2.2 and 2.1.14.
- **Run 2.2.3 or later at absolute minimum,** and prefer a currently maintained branch, since every minor release since 2.2 has carried further clone fixes.
- **Savings do not survive replication.** The BRT is pool-local, clones fully materialize in a send stream, and backup targets must be sized from `zfs send -nvP` output rather than from source allocation or `bcloneratio`.
- **Verify engagement rather than assuming it.** Watch `bclonesaved` move across a test copy, alert when it flatlines, and confirm that writing to a clone leaves the original intact.
