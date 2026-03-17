---
title: "Kubernetes Pod Disruption Budgets and Priority Classes: Production Availability Guarantees"
date: 2030-08-11T00:00:00-05:00
draft: false
tags: ["Kubernetes", "PodDisruptionBudget", "PriorityClass", "High Availability", "Cluster Autoscaler", "Descheduler"]
categories:
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise availability guide for Kubernetes: PDB minAvailable vs maxUnavailable, interaction with Cluster Autoscaler and Descheduler, PriorityClass configuration, preemption policies, and designing availability guarantees for multi-tier applications."
more_link: "yes"
url: "/kubernetes-pod-disruption-budgets-priority-classes-availability-guarantees/"
---

Pod Disruption Budgets (PDBs) and PriorityClasses are the two Kubernetes mechanisms that protect workload availability during both planned and unplanned disruptions. Together, they answer two distinct questions: "How much of this application can be disrupted at once?" (PDB), and "When resources are scarce, which pods survive?" (PriorityClass). Getting both right is a prerequisite for SLA-backed production deployments.

<!--more-->

## Overview

This guide covers PDB configuration patterns, the semantic differences between `minAvailable` and `maxUnavailable`, PDB interactions with Cluster Autoscaler and Descheduler, PriorityClass design for multi-tier applications, preemption policies, and operational patterns for designing availability guarantees across complete application tiers.

## Pod Disruption Budget Fundamentals

### What Counts as a Disruption

Kubernetes distinguishes between voluntary and involuntary disruptions:

**Voluntary disruptions** (blocked by PDBs):
- `kubectl drain` on a node
- Node taint that evicts running pods
- Rolling update triggering pod eviction (via the Eviction API)
- Cluster Autoscaler scale-down
- Descheduler pod eviction
- Manual eviction via `kubectl delete pod`

**Involuntary disruptions** (not blocked by PDBs):
- Node hardware failure
- Node kernel panic or OOM kill
- Virtual machine preemption by cloud provider
- `kubectl delete pod --force`
- Pod terminated by OOM killer

PDBs protect against voluntary disruptions. They cannot prevent involuntary disruptions, which is why replica counts must be set appropriately for fault tolerance independent of PDBs.

### PDB Spec: minAvailable vs maxUnavailable

```yaml
# minAvailable: absolute minimum replicas that must remain available
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-api-pdb
  namespace: production
spec:
  minAvailable: 2  # At least 2 pods must be running during disruption
  selector:
    matchLabels:
      app: payment-api
```

```yaml
# maxUnavailable: maximum pods that can be simultaneously unavailable
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: order-service-pdb
  namespace: production
spec:
  maxUnavailable: 1  # At most 1 pod can be unavailable at a time
  selector:
    matchLabels:
      app: order-service
```

```yaml
# Percentage-based configuration
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: worker-pdb
  namespace: production
spec:
  minAvailable: "50%"   # At least half of replicas must remain available
  selector:
    matchLabels:
      app: background-worker
```

### Choosing minAvailable vs maxUnavailable

| Scenario | Recommended field | Why |
|----------|------------------|-----|
| Quorum-based distributed system | `minAvailable: 2` (or specific quorum count) | Prevent loss of majority |
| Stateless service with N replicas | `maxUnavailable: 1` | Scales naturally with replica count changes |
| Single-replica development service | `minAvailable: 0` or no PDB | Don't block upgrades |
| Database primary + replicas | `minAvailable` with exact count | Ensure primary is never evicted alone |
| Horizontal worker pool | `maxUnavailable: "25%"` | Allow faster rolling maintenance |

### PDB Status Fields

```bash
kubectl -n production get pdb payment-api-pdb -o yaml
```

```yaml
status:
  currentHealthy: 5      # Pods currently counted as healthy
  desiredHealthy: 4      # Minimum required (from minAvailable or calculation)
  disruptionsAllowed: 1  # How many pods can currently be disrupted
  expectedPods: 5        # Total pods expected by selector
  observedGeneration: 3
  conditions:
  - lastTransitionTime: "2030-08-11T00:00:00Z"
    message: ""
    observedGeneration: 3
    reason: SufficientPods
    status: "True"
    type: DisruptionAllowed
```

`disruptionsAllowed: 0` means no voluntary disruptions can proceed. Draining a node with pods covered by a zero-disruption-allowed PDB will stall indefinitely.

## PDB Interaction with Cluster Autoscaler

### Scale-Down Behavior

The Cluster Autoscaler checks PDBs before removing underutilized nodes:

1. CA identifies a node as a scale-down candidate (utilization below threshold)
2. CA checks if pods on the node are covered by PDBs
3. If evicting would violate any PDB, the node is **not** removed
4. CA waits and retries at the next evaluation interval

```yaml
# Cluster Autoscaler configuration (--scale-down-* flags)
# relevant to PDB interaction:
--scale-down-utilization-threshold=0.5
--scale-down-delay-after-add=10m
--scale-down-unneeded-time=10m
# CA will wait up to this long for PDB-blocked evictions:
--max-graceful-termination-sec=600
# If pods can't be evicted due to PDB within this time, node stays:
--max-node-provision-time=15m
```

### Common PDB Anti-Patterns That Break Scale-Down

**Anti-pattern 1: PDB with minAvailable equal to total replicas**

```yaml
# BAD: blocks all scale-down permanently
spec:
  replicas: 3
---
spec:
  minAvailable: 3  # Can never evict any pod
```

**Anti-pattern 2: PDB with unhealthy pods**

If fewer than `minAvailable` pods are healthy (e.g., during a failing rollout), `disruptionsAllowed` becomes 0, blocking both the drain and the new pod deployment from making progress. Use `maxUnavailable` instead for rolling-update scenarios.

**Anti-pattern 3: PDB on single-replica deployment**

```yaml
# BAD: blocks all maintenance on single-replica workloads
spec:
  replicas: 1
---
spec:
  minAvailable: 1  # Never allows eviction; blocks all node drains
```

For single-replica workloads, either:
- Set `minAvailable: 0` (allows disruption, service will be briefly unavailable)
- Increase replicas to 2 and set `minAvailable: 1`
- Use `maxUnavailable: 1` instead (equivalent but more semantic)

### PDB and Pod Anti-Affinity Interaction

When pods are spread across zones via `topologySpreadConstraints`, PDB enforcement combines with topology awareness:

```yaml
# Correct multi-zone PDB: accounts for zone failures
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-api
spec:
  replicas: 6  # 2 per zone
  template:
    spec:
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: payment-api
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-api-pdb
spec:
  minAvailable: 4  # Ensure at least 4/6 pods available
  # This allows 2 pods to be disrupted at once
  # If a full zone goes down (involuntary), 4 survive across 2 zones
  selector:
    matchLabels:
      app: payment-api
```

## PDB Interaction with the Descheduler

The Descheduler evicts pods to rebalance utilization, improve affinity compliance, or remove duplicates. It respects PDBs when deciding which pods to evict.

```yaml
# KubeDescheduler policy
apiVersion: descheduler/v1alpha2
kind: DeschedulerPolicy
profiles:
- name: ProfileName
  pluginConfig:
  - name: DefaultEvictor
    args:
      evictSystemCriticalPods: false
      evictFailedBarePods: true
      evictLocalStoragePods: false
      # Respect PDBs (default: true)
      ignorePvcPods: false
      nodeFit: true
  - name: RemovePodsHavingTooManyRestarts
    args:
      podRestartThreshold: 100
      includingInitContainers: true
  - name: LowNodeUtilization
    args:
      targetThresholds:
        cpu: 50
        memory: 50
        pods: 50
      thresholds:
        cpu: 20
        memory: 20
        pods: 20
  plugins:
    balance:
      enabled:
      - LowNodeUtilization
    deschedule:
      enabled:
      - RemovePodsHavingTooManyRestarts
```

The Descheduler checks `disruptionsAllowed > 0` before evicting any pod. If a PDB blocks eviction, the pod is skipped in that cycle.

## PriorityClass Design

### What PriorityClass Controls

PriorityClass assigns numeric priority to pods. When the scheduler cannot fit a pod due to resource constraints, it preempts lower-priority pods to make room for higher-priority ones. During resource pressure (e.g., node OOM), the kubelet evicts lower-priority pods first.

```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: production-critical
value: 1000000        # Higher = more important (max: 1000000000)
globalDefault: false  # Only one PriorityClass can be globalDefault: true
description: "Production-critical services: payment, auth, order APIs"
preemptionPolicy: PreemptLowerPriority  # Default behavior
```

### Reserved Priority Ranges

| Range | Reserved for | Examples |
|-------|-------------|---------|
| 2000000000+ | System critical | kube-system pods, node agents |
| 1000000000–1999999999 | Cluster critical | Monitoring, logging, CNI |
| 100000–999999999 | User workloads | Application tiers |
| 0–99999 | Low-priority | Batch, preemptible |
| Negative | Least-priority | Test, CI, dev |

### Multi-Tier Priority Structure

```yaml
# /cluster/priority-classes.yaml

# Tier 0: Critical infrastructure
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: infrastructure-critical
value: 900000000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: "Cluster infrastructure: CNI, CSI, monitoring agents, cert-manager"

# Tier 1: Revenue-critical services
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: production-critical
value: 1000000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: "Revenue-critical: payment, auth, checkout APIs"

# Tier 2: Standard production services
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: production-standard
value: 100000
globalDefault: true  # Default for all pods without explicit priority
preemptionPolicy: PreemptLowerPriority
description: "Standard production services"

# Tier 3: Background processing
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: background
value: 10000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: "Background workers, async processors"

# Tier 4: Batch workloads
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: batch
value: 1000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: "Batch jobs, ETL pipelines"

# Tier 5: Preemptible (spot-instance friendly)
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: preemptible
value: 0
globalDefault: false
preemptionPolicy: Never   # Cannot preempt other pods, but can be preempted
description: "CI/CD runners, development environments, spot-tolerant batch"
```

### Assigning PriorityClasses to Workloads

```yaml
# Revenue-critical service
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-api
  namespace: production
spec:
  template:
    spec:
      priorityClassName: production-critical
      containers:
      - name: payment-api
        image: registry.support.tools/payment-api:v3.2.1
        resources:
          requests:
            cpu: "1"
            memory: "512Mi"
          limits:
            cpu: "2"
            memory: "1Gi"
---
# Batch job that should yield to production
apiVersion: batch/v1
kind: CronJob
metadata:
  name: nightly-reconciliation
  namespace: production
spec:
  jobTemplate:
    spec:
      template:
        spec:
          priorityClassName: batch
          restartPolicy: OnFailure
          containers:
          - name: reconciler
            image: registry.support.tools/reconciler:v1.0.0
```

## Preemption Policies

### PreemptLowerPriority (Default)

When a `PreemptLowerPriority` pod cannot be scheduled, the scheduler finds nodes where preempting lower-priority pods would free enough resources, then evicts those pods (respecting PDBs) and schedules the high-priority pod.

```yaml
# Aggressive: preempts anything lower priority to get scheduled
spec:
  priorityClassName: production-critical
  preemptionPolicy: PreemptLowerPriority  # Explicitly set (also the default)
```

### Never (Non-Preempting)

A pod with `preemptionPolicy: Never` is placed in the scheduling queue by priority but will not preempt other pods. It waits for resources to become available naturally.

Use `Never` for:
- High-priority-labeled pods that should not disrupt production when they fail
- Spot-instance workloads that should wait for free capacity rather than evicting production pods

```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: high-priority-no-preempt
value: 500000
preemptionPolicy: Never  # Will not preempt other pods
description: "Important but non-preempting batch work"
```

### Preemption and PDB Interaction

When the scheduler preempts pods to place a high-priority pod:

1. Scheduler identifies candidate nodes with lower-priority pods
2. Scheduler checks if evicting those pods violates their PDBs
3. If PDB would be violated, those pods cannot be preempted
4. Scheduler looks for other candidates or other nodes

This means a PDB can protect against preemption as well as voluntary disruption:

```yaml
# Protect standard-priority pods from being preempted by production-critical
# when minimum availability is already at the PDB floor
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: order-service-pdb
spec:
  minAvailable: 2   # Preemption cannot bring healthy pods below 2
  selector:
    matchLabels:
      app: order-service
```

## Complete Multi-Tier Availability Configuration

### Tier 1: Payment Service (Revenue Critical)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-api
  namespace: production
spec:
  replicas: 6
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0   # Zero-downtime rolling update
  template:
    metadata:
      labels:
        app: payment-api
        tier: critical
    spec:
      priorityClassName: production-critical
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: payment-api
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: payment-api
            topologyKey: kubernetes.io/hostname
      containers:
      - name: payment-api
        image: registry.support.tools/payment-api:v3.2.1
        resources:
          requests:
            cpu: "1"
            memory: "512Mi"
          limits:
            cpu: "2"
            memory: "1Gi"
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-api-pdb
  namespace: production
spec:
  minAvailable: 4   # Allow 2 of 6 to be disrupted simultaneously
  selector:
    matchLabels:
      app: payment-api
```

### Tier 2: Order Service (Standard)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
  namespace: production
spec:
  replicas: 4
  template:
    spec:
      priorityClassName: production-standard
      containers:
      - name: order-service
        image: registry.support.tools/order-service:v2.1.0
        resources:
          requests:
            cpu: "500m"
            memory: "256Mi"
          limits:
            cpu: "1"
            memory: "512Mi"
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: order-service-pdb
  namespace: production
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: order-service
```

### Tier 3: Background Workers

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: notification-worker
  namespace: production
spec:
  replicas: 8
  template:
    spec:
      priorityClassName: background
      containers:
      - name: notification-worker
        image: registry.support.tools/notification-worker:v1.5.0
        resources:
          requests:
            cpu: "250m"
            memory: "128Mi"
          limits:
            cpu: "500m"
            memory: "256Mi"
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: notification-worker-pdb
  namespace: production
spec:
  maxUnavailable: "25%"   # Up to 2 of 8 workers can be disrupted
  selector:
    matchLabels:
      app: notification-worker
```

### Tier 4: Spot-Tolerant Batch

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: daily-analytics
  namespace: production
spec:
  schedule: "0 2 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          priorityClassName: preemptible
          # Tolerate spot instance preemption
          tolerations:
          - key: cloud.google.com/gke-spot
            operator: Equal
            value: "true"
            effect: NoSchedule
          - key: kubernetes.azure.com/scalesetpriority
            operator: Equal
            value: spot
            effect: NoSchedule
          restartPolicy: OnFailure
          containers:
          - name: analytics
            image: registry.support.tools/analytics:v1.0.0
```

## Monitoring and Alerting for PDB and Priority

### PDB Health Monitoring

```promql
# Alert when any PDB has zero disruptions allowed for extended period
# (may indicate stuck rollout or failed pods)
kube_poddisruptionbudget_status_disruptions_allowed == 0
```

```yaml
# Prometheus alerting rules
groups:
- name: availability
  rules:
  - alert: PDBBlockingDrain
    expr: |
      kube_poddisruptionbudget_status_disruptions_allowed == 0
      and
      kube_poddisruptionbudget_status_current_healthy
        < kube_poddisruptionbudget_status_desired_healthy
    for: 30m
    labels:
      severity: warning
    annotations:
      summary: "PDB {{ $labels.namespace }}/{{ $labels.poddisruptionbudget }} blocking drain"
      description: "current_healthy={{ $value }} < desired_healthy"

  - alert: PDBCurrentHealthyBelowMinAvailable
    expr: |
      kube_poddisruptionbudget_status_current_healthy
        < kube_poddisruptionbudget_status_desired_healthy
    for: 5m
    labels:
      severity: critical
    annotations:
      summary: "PDB {{ $labels.namespace }}/{{ $labels.poddisruptionbudget }} below minimum healthy"

  - alert: PodPreempted
    expr: increase(kube_pod_preempted_total[5m]) > 0
    for: 1m
    labels:
      severity: info
    annotations:
      summary: "Pods preempted in cluster"
      description: "{{ $value }} pods preempted in the last 5 minutes"
```

### Checking PDB Status Operationally

```bash
# List all PDBs and their disruption budget
kubectl get pdb -A -o custom-columns=\
'NAMESPACE:.metadata.namespace,'\
'NAME:.metadata.name,'\
'MIN-AVAILABLE:.spec.minAvailable,'\
'MAX-UNAVAIL:.spec.maxUnavailable,'\
'ALLOWED:.status.disruptionsAllowed,'\
'CURRENT:.status.currentHealthy,'\
'DESIRED:.status.desiredHealthy,'\
'TOTAL:.status.expectedPods'

# Find PDBs that are currently blocking disruptions
kubectl get pdb -A -o json | jq -r '
  .items[] |
  select(.status.disruptionsAllowed == 0) |
  "\(.metadata.namespace)/\(.metadata.name): disruptionsAllowed=0 (currentHealthy=\(.status.currentHealthy), desiredHealthy=\(.status.desiredHealthy))"
'

# Check which PriorityClasses exist and their values
kubectl get priorityclass -o custom-columns=\
'NAME:.metadata.name,'\
'VALUE:.value,'\
'GLOBAL-DEFAULT:.globalDefault,'\
'PREEMPTION:.preemptionPolicy'
```

### Node Drain Simulation

Test PDB behavior before a maintenance window:

```bash
#!/bin/bash
# simulate-drain.sh - test PDB impact without actually draining
NODE="$1"
NAMESPACE="${2:-production}"

echo "=== Pods on node $NODE ==="
kubectl get pods -n "$NAMESPACE" \
  --field-selector spec.nodeName="$NODE" \
  -o custom-columns='NAME:.metadata.name,PRIORITY:.spec.priorityClassName'

echo ""
echo "=== PDB Status ==="
kubectl get pdb -n "$NAMESPACE" -o wide

echo ""
echo "=== Simulating evictions (dry-run) ==="
kubectl drain "$NODE" \
  --dry-run=client \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --grace-period=30 \
  2>&1 | grep -E "evict|cannot evict|PodDisruptionBudget|error"
```

## Operational Best Practices

### PDB Sizing Guidelines

For stateless services:
```
minAvailable = floor(replicas * (1 - acceptable_disruption_fraction))
# For 3 replicas, 33% disruption acceptable:
minAvailable = floor(3 * 0.67) = 2
```

For stateful quorum services (etcd, Kafka, etc.):
```
minAvailable = ceil(replicas / 2) + 1  # Strict quorum
# For 3 replicas: minAvailable = 2
# For 5 replicas: minAvailable = 3
```

### PDB and Deployment Strategy Alignment

Ensure the Deployment rolling update strategy does not conflict with the PDB:

```yaml
# Deployment with 4 replicas
spec:
  replicas: 4
  strategy:
    rollingUpdate:
      maxSurge: 1         # Allow 5 pods during rollout
      maxUnavailable: 0   # Never have fewer than 4 pods running
---
# PDB aligned with rolling update
spec:
  minAvailable: 3  # Allow 1 unavailable (matches maxUnavailable=0 effectively keeps 4, but during initial unavailability we want at least 3)
```

If `maxUnavailable` in both Deployment and PDB conflict—e.g., Deployment says `maxUnavailable: 2` but PDB says `minAvailable: 4` on a 4-replica deployment—the PDB wins and the rolling update stalls.

## Summary

Pod Disruption Budgets and PriorityClasses work together to provide multi-dimensional availability guarantees in Kubernetes. PDBs ensure that voluntary disruptions—node drains, Cluster Autoscaler scale-downs, Descheduler rebalancing—never reduce a service below its defined availability floor. PriorityClasses ensure that when resources are scarce, lower-priority workloads yield capacity to higher-priority ones, with `preemptionPolicy: Never` providing a way to express importance without destructive preemption behavior. A complete multi-tier application maps each tier to an appropriate priority value, PDB configuration, and topology spread constraint, creating a coherent availability architecture that survives maintenance windows, node failures, and capacity pressure without manual intervention.
