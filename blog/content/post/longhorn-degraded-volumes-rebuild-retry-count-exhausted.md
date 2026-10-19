---
title: "Longhorn Volumes Stuck Degraded With Zero Rebuilds: rebuildRetryCount Exhaustion on Longhorn 1.12"
date: 2026-10-19T09:00:00-05:00
draft: false
tags: ["Longhorn", "Kubernetes", "Storage", "RKE2", "Cilium", "Troubleshooting", "Incident Response", "jq", "Prometheus"]
categories:
- Kubernetes
- Storage
- Troubleshooting
author: "Matthew Mattox - mmattox@support.tools"
description: "Why 43 Longhorn 1.12 volumes stayed degraded for hours with no rebuilds after a network flap, why deleting replicas failed, why a published zombie-replica jq filter is unsafe on 1.12, and the one-field fix."
more_link: "yes"
url: "/longhorn-degraded-volumes-rebuild-retry-count-exhausted/"
---

After a cluster-wide maintenance outage, every node was back, `Ready`, and quiet. Cilium health checks were green. The network had been stable for hours. And 43 Longhorn volumes were still `degraded`, with **zero** replicas rebuilding, an empty `status.rebuildStatus` on every affected engine, and twelve volumes running on a single healthy replica. Nothing was wrong with the cluster anymore. Longhorn had simply stopped trying.

The cause was a single per-replica counter, `spec.rebuildRetryCount`, that had climbed to its hard-coded ceiling of 5 during an hour of network flapping and then never came back down. The usual remedy (delete the failed replica and let Longhorn create a fresh one) did not work on Longhorn 1.12. A SUSE knowledge base article describing the downstream symptom offered a cleanup filter that, run as written on 1.12, would have deleted replicas that were actively rebuilding. This post walks through the diagnosis, the trap, the one-field fix, and the copy-paste commands to find the same condition on any cluster.

<!--more-->

## Environment and Background

The cluster in question runs **RKE2** with **Cilium** as the CNI and **Longhorn v1.12.1** for block storage, with KubeVirt workloads on some nodes. The volumes were three-replica, spread across the worker pool.

The outage that preceded this incident had its own root cause: **mixed per-node MTU**. On nodes where KubeVirt attached VM interfaces to a Linux bridge, the bridge's MTU dropped to the smallest port's MTU, Cilium auto-detected that lower value, and nodes ended up disagreeing about the VXLAN MTU. Large encapsulated packets between mismatched nodes were silently dropped. Small packets (health checks, pings, API calls) worked fine, which is exactly why the failure was hard to see, and Longhorn replica traffic, which is mostly large writes, was among the first casualties.

The fix was to pin the MTU to 1500 everywhere and reboot every node. During the same recovery window, two further changes went in: Cilium was switched to **WireGuard** transparent encryption, and two worker nodes were moved to a `br0` bridge layout. Those two nodes flapped on and off the network for roughly an hour while the bridge and encryption changes settled.

That hour is the whole story. Everything below is a consequence of Longhorn trying, and failing, to rebuild replicas on two nodes that kept disappearing.

## The Symptom: Degraded, but Nothing Rebuilding

Hours after the network settled, the state looked like this:

| Signal | Value |
| --- | --- |
| Volumes with `status.robustness: degraded` | 43 |
| Replicas currently rebuilding | 0 |
| Engines with a non-empty `status.rebuildStatus` | 0 |
| Failed replicas | 55, every one on the two nodes that flapped |
| `spec.rebuildRetryCount` on those 55 replicas | 5, on all of them |
| Volumes down to one healthy replica | 12 |
| Node status and `cilium-health` | Healthy, for hours |

A degraded volume with no rebuild in progress is the important shape. Degraded-and-rebuilding is normal after a node reboot and resolves on its own. Degraded-and-idle means something has decided not to rebuild, and it will stay that way until a human intervenes. Twelve volumes on a single replica meant one more disk or node failure away from data loss.

## Root Cause: rebuildRetryCount Hits 5 and Stays There

Longhorn tracks rebuild attempts per replica in `spec.rebuildRetryCount` on the `replicas.longhorn.io` object. Each failed rebuild attempt increments it. Once it reaches **5**, Longhorn stops scheduling rebuilds for that replica.

Three properties make this dangerous after a network event:

1. **The limit is hard-coded.** There is no Longhorn setting to raise it, and nothing in the UI surfaces it.
2. **The counter is per replica and does not decay.** It does not reset when the node becomes healthy again or after some quiet period. A replica that burned through its retries during a transient failure stays exhausted indefinitely.
3. **A flapping node burns retries fast.** Every time a node reappeared, Longhorn started a rebuild onto it; every time it vanished mid-rebuild, the attempt failed and the counter went up. An hour of flapping was more than enough to drive all 55 replicas on those nodes to 5.

The retry ceiling exists for a good reason: it stops Longhorn from hammering a genuinely broken disk forever. The problem is that it cannot tell the difference between "this disk is bad" and "this node was unreachable for a while and is fine now."

## Why Deleting the Failed Replica Did Not Work

The standard advice for a stuck replica is to delete it. Longhorn notices the volume is short a replica, creates a new one, and rebuilds it from a healthy peer. On this cluster, running Longhorn 1.12, that did not happen.

What was observed instead:

- The replacement replica was created with `spec.rebuildRetryCount: 5` already set.
- It came up with `status.currentState: running`.
- It was never added to the engine's `spec.replicaAddressMap`, so the engine never started a rebuild onto it.

The result was a replica that looked alive, consumed an instance-manager process and disk space, and did nothing. Deleting more replicas would only have produced more of these.

## The Second-Order Effect: Rebuild Slot Saturation

Those orphaned replicas caused a second problem. The `longhorn-manager` pod on one of the affected nodes logged this warning roughly **1,900 times in ten minutes**:

```text
Replica rebuilding for map[...] are in progress on this node, which reaches or exceeds the concurrent limit value
```

Longhorn caps concurrent rebuilds per node with the `concurrent-replica-rebuild-per-node-limit` setting. Running replicas that had never become healthy, and were not attached to any engine, were being counted against that cap. With the cluster's limit set to 2, a couple of zombie replicas were enough to occupy every slot on the node, which blocked rebuilds for replicas that did not have exhausted counters.

This is the same failure mode SUSE documents in KB 000023009, [Harvester VM volumes stuck in Degraded state due to Longhorn rebuild slot saturation](https://support.scc.suse.com/s/kb/Harvester-VM-volumes-stuck-in-Degraded-state-due-to-Longhorn-rebuild-slot-saturation?language=en_US). The article was written against Longhorn 1.9.x and 1.10.x underneath Harvester, and it was the most useful public reference found during this incident. Credit where it is due: it correctly identified slot saturation as the mechanism, and its guidance on the concurrency setting (covered below) is sound.

Its remediation is to find and delete **zombie replicas**, defined roughly as replicas that are running, have never been healthy (`spec.healthyAt` is empty), and do not appear in any engine's `status.currentReplicas` list.

## The Trap: The KB's Filter on Longhorn 1.12

On Longhorn 1.12, the `Engine` custom resource has **no `status.currentReplicas` field at all**. On this cluster, zero of 89 engines had it.

That changes what the zombie filter means. When the "is this replica referenced by an engine?" check reads a field that does not exist, the referenced set is empty, and the filter reduces to "every running replica that has never been healthy." That set includes every replica that is **actively rebuilding right now**, because a replica in the middle of a rebuild is running, attached to its engine in write-only (`WO`) mode, and has not yet been marked healthy.

In other words, the filter as written does not find zombies on 1.12. It finds rebuilds in progress, and running a delete loop over its output would cancel them. On a cluster with volumes already down to one replica, that is the wrong direction to move in.

The general lesson is worth stating plainly: a jq filter in a knowledge base article is written against a specific schema, and Longhorn's CRD schemas change between minor releases. A missing field does not cause jq to fail. It quietly evaluates to `null`, and the filter quietly matches far more than intended.

### Checking Field Existence Before Trusting a Filter

Before running any published filter against Longhorn objects, confirm the fields it depends on actually exist on your version:

```bash
# Does this Longhorn version populate the fields the filter relies on?
kubectl -n longhorn-system get engines.longhorn.io -o json \
  | jq '{engines: (.items | length),
         with_currentReplicas: ([.items[] | select(.status.currentReplicas != null)] | length),
         with_replicaModeMap:  ([.items[] | select(.status.replicaModeMap != null)] | length)}'
```

On Longhorn 1.12.1 this returns output like the following (the incident cluster reported 0 of 89 at the time):

```json
{
  "engines": 91,
  "with_currentReplicas": 0,
  "with_replicaModeMap": 87
}
```

Zero means the field is not there. Any filter that relies on it is broken on this version, regardless of how well it worked on the version it was written for.

### A Zombie Filter That Is Safe on 1.12

On 1.12 the engine records which replicas it knows about in two places: `spec.replicaAddressMap` (replicas the engine is configured to use) and `status.replicaModeMap` (replicas the engine is actually talking to, with mode `RW`, `WO`, or `ERR`). Treat the union of both maps' keys as the active set. A replica is only a zombie if it is running, has never been healthy, and is in neither map.

```bash
# Snapshot the engines once, then compare every replica against them.
NS=longhorn-system
ENGINES=$(mktemp)
kubectl -n "$NS" get engines.longhorn.io -o json > "$ENGINES"

kubectl -n "$NS" get replicas.longhorn.io -o json \
  | jq -r --slurpfile eng "$ENGINES" '
      # Every replica name any engine references, from spec or status.
      ([ $eng[0].items[]
         | ((.status.replicaModeMap   // {}) | keys[]),
           ((.spec.replicaAddressMap  // {}) | keys[]) ] | unique) as $active
      | .items[]
      | select(.status.currentState == "running")
      | select((.spec.healthyAt // "") == "")
      | select(.metadata.name as $n | $active | index($n) | not)
      | [.metadata.name, .spec.nodeID, .spec.volumeName,
         "retry=\(.spec.rebuildRetryCount // 0)"] | @tsv'

rm -f "$ENGINES"
```

The difference is not academic. Run against the same cluster partway through recovery, the naive "running and never healthy" filter matched 25 replicas, every one of them a `WO` replica mid-rebuild. The filter above matched 0.

## The Fix: Reset the Counter

Since the counter is the thing blocking rebuilds, the fix is to reset it. `spec.rebuildRetryCount` is an ordinary spec field and can be patched directly:

```bash
kubectl -n longhorn-system patch replicas.longhorn.io pvc-0f3c2a9e-r-7b1d44c2 \
  --type=merge -p '{"spec":{"rebuildRetryCount":0}}'
```

Do this only once the underlying cause is actually fixed. If the nodes are still flapping, resetting the counter just hands Longhorn five more attempts to burn.

### Confirm Before Patching

List what will be touched first, grouped by node. If every exhausted replica sits on the nodes that had the network problem, that is a strong confirmation of the diagnosis:

```bash
# Exhausted replicas per node.
kubectl -n longhorn-system get replicas.longhorn.io -o json \
  | jq -r '[.items[] | select((.spec.rebuildRetryCount // 0) >= 5)]
           | group_by(.spec.nodeID)[]
           | "\(.[0].spec.nodeID)\t\(length)"'
```

```bash
# The individual replicas, with state and volume.
kubectl -n longhorn-system get replicas.longhorn.io -o json \
  | jq -r '.items[] | select((.spec.rebuildRetryCount // 0) >= 5)
           | [.metadata.name, .spec.nodeID, .status.currentState, .spec.volumeName] | @tsv'
```

### The Patch Loop

```bash
#!/usr/bin/env bash
# Reset rebuildRetryCount on every Longhorn replica that has hit the retry ceiling.
# Set DRY_RUN=0 to apply; the default is a server-side dry run.
set -euo pipefail

NS=longhorn-system
DRY_RUN="${DRY_RUN:-1}"
dry_flag=()
[[ "$DRY_RUN" == "1" ]] && dry_flag=(--dry-run=server)

mapfile -t exhausted < <(
  kubectl -n "$NS" get replicas.longhorn.io -o json \
    | jq -r '.items[] | select((.spec.rebuildRetryCount // 0) >= 5) | .metadata.name'
)

echo "exhausted replicas: ${#exhausted[@]} (dry run: $DRY_RUN)"

for r in "${exhausted[@]}"; do
  kubectl -n "$NS" patch replicas.longhorn.io "$r" "${dry_flag[@]}" \
    --type=merge -p '{"spec":{"rebuildRetryCount":0}}'
done
```

### What Happened Next

The effect was close to immediate. Within about a minute of resetting the 55 counters:

- Concurrent rebuilds across the cluster went from **4 to 25**.
- The "reaches or exceeds the concurrent limit" warnings dropped to **zero**.
- Degraded volumes went from **43 to 27** and kept draining as rebuilds completed.

Running the safe zombie filter afterward found **zero** zombies. The replicas that had been running but orphaned joined their engines on their own once their counters were reset. In this incident there was nothing to delete: the "zombies" were simply replicas Longhorn had given up on, and resetting the counter brought them back into use.

## Diagnostic Commands

The commands below are what was used to work through this incident, cleaned up for reuse. They are read-only and written against Longhorn 1.12 field names:

- Replicas: `spec.rebuildRetryCount`, `spec.healthyAt`, `spec.failedAt`, `spec.nodeID`, `spec.volumeName`, `status.currentState`
- Engines: `spec.replicaAddressMap`, `status.replicaModeMap`, `status.rebuildStatus[<addr>].isRebuilding` and `.progress`
- Volumes: `status.robustness`, `status.state`

### Count Replicas by rebuildRetryCount

This should be the first command run after any network flap or multi-node reboot. Anything at 5 is a replica Longhorn will not touch again on its own.

```bash
kubectl -n longhorn-system get replicas.longhorn.io -o json \
  | jq -r '.items | group_by(.spec.rebuildRetryCount // 0)[]
           | "rebuildRetryCount=\(.[0].spec.rebuildRetryCount // 0)  replicas=\(length)"'
```

During this incident the output had exactly two lines: the healthy majority at 0, and 55 replicas at 5, all on the two nodes that had flapped.

### List Degraded Volumes

```bash
kubectl -n longhorn-system get volumes.longhorn.io -o json \
  | jq -r '.items[] | select(.status.robustness == "degraded")
           | [.metadata.name, .status.state, "replicas=\(.spec.numberOfReplicas)"] | @tsv'
```

### Map Missing Replicas to Nodes

For each volume with an unhealthy replica, show how many healthy replicas remain and where the unhealthy ones live. Sort by `healthy=1` first; those are the volumes with no redundancy left.

```bash
kubectl -n longhorn-system get replicas.longhorn.io -o json \
  | jq -r '.items | group_by(.spec.volumeName)[]
           | {vol: .[0].spec.volumeName,
              healthy: ([.[] | select(.spec.healthyAt != "" and .spec.failedAt == "")] | length),
              bad: [.[] | select(.spec.healthyAt == "" or .spec.failedAt != "")
                        | "\(.spec.nodeID):\(.status.currentState):retry=\(.spec.rebuildRetryCount // 0)"]}
           | select(.bad | length > 0)
           | "healthy=\(.healthy)\t\(.vol)\t\(.bad | join(" "))"' \
  | sort
```

### Check Whether Anything Is Actually Rebuilding

`status.rebuildStatus` is keyed by the destination replica's address in `tcp://ip:port` form, while `spec.replicaAddressMap` stores the bare `ip:port`. The filter below joins them so the output names the replica being rebuilt:

```bash
kubectl -n longhorn-system get engines.longhorn.io -o json \
  | jq -r '.items[]
           | .metadata.name as $engine
           | ((.spec.replicaAddressMap // {}) | with_entries({key: ("tcp://" + .value), value: .key})) as $byAddr
           | (.status.rebuildStatus // {}) | to_entries[]
           | select(.value.isRebuilding)
           | [$engine, ($byAddr[.key] // .key), "\(.value.progress)%", .value.state] | @tsv'
```

For just the count:

```bash
kubectl -n longhorn-system get engines.longhorn.io -o json \
  | jq '[.items[].status.rebuildStatus // {} | to_entries[] | select(.value.isRebuilding)] | length'
```

Degraded volumes plus a count of 0 here is the signature of this incident.

### Grep longhorn-manager Logs for the Slot Warning

```bash
# Per-pod count of rebuild-slot warnings in the last 10 minutes.
kubectl -n longhorn-system logs -l app=longhorn-manager -c longhorn-manager \
  --since=10m --tail=-1 --prefix \
  | grep 'reaches or exceeds the concurrent limit' \
  | awk '{print $1}' | sort | uniq -c | sort -rn
```

Map the noisiest pod back to its node:

```bash
kubectl -n longhorn-system get pods -l app=longhorn-manager \
  -o custom-columns=POD:.metadata.name,NODE:.spec.nodeName
```

The `--tail=-1` is not optional. When `kubectl logs` is given a label selector, it defaults to `--tail=10` per pod, and `--since` does not override that. Without it, the grep sees at most ten lines per pod and reports a handful of warnings when there are thousands.

### Watch Recovery

Once the counters are reset, this loop shows recovery progressing: degraded count falling, rebuilds running, no replicas re-exhausting, and the slot warnings gone.

```bash
#!/usr/bin/env bash
# Print a one-line Longhorn recovery summary every 30 seconds.
NS=longhorn-system
while true; do
  degraded=$(kubectl -n "$NS" get volumes.longhorn.io -o json \
    | jq '[.items[] | select(.status.robustness == "degraded")] | length')
  rebuilding=$(kubectl -n "$NS" get engines.longhorn.io -o json \
    | jq '[.items[].status.rebuildStatus // {} | to_entries[] | select(.value.isRebuilding)] | length')
  exhausted=$(kubectl -n "$NS" get replicas.longhorn.io -o json \
    | jq '[.items[] | select((.spec.rebuildRetryCount // 0) >= 5)] | length')
  slotwarn=$(kubectl -n "$NS" logs -l app=longhorn-manager -c longhorn-manager \
      --since=1m --tail=-1 2>/dev/null \
    | grep -c 'reaches or exceeds the concurrent limit' || true)
  printf '%s degraded=%s rebuilding=%s exhausted=%s slot_warnings_1m=%s\n' \
    "$(date +%H:%M:%S)" "$degraded" "$rebuilding" "$exhausted" "$slotwarn"
  sleep 30
done
```

If `exhausted` starts climbing again after a reset, stop: something is still failing rebuilds, and the counters will burn back to 5. Find that cause before resetting a second time.

## Settings That Matter During Recovery

Three Longhorn settings came up during this incident. All of them live as `settings.longhorn.io` objects with a top-level `value` field:

```bash
kubectl -n longhorn-system get settings.longhorn.io \
  concurrent-replica-rebuild-per-node-limit \
  offline-replica-rebuilding \
  replica-replenishment-wait-interval
```

### concurrent-replica-rebuild-per-node-limit

This caps how many replicas a single node rebuilds at once. The cluster had it at 2, which made slot saturation trivially easy to hit. It was raised to 5:

```bash
kubectl -n longhorn-system patch settings.longhorn.io \
  concurrent-replica-rebuild-per-node-limit --type=merge -p '{"value":"5"}'
```

Do not go higher than 5. The SUSE KB warns against exceeding it, citing [longhorn/longhorn#13087](https://github.com/longhorn/longhorn/issues/13087), an instance-manager nil-pointer panic at higher concurrency. Raising the limit also does not fix slot saturation by itself. It only gives the zombie replicas more room before they block everything again. The counter reset is the actual fix.

### offline-replica-rebuilding

When enabled, Longhorn rebuilds replicas of detached volumes. That is useful during a recovery like this one, where detached volumes would otherwise sit degraded until their workloads come back. The downside is that offline rebuild tickets can block volume attaches while a node is down, which turns a node outage into workloads that cannot start. The standing configuration on this cluster is `false`, turned on only during deliberate recovery and turned off again afterward.

### replica-replenishment-wait-interval

This is how long, in seconds, Longhorn waits for a failed replica's node to come back before creating a brand-new replica elsewhere. It was set to `600`. A reasonable wait avoids rebuilding full volumes across the network for a node that is only rebooting. It does nothing for replicas that have exhausted their retry count, which is part of why this incident was so confusing: the replenishment logic was behaving correctly while the per-replica retry logic was silently refusing to act.

## Alerting on the Condition

The single most useful signal from this incident is **a volume that is degraded with no rebuild in progress**. Longhorn 1.12 exports enough metrics to express that directly. Two details are worth knowing:

- `longhorn_volume_robustness` is a one-hot gauge with a `state` label (`healthy`, `degraded`, `faulted`, `unknown`), not a numeric enum. Rules of the form `longhorn_volume_robustness == 2` never fire; the correct form is `longhorn_volume_robustness{state="degraded"} == 1`.
- `longhorn_engine_rebuild_progress` has a series only while a rebuild is in flight, labeled with `pvc` and `pvc_namespace`, which allows joining against the robustness metric.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: longhorn-rebuild-stalled
  namespace: monitoring
spec:
  groups:
    - name: longhorn-rebuild-stalled
      rules:
        # One volume degraded and nothing rebuilding it.
        - alert: LonghornVolumeDegradedNoRebuild
          expr: |
            (longhorn_volume_robustness{state="degraded"} == 1)
            unless on (pvc, pvc_namespace)
            longhorn_engine_rebuild_progress
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "Longhorn volume {{ $labels.pvc_namespace }}/{{ $labels.pvc }} degraded with no rebuild for 30m"
            description: "Check spec.rebuildRetryCount on its replicas; a value of 5 means Longhorn has stopped retrying."
        # Cluster-wide: degraded volumes exist and zero rebuilds are running anywhere.
        - alert: LonghornRebuildsStalledClusterWide
          expr: |
            (count(longhorn_volume_robustness{state="degraded"} == 1) > 0)
            unless on ()
            (count(longhorn_engine_rebuild_progress) > 0)
          for: 15m
          labels:
            severity: critical
          annotations:
            summary: "Longhorn has degraded volumes and no rebuilds running anywhere"
            description: "Rebuilds have stopped cluster-wide. Count replicas by spec.rebuildRetryCount and check longhorn-manager logs for rebuild slot warnings."
```

Verify any alert like this against ground truth before relying on it: a rule that references a metric shape your exporter does not produce loads cleanly, validates, and stays silent forever. Compare `count(longhorn_volume_robustness{state="degraded"} == 1)` against the degraded count from `kubectl` and confirm they agree.

## Lessons

- **After any network flap or multi-node reboot, check `rebuildRetryCount` first.** It takes one command, and it is the difference between a few minutes of recovery and hours of staring at volumes that are not rebuilding.
- **Degraded with zero rebuilds is a distinct failure state.** It does not self-heal. Treat it as an incident, and alert on it explicitly rather than on degraded volumes alone.
- **Don't trust a KB's jq across Longhorn versions.** Check that every field the filter depends on exists, with something like `jq '[.items[] | select(.status.currentReplicas)] | length'`. A missing field turns a precise filter into a broad one without any error.
- **Don't delete and hope.** On 1.12, deleting an exhausted replica produced another exhausted replica. Understand why Longhorn is not rebuilding before removing anything.
- **Fix the network first, then reset counters.** The retry limit is a safety mechanism. Resetting it while the underlying fault is still present just burns through the retries again.
- **Keep `concurrent-replica-rebuild-per-node-limit` at or below 5**, and keep `offline-replica-rebuilding` off outside of deliberate recovery.

## References

- SUSE KB 000023009: [Harvester VM volumes stuck in Degraded state due to Longhorn rebuild slot saturation](https://support.scc.suse.com/s/kb/Harvester-VM-volumes-stuck-in-Degraded-state-due-to-Longhorn-rebuild-slot-saturation?language=en_US)
- [longhorn/longhorn#13087](https://github.com/longhorn/longhorn/issues/13087): instance-manager panic at high rebuild concurrency
- [Longhorn settings reference](https://longhorn.io/docs/latest/references/settings/)
- [Longhorn Prometheus metrics](https://longhorn.io/docs/latest/monitoring/metrics/)
