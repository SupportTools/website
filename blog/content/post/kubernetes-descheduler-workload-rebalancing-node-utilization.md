---
title: "Kubernetes Descheduler: Workload Rebalancing and Node Utilization Optimization"
date: 2030-07-12T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Descheduler", "Scheduling", "Resource Optimization", "Cluster Autoscaler", "Platform Engineering"]
categories:
- Kubernetes
- Platform Engineering
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Production Kubernetes Descheduler guide covering eviction strategies including RemoveDuplicates, LowNodeUtilization, and RemovePodsViolatingTopologySpreadConstraints, scheduling profile configuration, safe eviction policies with PodDisruptionBudgets, and integration with Cluster Autoscaler for cost-efficient cluster operations."
more_link: "yes"
url: "/kubernetes-descheduler-workload-rebalancing-node-utilization/"
---

The Kubernetes scheduler makes placement decisions for pods at creation time based on the cluster state at that moment. Over time, the cluster state diverges from the conditions that originally governed pod placement: new nodes join, old nodes become overloaded, topology spread constraints are violated by rolling updates, and nodes with high utilization prevent scale-down while others sit idle. The Descheduler addresses this temporal imbalance by periodically evicting pods according to configurable policies, allowing the scheduler to re-place them on nodes that better fit current constraints. The result is improved bin-packing, reduced resource fragmentation, and better Cluster Autoscaler efficiency.

<!--more-->

## How the Descheduler Works

The Descheduler runs as a `CronJob` or `Deployment` in the cluster and:

1. Enumerates all pods across namespaces
2. Applies enabled eviction policies (plugins) to identify candidates for eviction
3. Evicts candidates, respecting PodDisruptionBudgets, node drain thresholds, and system pod exclusions
4. Relies on the standard scheduler to re-place evicted pods onto optimal nodes

The Descheduler does **not** directly place pods — it only removes them. Re-placement is entirely the scheduler's responsibility.

```
Cluster state at t=0:
  Node A: 80% CPU (8 pods)
  Node B: 20% CPU (2 pods)
  Node C: 75% CPU (7 pods) — newly added

Descheduler (LowNodeUtilization):
  Evicts 2 pods from Node A (overutilized)
  Evicts 2 pods from Node C (overutilized)

Scheduler re-places:
  Node A: 60% CPU (6 pods)
  Node B: 55% CPU (5 pods)
  Node C: 55% CPU (6 pods) — balanced
```

## Installation

```bash
# Install with Helm
helm repo add descheduler https://kubernetes-sigs.github.io/descheduler/
helm repo update

# Install with production-ready configuration
helm install descheduler descheduler/descheduler \
  --namespace kube-system \
  --version "0.30.1" \
  --values descheduler-values.yaml
```

### values.yaml for Production Deployment

```yaml
# descheduler-values.yaml

kind: CronJob
# Run every hour during business hours — adjust schedule per environment
schedule: "0 * * * *"

deschedulerPolicy:
  profiles:
    - name: default-profile
      pluginConfig:
        # LowNodeUtilization: migrate pods from underutilized nodes
        - name: LowNodeUtilization
          args:
            apiVersion: descheduler/v1alpha2
            kind: LowNodeUtilizationArgs
            lowThreshold:
              cpu: 20
              memory: 20
              pods: 20
            highThreshold:
              cpu: 50
              memory: 50
              pods: 50
            thresholdPriorityClassName: ""
            evictableNamespaces:
              exclude:
                - kube-system
                - monitoring
                - logging

        # RemovePodsViolatingTopologySpreadConstraints
        - name: RemovePodsViolatingTopologySpreadConstraints
          args:
            apiVersion: descheduler/v1alpha2
            kind: RemovePodsViolatingTopologySpreadConstraintsArgs
            constraints:
              - DoNotSchedule
              - ScheduleAnyway
            labelSelector: {}

        # RemoveDuplicates: ensure no more than one pod per topology key
        - name: RemoveDuplicates
          args:
            apiVersion: descheduler/v1alpha2
            kind: RemoveDuplicatesArgs
            excludeOwnerKinds:
              - ReplicaSet
              - Deployment
              - StatefulSet

        # RemovePodsViolatingNodeAffinity
        - name: RemovePodsViolatingNodeAffinity
          args:
            apiVersion: descheduler/v1alpha2
            kind: RemovePodsViolatingNodeAffinityArgs
            nodeAffinityType:
              - requiredDuringSchedulingIgnoredDuringExecution

        # RemovePodsViolatingNodeTaints
        - name: RemovePodsViolatingNodeTaints
          args:
            apiVersion: descheduler/v1alpha2
            kind: RemovePodsViolatingNodeTaintsArgs

        # RemovePodsHavingTooManyRestarts
        - name: RemovePodsHavingTooManyRestarts
          args:
            apiVersion: descheduler/v1alpha2
            kind: RemovePodsHavingTooManyRestartsArgs
            podRestartThreshold: 100
            includingInitContainers: true

      plugins:
        balance:
          enabled:
            - RemoveDuplicates
            - LowNodeUtilization
            - RemovePodsViolatingTopologySpreadConstraints
        deschedule:
          enabled:
            - RemovePodsViolatingNodeAffinity
            - RemovePodsViolatingNodeTaints
            - RemovePodsHavingTooManyRestarts

# Eviction constraints
deschedulerPolicyConfigMapName: descheduler-policy-configmap

resources:
  requests:
    cpu: 500m
    memory: 256Mi
  limits:
    cpu: 1000m
    memory: 512Mi

# Service account
serviceAccount:
  create: true
  name: descheduler

# Run on control plane nodes
nodeSelector:
  node-role.kubernetes.io/control-plane: ""

tolerations:
  - key: node-role.kubernetes.io/control-plane
    operator: Exists
    effect: NoSchedule
```

## Descheduler Policy Reference

### LowNodeUtilization

Evicts pods from overloaded nodes so they can be rescheduled onto underutilized nodes. The plugin identifies:
- **Target nodes** (eviction candidates): nodes exceeding the `highThreshold` for at least one resource
- **Candidate nodes** (available for re-placement): nodes below `lowThreshold` for all resources

```yaml
- name: LowNodeUtilization
  args:
    apiVersion: descheduler/v1alpha2
    kind: LowNodeUtilizationArgs
    # Nodes below these thresholds are considered underutilized
    # and are acceptable destinations for evicted pods
    lowThreshold:
      cpu: 20       # percent
      memory: 20    # percent
      pods: 20      # percent of pod capacity
    # Nodes above these thresholds are candidates for eviction
    highThreshold:
      cpu: 50
      memory: 50
      pods: 50
    # Minimum replicas that must remain after eviction
    numberOfNodes: 2
    # Use actual pod resource requests to calculate utilization
    useDeviationThresholds: false
    # Evict at most this percentage of pods per node per cycle
    evictionLimiter:
      maxPodsToEvictPerNode: 5
      maxPodsToEvictPerNamespace: 10
      maxNoOfPodsToEvictTotal: 100
```

**Threshold selection guidance:**

| Cluster type | lowThreshold | highThreshold |
|---|---|---|
| Batch/ML workloads | 20-30% | 70-80% |
| Web services | 20-30% | 50-60% |
| Mixed workloads | 20% | 50% |
| Cost-optimized | 30% | 80% |

**Critical warning**: If `highThreshold` is set too aggressively (e.g., >80%) and `lowThreshold` too low, the Descheduler can create eviction cascades — it evicts from high-utilization nodes, those pods land on previously-low-utilization nodes, pushing them above `highThreshold`, triggering further evictions. Always test thresholds in staging before production.

### RemoveDuplicates

Ensures ReplicaSet replicas are spread across as many nodes as possible. After rolling updates, multiple replicas of the same RS may land on the same node:

```yaml
- name: RemoveDuplicates
  args:
    apiVersion: descheduler/v1alpha2
    kind: RemoveDuplicatesArgs
    excludeOwnerKinds:
      - Job          # Batch jobs should not be moved mid-execution
      - DaemonSet    # DaemonSets are already 1-per-node
```

This plugin does not respect topology spread constraints — use `RemovePodsViolatingTopologySpreadConstraints` for that purpose.

### RemovePodsViolatingTopologySpreadConstraints

After deployments or node changes, pods may violate `topologySpreadConstraints` that were satisfiable at scheduling time but are no longer valid:

```yaml
- name: RemovePodsViolatingTopologySpreadConstraints
  args:
    apiVersion: descheduler/v1alpha2
    kind: RemovePodsViolatingTopologySpreadConstraintsArgs
    # Which constraint types to enforce
    constraints:
      - DoNotSchedule         # Hard constraints
      - ScheduleAnyway        # Soft constraints (optional — may be too aggressive)
    # Optional: only evict pods matching these labels
    labelSelector:
      matchLabels:
        topology-rebalancing: "true"
    # Namespace exclusions
    namespaces:
      exclude:
        - kube-system
```

### RemovePodsViolatingNodeAffinity

Evicts pods placed before a node's labels changed, where the pod's required node affinity no longer matches:

```yaml
- name: RemovePodsViolatingNodeAffinity
  args:
    apiVersion: descheduler/v1alpha2
    kind: RemovePodsViolatingNodeAffinityArgs
    nodeAffinityType:
      - requiredDuringSchedulingIgnoredDuringExecution
    # Do NOT include preferredDuringScheduling — that evicts too aggressively
```

### RemovePodsHavingTooManyRestarts

Evicts pods that are crash-looping. Combined with proper scheduling constraints, this forces re-placement onto healthy nodes:

```yaml
- name: RemovePodsHavingTooManyRestarts
  args:
    apiVersion: descheduler/v1alpha2
    kind: RemovePodsHavingTooManyRestartsArgs
    podRestartThreshold: 100   # Evict after 100 restarts
    includingInitContainers: true
```

**Note**: This is only useful when the crash is node-specific (e.g., a node-level dependency is missing). If the crash is due to application configuration, eviction just re-creates the same crash on a different node.

## Safe Eviction Configuration

### PodDisruptionBudget Integration

The Descheduler respects PodDisruptionBudgets by default. Every critical workload must have a PDB to prevent the Descheduler from taking down too many replicas simultaneously:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-service-pdb
  namespace: production
spec:
  minAvailable: 2   # At least 2 replicas must remain available
  selector:
    matchLabels:
      app: payment-service
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-gateway-pdb
  namespace: production
spec:
  maxUnavailable: 1  # At most 1 replica can be unavailable
  selector:
    matchLabels:
      app: api-gateway
```

### Annotation-Based Exclusions

Individual pods can opt out of descheduling:

```yaml
# Exclude a pod from all descheduler policies
metadata:
  annotations:
    descheduler.alpha.kubernetes.io/evict: "false"

# Exclude from specific policies via labels
metadata:
  labels:
    descheduler.alpha.kubernetes.io/do-not-evict: "true"
```

### Eviction Budget Configuration

```yaml
# Global eviction limits in the descheduler policy
deschedulerPolicy:
  maxNoOfPodsToEvictPerNode: 5        # Per node per cycle
  maxNoOfPodsToEvictPerNamespace: 20  # Per namespace per cycle
  maxNoOfPodsToEvictTotal: 100        # Global limit per cycle
  ignorePvcPods: true                 # Never evict pods with PVCs (default: false)
  evictDaemonSetPods: false           # Never evict DaemonSet pods
  evictSystemCriticalPods: false      # Never evict system-critical pods
  evictFailedBarePods: true           # Evict standalone failed pods
  evictLocalStoragePods: false        # Never evict pods using local storage
```

## Integration with Cluster Autoscaler

The Descheduler and Cluster Autoscaler work together to optimize cluster cost:

1. **Descheduler consolidates** workloads from underutilized nodes onto fewer nodes using `LowNodeUtilization`.
2. **Cluster Autoscaler detects** nodes with all pods moveable and schedules them for scale-down.
3. **Pods are drained** from scale-down candidates and re-scheduled onto remaining nodes.

For this workflow to function, the Descheduler must be enabled **before** Cluster Autoscaler scale-down checks run. A typical schedule:

```
# Descheduler CronJob: every 30 minutes
"*/30 * * * *"

# Cluster Autoscaler: continuously (built-in)
# scale-down-unneeded-time: 10m (default)
# scale-down-delay-after-add: 10m (default)
```

### Preventing Eviction Storms

When the Descheduler and Cluster Autoscaler run simultaneously, poorly tuned thresholds can trigger eviction storms:

```
Problem:
  1. Descheduler evicts pods from Node A (utilization 55%, above 50% highThreshold)
  2. Pods reschedule to Node B and Node C
  3. Node B now at 75% → Descheduler evicts from Node B next cycle
  4. Cascade continues

Solution:
  - Set highThreshold higher (70-80%) so only genuinely overloaded nodes are targeted
  - Set maxNoOfPodsToEvictPerNode conservatively (3-5)
  - Add cooldown by running Descheduler hourly, not every 10 minutes
  - Monitor eviction rates and alert on spikes
```

### Cluster Autoscaler Annotations for Safe Scale-Down

```yaml
# Prevent a node from being scaled down while critical pods are running
metadata:
  annotations:
    cluster-autoscaler.kubernetes.io/safe-to-evict: "false"

# Allow eviction of a specific pod (overrides default)
metadata:
  annotations:
    cluster-autoscaler.kubernetes.io/safe-to-evict: "true"
```

## Monitoring Descheduler Activity

### Prometheus Metrics

The Descheduler exposes metrics at `/metrics`:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: descheduler
  namespace: monitoring
spec:
  namespaceSelector:
    matchNames:
      - kube-system
  selector:
    matchLabels:
      app.kubernetes.io/name: descheduler
  endpoints:
    - port: metrics
      interval: 60s
      path: /metrics
```

Key metrics:

```promql
# Total evictions per plugin
sum by (plugin) (rate(descheduler_pods_evicted_total[5m]))

# Eviction rate (pods/minute)
rate(descheduler_pods_evicted_total[5m]) * 60

# Evictions blocked by PDB
rate(descheduler_pods_eviction_failures_total{reason="PodDisruptionBudget"}[5m])

# Scheduler balance score (external metric from node utilization)
stddev(kube_node_status_allocatable{resource="cpu"} - kube_node_status_capacity{resource="cpu"})
```

### Alert Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: descheduler-alerts
  namespace: monitoring
spec:
  groups:
    - name: descheduler
      rules:
        - alert: DeschedulerHighEvictionRate
          expr: rate(descheduler_pods_evicted_total[10m]) > 10
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Descheduler evicting more than 10 pods/minute"
            description: "High eviction rate may indicate misconfigured thresholds or cluster instability"

        - alert: DeschedulerEvictionBlocked
          expr: |
            rate(descheduler_pods_eviction_failures_total[10m]) > 5
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Descheduler evictions frequently blocked"
            description: "Check PDBs and pod configurations blocking eviction"

        - alert: NodeUtilizationImbalanced
          expr: |
            (
              max(kube_node_status_allocatable{resource="cpu"} /
                  kube_node_status_capacity{resource="cpu"}) -
              min(kube_node_status_allocatable{resource="cpu"} /
                  kube_node_status_capacity{resource="cpu"})
            ) > 0.5
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "Node CPU utilization spread exceeds 50%"
            description: "Descheduler may not be effectively balancing workloads"
```

## Testing Descheduler Policies

### Dry-Run Mode

```bash
# Run descheduler in dry-run mode to preview eviction decisions
kubectl run descheduler-dryrun \
  --image=registry.k8s.io/descheduler/descheduler:v0.30.1 \
  --restart=Never \
  --serviceaccount=descheduler \
  -n kube-system \
  -- \
  /bin/descheduler \
    --policy-config-file /policy/policy.yaml \
    --dry-run=true \
    --v=4

# Watch logs for eviction decisions
kubectl logs descheduler-dryrun -n kube-system -f
```

### Verifying PDB Compliance

```bash
# Check that descheduler respects PDBs
# 1. Find a deployment with PDB
kubectl get pdb -A

# 2. Scale down to minAvailable
kubectl scale deployment payment-service --replicas=2 -n production

# 3. Run descheduler and verify no evictions violate PDB
kubectl create job --from=cronjob/descheduler test-pdb-compliance -n kube-system

# 4. Watch events
kubectl get events -n production --sort-by='.lastTimestamp' | grep -i evict

# 5. Verify deployment availability was maintained
kubectl get deployment payment-service -n production
```

### Simulating Cluster Imbalance

```bash
# Create an imbalanced cluster state for testing
# Cordon all nodes except one, deploy many pods, then uncordon
kubectl cordon node-02 node-03 node-04

kubectl apply -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: imbalance-test
  namespace: default
spec:
  replicas: 20
  selector:
    matchLabels:
      app: imbalance-test
  template:
    metadata:
      labels:
        app: imbalance-test
    spec:
      containers:
        - name: sleep
          image: busybox:1.36
          command: ["sleep", "3600"]
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
EOF

kubectl uncordon node-02 node-03 node-04

# Before descheduling: all 20 pods on node-01
kubectl get pods -o wide | grep imbalance-test | awk '{print $7}' | sort | uniq -c

# Run descheduler
kubectl create job --from=cronjob/descheduler test-rebalance -n kube-system

# After descheduling: pods distributed across all nodes
kubectl get pods -o wide | grep imbalance-test | awk '{print $7}' | sort | uniq -c

# Cleanup
kubectl delete deployment imbalance-test
kubectl delete job test-rebalance -n kube-system
```

## Production Scheduling Profile

A complete, tested production profile combining all recommended plugins:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: descheduler-policy-configmap
  namespace: kube-system
data:
  policy.yaml: |
    apiVersion: descheduler/v1alpha2
    kind: DeschedulerPolicy
    maxNoOfPodsToEvictPerNode: 5
    maxNoOfPodsToEvictPerNamespace: 20
    maxNoOfPodsToEvictTotal: 200
    ignorePvcPods: true
    evictDaemonSetPods: false
    evictSystemCriticalPods: false
    evictFailedBarePods: true
    evictLocalStoragePods: false
    profiles:
      - name: production-balanced
        pluginConfig:
          - name: LowNodeUtilization
            args:
              apiVersion: descheduler/v1alpha2
              kind: LowNodeUtilizationArgs
              lowThreshold:
                cpu: 20
                memory: 20
              highThreshold:
                cpu: 60
                memory: 60
              numberOfNodes: 3
              evictionLimiter:
                maxPodsToEvictPerNode: 5
          - name: RemovePodsViolatingTopologySpreadConstraints
            args:
              apiVersion: descheduler/v1alpha2
              kind: RemovePodsViolatingTopologySpreadConstraintsArgs
              constraints:
                - DoNotSchedule
              namespaces:
                exclude:
                  - kube-system
                  - monitoring
                  - logging
                  - cert-manager
          - name: RemoveDuplicates
            args:
              apiVersion: descheduler/v1alpha2
              kind: RemoveDuplicatesArgs
              excludeOwnerKinds:
                - Job
                - DaemonSet
          - name: RemovePodsViolatingNodeAffinity
            args:
              apiVersion: descheduler/v1alpha2
              kind: RemovePodsViolatingNodeAffinityArgs
              nodeAffinityType:
                - requiredDuringSchedulingIgnoredDuringExecution
          - name: RemovePodsViolatingNodeTaints
            args:
              apiVersion: descheduler/v1alpha2
              kind: RemovePodsViolatingNodeTaintsArgs
          - name: RemovePodsHavingTooManyRestarts
            args:
              apiVersion: descheduler/v1alpha2
              kind: RemovePodsHavingTooManyRestartsArgs
              podRestartThreshold: 100
              includingInitContainers: true
        plugins:
          balance:
            enabled:
              - RemoveDuplicates
              - LowNodeUtilization
              - RemovePodsViolatingTopologySpreadConstraints
          deschedule:
            enabled:
              - RemovePodsViolatingNodeAffinity
              - RemovePodsViolatingNodeTaints
              - RemovePodsHavingTooManyRestarts
```

## Summary

The Kubernetes Descheduler is a critical but often overlooked component for maintaining cluster efficiency over time:

- **LowNodeUtilization** reclaims wasted capacity on overloaded nodes and enables Cluster Autoscaler to consolidate workloads and scale down underutilized nodes.
- **RemovePodsViolatingTopologySpreadConstraints** corrects imbalances that accumulate through rolling updates and node replacements.
- **RemoveDuplicates** ensures replica spread is maintained when the scheduler's initial decisions become suboptimal.
- **PodDisruptionBudgets** are the safety layer that ensures eviction policies never reduce availability below defined minima.
- **Conservative thresholds and eviction budgets** prevent the Descheduler from creating the instability it is designed to prevent.

Deploy the Descheduler on every cluster running more than 10 nodes with dynamic workloads — the cluster imbalance that accumulates without it translates directly to wasted compute cost and degraded scheduling quality.
