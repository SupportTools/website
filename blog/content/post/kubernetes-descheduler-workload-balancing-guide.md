---
title: "Kubernetes Descheduler: Rebalancing Workloads After Cluster Events"
date: 2028-05-21T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Descheduler", "Workload Balancing", "Node Utilization", "Scheduling", "Production"]
categories: ["Kubernetes", "Infrastructure"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to the Kubernetes Descheduler: LowNodeUtilization, RemoveDuplicates, and TopologySpreadViolations policies, production configuration, and workload rebalancing strategies for enterprise clusters."
more_link: "yes"
url: "/kubernetes-descheduler-workload-balancing-guide/"
---

The Kubernetes scheduler makes optimal placement decisions at pod creation time. But clusters change: nodes are added and removed, resource pressure shifts, pods are evicted and rescheduled, and topology constraints drift from their intended configuration. The original placement decision, once optimal, becomes suboptimal over time. The Kubernetes Descheduler addresses this by periodically evicting pods that violate scheduling policies, allowing the scheduler to place them optimally on the current cluster state.

<!--more-->

## Why Descheduler Exists

Kubernetes scheduling is a one-time event. Once a pod is running, the scheduler doesn't revisit the placement decision even if the cluster state changes significantly. Common scenarios that lead to imbalanced clusters:

**Node addition**: A new high-capacity node joins the cluster. Existing pods don't migrate to it, leaving the new node underutilized while older nodes remain overloaded.

**Node failure and recovery**: When a node fails, its pods land wherever the scheduler can place them (often concentrated on remaining nodes). When the node recovers, those pods don't redistribute back.

**Cluster scale-up**: Cloud autoscaler adds nodes during a traffic spike. Traffic normalizes, new nodes sit empty, but no pods migrate to use them.

**Topology drift**: Anti-affinity rules spread pods across availability zones. Pods are evicted from one zone and rescheduled into another, violating the intended spread. TopologySpreadConstraints drift is especially common.

**Duplicate placement**: Multiple replicas of the same deployment end up on the same node, defeating the fault tolerance intent.

The Descheduler evicts pods from suboptimal nodes. The scheduler then places the evicted pods optimally on the current cluster.

## Installation

```bash
helm repo add descheduler https://kubernetes-sigs.github.io/descheduler/
helm repo update

helm install descheduler descheduler/descheduler \
  --namespace kube-system \
  --version 0.30.1 \
  --values descheduler-values.yaml
```

```yaml
# descheduler-values.yaml
kind: CronJob
schedule: "*/2 * * * *"      # Run every 2 minutes

image:
  tag: "v0.30.1"

resources:
  requests:
    cpu: 500m
    memory: 256Mi
  limits:
    cpu: 1000m
    memory: 512Mi

# Run as CronJob (default) or Deployment for continuous operation
# CronJob is recommended for most cases

deschedulerPolicy:
  profiles:
  - name: DefaultProfile
    pluginConfig:
    - name: DefaultEvictor
      args:
        evictSystemCriticalPods: false
        evictFailedBarePods: true
        evictLocalStoragePods: false
        ignorePvcPods: true
        priorityThreshold:
          value: 10000       # Don't evict pods above this priority
    plugins:
      balance:
        enabled:
        - RemoveDuplicates
        - RemovePodsViolatingTopologySpreadConstraint
        - LowNodeUtilization
      deschedule:
        enabled:
        - RemovePodsViolatingInterPodAntiAffinity
        - RemovePodsViolatingNodeAffinity
        - RemovePodsViolatingNodeTaints
        - RemovePodsHavingTooManyRestarts
        - PodLifeTime
```

## Descheduler Profiles

The Descheduler v0.26+ uses a profile-based configuration. Each profile can have multiple plugins:

### Profile Categories

**Balance plugins**: Aim to evenly distribute pods across nodes.
- `RemoveDuplicates`: Prevent multiple pod replicas on the same node
- `RemovePodsViolatingTopologySpreadConstraint`: Fix spread violations
- `LowNodeUtilization`: Move pods from underutilized nodes
- `HighNodeUtilization`: Compact pods onto fewer nodes (for scale-down)

**Deschedule plugins**: Evict pods that violate current rules.
- `RemovePodsViolatingInterPodAntiAffinity`: Fix anti-affinity violations
- `RemovePodsViolatingNodeAffinity`: Evict pods on wrong nodes after label changes
- `RemovePodsViolatingNodeTaints`: Evict pods from newly tainted nodes
- `RemovePodsHavingTooManyRestarts`: Evict crash-looping pods
- `PodLifeTime`: Evict long-running pods (for ephemeral workloads)

## LowNodeUtilization Policy

The most commonly needed policy. Evicts pods from underutilized nodes to enable cluster scale-down and node pool optimization:

```yaml
deschedulerPolicy:
  profiles:
  - name: BalanceProfile
    pluginConfig:
    - name: DefaultEvictor
      args:
        evictSystemCriticalPods: false
        evictFailedBarePods: true
        evictLocalStoragePods: false
        ignorePvcPods: true
        nodeFit: true       # Verify pod can be scheduled on target node before evicting
    - name: LowNodeUtilization
      args:
        thresholds:
          cpu: 20           # Nodes with CPU <20% are "underutilized"
          memory: 20        # Nodes with memory <20% are "underutilized"
          pods: 20          # Nodes with <20% pod count are underutilized
        targetThresholds:
          cpu: 50           # Target: nodes should be <50% CPU after rebalancing
          memory: 50        # Target: nodes should be <50% memory
          pods: 50          # Target: nodes should have <50% pod count
        useDeviationThresholds: false
        evictableNamespaces:
          exclude:
          - kube-system
          - monitoring
          - kube-node-lease
        numberOfNodes: 2    # Only trigger if at least 2 nodes are underutilized
    plugins:
      balance:
        enabled:
        - LowNodeUtilization
```

### Using Deviation Thresholds

Instead of absolute percentages, scale thresholds relative to cluster average:

```yaml
- name: LowNodeUtilization
  args:
    useDeviationThresholds: true
    thresholds:
      cpu: 10           # Underutilized: >10% below cluster average
      memory: 10
    targetThresholds:
      cpu: 10           # Target: within 10% of cluster average
      memory: 10
```

This adapts automatically as cluster size and workload change.

### HighNodeUtilization (Compaction Mode)

For clusters with autoscaling, compact pods onto fewer nodes to enable scale-in:

```yaml
- name: HighNodeUtilization
  args:
    thresholds:
      cpu: 20           # Nodes below 20% will be candidates for emptying
      memory: 20
    targetThresholds:
      cpu: 80           # Pack pods onto nodes up to 80% utilization
      memory: 80
    evictableNamespaces:
      exclude:
      - kube-system
```

Combine with Cluster Autoscaler to automatically scale down emptied nodes:

```yaml
# Cluster Autoscaler settings to work with HighNodeUtilization
# In Cluster Autoscaler configuration:
# --scale-down-utilization-threshold=0.25
# --scale-down-delay-after-add=10m
# --scale-down-unneeded-time=5m
```

## RemoveDuplicates Policy

Prevents multiple replicas of the same ReplicaSet/StatefulSet/Job from running on the same node:

```yaml
- name: RemoveDuplicates
  args:
    excludeOwnerKinds:
    - "ReplicationController"     # Legacy, leave alone
    namespaces:
      exclude:
      - kube-system
```

This is particularly important for stateless services where fault tolerance requires geographic spread. If a node failure takes down all replicas of a service simultaneously, the service is completely unavailable.

Verify the issue exists before enabling:

```bash
# Find nodes with multiple replicas of the same deployment
kubectl get pods -A -o json | jq -r '
  .items[] |
  {
    node: .spec.nodeName,
    namespace: .metadata.namespace,
    owner: (.metadata.ownerReferences[0].name // "none"),
    ownerKind: (.metadata.ownerReferences[0].kind // "none")
  }
' | jq -s '
  group_by(.node, .owner) |
  map(select(length > 1)) |
  .[]
'
```

## RemovePodsViolatingTopologySpreadConstraint

Evicts pods that violate their `topologySpreadConstraints`. This commonly happens after nodes fail and recover:

```yaml
- name: RemovePodsViolatingTopologySpreadConstraint
  args:
    constraints:
    - DoNotSchedule      # Fix hard constraints (required to be satisfied)
    - ScheduleAnyway     # Also fix soft constraints
    namespaces:
      exclude:
      - kube-system
    labelSelector:
      matchLabels:
        managed-by-descheduler: "true"
```

Example deployment that benefits from this plugin:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
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
            app: api-server
      - maxSkew: 1
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: ScheduleAnyway
        labelSelector:
          matchLabels:
            app: api-server
```

After a zone failure and recovery, pods may be concentrated in 2 zones instead of spread across 3. The Descheduler evicts pods from the overloaded zones; the scheduler places them in the underloaded zone.

## RemovePodsViolatingInterPodAntiAffinity

Evicts pods that are co-located with pods they have anti-affinity rules against:

```yaml
- name: RemovePodsViolatingInterPodAntiAffinity
  args:
    namespaces:
      exclude:
      - kube-system
```

This scenario occurs when:
1. Pod A with anti-affinity to Pod B is running on Node X
2. Pod B is later scheduled onto Node X (perhaps during high load when anti-affinity was `preferredDuringSchedulingIgnoredDuringExecution`)
3. The Descheduler evicts Pod A or B to restore the anti-affinity intent

## RemovePodsViolatingNodeAffinity

When node labels change after pods are scheduled:

```yaml
- name: RemovePodsViolatingNodeAffinity
  args:
    nodeAffinityType:
    - "requiredDuringSchedulingIgnoredDuringExecution"
    namespaces:
      exclude:
      - kube-system
```

Use case: A node is relabeled from `environment=production` to `environment=staging`. Pods with `requiredDuringScheduling` affinity for production remain running on the node (Kubernetes doesn't evict them). The Descheduler detects the violation and evicts the pods.

## PodLifeTime: Ephemeral Workload Management

Evict pods older than a specified duration. Useful for batch jobs, development namespaces, and ephemeral workloads:

```yaml
- name: PodLifeTime
  args:
    maxPodLifeTimeSeconds: 86400    # Evict pods older than 24 hours
    states:
    - "Running"
    - "Pending"
    podStatusPhases:
    - "Running"
    namespaces:
      include:
      - dev
      - staging
      - ci
    labelSelector:
      matchLabels:
        lifecycle: ephemeral
```

## RemovePodsHavingTooManyRestarts

Evict pods in crash loops to allow them to reschedule (potentially on a different node):

```yaml
- name: RemovePodsHavingTooManyRestarts
  args:
    podRestartThreshold: 100        # Evict after 100 restarts
    includingInitContainers: true
    namespaces:
      exclude:
      - kube-system
```

This can break crash loops caused by node-specific issues (bad disk, specific hardware failure, network path problems). The pod may stabilize when rescheduled elsewhere.

## Production Configuration: Multi-Profile Setup

A production cluster typically needs multiple profiles with different behaviors for different workload types:

```yaml
deschedulerPolicy:
  profiles:
  # Profile 1: Standard workloads - balance and topology
  - name: StandardProfile
    pluginConfig:
    - name: DefaultEvictor
      args:
        evictSystemCriticalPods: false
        evictFailedBarePods: true
        evictLocalStoragePods: false
        ignorePvcPods: true
        priorityThreshold:
          value: 100000
        nodeFit: true
    - name: LowNodeUtilization
      args:
        useDeviationThresholds: true
        thresholds:
          cpu: 20
          memory: 20
        targetThresholds:
          cpu: 30
          memory: 30
        numberOfNodes: 3
        evictableNamespaces:
          exclude:
          - kube-system
          - monitoring
          - cert-manager
    - name: RemoveDuplicates
      args:
        namespaces:
          exclude:
          - kube-system
    - name: RemovePodsViolatingTopologySpreadConstraint
      args:
        constraints:
        - DoNotSchedule
        - ScheduleAnyway
        namespaces:
          exclude:
          - kube-system
    plugins:
      balance:
        enabled:
        - RemoveDuplicates
        - RemovePodsViolatingTopologySpreadConstraint
        - LowNodeUtilization
      deschedule:
        enabled:
        - RemovePodsViolatingInterPodAntiAffinity
        - RemovePodsViolatingNodeAffinity
        - RemovePodsViolatingNodeTaints

  # Profile 2: Stateful workloads - conservative, PVC-aware
  - name: StatefulProfile
    pluginConfig:
    - name: DefaultEvictor
      args:
        evictSystemCriticalPods: false
        evictFailedBarePods: false
        evictLocalStoragePods: false
        ignorePvcPods: false         # Allow PVC pod eviction
        priorityThreshold:
          value: 100000
        nodeFit: true
    - name: RemovePodsViolatingNodeTaints
      args:
        namespaces:
          include:
          - databases
          - stateful-apps
    plugins:
      deschedule:
        enabled:
        - RemovePodsViolatingNodeTaints
        - RemovePodsViolatingNodeAffinity

  # Profile 3: Development namespaces - aggressive cleanup
  - name: DevProfile
    pluginConfig:
    - name: DefaultEvictor
      args:
        evictSystemCriticalPods: false
        evictFailedBarePods: true
        evictLocalStoragePods: true
        ignorePvcPods: false
    - name: PodLifeTime
      args:
        maxPodLifeTimeSeconds: 43200  # 12 hours
        states:
        - "Running"
        namespaces:
          include:
          - dev
          - feature-branches
    - name: RemovePodsHavingTooManyRestarts
      args:
        podRestartThreshold: 10
        includingInitContainers: true
        namespaces:
          include:
          - dev
          - feature-branches
    plugins:
      balance:
        enabled:
        - LowNodeUtilization
      deschedule:
        enabled:
        - RemovePodsHavingTooManyRestarts
        - PodLifeTime
```

## Deployment Mode: CronJob vs Deployment

```yaml
# CronJob mode (default): Runs periodically, exits after each pass
kind: CronJob
schedule: "*/2 * * * *"    # Every 2 minutes

# Deployment mode: Continuous operation with sleep between passes
kind: Deployment
deschedulingInterval: 2m
```

The CronJob mode is preferred because:
- Predictable resource usage (runs for seconds, not continuously)
- Kubernetes restarts it if it fails
- Easy to disable temporarily (suspend the CronJob)

For very large clusters (1000+ nodes), the Deployment mode is more appropriate because the analysis itself can take significant time.

## Protecting Workloads from Eviction

Not all pods should be evictable. Several mechanisms protect critical workloads:

### Priority Classes

```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: descheduler-immune
value: 1000000    # Above descheduler's priority threshold
globalDefault: false
description: "Pods not evicted by descheduler"
```

Configure the descheduler's priority threshold:

```yaml
- name: DefaultEvictor
  args:
    priorityThreshold:
      value: 100000    # Don't evict pods with priority >= 100000
      # OR use a priority class name:
      # name: "system-cluster-critical"
```

### Annotations

```yaml
# Opt specific pods out of descheduling
apiVersion: v1
kind: Pod
metadata:
  annotations:
    descheduler.alpha.kubernetes.io/evict: "false"
```

### PodDisruptionBudgets

PodDisruptionBudgets are fully respected by the descheduler. Configure them for all production workloads:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-server-pdb
  namespace: production
spec:
  minAvailable: "75%"    # Always keep 75% of pods running
  selector:
    matchLabels:
      app: api-server
```

The descheduler checks PDBs before evicting. If eviction would violate the PDB, the pod is skipped. This prevents descheduling from causing outages.

## Observability and Monitoring

### Descheduler Metrics

```yaml
# Enable metrics in Helm values
serviceMonitor:
  enabled: true
  namespace: monitoring
  interval: 30s
```

Key metrics:

```promql
# Total pods evicted by strategy
sum by (strategy) (descheduler_pods_evicted)

# Evictions over time
rate(descheduler_pods_evicted[5m])

# Eviction errors (failed evictions due to PDB, etc.)
sum by (result) (descheduler_pod_evictions_total)
```

### Alert Rules

```yaml
groups:
- name: descheduler-alerts
  rules:
  - alert: DeschedulerEvictionRateHigh
    expr: rate(descheduler_pods_evicted[5m]) > 5
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Descheduler evicting >5 pods/min - investigate cluster imbalance"

  - alert: DeschedulerNotRunning
    expr: |
      absent(descheduler_pods_evicted) == 1
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "Descheduler hasn't run in 10 minutes"

  - alert: DeschedulerEvictionsFailing
    expr: |
      rate(descheduler_pod_evictions_total{result="error"}[5m]) > 0
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Descheduler is failing to evict pods - check PDBs and permissions"
```

## Node Utilization Verification

Before and after analysis to verify descheduler effectiveness:

```bash
#!/bin/bash
# Check node utilization distribution

echo "=== Node Resource Utilization ==="
kubectl top nodes --no-headers | while read NAME CPU_VAL CPU_PCT MEM_VAL MEM_PCT; do
    echo "Node: $NAME | CPU: $CPU_PCT | Memory: $MEM_PCT"
done

echo ""
echo "=== Pod Distribution per Node ==="
kubectl get pods -A --field-selector status.phase=Running -o json | \
  jq -r '.items[].spec.nodeName' | sort | uniq -c | sort -rn | \
  head -20

echo ""
echo "=== Duplicate Replicas on Same Node ==="
kubectl get pods -A -o json | jq -r '
  .items[] |
  select(.metadata.ownerReferences != null) |
  "\(.spec.nodeName) \(.metadata.namespace)/\(.metadata.ownerReferences[0].name)"
' | sort | uniq -d | head -20
```

## Tuning for Large Clusters

For clusters with hundreds of nodes, descheduler performance matters:

```yaml
deschedulerPolicy:
  maxNoOfPodsToEvictPerNode: 10      # Limit evictions per node per run
  maxNoOfPodsToEvictPerNamespace: 50  # Limit evictions per namespace per run
  maxNoOfPodsToEvictTotal: 200        # Global eviction limit per run
  ignorePVCPods: true                 # Skip PVC pods for performance

  profiles:
  - name: DefaultProfile
    pluginConfig:
    - name: LowNodeUtilization
      args:
        evictionsInBackground: true      # Evict asynchronously
        targetThresholds:
          cpu: 50
          memory: 50
```

## Interaction with Cluster Autoscaler

The Descheduler and Cluster Autoscaler complement each other:

1. **Descheduler evicts pods** from underutilized nodes
2. **Cluster Autoscaler detects empty/low nodes** and removes them
3. **Cluster Autoscaler adds new nodes** when pods can't be scheduled
4. **Descheduler rebalances** pods onto new nodes

Configure them to work in concert:

```yaml
# Cluster Autoscaler: be patient with node scale-down
# (give descheduler time to drain nodes before CA removes them)
# --scale-down-unneeded-time=10m
# --scale-down-utilization-threshold=0.25

# Descheduler: run frequently to expose underutilized nodes quickly
schedule: "*/2 * * * *"
```

## Summary

The Kubernetes Descheduler fills a critical gap in cluster lifecycle management. Static scheduling decisions degrade over time as clusters evolve. The Descheduler's periodic analysis and targeted evictions restore the cluster to an optimal state: workloads spread across zones as their topology constraints require, duplicates eliminated from single nodes, underutilized nodes emptied for Cluster Autoscaler to reclaim. With proper PodDisruptionBudgets on all production workloads, descheduling is safe - the scheduler ensures evicted pods find new homes, and PDBs ensure continuity during the transition.
