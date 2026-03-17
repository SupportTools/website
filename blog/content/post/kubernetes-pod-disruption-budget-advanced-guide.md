---
title: "Kubernetes Pod Disruption Budgets: High Availability Guarantees During Cluster Operations"
date: 2027-08-13T00:00:00-05:00
draft: false
tags: ["Kubernetes", "High Availability", "PodDisruptionBudget"]
categories:
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "PodDisruptionBudget strategy for stateful and stateless workloads in Kubernetes, covering interaction with cluster autoscaler, node drains, rolling updates, and calculating appropriate minAvailable and maxUnavailable values for production."
more_link: "yes"
url: "/kubernetes-pod-disruption-budget-advanced-guide/"
---

PodDisruptionBudgets (PDBs) are the primary mechanism for guaranteeing application availability during voluntary disruptions — node drains, cluster upgrades, and autoscaler scale-down operations. Without PDBs, a drain operation can terminate all pods of a Deployment simultaneously, causing a complete service outage. With properly configured PDBs, Kubernetes ensures that the eviction API respects minimum availability thresholds, making cluster maintenance operations safe for production workloads.

<!--more-->

## PDB Fundamentals

A PodDisruptionBudget defines the minimum number of pods that must remain available (or the maximum number that can be unavailable) during a voluntary disruption. The eviction API enforces these constraints when performing node drains, while rolling updates use the Deployment's own `maxUnavailable` strategy.

### minAvailable vs. maxUnavailable

```yaml
# Absolute: at least 3 pods must be available at all times
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: frontend-pdb
  namespace: production
spec:
  minAvailable: 3
  selector:
    matchLabels:
      app: frontend

---
# Percentage: at most 25% of pods may be unavailable
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: backend-pdb
  namespace: production
spec:
  maxUnavailable: 25%
  selector:
    matchLabels:
      app: backend
```

### Checking PDB Status

```bash
kubectl get pdb -n production

# NAME           MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS   AGE
# backend-pdb    N/A             25%               2                     10d
# frontend-pdb   3               N/A               1                     10d
```

`ALLOWED DISRUPTIONS` shows how many pods can currently be evicted while respecting the budget.

## Calculating Appropriate Values

### Stateless Services

For stateless Deployments, `maxUnavailable: 1` (or 25% for larger deployments) is the standard starting point. The key constraint is that at least one replica must remain available at all times:

| Replicas | Recommended PDB |
|----------|----------------|
| 1 | No PDB possible — a drain will always violate availability |
| 2 | `minAvailable: 1` |
| 3-5 | `maxUnavailable: 1` |
| 6-20 | `maxUnavailable: 25%` |
| 20+ | `maxUnavailable: 20%` |

For single-replica workloads, PDBs cannot provide protection. The correct solution is to increase replicas to at least 2.

### Stateful Services

Stateful workloads like databases require more conservative PDBs because losing a replica may affect quorum:

**Odd-quorum services (etcd, Zookeeper, Consul, Raft-based databases):**

```
Available nodes for quorum = floor(N/2) + 1
Maximum safe disruptions = N - quorum_minimum
```

For a 3-node cluster: quorum = 2, max disruptions = 1
For a 5-node cluster: quorum = 3, max disruptions = 2

```yaml
# 3-node etcd cluster
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: etcd-pdb
  namespace: infra
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: etcd

---
# 5-node Kafka cluster (each broker holds data replicas)
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: kafka-pdb
  namespace: production
spec:
  minAvailable: 4
  selector:
    matchLabels:
      app: kafka
```

**Primary-replica databases (PostgreSQL, MySQL):**

```yaml
# PostgreSQL with 1 primary + 2 replicas
# Never disrupt the primary without failover
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: postgresql-pdb
  namespace: production
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: postgresql
```

## PDB Interaction with Node Drain

When `kubectl drain` is executed, the drain controller uses the eviction API for each pod. For each eviction attempt, the API server checks all applicable PDBs. If the eviction would violate any PDB, the API server returns HTTP 429 (Too Many Requests) and the drain operation backs off and retries.

### Drain Behavior with PDBs

```bash
# Standard drain — respects PDBs, retries with backoff
kubectl drain worker-01 --ignore-daemonsets --delete-emissary-data --timeout=300s

# Expected output when PDB is blocking:
# evicting pod production/frontend-xxx
# error when evicting pods/"frontend-xxx" -n "production"
#   (will retry after 5s): Cannot evict pod as it would violate the pod's disruption budget.
# evicting pod production/frontend-xxx
# pod/frontend-xxx evicted
# node/worker-01 drained
```

The drain succeeds once pods from `worker-01` are rescheduled elsewhere and the PDB constraint is satisfied.

### Identifying PDB-Blocked Drains

```bash
# Check which PDBs are currently at their minimum
kubectl get pdb --all-namespaces -o json | jq '
  .items[] |
  select(.status.disruptionsAllowed == 0) |
  {namespace: .metadata.namespace, name: .metadata.name, minAvailable: .spec.minAvailable}
'

# Check disruption budget status in detail
kubectl describe pdb frontend-pdb -n production

# Output:
# Spec:
#   Min Available:  3
# Status:
#   Observed Generation:  1
#   Disruptions Allowed:  0    ← No disruptions currently allowed
#   Current Healthy:      3
#   Desired Healthy:      3
#   Total Replicas:       3
```

### Handling Stuck Drains

When a drain is stuck because a PDB is blocking and no new nodes are available to reschedule pods:

```bash
# Option 1: Temporarily patch the PDB (requires approval process)
kubectl patch pdb frontend-pdb -n production \
    -p '{"spec":{"minAvailable":2}}'

# Perform drain, then restore PDB
kubectl drain worker-01 --ignore-daemonsets --delete-emissary-data --timeout=120s
kubectl patch pdb frontend-pdb -n production \
    -p '{"spec":{"minAvailable":3}}'

# Option 2: Use --disable-eviction (bypasses PDBs entirely — emergency only)
kubectl drain worker-01 \
    --ignore-daemonsets \
    --delete-emissary-data \
    --disable-eviction \
    --force \
    --timeout=60s
```

## PDB Interaction with Cluster Autoscaler

The Cluster Autoscaler respects PDBs during scale-down operations. A node will not be scaled down if doing so would violate any PDB of pods running on it.

### Autoscaler Scale-Down Rules

The autoscaler evaluates a node for removal when:
- The node has been underutilized (below `scale-down-utilization-threshold`) for `scale-down-unneeded-time`
- All pods on the node can be safely rescheduled
- No PDB would be violated

If PDBs prevent scale-down, the autoscaler logs:

```
I0812 Node worker-03 is not suitable for removal: can't move kube-system/coredns-xxx: 
  Pod kube-system/coredns-xxx has too few replicas for the disruption budget
```

### Autoscaler-Friendly PDB Configuration

For workloads with many replicas, `maxUnavailable` as a percentage scales better than absolute values because the autoscaler can always find a value that works:

```yaml
# Absolute minAvailable can block scale-down when replicas == minAvailable
# Example: 3 replicas, minAvailable: 3 → ALLOWED DISRUPTIONS = 0 → autoscaler blocked
spec:
  minAvailable: 3  # AVOID when replicas may equal this value

---
# Percentage-based is autoscaler-friendly
spec:
  maxUnavailable: 25%  # For 4 replicas: 1 disruption allowed → autoscaler can proceed
```

### Pod Anti-Affinity + PDB Combination

For maximum autoscaler compatibility, combine PDBs with pod anti-affinity to ensure pods are spread across nodes:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend
  namespace: production
spec:
  replicas: 4
  template:
    spec:
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    app: frontend
                topologyKey: kubernetes.io/hostname

---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: frontend-pdb
  namespace: production
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: frontend
```

With 4 replicas spread across 4 nodes, the autoscaler can remove nodes one at a time while `maxUnavailable: 1` ensures continuous service.

## PDB Interaction with Rolling Updates

PDBs do not directly control rolling updates — the Deployment's `maxUnavailable` strategy does. However, they interact when pods from an old ReplicaSet overlap with pods from a new ReplicaSet during a rolling update.

### Preventing Deadlock During Rolling Updates

If `minAvailable` equals the total desired replicas and `maxUnavailable: 0` in the Deployment strategy, a rolling update can deadlock because the old pod cannot be evicted:

```yaml
# AVOID: This configuration causes rolling update deadlock
apiVersion: apps/v1
kind: Deployment
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 0
      maxUnavailable: 0  # Cannot terminate any old pod

---
# And simultaneously:
apiVersion: policy/v1
kind: PodDisruptionBudget
spec:
  minAvailable: 3  # Requires all 3 running at all times
```

The correct pattern is to allow surge replicas so new pods can start before old pods are terminated:

```yaml
# CORRECT: Allow surge during rolling updates
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1       # Allow one extra pod during rollout
      maxUnavailable: 0 # Never terminate old pod before new is ready
```

With `maxSurge: 1`, the rolling update creates 4 pods (3 old + 1 new), waits for the new pod to be Ready, then terminates one old pod. The PDB `minAvailable: 3` is satisfied because 4 pods are running during the transition.

## PDB for DaemonSets

DaemonSets are typically excluded from PDB enforcement because they run exactly one pod per node by design. However, PDBs can be applied to DaemonSets to prevent simultaneous disruption of multiple nodes' DaemonSet pods:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: monitoring-agent-pdb
  namespace: monitoring
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: monitoring-agent
```

This PDB ensures only one monitoring-agent pod (across all nodes) is disrupted at a time during a multi-node drain or upgrade.

## UnhealthyPodEvictionPolicy

Kubernetes 1.27+ added `unhealthyPodEvictionPolicy` to control whether unhealthy (not Ready) pods are counted toward the PDB disruption budget:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: frontend-pdb
  namespace: production
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: frontend
  unhealthyPodEvictionPolicy: AlwaysAllow
```

| Value | Behavior |
|-------|----------|
| `IfHealthyBudget` (default) | Only evict unhealthy pods if the budget currently allows disruptions |
| `AlwaysAllow` | Unhealthy pods can always be evicted, regardless of the budget |

`AlwaysAllow` is recommended for production because it prevents stuck drains caused by already-broken pods that cannot be evicted under the default policy.

## Monitoring PDB Health

### Prometheus Queries

```promql
# PDBs currently blocking disruptions (disruptions allowed = 0)
kube_poddisruptionbudget_status_disruptions_allowed == 0

# PDBs where current healthy < desired healthy (budget violated)
kube_poddisruptionbudget_status_current_healthy
  < kube_poddisruptionbudget_status_desired_healthy

# PDB disruptions allowed per namespace
sum by (namespace, poddisruptionbudget) (
  kube_poddisruptionbudget_status_disruptions_allowed
)
```

### PrometheusRule Alerts

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: pdb-alerts
  namespace: monitoring
spec:
  groups:
    - name: pod-disruption-budget
      rules:
        - alert: PodDisruptionBudgetAtMinimum
          expr: |
            kube_poddisruptionbudget_status_disruptions_allowed == 0
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "PDB {{ $labels.namespace }}/{{ $labels.poddisruptionbudget }} allows zero disruptions"
            description: "This PDB has been blocking disruptions for 15 minutes. Cluster maintenance operations may be stalled."

        - alert: PodDisruptionBudgetViolated
          expr: |
            kube_poddisruptionbudget_status_current_healthy
              < kube_poddisruptionbudget_status_desired_healthy
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "PDB {{ $labels.namespace }}/{{ $labels.poddisruptionbudget }} violated"
            description: "Fewer healthy pods than the PDB requires. Current: {{ $value }} expected >= {{ with query \"kube_poddisruptionbudget_status_desired_healthy{namespace='\" $labels.namespace \"',poddisruptionbudget='\" $labels.poddisruptionbudget \"'}\" }}{{ . | first | value }}{{ end }}"
```

## PDB Reference Configuration by Workload Type

```yaml
# Stateless web service — 4 replicas
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: web-pdb
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      tier: web

---
# Stateless API service — 10 replicas
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-pdb
spec:
  maxUnavailable: 25%
  selector:
    matchLabels:
      tier: api

---
# PostgreSQL primary + 2 replicas managed by an operator
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: postgres-pdb
spec:
  minAvailable: 2
  unhealthyPodEvictionPolicy: AlwaysAllow
  selector:
    matchLabels:
      app: postgresql

---
# 3-node ZooKeeper ensemble
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: zookeeper-pdb
spec:
  minAvailable: 2
  unhealthyPodEvictionPolicy: AlwaysAllow
  selector:
    matchLabels:
      app: zookeeper

---
# Monitoring DaemonSet
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: monitoring-daemonset-pdb
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: node-exporter
```

## Summary

PodDisruptionBudgets are non-optional for production Kubernetes clusters that undergo regular maintenance. The key design decisions are: using `maxUnavailable` as a percentage for autoscaler-friendly workloads, using absolute `minAvailable` for quorum-based stateful services, setting `unhealthyPodEvictionPolicy: AlwaysAllow` to prevent stuck drains caused by already-broken pods, and ensuring rolling update strategies include `maxSurge` to avoid deadlock with strict PDBs. PDB monitoring through Prometheus alerts on zero-disruption-allowed conditions provides the operational visibility needed to detect maintenance blockages before they become multi-hour incidents.
