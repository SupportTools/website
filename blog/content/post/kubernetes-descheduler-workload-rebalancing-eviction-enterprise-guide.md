---
title: "Kubernetes Descheduler: Workload Rebalancing and Eviction"
date: 2029-04-17T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Descheduler", "Workload Rebalancing", "Cluster Autoscaler", "Scheduling", "Operations"]
categories:
- Kubernetes
- Operations
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to the Kubernetes descheduler covering eviction policies including RemoveDuplicates, LowNodeUtilization, and RemovePodsHavingTooManyRestarts, scheduling profiles, and integration with cluster-autoscaler."
more_link: "yes"
url: "/kubernetes-descheduler-workload-rebalancing-eviction-enterprise-guide/"
---

The Kubernetes scheduler makes placement decisions when pods are first created. It does not continuously optimize placement as conditions change — nodes may become overloaded, new nodes may join with capacity to spare, and cluster topology may shift after rolling updates. The descheduler fills this gap by periodically evicting pods from suboptimal locations so the scheduler can place them somewhere better.

This guide covers the descheduler's eviction policies in depth, explains how to configure scheduling profiles for different cluster types, and shows how to integrate the descheduler with cluster-autoscaler to maximize utilization without disrupting production workloads.

<!--more-->

# Kubernetes Descheduler: Workload Rebalancing and Eviction

## Section 1: Descheduler Architecture

### How the Descheduler Works

The descheduler is not a replacement for the scheduler. Its workflow:

1. Periodically scans the cluster (or runs as a Job/CronJob)
2. Evaluates pods against configurable policies
3. Evicts pods that violate policy constraints
4. The scheduler then re-places evicted pods on better nodes

The descheduler never directly schedules pods — it only evicts, then relies on the scheduler to make new placement decisions.

### Key Constraints

- The descheduler respects PodDisruptionBudgets before evicting
- Pods with `priorityClassName: system-cluster-critical` or `system-node-critical` are never evicted
- Pods on nodes with `node.kubernetes.io/unschedulable` taint are not considered
- DaemonSet pods are never evicted (they must run on specific nodes by design)
- Static pods (created by kubelet from static manifests) are never evicted

### Installation with Helm

```bash
# Add the descheduler Helm chart
helm repo add descheduler https://kubernetes-sigs.github.io/descheduler/
helm repo update

kubectl create namespace kube-system  # if not exists

# Install descheduler as a CronJob (runs every 5 minutes)
helm install descheduler descheduler/descheduler \
  --namespace kube-system \
  --set kind=CronJob \
  --set schedule="*/5 * * * *" \
  --set deschedulerPolicy.profiles[0].name=default \
  --version 0.29.0

# Or as a Deployment (continuous, with configurable interval)
helm install descheduler descheduler/descheduler \
  --namespace kube-system \
  --set kind=Deployment \
  --set deschedulingInterval=5m
```

## Section 2: Core Eviction Policies

### RemoveDuplicates

`RemoveDuplicates` evicts duplicate pods — multiple pods from the same ReplicaSet, Deployment, StatefulSet, or Job running on the same node.

**Problem it solves**: After a node failure and recovery, the scheduler may place multiple pods from the same deployment on a single node (the replacement pod plus the recovered pod from the recovered node). This concentrates blast radius.

```yaml
apiVersion: descheduler/v1alpha2
kind: DeschedulerPolicy
profiles:
- name: remove-duplicates
  pluginConfig:
  - name: RemoveDuplicates
    args:
      # Exclude specific namespaces from duplicate removal
      namespaces:
        exclude:
        - kube-system
        - monitoring
      # ExcludeOwnerKinds: skip pods owned by these
      excludeOwnerKinds:
      - ReplicationController  # legacy, treat as unique
  plugins:
    balance:
      enabled:
      - RemoveDuplicates
```

### LowNodeUtilization

`LowNodeUtilization` identifies underutilized nodes and evicts pods from overutilized nodes so they can be rescheduled onto the underutilized ones.

**Problem it solves**: After new nodes join the cluster, existing pods remain on old nodes. The new nodes sit idle while old nodes are overloaded.

```yaml
apiVersion: descheduler/v1alpha2
kind: DeschedulerPolicy
profiles:
- name: low-node-utilization
  pluginConfig:
  - name: LowNodeUtilization
    args:
      # Nodes below these thresholds are considered underutilized
      thresholds:
        cpu: 20      # percent
        memory: 20   # percent
        pods: 20     # percent
      # Nodes above these thresholds are considered overutilized
      targetThresholds:
        cpu: 50
        memory: 50
        pods: 50
      # Only consider nodes that have been underutilized for this duration
      # (prevents thrashing)
      nodeFit: true
      # Use namespace constraints when selecting pods to evict
      useDeallocationPolicy: true
      evictableNamespaces:
        include:
        - production
        - staging
      # Minimum number of pods that must remain on the node
      # after eviction (prevents over-eviction)
      # (set via evictionLimiter)
  plugins:
    balance:
      enabled:
      - LowNodeUtilization
```

**Understanding the thresholds**:
- Nodes with utilization below `thresholds` are "underutilized targets" — pods will be moved HERE
- Nodes with utilization above `targetThresholds` are "overutilized sources" — pods will be evicted FROM HERE
- Pods from overutilized nodes are evicted until the node drops below `targetThresholds`

### HighNodeUtilization

The inverse of `LowNodeUtilization`. Evicts pods from lightly loaded nodes so they can be consolidated:

```yaml
  pluginConfig:
  - name: HighNodeUtilization
    args:
      # Evict pods from nodes BELOW these thresholds
      thresholds:
        cpu: 20
        memory: 20
      # Target nodes above these thresholds (where evicted pods should land)
      targetThresholds:
        cpu: 50
        memory: 50
      nodeFit: true
  plugins:
    balance:
      enabled:
      - HighNodeUtilization
```

This policy is specifically designed to work with cluster-autoscaler — by concentrating workloads onto fewer nodes, underutilized nodes become eligible for scale-down.

### RemovePodsHavingTooManyRestarts

Evicts pods with excessive restart counts, forcing them to be recreated on a potentially healthier node.

**Problem it solves**: A pod may be crashing repeatedly on a specific node due to a node-level issue (bad disk, memory error, corrupted file in hostPath) while the same pod would run fine on another node. The descheduler evicts it so the scheduler can place it elsewhere.

```yaml
  pluginConfig:
  - name: RemovePodsHavingTooManyRestarts
    args:
      # Evict pods with more than this many restarts
      podRestartThreshold: 100
      # Include Init containers in restart count
      includingInitContainers: true
      # Only consider pods in Running state
      # (don't evict pods already in a terminal state)
      states:
      - Running
      - CrashLoopBackOff
      namespaces:
        include:
        - production
  plugins:
    deschedule:
      enabled:
      - RemovePodsHavingTooManyRestarts
```

### RemovePodsViolatingNodeAffinity

Evicts pods that are running on nodes that no longer match their node affinity rules. This happens when node labels change after pods are scheduled.

```yaml
  pluginConfig:
  - name: RemovePodsViolatingNodeAffinity
    args:
      # Check these affinity types
      nodeAffinityType:
      - requiredDuringSchedulingIgnoredDuringExecution
      # ^ "IgnoredDuringExecution" means scheduler ignores existing violations
      # The descheduler corrects them retroactively
      namespaces:
        exclude:
        - kube-system
  plugins:
    deschedule:
      enabled:
      - RemovePodsViolatingNodeAffinity
```

Example scenario: A node is relabeled from `environment=production` to `environment=staging`. Pods with `requiredDuringSchedulingIgnoredDuringExecution` affinity for production nodes should be evicted and rescheduled.

### RemovePodsViolatingNodeTaints

Evicts pods running on nodes with NoExecute taints that they don't tolerate:

```yaml
  pluginConfig:
  - name: RemovePodsViolatingNodeTaints
    args:
      # Include pods without explicit tolerations
      includePreferNoSchedule: false
      namespaces:
        exclude:
        - kube-system
  plugins:
    deschedule:
      enabled:
      - RemovePodsViolatingNodeTaints
```

### RemovePodsViolatingTopologySpreadConstraint

Evicts pods that violate `topologySpreadConstraints` in their spec. This is particularly useful after scaling events that create imbalanced distributions.

```yaml
  pluginConfig:
  - name: RemovePodsViolatingTopologySpreadConstraint
    args:
      # Re-balance pods violating hard constraints
      constraints:
      - DoNotSchedule
      # Also re-balance pods violating soft constraints
      # - ScheduleAnyway
      namespaces:
        exclude:
        - kube-system
      labelSelector:
        matchExpressions:
        - key: app
          operator: In
          values:
          - api-server
          - worker
  plugins:
    balance:
      enabled:
      - RemovePodsViolatingTopologySpreadConstraint
```

### RemovePodsViolatingInterPodAntiAffinity

Evicts pods that co-locate with pods they have anti-affinity rules against. This can happen when pods are scheduled before all their anti-affinity peers are running.

```yaml
  pluginConfig:
  - name: RemovePodsViolatingInterPodAntiAffinity
    args: {}
  plugins:
    deschedule:
      enabled:
      - RemovePodsViolatingInterPodAntiAffinity
```

## Section 3: Scheduling Profiles

### Profile-Based Configuration

Profiles group policies together with shared parameters. You can run multiple profiles simultaneously, each targeting different workloads or addressing different types of imbalance.

### Production Profile — Balance Without Disruption

```yaml
apiVersion: descheduler/v1alpha2
kind: DeschedulerPolicy

# Global eviction constraints
maxNoOfPodsToEvictPerNode: 5        # max evictions per node per cycle
maxNoOfPodsToEvictPerNamespace: 20  # max evictions per namespace per cycle
maxNoOfPodsToEvictTotal: 100        # max total evictions per cycle

profiles:
# Profile 1: Fix topology violations (high priority, run first)
- name: fix-violations
  pluginConfig:
  - name: DefaultEvictor
    args:
      nodeFit: true
      priorityThreshold:
        value: 1000  # don't evict pods with priority >= 1000
      evictLocalStoragePods: false
      evictSystemCriticalPods: false
  - name: RemovePodsViolatingNodeAffinity
    args:
      nodeAffinityType:
      - requiredDuringSchedulingIgnoredDuringExecution
  - name: RemovePodsViolatingInterPodAntiAffinity
    args: {}
  - name: RemovePodsViolatingTopologySpreadConstraint
    args:
      constraints:
      - DoNotSchedule
  plugins:
    deschedule:
      enabled:
      - RemovePodsViolatingNodeAffinity
      - RemovePodsViolatingInterPodAntiAffinity
    balance:
      enabled:
      - RemovePodsViolatingTopologySpreadConstraint

# Profile 2: Rebalance utilization (lower priority, run after violations fixed)
- name: rebalance-utilization
  pluginConfig:
  - name: DefaultEvictor
    args:
      nodeFit: true
      priorityThreshold:
        value: 100  # only evict lower-priority pods for rebalancing
      evictLocalStoragePods: false
  - name: LowNodeUtilization
    args:
      thresholds:
        cpu: 20
        memory: 20
        pods: 10
      targetThresholds:
        cpu: 50
        memory: 50
        pods: 50
      nodeFit: true
  plugins:
    balance:
      enabled:
      - LowNodeUtilization
```

### Development Cluster Profile — Aggressive Rebalancing

For dev clusters where disruption tolerance is higher:

```yaml
profiles:
- name: dev-aggressive-rebalance
  pluginConfig:
  - name: DefaultEvictor
    args:
      nodeFit: false           # evict even if no other node fits right now
      evictLocalStoragePods: true   # evict pods with emptyDir
      evictSystemCriticalPods: false
      priorityThreshold:
        value: 0               # evict any non-critical pod
  - name: RemoveDuplicates
    args: {}
  - name: LowNodeUtilization
    args:
      thresholds:
        cpu: 10
        memory: 10
        pods: 10
      targetThresholds:
        cpu: 80
        memory: 80
        pods: 80
  - name: RemovePodsHavingTooManyRestarts
    args:
      podRestartThreshold: 10
  plugins:
    deschedule:
      enabled:
      - RemovePodsHavingTooManyRestarts
    balance:
      enabled:
      - RemoveDuplicates
      - LowNodeUtilization
```

### GPU Cluster Profile

For ML/AI clusters where GPU utilization must be optimized:

```yaml
profiles:
- name: gpu-optimization
  pluginConfig:
  - name: DefaultEvictor
    args:
      nodeFit: true
      evictLocalStoragePods: false
      nodeSelector: "nvidia.com/gpu.present=true"
  - name: LowNodeUtilization
    args:
      thresholds:
        cpu: 5
        memory: 5
        # Custom resource thresholds
        "nvidia.com/gpu": 20   # GPU utilization threshold
      targetThresholds:
        cpu: 50
        memory: 50
        "nvidia.com/gpu": 80
  plugins:
    balance:
      enabled:
      - LowNodeUtilization
```

## Section 4: Integration with Cluster Autoscaler

### The Descheduler-Autoscaler Loop

The descheduler and cluster-autoscaler work together to optimize cluster size and utilization:

1. **Cluster Autoscaler scales up**: New node added when pods can't be scheduled
2. **Descheduler redistributes**: Evicts pods from overloaded nodes to newly added nodes
3. **Cluster Autoscaler scales down**: After descheduler consolidates pods, underutilized nodes become empty and eligible for removal

```
New pods -> Scheduler can't place -> CA scales up new node
               ↓
Descheduler runs -> Evicts pods from overloaded nodes
               ↓
Evicted pods -> Scheduler places on new (or other available) nodes
               ↓
Old overloaded node now underutilized -> CA scales it down
```

### Coordinating Descheduler with Cluster Autoscaler

```yaml
# cluster-autoscaler-config.yaml
apiVersion: autoscaling.k8s.io/v1
kind: ClusterAutoscaler
spec:
  scaleDown:
    enabled: true
    # Delay scale-down to allow descheduler to run first
    delayAfterAdd: 10m        # wait 10 minutes after scale-up before scaling down
    delayAfterDelete: 10m     # wait after node deletion
    delayAfterFailure: 3m
    # Utilization threshold for scale-down candidate
    utilizationThreshold: "0.5"  # scale down nodes below 50% utilization
    # Empty node scale-down
    unneededTime: 10m          # node must be unneeded for 10 min before removal
```

```yaml
# descheduler-for-autoscaler.yaml — optimize for CA interaction
apiVersion: descheduler/v1alpha2
kind: DeschedulerPolicy
profiles:
- name: consolidate-for-autoscaler
  pluginConfig:
  - name: DefaultEvictor
    args:
      nodeFit: true
      # Don't evict pods that have requested PVC storage
      # (they would need to be on the same node as the PV)
      evictLocalStoragePods: false
      priorityThreshold:
        value: 2000
  - name: HighNodeUtilization
    args:
      # Evict from nodes below 30% CPU and memory
      # CA will then scale these down
      thresholds:
        cpu: 30
        memory: 30
      targetThresholds:
        cpu: 70
        memory: 70
      nodeFit: true
  plugins:
    balance:
      enabled:
      - HighNodeUtilization
```

### Preventing Descheduler Interference with Rolling Updates

```yaml
# Annotate pods during rolling updates to prevent descheduling
# The DefaultEvictor checks this annotation
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
spec:
  template:
    metadata:
      annotations:
        # Prevent descheduler from evicting pods during rollout
        # (remove annotation once rollout is complete)
        descheduler.alpha.kubernetes.io/evict: "false"
```

Or use a pre/post-rollout hook:

```bash
# Pre-deployment hook: annotate existing pods
kubectl annotate pods -n production \
  -l app=api-server \
  --overwrite \
  descheduler.alpha.kubernetes.io/evict=false

# Deploy
kubectl rollout restart deployment/api-server -n production
kubectl rollout status deployment/api-server -n production

# Post-deployment: remove annotation
kubectl annotate pods -n production \
  -l app=api-server \
  --overwrite \
  descheduler.alpha.kubernetes.io/evict-
```

## Section 5: DefaultEvictor Configuration

The `DefaultEvictor` controls which pods are eligible for eviction across all policies:

```yaml
  pluginConfig:
  - name: DefaultEvictor
    args:
      # Only evict pods that can be rescheduled elsewhere
      # (checks if another node could accept the pod)
      nodeFit: true

      # Priority threshold: don't evict pods with priority >= this value
      # system-cluster-critical = 2000000000
      # system-node-critical = 2000001000
      priorityThreshold:
        value: 100    # only evict pods with priority < 100
        # OR use a priority class name:
        # name: low-priority

      # Evict pods even if they use local storage (emptyDir, hostPath)
      # Default: false (safe)
      evictLocalStoragePods: false

      # Evict system critical pods (not recommended for production)
      evictSystemCriticalPods: false

      # Ignore PodDisruptionBudgets (NOT recommended)
      ignorePvcPods: false

      # Filter by node labels
      nodeSelector: "node-role.kubernetes.io/worker=true"

      # Label selector for pods eligible for eviction
      labelSelector:
        matchExpressions:
        - key: eviction-group
          operator: In
          values:
          - "allowed"
```

## Section 6: Monitoring the Descheduler

### Prometheus Metrics

The descheduler exposes metrics on port 10258:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: descheduler-monitor
  namespace: kube-system
spec:
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
# Total evictions by plugin
sum(increase(descheduler_pods_evicted_total[1h])) by (plugin, namespace)

# Eviction success rate
rate(descheduler_pods_evicted_total{result="success"}[5m])
  /
rate(descheduler_pods_evicted_total[5m])

# Failed evictions (due to PDB or other constraints)
sum(increase(descheduler_pods_evicted_total{result="error"}[1h])) by (plugin)

# Nodes below utilization threshold
descheduler_nodes_eviction_metadata{type="underutilized"}
```

### Alerting for Excessive Evictions

```yaml
groups:
- name: descheduler-alerts
  rules:
  - alert: HighDeschedulerEvictionRate
    expr: |
      rate(descheduler_pods_evicted_total[5m]) > 10
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "Descheduler evicting more than 10 pods/minute"
      description: |
        The descheduler is evicting pods at a high rate, which may indicate
        a configuration issue or persistent cluster imbalance.

  - alert: DeschedulerPDBViolations
    expr: |
      increase(descheduler_pods_eviction_disabled_total[1h]) > 100
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Descheduler blocked by PDBs"
      description: |
        The descheduler is being blocked by PodDisruptionBudgets.
        Check for misconfigured PDBs that prevent rebalancing.
```

### Logging for Audit Trail

```bash
# Check descheduler logs for eviction decisions
kubectl logs -n kube-system \
  $(kubectl get pod -n kube-system -l app.kubernetes.io/name=descheduler -o name | head -1) \
  | grep -E "evict|error|warn" | tail -50

# Sample log entries:
# {"level":"info","time":"2029-04-17T10:00:00Z","msg":"Evicting pod",
#   "pod":"production/api-server-abc123","node":"worker-1",
#   "strategy":"LowNodeUtilization"}

# Monitor eviction events
kubectl get events -A \
  --field-selector reason=Evicted \
  --sort-by='.lastTimestamp' | tail -20
```

## Section 7: Advanced Configuration

### Running as a Job vs Deployment vs CronJob

**CronJob (recommended for most clusters)**:
```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: descheduler
  namespace: kube-system
spec:
  schedule: "*/5 * * * *"    # every 5 minutes
  concurrencyPolicy: Forbid  # don't run concurrent instances
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: descheduler
          restartPolicy: Never
          containers:
          - name: descheduler
            image: registry.k8s.io/descheduler/descheduler:v0.29.0
            command:
            - /bin/descheduler
            - --policy-config-file=/policy/policy.yaml
            - --v=4
            volumeMounts:
            - name: policy-volume
              mountPath: /policy
          volumes:
          - name: policy-volume
            configMap:
              name: descheduler-policy
```

**Deployment (for very large clusters needing continuous operation)**:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: descheduler
  namespace: kube-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app: descheduler
  template:
    spec:
      containers:
      - name: descheduler
        image: registry.k8s.io/descheduler/descheduler:v0.29.0
        command:
        - /bin/descheduler
        - --policy-config-file=/policy/policy.yaml
        - --descheduling-interval=5m
        - --v=4
```

### Namespace Filtering

```yaml
# Global namespace exclusions (apply to all plugins)
profiles:
- name: default
  pluginConfig:
  - name: DefaultEvictor
    args:
      evictNamespaces:
        include:     # Only evict from these namespaces
        - production
        - staging
        # exclude: [list of namespaces to never touch]

  - name: LowNodeUtilization
    args:
      thresholds:
        cpu: 20
        memory: 20
      targetThresholds:
        cpu: 50
        memory: 50
      # Plugin-specific namespace filter
      namespaces:
        exclude:
        - kube-system
        - monitoring
        - cert-manager
```

### Custom Eviction Rate Limiting

```yaml
apiVersion: descheduler/v1alpha2
kind: DeschedulerPolicy

# Global rate limits
maxNoOfPodsToEvictPerNode: 3
maxNoOfPodsToEvictPerNamespace: 10
maxNoOfPodsToEvictTotal: 50

# Eviction rate limits prevent runaway evictions
# These apply across all profiles
```

## Section 8: Troubleshooting

### Common Issues

**Issue: Pods not being evicted despite policy configuration**

```bash
# Check if pods have the eviction disabled annotation
kubectl get pods -n production -o json | \
  jq -r '.items[] |
    select(.metadata.annotations["descheduler.alpha.kubernetes.io/evict"] == "false") |
    .metadata.name'

# Check if pods are system-critical
kubectl get pods -n production -o json | \
  jq -r '.items[] |
    select(.spec.priorityClassName == "system-cluster-critical" or
           .spec.priorityClassName == "system-node-critical") |
    .metadata.name'

# Check if PDBs are blocking
kubectl get pdb -A -o json | \
  jq -r '.items[] | select(.status.disruptionsAllowed == 0) |
    "\(.metadata.namespace)/\(.metadata.name): disruptionsAllowed=0"'
```

**Issue: LowNodeUtilization not evicting from overloaded nodes**

```bash
# Check actual node utilization
kubectl top nodes

# Verify the thresholds are calibrated correctly
# If targetThresholds.cpu=50 but nodes are at 45%, they're not "overutilized"

# Check descheduler logs for which nodes are classified as over/under utilized
kubectl logs -n kube-system \
  $(kubectl get pod -n kube-system -l app=descheduler -o name | head -1) | \
  grep -E "underutilized|overutilized|candidate"
```

**Issue: Excessive pod evictions causing disruption**

```bash
# Reduce eviction limits
kubectl edit configmap descheduler-policy -n kube-system
# Decrease maxNoOfPodsToEvictPerNode and maxNoOfPodsToEvictTotal

# Add priority threshold to protect important pods
# Set priorityThreshold.value to a value below important pods' priorities

# Add PDBs for critical deployments
kubectl create pdb critical-app-pdb \
  --selector=app=critical-app \
  --min-available=80% \
  -n production
```

### Dry Run Mode

```bash
# Run descheduler in dry-run mode to preview evictions without taking action
kubectl run descheduler-dryrun \
  --image=registry.k8s.io/descheduler/descheduler:v0.29.0 \
  --restart=Never \
  --rm \
  -it \
  -- /bin/descheduler \
  --policy-config-file=/policy/policy.yaml \
  --dry-run \
  --v=4
```

## Summary

The Kubernetes descheduler is an essential component for long-running production clusters where initial pod placement becomes suboptimal over time. Key operational points:

- **RemoveDuplicates** prevents concentration of replicas on a single node after node recovery events
- **LowNodeUtilization** redistributes pods from overloaded nodes to underutilized ones, especially after new nodes join
- **HighNodeUtilization** concentrates workloads for CA-driven scale-down
- **RemovePodsHavingTooManyRestarts** relocates crash-looping pods away from problematic nodes
- **RemovePodsViolatingTopologySpreadConstraint** re-balances zone distribution after scaling

Configure the `DefaultEvictor` with appropriate `priorityThreshold` values to protect critical system workloads. Set `nodeFit: true` to avoid evicting pods that cannot be rescheduled, which would simply make them pending. Integrate with cluster-autoscaler by using `HighNodeUtilization` to consolidate workloads and enable scale-down. Always monitor `descheduler_pods_evicted_total` with Prometheus to detect misconfiguration before it causes production disruption.
