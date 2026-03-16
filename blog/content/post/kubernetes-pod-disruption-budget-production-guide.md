---
title: "Kubernetes PodDisruptionBudgets: Production Patterns for Zero-Downtime Operations"
date: 2027-05-08T00:00:00-05:00
draft: false
tags: ["Kubernetes", "PodDisruptionBudget", "High Availability", "Availability", "Operations", "SRE"]
categories: ["Kubernetes", "SRE"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive production guide to Kubernetes PodDisruptionBudgets covering minAvailable vs maxUnavailable, interaction with node drains, cluster autoscaling, StatefulSets, multi-zone strategies, and Prometheus monitoring."
more_link: "yes"
url: "/kubernetes-pod-disruption-budget-production-guide/"
---

Node drains, cluster upgrades, and voluntary evictions are unavoidable in production Kubernetes operations. Without PodDisruptionBudgets, these operations can inadvertently take down more replicas of a workload than it can tolerate, causing service degradation or outages. PodDisruptionBudgets are the mechanism by which application owners communicate their availability requirements to the Kubernetes control plane, ensuring that voluntary disruptions respect availability constraints.

Despite being a fundamental availability control, PodDisruptionBudgets are frequently misconfigured — too restrictive PDBs block node drains indefinitely, while absent or too-permissive PDBs allow disruptions that exceed application tolerance. This guide covers correct PDB configuration for every production scenario, explains how PDBs interact with the broader Kubernetes ecosystem, and provides monitoring patterns to detect PDB health before it becomes a crisis.

<!--more-->

## What PodDisruptionBudgets Protect Against

Kubernetes distinguishes between two categories of pod termination:

**Voluntary disruptions** are disruptions initiated by cluster operators or automation: node drains (`kubectl drain`), manual pod deletion, Deployment updates that evict pods, cluster autoscaler scale-down, and node maintenance. The Kubernetes eviction API mediates these disruptions, and it respects PDB constraints.

**Involuntary disruptions** are hardware failures, kernel panics, out-of-memory kills, and node network partitions. PDBs provide no protection against involuntary disruptions. Fault tolerance against node loss requires pod anti-affinity, appropriate replica counts, and multi-zone topology.

The distinction matters: teams sometimes create PDBs expecting them to prevent OOM kills or hardware failures. They will not. PDBs are exclusively about voluntary disruption control.

## Core PDB Fields

### Selector

Every PDB must specify a `selector` that identifies the pods it governs. The selector must match the pods of the workload being protected:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: checkout-pdb
  namespace: checkout
spec:
  selector:
    matchLabels:
      app: checkout
      tier: backend
```

Use the same label selector as the controlling Deployment, StatefulSet, or ReplicaSet. A PDB with a selector that matches no pods is valid but ineffective — Kubernetes will not report an error, and evictions will proceed unconstrained.

### minAvailable

`minAvailable` specifies the minimum number (or percentage) of pods that must remain available after a disruption is applied:

```yaml
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: checkout
```

If the Deployment has 3 replicas, Kubernetes will evict at most 1 pod at a time. If the Deployment has been scaled down to 2 replicas, no pods can be evicted until the desired replica count is increased.

### maxUnavailable

`maxUnavailable` specifies the maximum number (or percentage) of pods that may be unavailable at any point during a disruption:

```yaml
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: checkout
```

`maxUnavailable: 1` and `minAvailable: N-1` are equivalent when the Deployment is at its desired replica count, but they behave differently when the Deployment is scaled or has existing unavailable pods. This distinction is critical and covered in the next section.

### Percentage Values

Both `minAvailable` and `maxUnavailable` accept percentage strings:

```yaml
spec:
  minAvailable: "50%"
  # OR
  maxUnavailable: "25%"
```

Percentages are rounded. For `minAvailable`, the result is rounded **up** (conservative — protects more pods). For `maxUnavailable`, the result is rounded **down** (conservative — allows fewer disruptions). A `minAvailable: "50%"` on a Deployment with 3 replicas means at least 2 pods must be available (50% of 3 = 1.5, rounded up to 2).

## minAvailable vs maxUnavailable: When the Difference Matters

The practical difference between `minAvailable` and `maxUnavailable` surfaces when the current number of available pods is below the desired replica count — for example, during a rolling update, after a pod crash, or during a gradual scale-up.

### Scenario: Rolling Update in Progress

A Deployment with 4 desired replicas is in the middle of a rolling update. Two pods are on the old version and running, one pod is on the new version and running, and one pod is terminating (being replaced by the rolling update). Available pods: 3.

With `minAvailable: 3`: The PDB sees 3 available pods, which equals the minimum. No additional evictions are permitted. The eviction API blocks any drain attempts until the rolling update completes and all 4 pods are available.

With `maxUnavailable: 1`: The PDB sees 1 unavailable pod (the terminating one), which equals the maximum. No additional evictions are permitted. Identical behavior in this case.

With `minAvailable: 2` and the same scenario: 3 available pods > 2 minimum. One additional pod can be evicted, allowing a drain to proceed during the rolling update. This might or might not be acceptable depending on the application's actual tolerance.

### Scenario: Pod Crash

A Deployment with 3 desired replicas has one pod that has crashed and is not running. Available: 2.

With `minAvailable: 2`: 2 available pods equals the minimum. No evictions permitted. Drain is blocked until the crashed pod is replaced and the Deployment returns to 3 running pods.

With `maxUnavailable: 1`: 1 unavailable pod (the crashed one) equals the maximum. No evictions permitted. Same result.

With `minAvailable: 1`: 2 available pods > 1 minimum. One eviction permitted. Drain can proceed even with an already-degraded Deployment. This can cause a 2-pod Deployment to drop to 1 pod briefly, which may or may not be acceptable.

**Recommendation**: Use `minAvailable` for stateful workloads and services with a hard minimum quorum requirement. Use `maxUnavailable` for stateless workloads where the percentage of concurrently unavailable pods is the relevant constraint. Never use both in the same PDB — the spec allows only one.

## UnhealthyPodEvictionPolicy

The `unhealthyPodEvictionPolicy` field (stable in Kubernetes 1.27) controls whether PDB disruption budget calculations include unhealthy pods.

### Default: IfHealthyBudget

The default policy is `IfHealthyBudget`. Under this policy:

- If the number of healthy (running and ready) pods is at or below `minAvailable`, no pods (healthy or unhealthy) can be evicted.
- If the number of healthy pods exceeds `minAvailable`, unhealthy pods can be evicted freely.

This means a stuck unhealthy pod will block drains when the healthy pod count is at the minimum.

### AlwaysAllow

The `AlwaysAllow` policy allows unhealthy pods to be evicted regardless of disruption budget:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: checkout-pdb
  namespace: checkout
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: checkout
  unhealthyPodEvictionPolicy: AlwaysAllow
```

This is the recommended setting for most production workloads because it prevents a CrashLooping or unready pod from blocking node maintenance. The tradeoff is that during a degraded state, nodes can still be drained even when the application is already below its desired availability.

Use `IfHealthyBudget` when the application's availability guarantee must hold even during degraded states — for example, a quorum-based system where evicting an unhealthy member while the cluster is already degraded would be catastrophic.

## PDB Patterns for Common Workloads

### Stateless HTTP Services

For a stateless service with 3+ replicas that can tolerate losing one at a time:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-gateway-pdb
  namespace: api
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: api-gateway
  unhealthyPodEvictionPolicy: AlwaysAllow
```

This allows exactly one pod to be unavailable at any time. For services with many replicas where losing 1 of 20 is trivially safe, consider using a percentage:

```yaml
spec:
  maxUnavailable: "25%"
  selector:
    matchLabels:
      app: api-gateway
  unhealthyPodEvictionPolicy: AlwaysAllow
```

### Databases and Stateful Services with Quorum

For a 3-node database cluster that requires a quorum of 2 nodes:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: postgres-pdb
  namespace: databases
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: postgres
      role: cluster-member
  unhealthyPodEvictionPolicy: IfHealthyBudget
```

`IfHealthyBudget` is intentional here: if one node is already unhealthy, the database cluster is already degraded. Evicting another node to drain the host would break quorum and cause data unavailability.

For a 5-node cluster tolerating 2 failures:

```yaml
spec:
  minAvailable: 3
  selector:
    matchLabels:
      app: cassandra
```

### Kafka or ZooKeeper Clusters

Kafka and ZooKeeper are sensitive to leadership elections. Evicting the leader triggers an election that temporarily affects availability. The PDB should prevent losing more than one broker at a time:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: kafka-pdb
  namespace: kafka
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: kafka
      app.kubernetes.io/component: broker
```

For a 3-node ZooKeeper ensemble, losing more than 1 node breaks quorum (3 nodes require 2 for quorum):

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: zookeeper-pdb
  namespace: kafka
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app.kubernetes.io/name: zookeeper
```

### Redis Sentinel

A Redis Sentinel setup with 3 Sentinel pods requires 2 Sentinels for quorum:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: redis-sentinel-pdb
  namespace: redis
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: redis
      role: sentinel
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: redis-server-pdb
  namespace: redis
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: redis
      role: server
```

Note that the primary and sentinel pods have separate PDBs with separate selectors.

### Single-Replica Workloads

Some workloads intentionally run as a single replica — leader election jobs, batch controllers, and similar. A PDB with `minAvailable: 1` on a single-replica Deployment blocks all voluntary evictions:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: batch-controller-pdb
  namespace: batch
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: batch-controller
```

**This configuration blocks node drains permanently** for the node running the single pod, unless the pod is running and healthy. For single-replica workloads that do not actually require zero-downtime protection, consider whether a PDB is needed at all, or use `maxUnavailable: 1` instead:

```yaml
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: batch-controller
```

With `maxUnavailable: 1`, a drain on the node can proceed because one pod being unavailable is within budget. The pod will be rescheduled on another node before or after eviction depending on node capacity.

## PDB Interaction with Node Drains

`kubectl drain` uses the Kubernetes eviction API to gracefully terminate pods. The eviction API checks PDB constraints before proceeding with each eviction. If a PDB constraint would be violated, the eviction is rejected with HTTP 429 (Too Many Requests).

`kubectl drain` retries rejected evictions by default. The `--timeout` flag controls how long the drain command waits before giving up:

```bash
# Drain with a 10-minute timeout
kubectl drain node-01 \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --timeout=600s

# Drain with --force bypasses PDB checks (DANGEROUS - avoid in production)
kubectl drain node-01 \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --force
```

**Never use `--force` on production nodes** without understanding which PDBs it bypasses and why they are blocking the drain. `--force` treats PDB-protected pods as regular pods and evicts them regardless, potentially causing service outages.

### Diagnosing a Blocked Drain

When a drain is blocked, identify which PDB is preventing eviction:

```bash
# Check which pods are blocking the drain
kubectl drain node-01 --ignore-daemonsets --dry-run=client

# Inspect PDB status for affected namespaces
kubectl get pdb --all-namespaces

# Check a specific PDB's disruptions allowed
kubectl get pdb checkout-pdb -n checkout -o yaml

# Check the pod's eviction status
kubectl describe pod <pod-name> -n <namespace>
```

A PDB report showing `DISRUPTIONS ALLOWED: 0` indicates that the PDB is blocking eviction. Common causes:

1. **Rolling update in progress**: The Deployment is updating pods and the available count is at the minimum. Wait for the rolling update to complete.

2. **Pod not ready**: One or more pods are in a non-ready state, reducing the available count below the minimum.

3. **Replica count too low**: The Deployment was intentionally scaled down, but the PDB's `minAvailable` was not updated to match.

4. **PDB misconfiguration**: `minAvailable` equals or exceeds the total desired replica count, making eviction impossible by definition. A `minAvailable: 3` on a 3-replica Deployment allows zero disruptions.

## PDB Interaction with Cluster Autoscaler

The Cluster Autoscaler respects PDBs when deciding whether to scale down nodes. A node will not be considered for scale-down if evicting its pods would violate any PDB.

### Scale-Down Blocked by PDB

If the Cluster Autoscaler cannot drain a node due to PDB constraints, it marks the node as not removable:

```bash
# Check why a node is not being scaled down
kubectl get events --field-selector involvedObject.name=node-01 \
  | grep -i autoscaler

# Check cluster autoscaler logs
kubectl logs -n kube-system \
  -l app=cluster-autoscaler \
  --tail=100 | grep -i "pdb\|disrupt"
```

Common log messages:

```
I0506 12:34:56 scale_down.go:789] Node node-01 is not removable:
  pod checkout/checkout-5b7f9d4c6-xkrp2 is protected by PDB
  checkout/checkout-pdb, which has 0 disruptions allowed
```

### PDB and Autoscaler Best Practices

To prevent PDBs from blocking autoscaler scale-down indefinitely:

1. Use `maxUnavailable` rather than `minAvailable: N` for stateless services. This allows the autoscaler to evict pods as long as total unavailability stays within bounds.

2. Set `unhealthyPodEvictionPolicy: AlwaysAllow` to prevent unhealthy pods from blocking scale-down.

3. Annotate pods that should never block scale-down (single-replica critical system pods) with `cluster-autoscaler.kubernetes.io/safe-to-evict: "true"`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: log-collector
spec:
  template:
    metadata:
      annotations:
        cluster-autoscaler.kubernetes.io/safe-to-evict: "true"
```

Note that this annotation bypasses PDB protection for the annotated pods — use it only for pods where disruption is truly acceptable.

## PDB Interaction with Horizontal Pod Autoscaler

HPA does not interact with PDBs directly. HPA adds or removes pods by scaling the Deployment's replica count, not by evicting individual pods. However, HPA-driven scale-down of a Deployment can reduce available pods below a `minAvailable` PDB threshold, which will then block subsequent node drains.

### Example: HPA Scales Down During Off-Peak Hours

A Deployment has `maxReplicas: 10` and `minReplicas: 2`. At off-peak hours, HPA scales the Deployment down to 2 replicas. A PDB with `minAvailable: 2` now prevents all evictions — any drain will block because both remaining pods are at the minimum.

The resolution is to align the PDB with the HPA minimum:

```yaml
# If HPA minReplicas is 2, set minAvailable to 1 to allow disruptions
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: web-frontend
```

Or use a percentage that scales proportionally:

```yaml
spec:
  minAvailable: "50%"
```

With `50%`, a 2-replica Deployment requires 1 available pod (50% of 2, rounded up). Evictions are permitted as long as at least 1 pod remains.

## PDB for StatefulSets

StatefulSets require particular care with PDBs because pods have stable identities and ordered termination semantics.

### Ordered Termination and PDB

By default, StatefulSets terminate pods in reverse ordinal order (N-1, N-2, ..., 0) during scale-down. When a node drain evicts a StatefulSet pod, this ordinal ordering is bypassed — the drain evicts whichever pod is on the node being drained, regardless of ordinal.

For databases and consensus systems, this means a drain may evict the pod with ordinal 0 (often the primary) rather than the highest-ordinal replica. The PDB does not prevent this sequencing issue; it only prevents too many pods from being unavailable simultaneously.

For databases, configure the PDB to maintain quorum:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: etcd-pdb
  namespace: etcd
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app.kubernetes.io/name: etcd
```

And configure the database itself to handle leadership failover gracefully.

### StatefulSet with podManagementPolicy: Parallel

StatefulSets with `podManagementPolicy: Parallel` terminate all pods simultaneously during deletion. Combined with a PDB, this creates a contradiction: the StatefulSet wants to delete all pods at once, but the PDB requires some to remain available.

In practice, PDBs govern the eviction API, not the StatefulSet controller's own deletion path. When a StatefulSet is deleted (not drained), the StatefulSet controller deletes pods directly without going through the eviction API, and PDBs are not respected. PDBs apply to `kubectl drain` and the eviction API only.

## Multi-Zone PDB Strategies

For highly available deployments spanning multiple availability zones, PDB configuration needs to account for zone-level topology.

### Zone-Aware PDB

A 6-replica Deployment spread across 3 zones (2 pods per zone) should maintain at least 4 pods — losing more than 2 would leave an entire zone's load on 4 pods:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-ha-pdb
  namespace: api
spec:
  minAvailable: 4
  selector:
    matchLabels:
      app: api-service
```

However, this static value does not adapt if the zone distribution changes. A better approach uses `maxUnavailable` with a percentage:

```yaml
spec:
  maxUnavailable: "33%"
```

For 6 replicas, 33% of 6 = 1.98, rounded down to 1. At most 1 pod can be unavailable at a time. This is more conservative than needed for a 6-replica deployment, but safe.

### Topology Spread Constraints with PDB

Combine `topologySpreadConstraints` with a PDB to ensure zone-aware placement and disruption control:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-service
  namespace: api
spec:
  replicas: 6
  template:
    spec:
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: api-service
      containers:
        - name: api
          image: api-service:v2.1.0
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-service-pdb
  namespace: api
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: api-service
  unhealthyPodEvictionPolicy: AlwaysAllow
```

The `topologySpreadConstraints` ensures pods are spread across zones; the PDB ensures that at most 1 pod is evicted at a time regardless of zone.

## PDB Validation and Common Mistakes

### Mistake 1: PDB Selector Matches No Pods

```yaml
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: checkout  # Pods have label "app: checkout-service"
```

Kubernetes accepts this PDB without error. The PDB is silently ineffective. Validate selectors immediately after creating PDBs:

```bash
# Verify how many pods the PDB governs
kubectl get pdb checkout-pdb -n checkout -o jsonpath='{.status.expectedPods}'
# Should return the Deployment's replica count, not 0
```

### Mistake 2: minAvailable Equals Replica Count

```yaml
# Deployment: replicas: 3
spec:
  minAvailable: 3
  selector:
    matchLabels:
      app: checkout
```

Zero disruptions are ever permitted. No drain will succeed. This is the most common cause of blocked node maintenance. Set `minAvailable` to at most `replicas - 1` (or use `maxUnavailable: 1`).

### Mistake 3: PDB Without Matching Workload Labels

After a Deployment label update, the PDB's selector no longer matches:

```bash
# After this change, the PDB selector no longer matches
kubectl set selector deployment checkout "app=checkout-v2,tier=backend" -n checkout

# The PDB still has selector: app=checkout, tier=backend
# Validate selector alignment
kubectl get pdb checkout-pdb -n checkout -o yaml | grep -A5 selector
kubectl get pods -n checkout -l "app=checkout,tier=backend"
```

Use `kubectl get pods --selector` to verify the PDB selector matches the actual pods.

### Mistake 4: Overlapping PDBs

Multiple PDBs with overlapping selectors compound their effects:

```yaml
# PDB 1: minAvailable: 2
# PDB 2: maxUnavailable: 1
# Both apply to the same pods
```

Kubernetes evaluates all matching PDBs and takes the most restrictive. Two overlapping PDBs may block all disruptions unintentionally. Audit PDB selectors to prevent overlap:

```bash
kubectl get pdb --all-namespaces -o json | \
  jq -r '.items[] | [.metadata.namespace, .metadata.name,
    (.spec.selector.matchLabels | to_entries | map(.key + "=" + .value) | join(","))] |
    @csv'
```

### Mistake 5: Missing PDB for Critical Workloads

The absence of a PDB on critical workloads means any drain can proceed, potentially removing all replicas from a small Deployment simultaneously during a rolling node upgrade.

Create a default PDB for all Deployments with 2+ replicas as a baseline:

```bash
# Find Deployments without PDBs
for ns in $(kubectl get ns -o name | cut -d/ -f2); do
  deployments=$(kubectl get deployment -n "$ns" -o jsonpath='{.items[*].metadata.name}' 2>/dev/null)
  for deploy in $deployments; do
    replicas=$(kubectl get deployment "$deploy" -n "$ns" \
      -o jsonpath='{.spec.replicas}' 2>/dev/null)
    if [ "$replicas" -ge 2 ]; then
      # Get the deployment's label selector
      selector=$(kubectl get deployment "$deploy" -n "$ns" \
        -o jsonpath='{.spec.selector.matchLabels}' 2>/dev/null)
      pdb_count=$(kubectl get pdb -n "$ns" 2>/dev/null | grep -c "$deploy" || echo 0)
      if [ "$pdb_count" -eq 0 ]; then
        echo "MISSING PDB: $ns/$deploy (replicas: $replicas)"
      fi
    fi
  done
done
```

## Disruption Budget Calculation

The `status` subresource of a PDB reports the computed disruption budget in real time:

```bash
kubectl get pdb -n checkout
# NAME           MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS   AGE
# checkout-pdb   2               N/A               1                     45d
```

The `ALLOWED DISRUPTIONS` column shows how many pods can currently be disrupted. A value of 0 means no evictions are permitted.

Inspect the full status:

```bash
kubectl get pdb checkout-pdb -n checkout -o yaml
```

```yaml
status:
  conditions:
    - lastTransitionTime: "2027-05-06T00:00:00Z"
      message: ""
      observedGeneration: 1
      reason: SufficientPods
      status: "True"
      type: DisruptionAllowed
  currentHealthy: 3
  desiredHealthy: 2
  disruptionsAllowed: 1
  expectedPods: 3
  observedGeneration: 1
```

Key fields:

- `currentHealthy`: Number of pods currently running and ready.
- `desiredHealthy`: The minimum number required (derived from `minAvailable` or `maxUnavailable` calculation against `expectedPods`).
- `disruptionsAllowed`: Pods that can be evicted right now (`currentHealthy - desiredHealthy`).
- `expectedPods`: Total pods matching the PDB selector (should match the Deployment's desired replica count).

## Monitoring PDB Status with Prometheus

The `kube-state-metrics` component exposes PDB status as Prometheus metrics.

### Key Metrics

```prometheus
# Current number of healthy pods
kube_poddisruptionbudget_status_current_healthy

# Desired minimum healthy pods
kube_poddisruptionbudget_status_desired_healthy

# Number of disruptions allowed
kube_poddisruptionbudget_status_pod_disruptions_allowed

# Expected pods (total matching selector)
kube_poddisruptionbudget_status_expected_pods

# Whether disruption is allowed at all
kube_poddisruptionbudget_status_disruptions_allowed
```

### Prometheus Alert Rules

```yaml
groups:
  - name: pdb-alerts
    rules:
      - alert: PDBZeroDisruptionsAllowed
        expr: |
          kube_poddisruptionbudget_status_pod_disruptions_allowed == 0
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "PDB {{ $labels.namespace }}/{{ $labels.poddisruptionbudget }} has 0 disruptions allowed"
          description: |
            PDB {{ $labels.namespace }}/{{ $labels.poddisruptionbudget }} has had
            zero disruptions allowed for 30 minutes. This may block node drains and
            cluster maintenance. Current healthy: {{ $labels.current_healthy }}.
            Check for pods in non-ready state or a rolling update in progress.

      - alert: PDBMisconfigured
        expr: |
          kube_poddisruptionbudget_status_expected_pods == 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "PDB {{ $labels.namespace }}/{{ $labels.poddisruptionbudget }} selector matches no pods"
          description: |
            PDB {{ $labels.namespace }}/{{ $labels.poddisruptionbudget }} has an
            expectedPods count of 0, indicating its selector matches no running pods.
            The PDB is ineffective and should be reviewed.

      - alert: PDBCurrentHealthyBelowDesired
        expr: |
          kube_poddisruptionbudget_status_current_healthy
            < kube_poddisruptionbudget_status_desired_healthy
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "PDB {{ $labels.namespace }}/{{ $labels.poddisruptionbudget }} is below desired healthy"
          description: |
            PDB {{ $labels.namespace }}/{{ $labels.poddisruptionbudget }} reports
            current healthy pods ({{ $value }}) below the desired healthy minimum.
            The workload is currently below its availability target. Investigate
            CrashLooping, evicted, or unhealthy pods in the namespace.

      - alert: PDBBlockingNodeDrain
        expr: |
          kube_node_spec_unschedulable == 1
          and on() kube_poddisruptionbudget_status_pod_disruptions_allowed == 0
        for: 1h
        labels:
          severity: warning
        annotations:
          summary: "Node drain may be blocked by PDB in namespace {{ $labels.namespace }}"
          description: |
            At least one node is cordoned (unschedulable) and at least one PDB
            has zero disruptions allowed. A node drain may be in progress and
            blocked by a PDB. Review PDB status and check for ongoing maintenance.
```

### Grafana Dashboard Queries

Key queries for a PDB health dashboard:

```promql
# PDBs with zero disruptions allowed
count by (namespace, poddisruptionbudget) (
  kube_poddisruptionbudget_status_pod_disruptions_allowed == 0
)

# Average disruptions allowed per namespace
avg by (namespace) (
  kube_poddisruptionbudget_status_pod_disruptions_allowed
)

# PDBs where current healthy is below desired
(kube_poddisruptionbudget_status_desired_healthy
  - kube_poddisruptionbudget_status_current_healthy) > 0

# Percent of PDBs at zero disruptions allowed
(
  count(kube_poddisruptionbudget_status_pod_disruptions_allowed == 0)
  /
  count(kube_poddisruptionbudget_status_pod_disruptions_allowed)
) * 100
```

## PDB in GitOps Workflows

PDBs should be version-controlled alongside the workloads they protect. In a GitOps workflow, create PDBs in the same directory or chart as the Deployment:

```
apps/checkout/
  deployment.yaml
  service.yaml
  pdb.yaml          # Always co-located with the workload
  hpa.yaml
```

Kustomize or Helm should render PDBs as part of the application bundle. Avoid creating PDBs through ad-hoc `kubectl apply` without corresponding repository updates.

### Helm Chart PDB Template

A Helm chart template for a reusable PDB:

```yaml
{{- if .Values.podDisruptionBudget.enabled }}
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: {{ include "app.fullname" . }}-pdb
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "app.labels" . | nindent 4 }}
spec:
  {{- if .Values.podDisruptionBudget.minAvailable }}
  minAvailable: {{ .Values.podDisruptionBudget.minAvailable }}
  {{- else if .Values.podDisruptionBudget.maxUnavailable }}
  maxUnavailable: {{ .Values.podDisruptionBudget.maxUnavailable }}
  {{- end }}
  selector:
    matchLabels:
      {{- include "app.selectorLabels" . | nindent 6 }}
  {{- if .Values.podDisruptionBudget.unhealthyPodEvictionPolicy }}
  unhealthyPodEvictionPolicy: {{ .Values.podDisruptionBudget.unhealthyPodEvictionPolicy }}
  {{- end }}
{{- end }}
```

Default values:

```yaml
podDisruptionBudget:
  enabled: true
  maxUnavailable: 1
  unhealthyPodEvictionPolicy: AlwaysAllow
```

## Summary

PodDisruptionBudgets are a critical but often overlooked component of production Kubernetes availability. The key operational principles are:

**Use `maxUnavailable` for stateless workloads** where the proportion of concurrently unavailable pods matters, rather than an absolute count.

**Use `minAvailable` for quorum-based stateful workloads** where a specific minimum number of members must remain running for the cluster to function.

**Set `unhealthyPodEvictionPolicy: AlwaysAllow`** for most workloads to prevent stuck unhealthy pods from blocking node maintenance indefinitely.

**Avoid `minAvailable` equaling the total replica count** — this creates an immovable object that blocks all voluntary disruptions permanently.

**Align PDB constraints with HPA minimum replicas** to prevent off-peak scale-downs from inadvertently creating zero-disruption situations.

**Monitor PDB status with Prometheus** and alert when PDBs reach zero disruptions allowed for extended periods, as this is a leading indicator of blocked maintenance windows.

**Co-locate PDB manifests with workload definitions** in version control to ensure PDBs are always synchronized with their workloads and do not drift.
