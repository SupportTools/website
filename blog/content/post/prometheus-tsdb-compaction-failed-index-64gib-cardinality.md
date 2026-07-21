---
title: "Prometheus TSDB Compaction Failed: The 64 GiB Index Ceiling and What It Says About Your Cardinality"
date: 2026-07-21T09:00:00-05:00
draft: false
tags: ["Prometheus", "TSDB", "Monitoring", "Observability", "Cardinality", "Troubleshooting", "Kubernetes"]
categories:
- Monitoring
- Observability
- Troubleshooting
author: "Matthew Mattox - mmattox@support.tools"
description: "Prometheus TSDB compaction failing with 'exceeding max size of 64GiB': why the index format has a hard ceiling, how to tell whether it is cardinality or churn, promtool triage commands, emergency containment, and the sharding fix."
more_link: "yes"
url: "/prometheus-tsdb-compaction-failed-index-64gib-cardinality/"
---

Prometheus compaction had been running fine for months. Then this showed up in the logs, and kept showing up every couple of hours:

```text
level=ERROR source=db.go:1219 msg="compaction failed" component=tsdb err="compact [/var/lib/prometheus/metrics2/01KJQ22FD0C2VFGQC2T8QP70P2 /var/lib/prometheus/metrics2/01KK8B5EK0CPXWDGPRD3H89ZQP /var/lib/prometheus/metrics2/01KKSP6NZ0EYNDGJFJTD3D6N6F]: populate block: add series: write series data: \"/var/lib/prometheus/metrics2/01KKSSF1T0T0T3AN0PJ00WVQGJ.tmp-for-creation/index\" exceeding max size of 64GiB

add padding: \"/var/lib/prometheus/metrics2/01KKSSF1T0T0T3AN0PJ00WVQGJ.tmp-for-creation/index\" exceeding max size of 64GiB"
```

Searching that string gets you almost nothing: a handful of GitHub issues, no runbook, no explanation. So here is the explanation. Short version: this is a hard limit in the TSDB index file format, not a resource problem. You cannot tune it, add RAM to it, or upgrade past it. It is real and it needs work, but it is *not* a data-loss event, and the most likely root cause is cardinality. Specifically, the number of distinct series that existed anywhere inside the merged block's time range, which is a very different number from your current head cardinality.

<!--more-->

# Prometheus TSDB Compaction Failed: The 64 GiB Index Ceiling

## Reading the error inside-out

Errors like this wrap several layers, and the layers tell you where in the block-writing process it died. Peel it from the outside:

| Layer | Meaning |
|---|---|
| `compact [block-A block-B block-C]` | Prometheus selected three existing blocks to merge into one larger block. |
| `populate block` | It is streaming series from the source blocks into the new one. |
| `add series` | It is writing the new block's **index**, series section. |
| `write series data` | The actual `FileWriter.Write()` call that tripped the guard. |
| `exceeding max size of 64GiB` | The index file hit the format ceiling. |
| `add padding: … exceeding max size of 64GiB` | The 16-byte alignment padding that follows the series section failed for the same reason. |

Two things follow from *where* it failed.

First, the target block ULID with the `.tmp-for-creation` suffix is a block that never existed. It was being built. It is not a block you lost.

Second, and this is the useful diagnostic, it blew the budget on **series data**, not on postings. A TSDB index is written in order: symbol table, then series records, then postings. If you run out of room while still writing series records, the block was over budget early, before the postings section (usually the largest single section) had even started. The proposed merge wasn't marginally too big. It was decisively too big.

## Why 64 GiB is a wall, not a tunable

This limit lives in the index format itself. From `tsdb/index/index.go` (verified at `v3.13.1`, and still present on `main`):

```go
var ErrIndexExceeds64GiB = errors.New("exceeding max size of 64GiB")

// For now the index file must not grow beyond 64GiB. Some of the fixed-sized
// offset references in v1 are only 4 bytes large.
// Once we move to compressed/varint representations in those areas, this limitation
// can be lifted.
if fw.pos > 16*math.MaxUint32 {
    return fmt.Errorf("%q %w", fw.name, ErrIndexExceeds64GiB)
}
```

The `16 *` multiplier is worth understanding, because it also explains the second half of your error message.

A 4-byte reference can address 2³² distinct values. If those references counted bytes, the ceiling would be 4 GiB. Instead, the index pads the series section to 16-byte boundaries and stores references in units of 16 bytes, so a 4-byte ref addresses `16 × 2³²` bytes, which is exactly 64 GiB. That alignment is done by `AddPadding`, which is a thin wrapper over the same `Write` that enforces the guard:

```go
// AddPadding adds zero byte padding until the file size is a multiple size.
func (fw *FileWriter) AddPadding(size int) error {
	p := fw.pos % uint64(size)
	if p == 0 {
		return nil
	}
	p = uint64(size) - p

	if err := fw.Write(make([]byte, p)); err != nil {
		return fmt.Errorf("add padding: %w", err)
	}
	return nil
}
```

That is why the same error appears twice with two different prefixes. The padding that makes the 16-byte reference scheme work is itself a write, and it fails against the ceiling that scheme creates.

The practical consequence: **there is no flag for this.** Adding memory does not help. Faster disks do not help. Upgrading does not help, since the limit is unchanged from 3.x through current `main`, and lifting it requires a varint index format that has not landed. If a merge would produce an index over 64 GiB, that merge is impossible on this Prometheus, today.

## What Prometheus actually does after the failure

This is the part that determines how alarmed to be, and the source is clearer than most of the discussion you'll find online.

**The half-built block is cleaned up.** The `write` path removes the temp directory in a `defer`:

```go
if err := os.RemoveAll(tmp); err != nil {
    c.logger.Error("removed tmp folder after failed compaction", "err", err.Error())
}
```

**The source blocks are untouched and still queryable.** Compaction is copy-then-swap. Nothing is deleted until a new block is successfully written, and no new block was written.

**Each source block is marked failed.** In `tsdb/compact.go`, when compaction returns an error that isn't `context.Canceled`:

```go
if err := b.setCompactionFailed(); err != nil {
    errs = append(errs, fmt.Errorf("setting compaction failed for block: %s: %w", b.Dir(), err))
}
```

That writes `compaction.failed: true` into each block's `meta.json`.

**And then the planner avoids them, aggressively.** This is stronger than it's usually described. In `selectDirs`:

```go
for _, dm := range p {
    if dm.meta.Compaction.Failed {
        continue Outer
    }
}
```

A single failed block causes the planner to skip the **entire candidate range**, not just that block. So the time span covered by those three blocks is now stranded: it stays as several smaller blocks and will not be retried. Other time ranges keep compacting normally.

So the real risk profile is:

- **Not** data loss. Your metrics are intact and queryable.
- Disk usage grows, because a range that should have been merged (and deduplicated at the symbol level) stays split.
- More block indexes to open and search for queries spanning that range.
- The same failure will recur in *later* ranges as they reach the same tier, unless the underlying growth is contained.
- The genuine emergency scenario is disk exhaustion, which *would* take down ingestion.

> **Do not delete the source block directories.** They are your data. Removing them to "clean up the failed compaction" discards those entire time ranges permanently. The `.tmp-for-creation` directory is the only thing safe to remove, and Prometheus already removes it.

## Why your head cardinality can look completely reasonable

The instinct is to check `/api/v1/status/tsdb`, see a sane active series count, and conclude cardinality isn't the problem. That conclusion is wrong, and it's the single most common misread of this failure.

**A block index describes every distinct label set that existed anywhere in that block's time range, not what is live right now.** A series that existed for eleven minutes yesterday and never again still needs a symbol-table entry, a series record, label references, and chunk metadata in every block covering that eleven minutes. Churn is invisible to head stats and enormous in block indexes.

Ranked by how much they typically contribute:

1. **Distinct historical series.** Usually dominant.
2. **Series churn.** Short-lived series mean a long-range block contains vastly more series than the head ever holds at once. This is the factor people miss.
3. **Labels per series.** Every series record carries a reference per label.
4. **Chunks per series.** Series records also carry chunk metadata. A long block span at a high sample rate inflates the index even when the label set is perfectly stable.
5. **Symbol-table size.** Many unique label *names* and *values*, meaning high-entropy strings, enlarge the symbol table directly.

Because your failure landed in `add series`, factors 1, 3, and 4 are the ones to weigh first.

The usual sources of unbounded churn, in rough order of how often they turn out to be the culprit:

- `pod`, `pod_uid`, `container_id`, and ephemeral `instance` values or pod IPs, where every rollout mints a fresh set
- Deployment hashes and ReplicaSet identifiers
- Request, trace, session, transaction, or user identifiers
- Raw URL paths containing IDs (`/users/839204` instead of `/users/{id}`)
- Label values that change on every service-discovery refresh
- Classic histogram buckets multiplied across many label combinations

Every one of these is a case of a label whose value space is controlled by something other than you: the scheduler, the client, the user. That is the definition of unbounded cardinality, and the Prometheus documentation warns against it explicitly for exactly this reason.

## Triage step 1: measure the three blocks

Use the `promtool` binary matching your Prometheus version, since index format details differ across major versions.

```bash
DB=/var/lib/prometheus/metrics2

blocks=(
  01KJQ22FD0C2VFGQC2T8QP70P2
  01KK8B5EK0CPXWDGPRD3H89ZQP
  01KKSP6NZ0EYNDGJFJTD3D6N6F
)

promtool tsdb list -r "$DB"

for b in "${blocks[@]}"; do
  echo "===== $b ====="

  stat -c 'index_bytes=%s' "$DB/$b/index"
  du -sh "$DB/$b"

  jq '{
    ulid,
    range_hours: ((.maxTime - .minTime) / 3600000),
    stats,
    compaction: {
      level: .compaction.level,
      failed: (.compaction.failed // false),
      source_count: ((.compaction.sources // []) | length)
    }
  }' "$DB/$b/meta.json"
done
```

What you are looking for:

- `stats.numSeries`, the historical series count per block, which is the number that actually matters
- `stats.numChunks`, chunk references, contributor #4 above
- Current index size per block. Sum them and compare against 64 GiB. If the sum is already near or over the ceiling, the merge was never going to fit and no amount of retrying will change that
- `range_hours`, the tier each block occupies, which you need for the containment step
- `compaction.failed`, confirming the blocks are now marked and being skipped

Then analyze each block. `promtool tsdb analyze` exists precisely for this: its help text is *"Analyze churn, label pair cardinality and compaction efficiency."*

```bash
for b in "${blocks[@]}"; do
  echo "===== analyzing $b ====="
  promtool tsdb analyze --limit=50 "$DB" "$b" \
    | tee "/tmp/${b}.analyze.txt"
done
```

`--limit` controls how many entries appear in each list (default 20). Start **without** `--extended`, because extended analysis on blocks this size drives substantial I/O and memory pressure, and you are already in a capacity incident. Run one block at a time, and prefer a snapshot or a copy on a machine that isn't serving queries.

The output ranks label pairs by series count and reports churn. In practice one label name is usually responsible for most of the index, and it shows up immediately.

## Triage step 2: the head and the API

```bash
curl -s 'http://127.0.0.1:9090/api/v1/status/tsdb?limit=100' |
  jq '.data | {
    headStats,
    seriesCountByMetricName,
    labelValueCountByLabelName,
    memoryInBytesByLabelName,
    seriesCountByLabelValuePair
  }'
```

`/api/v1/status/tsdb/blocks` additionally returns per-block series, sample, and chunk counts for every loaded block, which is a faster way to spot which tiers are trending toward the ceiling.

Keep the caveat in mind: **these are head statistics.** They tell you what is being ingested now. They systematically understate the historical churn that fills block indexes. Use them to find what to fix going forward, and use `promtool tsdb analyze` to understand what already happened.

## Containment

### Protect disk headroom first

```bash
df -h /var/lib/prometheus/metrics2
du -sh /var/lib/prometheus/metrics2
find /var/lib/prometheus/metrics2 \
  -maxdepth 1 -type d -name '*.tmp-for-creation' -print
```

Prometheus removes the temp directory itself, so that `find` should come back empty. If it doesn't, something interrupted the cleanup, so investigate before deleting anything, particularly with Prometheus running. Note also that each failed attempt writes a partial index before failing, so repeated attempts cause transient disk spikes even though nothing is retained.

### Stop the growth at ingestion

`metric_relabel_configs` drops data *before* it enters the TSDB, which is the only intervention that shrinks future block indexes:

- Drop entire metric families you never query
- Remove or normalize unbounded labels
- Drop unused classic histogram buckets, or reduce the configured bucket count
- Don't keep lifecycle identifiers (pod UID, deployment hash) unless a real query uses them
- Template your route labels: `/users/{id}`, never `/users/839204`

One trap worth stating explicitly: **dropping a label can collapse two previously-distinct series into the same label set**, which produces duplicate-sample ingestion errors. Dropping a whole metric family you don't need is safer than surgically removing labels from one you do.

Raising the scrape interval reduces samples and chunk references, contributor #4, but does nothing for unique-series count. It helps at the margin. It is not the fix.

### Cap the maximum block duration

Prometheus compacts 2h blocks into progressively larger tiers. The default ceiling on that progression, from `cmd/prometheus/main.go`:

```go
if cfg.tsdb.MaxBlockDuration == 0 {
	maxBlockDuration, err := model.ParseDuration("31d")
	if err != nil {
		panic(err)
	}
	// When the time retention is set and not too big use to define the max block duration.
	if cfg.tsdb.RetentionDuration != 0 && cfg.tsdb.RetentionDuration/10 < maxBlockDuration {
		maxBlockDuration = cfg.tsdb.RetentionDuration / 10
	}

	cfg.tsdb.MaxBlockDuration = maxBlockDuration
}
```

So: 10% of retention, capped at 31 days.

As emergency containment, read `range_hours` from the failed source blocks, identify the largest tier that still fits comfortably under the ceiling, and pin it:

```text
--storage.tsdb.max-block-duration=<largest-safe-tier>
```

If each failed source block spans roughly 162h, capping at `162h` stops Prometheus from attempting to merge that tier into anything larger.

Be honest about what this buys you. The flag is registered `Hidden()` with the help text *"Maximum duration compacted blocks may span. For use in testing. (Defaults to 10% of the retention period.)"*, so upstream does not consider it a production tuning knob. It requires a restart. It prevents *future* oversized merges, but it does not repair or split the blocks that already failed. And smaller maximum blocks mean more blocks per query, which costs you query performance.

Lowering retention is the supported alternative. It reduces the derived max block duration and eventually ages the failed blocks out, but only once their *entire* time range has expired, so relief is not immediate.

## The durable fix is sharding

An index crossing 64 GiB during routine compaction is a scale signal. Prometheus local storage is explicitly documented as single-node, non-replicated, and not arbitrarily scalable. You have reached the edge of what one TSDB is designed to hold, and every option above is a way of buying time.

The real fix is some combination of:

- **Functional sharding**, splitting by cluster, environment, region, or service group
- **Hash-based target sharding**, distributing scrape targets across multiple Prometheus instances
- **Shorter local retention**, with the long tail living elsewhere
- **Remote write** to horizontally scalable storage such as Thanos, Mimir, Cortex, or VictoriaMetrics. See [Cortex Multi-Tenant Monitoring: Horizontally Scalable Prometheus as a Service](/cortex-multi-tenant-monitoring-production/) for one way to build that tier
- **Reducing churn at the source**, in instrumentation and service discovery, not just relabeling at the edge

One caveat on remote write: it moves the *storage* problem, not the *cardinality* problem. Thanos hits this identical 64 GiB ceiling in its own compactor, for the same reason and in the same code path. If you ship unbounded cardinality downstream, you get the same failure with more moving parts. Fix the churn regardless of where the data lands.

## Bottom line

Treat this as an urgent capacity and scalability incident, not a data-loss incident. Nothing is corrupted, nothing is gone, and one range of history has stopped compacting.

The order that works:

1. Verify disk headroom and confirm the source blocks are healthy and queryable.
2. Analyze the three source blocks for cardinality and churn with `promtool tsdb analyze`.
3. Cut high-cardinality ingestion with `metric_relabel_configs`.
4. Temporarily cap `--storage.tsdb.max-block-duration`, or lower retention.
5. Shard the workload before the next time range reaches the same ceiling.

Restarting won't help. More RAM won't help. Upgrading won't help. The number in the error message is a property of the file format, and the only lever you actually control is how many distinct series you ask it to hold.

## References

- [`tsdb/index/index.go`](https://github.com/prometheus/prometheus/blob/main/tsdb/index/index.go): `ErrIndexExceeds64GiB`, the `16*math.MaxUint32` guard, `AddPadding`
- [`tsdb/compact.go`](https://github.com/prometheus/prometheus/blob/main/tsdb/compact.go): `setCompactionFailed`, `selectDirs`, temp directory cleanup
- [prometheus/prometheus#5868](https://github.com/prometheus/prometheus/issues/5868): feature request to detect and stop compacting blocks that would exceed 64 GiB
- [thanos-io/thanos#1424](https://github.com/thanos-io/thanos/issues/1424): the same ceiling in the Thanos compactor
- [Prometheus storage documentation](https://prometheus.io/docs/prometheus/latest/storage/)
- [kube-prometheus runbook: PrometheusTSDBCompactionsFailing](https://runbooks.prometheus-operator.dev/runbooks/prometheus/prometheustsdbcompactionsfailing/)
