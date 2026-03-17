---
title: "Advanced Kubernetes Pod Scheduling: Affinity, Topology, and Priority"
date: 2027-12-05T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Scheduling", "Affinity", "Topology Spread", "Priority"]
categories:
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Kubernetes pod scheduling including node affinity, pod affinity and anti-affinity, topology spread constraints, priority classes, preemption, scheduler plugins, descheduler, and GPU scheduling patterns for production clusters."
more_link: "yes"
url: /kubernetes-pod-scheduling-strategies-guide/
---

The Kubernetes scheduler makes placement decisions that directly affect application availability, performance, and cost. Understanding its internals — the filtering and scoring pipeline, how affinity expressions interact with topology spread constraints, how priority classes drive preemption — allows you to design workloads that behave predictably under pressure.

This guide covers every major scheduling primitive with production configurations, explains the failure modes that catch teams off guard, and shows how to extend and correct scheduling decisions with the descheduler and custom scheduler plugins.

<!--more-->

# Advanced Kubernetes Pod Scheduling: Affinity, Topology, and Priority

## Scheduler Architecture Overview

The kube-scheduler operates as a single-process control loop that selects a node for each unscheduled pod. The selection pipeline has two phases:

**Filtering phase** — eliminates nodes that cannot satisfy hard requirements:
- `NodeUnschedulable` — nodes with `spec.unschedulable: true`
- `NodeResourcesFit` — available CPU, memory, extended resources
- `NodeAffinity` — required node affinity expressions
- `PodAffinity` / `PodAntiAffinity` — required pod colocation/separation rules
- `TaintToleration` — pod tolerations must cover node taints
- `VolumeBinding` — node must satisfy PVC topology constraints
- `TopologySpread` — hard spread constraints (whenUnsatisfiable: DoNotSchedule)

**Scoring phase** — ranks remaining nodes by preference:
- `NodeResourcesBalancedAllocation` — prefers nodes with balanced CPU/memory utilization
- `ImageLocality` — favors nodes that already have the container image layers
- `InterPodAffinity` — soft pod affinity/anti-affinity preferences
- `NodeAffinity` — preferred node affinity weight contributions
- `TopologySpread` — soft spread constraint scoring
- `TaintToleration` — nodes with fewer un-tolerated taints score higher

Understanding this pipeline is essential for diagnosing `Pending` pods. When a pod cannot be scheduled, the scheduler logs a reason per filter plugin, visible via:

```bash
kubectl describe pod <pod-name> -n <namespace>
# Look for: Events section — "FailedScheduling"
# Example: 0/12 nodes available: 3 node(s) had taint {node.kubernetes.io/not-ready: }, 
#          4 node(s) didn't match pod anti-affinity rules, 5 node(s) had insufficient memory.
```

## Node Affinity and Anti-Affinity

Node affinity supersedes the older `nodeSelector` field and supports rich expression syntax.

### Required Node Affinity (Hard Rules)

Required affinity uses `requiredDuringSchedulingIgnoredDuringExecution`. The `IgnoredDuringExecution` part means existing pods are not evicted when node labels change — only new scheduling decisions are affected.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: database-tier
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: database-tier
  template:
    metadata:
      labels:
        app: database-tier
    spec:
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            # Terms are OR'd together — pod matches if any term satisfies
            - matchExpressions:
              # Expressions within a term are AND'd together
              - key: node-role.kubernetes.io/database
                operator: Exists
              - key: topology.kubernetes.io/zone
                operator: In
                values:
                - us-east-1a
                - us-east-1b
              - key: kubernetes.io/arch
                operator: In
                values:
                - amd64
            - matchExpressions:
              # Second term: bare-metal database nodes in any zone
              - key: node-role.kubernetes.io/database-baremetal
                operator: Exists
              - key: kubernetes.io/arch
                operator: In
                values:
                - amd64
      containers:
      - name: postgres
        image: postgres:16.1
        resources:
          requests:
            cpu: "4"
            memory: 16Gi
          limits:
            cpu: "8"
            memory: 32Gi
```

Valid operators for `matchExpressions`:
- `In` — label value must be in the values list
- `NotIn` — label value must not be in the values list
- `Exists` — label key must be present (values field ignored)
- `DoesNotExist` — label key must be absent
- `Gt` — label value (parsed as integer) must be greater than the single value
- `Lt` — label value must be less than the single value

`Gt` and `Lt` are useful for tiering nodes by generation or capacity:

```yaml
- matchExpressions:
  - key: node.kubernetes.io/generation
    operator: Gt
    values:
    - "2"   # Only schedule on 3rd generation or newer nodes
```

### Preferred Node Affinity (Soft Rules)

`preferredDuringSchedulingIgnoredDuringExecution` adds weighted hints to the scoring phase without blocking placement if no matching node exists.

```yaml
affinity:
  nodeAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
    - weight: 80
      preference:
        matchExpressions:
        - key: node.kubernetes.io/instance-type
          operator: In
          values:
          - m6i.4xlarge
          - m6i.8xlarge
    - weight: 60
      preference:
        matchExpressions:
        - key: topology.kubernetes.io/zone
          operator: In
          values:
          - us-east-1a
    - weight: 20
      preference:
        matchExpressions:
        - key: node-role.kubernetes.io/compute-optimized
          operator: Exists
```

Weights range from 1 to 100. The scheduler sums the weights of satisfied preferences and adds that to the node's score. With the example above, a node matching all three preferences receives 80 + 60 + 20 = 160 bonus scoring points before normalization.

### Node Affinity for Multi-Architecture Clusters

Mixed amd64/arm64 clusters require careful affinity to prevent scheduling surprises:

```yaml
# Enforce architecture explicitly for workloads with architecture-specific binaries
affinity:
  nodeAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      nodeSelectorTerms:
      - matchExpressions:
        - key: kubernetes.io/arch
          operator: In
          values:
          - amd64
```

For multi-arch images that genuinely run on either architecture, omit the constraint — the scheduler's image locality scoring will prefer nodes that already have the image pulled.

## Pod Affinity and Anti-Affinity

Pod affinity and anti-affinity co-locate or separate pods based on what is already running on a node or within a topology domain.

### Understanding topologyKey

The `topologyKey` field defines the scope of the affinity check. The scheduler groups nodes by the value of `topologyKey` and evaluates the constraint at that granularity:

| `topologyKey` | Scope |
|---|---|
| `kubernetes.io/hostname` | Single node |
| `topology.kubernetes.io/zone` | Availability zone |
| `topology.kubernetes.io/region` | Cloud region |
| `node-role.kubernetes.io/worker` | All nodes sharing this label value |
| Custom label | Any grouping you define |

When `topologyKey` is `topology.kubernetes.io/zone` and a pod with matching labels exists in `us-east-1a`, the anti-affinity rule prevents scheduling any more pods in `us-east-1a` (not just on that specific node).

### Required Pod Anti-Affinity for High Availability

Ensure replicas of a StatefulSet are never co-located in the same availability zone:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: kafka
  namespace: messaging
spec:
  replicas: 3
  serviceName: kafka-headless
  selector:
    matchLabels:
      app: kafka
  template:
    metadata:
      labels:
        app: kafka
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchExpressions:
              - key: app
                operator: In
                values:
                - kafka
            topologyKey: topology.kubernetes.io/zone
            namespaces:
            - messaging
      containers:
      - name: kafka
        image: confluentinc/cp-kafka:7.5.0
        ports:
        - containerPort: 9092
        - containerPort: 9093
        resources:
          requests:
            cpu: "2"
            memory: 8Gi
          limits:
            cpu: "4"
            memory: 16Gi
```

This configuration blocks scheduling unless the zone already has no other Kafka pod. In a 3-zone cluster with 3 replicas, each replica lands in a different zone.

**Critical failure mode:** If you have 3 replicas but only 2 zones, the third pod will remain `Pending` indefinitely. The `kubectl describe pod` output will show:

```
Events:
  Warning  FailedScheduling  0/9 nodes available: 
    3 node(s) didn't match pod anti-affinity rules (zone: us-east-1a already has kafka pod),
    3 node(s) didn't match pod anti-affinity rules (zone: us-east-1b already has kafka pod),
    3 node(s) had taint {node.kubernetes.io/not-ready: }.
```

### Preferred Pod Anti-Affinity

Soft anti-affinity expresses a preference without blocking placement:

```yaml
affinity:
  podAntiAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
    - weight: 100
      podAffinityTerm:
        labelSelector:
          matchLabels:
            app: frontend
        topologyKey: kubernetes.io/hostname
    - weight: 50
      podAffinityTerm:
        labelSelector:
          matchLabels:
            app: frontend
        topologyKey: topology.kubernetes.io/zone
```

This strongly prefers different nodes (weight 100) and moderately prefers different zones (weight 50). When node-level separation is impossible (more replicas than nodes), the scheduler falls back to zone-level separation before accepting colocation.

### Pod Affinity for Cache Colocation

Place application pods near their cache sidecar without requiring exact co-node placement:

```yaml
affinity:
  podAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
    - weight: 90
      podAffinityTerm:
        labelSelector:
          matchLabels:
            app: redis-cache
            tier: l1
        topologyKey: kubernetes.io/hostname
    - weight: 40
      podAffinityTerm:
        labelSelector:
          matchLabels:
            app: redis-cache
        topologyKey: topology.kubernetes.io/zone
```

Required pod affinity (`requiredDuringSchedulingIgnoredDuringExecution`) is rarely appropriate for application workloads because it creates hard coupling — if the target pods are evicted or scaled down, new pods cannot be scheduled. Use required affinity only for strict licensing or network topology requirements.

## Topology Spread Constraints

Topology spread constraints are the modern approach to distributing pods across failure domains. They overcome the combinatorial complexity of expressing even distribution through anti-affinity rules alone.

### Basic Zone Distribution

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: production
spec:
  replicas: 9
  selector:
    matchLabels:
      app: api-server
  template:
    metadata:
      labels:
        app: api-server
        version: v2
    spec:
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: api-server
        # matchLabelKeys adds the pod-template-hash to prevent 
        # cross-revision skew calculation during rolling updates (Kubernetes 1.27+)
        matchLabelKeys:
        - pod-template-hash
      - maxSkew: 2
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: ScheduleAnyway
        labelSelector:
          matchLabels:
            app: api-server
        matchLabelKeys:
        - pod-template-hash
      containers:
      - name: api-server
        image: myregistry.example.com/api-server:v2.4.1
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
```

With 9 replicas in 3 zones and `maxSkew: 1`, the scheduler targets 3 pods per zone. The maximum allowed difference between the most-populated and least-populated zone is 1 (so distributions like 4-3-2 are allowed, but 5-3-1 is not).

`whenUnsatisfiable` behaviors:
- `DoNotSchedule` — hard constraint; pod stays `Pending` if no valid placement exists
- `ScheduleAnyway` — soft constraint; scheduler still tries to minimize skew but proceeds even if it cannot satisfy it

### The matchLabelKeys Field

`matchLabelKeys` (stable in Kubernetes 1.27) is critical for rolling updates. Without it, the old and new ReplicaSet pods count together for spread calculation, causing the scheduler to over-constrain placement during transitions:

```yaml
# Without matchLabelKeys: both old (hash=abc) and new (hash=xyz) pods 
# are counted together. If 6 old pods exist across zones 3-2-1,
# new pods can only land in the zone with 1 old pod.

# With matchLabelKeys: [pod-template-hash], each ReplicaSet revision 
# calculates spread independently.
matchLabelKeys:
- pod-template-hash
```

### Multi-Dimension Spread

Constrain spread across both zone and node simultaneously for tighter placement guarantees:

```yaml
topologySpreadConstraints:
# Primary constraint: zone-level HA
- maxSkew: 1
  topologyKey: topology.kubernetes.io/zone
  whenUnsatisfiable: DoNotSchedule
  labelSelector:
    matchLabels:
      app: api-server
  minDomains: 3   # Require at least 3 zones to be present (Kubernetes 1.26+)
# Secondary constraint: prevent all pods landing on one node per zone
- maxSkew: 1
  topologyKey: kubernetes.io/hostname
  whenUnsatisfiable: ScheduleAnyway
  labelSelector:
    matchLabels:
      app: api-server
```

`minDomains` (stable in 1.28) prevents successful scheduling when fewer topology domains are available than expected. This catches degraded cluster states — if you lose an entire zone and `minDomains: 3`, new pods will be `Pending` rather than silently concentrating in 2 zones.

### NodeAffinityPolicy and NodeTaintsPolicy

In Kubernetes 1.26+, you can control whether topology spread counts only eligible nodes or all nodes:

```yaml
topologySpreadConstraints:
- maxSkew: 1
  topologyKey: topology.kubernetes.io/zone
  whenUnsatisfiable: DoNotSchedule
  labelSelector:
    matchLabels:
      app: api-server
  # Count only nodes matching nodeAffinity/nodeSelector
  nodeAffinityPolicy: Honor
  # Count only nodes without un-tolerated taints
  nodeTaintsPolicy: Honor
```

Default for both fields is `Honor` in 1.26+. Setting either to `Ignore` counts all nodes regardless of affinity or taints, which can mislead the spread calculation for taint-separated node groups.

### Cluster-Wide Default Topology Spread Constraints

Configure default constraints in the scheduler configuration to apply them to all pods that don't specify their own:

```yaml
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
profiles:
- schedulerName: default-scheduler
  pluginConfig:
  - name: PodTopologySpread
    args:
      defaultConstraints:
      - maxSkew: 3
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: ScheduleAnyway
      - maxSkew: 5
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: ScheduleAnyway
      defaultMinDomains: 1
```

These defaults only apply when the pod has no `topologySpreadConstraints` defined. Any pod-level constraints completely replace the defaults (they are not merged).

## Taints, Tolerations, and Dedicated Node Pools

### Node Taints

Taints prevent pods from scheduling on nodes unless the pod explicitly tolerates the taint:

```bash
# Taint a node pool for GPU workloads
kubectl taint nodes gpu-node-1 gpu-node-2 gpu-node-3 \
  nvidia.com/gpu=present:NoSchedule

# Taint for spot/preemptible instances
kubectl taint nodes spot-1 spot-2 spot-3 \
  cloud.google.com/gke-spot=true:NoSchedule

# Mark a node as draining (prevents new pods, does not evict existing)
kubectl taint nodes draining-node-1 \
  node.kubernetes.io/unschedulable=:NoSchedule
```

Taint effects:
- `NoSchedule` — new pods without toleration cannot be scheduled; existing pods are not affected
- `PreferNoSchedule` — soft version; scheduler avoids but does not forbid
- `NoExecute` — evicts existing pods that don't tolerate, in addition to blocking new pods

### Tolerations

```yaml
# Tolerate GPU taint
tolerations:
- key: "nvidia.com/gpu"
  operator: "Equal"
  value: "present"
  effect: "NoSchedule"

# Tolerate spot taint
- key: "cloud.google.com/gke-spot"
  operator: "Exists"
  effect: "NoSchedule"

# Tolerate any taint on this key regardless of value
- key: "dedicated"
  operator: "Exists"

# Tolerate the built-in not-ready taint for 300 seconds before eviction
- key: "node.kubernetes.io/not-ready"
  operator: "Exists"
  effect: "NoExecute"
  tolerationSeconds: 300
```

### Dedicated Node Pool Pattern

Combine taints with node affinity to create exclusive node pools:

```yaml
# DaemonSet for GPU node monitoring — must run on GPU nodes, nowhere else
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: gpu-monitor
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: gpu-monitor
  template:
    metadata:
      labels:
        app: gpu-monitor
    spec:
      tolerations:
      - key: nvidia.com/gpu
        operator: Exists
        effect: NoSchedule
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: nvidia.com/gpu
                operator: Exists
      containers:
      - name: gpu-monitor
        image: nvcr.io/nvidia/k8s/dcgm-exporter:3.3.0-3.2.0-ubuntu22.04
        securityContext:
          privileged: true
        resources:
          requests:
            nvidia.com/gpu: 1
            cpu: 100m
            memory: 128Mi
```

```yaml
# GPU training job — tolerate GPU taint AND require GPU node label
apiVersion: batch/v1
kind: Job
metadata:
  name: model-training-v3
  namespace: ml-platform
spec:
  template:
    spec:
      tolerations:
      - key: nvidia.com/gpu
        operator: Equal
        value: present
        effect: NoSchedule
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: nvidia.com/gpu
                operator: Exists
              - key: node.kubernetes.io/instance-type
                operator: In
                values:
                - p3.8xlarge
                - p3.16xlarge
                - p4d.24xlarge
      containers:
      - name: trainer
        image: nvcr.io/nvidia/pytorch:23.10-py3
        resources:
          requests:
            nvidia.com/gpu: 4
            cpu: "16"
            memory: 64Gi
          limits:
            nvidia.com/gpu: 4
            cpu: "32"
            memory: 128Gi
      restartPolicy: OnFailure
```

## Priority Classes and Preemption

### Priority Class Hierarchy

Define a priority class hierarchy that matches your operational tiers:

```yaml
# System-critical: reserved for infrastructure components
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: system-cluster-critical
value: 2000000000
globalDefault: false
description: "Reserved for system-critical cluster infrastructure."
preemptionPolicy: PreemptLowerPriority

---
# Platform-critical: monitoring, logging, security agents
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: platform-critical
value: 1000000
globalDefault: false
description: "Platform infrastructure that must remain running."
preemptionPolicy: PreemptLowerPriority

---
# Production high: latency-sensitive production services
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: production-high
value: 100000
globalDefault: false
description: "High-priority production workloads."
preemptionPolicy: PreemptLowerPriority

---
# Production default: standard production workloads
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: production-default
value: 50000
globalDefault: true
description: "Default priority for production workloads."
preemptionPolicy: PreemptLowerPriority

---
# Batch: background jobs and batch processing
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: batch
value: 10000
globalDefault: false
description: "Batch and background processing workloads."
preemptionPolicy: PreemptLowerPriority

---
# Spot-batch: jobs that run on spot/preemptible nodes
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: spot-batch
value: 1000
globalDefault: false
description: "Spot-tolerant batch jobs."
preemptionPolicy: Never   # Will not preempt other pods; accepts preemption gracefully
```

Built-in system priority classes (`system-node-critical` = 2000001000, `system-cluster-critical` = 2000000000) take precedence over user-defined ones. Do not create classes with values above 1 billion — values above that are reserved for system use.

### Assigning Priority Classes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: production
spec:
  replicas: 5
  template:
    spec:
      priorityClassName: production-high
      containers:
      - name: payment-service
        image: myregistry.example.com/payment-service:v3.2.0
        resources:
          requests:
            cpu: "1"
            memory: 2Gi
          limits:
            cpu: "2"
            memory: 4Gi
```

### Preemption Behavior

When a high-priority pod cannot be scheduled due to resource constraints, the scheduler will attempt to preempt (evict) lower-priority pods to make room:

1. The scheduler identifies nodes where preempting lower-priority pods would free enough resources
2. It selects the node that requires the least disruption
3. It removes selected pods (bypassing PodDisruptionBudgets for pods lower than the minimum available threshold)
4. The high-priority pod is scheduled on the newly freed node

**Important:** Preemption does NOT immediately evict pods. The scheduler marks the node as the nominated node for the pending pod, then the graceful termination of preempted pods proceeds normally. The pending pod may not land on that node if other pods get scheduled there first.

Monitor preemption events:

```bash
# Watch for preemption events
kubectl get events --all-namespaces \
  --field-selector reason=Preempted \
  --sort-by='.lastTimestamp'

# Check nominated node for a pending pod
kubectl get pod <pod-name> -o jsonpath='{.status.nominatedNodeName}'
```

### Non-Preempting Priority Classes

`preemptionPolicy: Never` creates a priority class that benefits from node scoring improvements (lower-priority pods are less likely to be scheduled on their preferred nodes) but will not evict existing pods. Use this for:

- Batch jobs that can wait but should not cause disruption
- Development workloads
- Spot-instance jobs that accept being blocked

```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: development
value: 5000
globalDefault: false
description: "Development and testing workloads. Non-preempting."
preemptionPolicy: Never
```

## Scheduler Profiles and Plugins

Kubernetes 1.18+ supports multiple scheduler profiles within a single scheduler process, allowing different workloads to use different scheduling policies.

### Dual-Profile Scheduler Configuration

```yaml
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
leaderElection:
  leaderElect: true
  resourceNamespace: kube-system
  resourceName: kube-scheduler
clientConnection:
  kubeconfig: /etc/kubernetes/scheduler.conf
profiles:
# Default profile for general workloads
- schedulerName: default-scheduler
  plugins:
    filter:
      enabled:
      - name: NodeResourcesFit
      - name: NodeAffinity
      - name: PodTopologySpread
      - name: TaintToleration
      - name: VolumeBinding
    score:
      enabled:
      - name: NodeResourcesBalancedAllocation
        weight: 1
      - name: ImageLocality
        weight: 1
      - name: NodeAffinity
        weight: 2
      - name: PodTopologySpread
        weight: 2
      - name: TaintToleration
        weight: 1
  pluginConfig:
  - name: PodTopologySpread
    args:
      defaultConstraints:
      - maxSkew: 3
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: ScheduleAnyway
  - name: NodeResourcesFit
    args:
      scoringStrategy:
        type: LeastAllocated
        resources:
        - name: cpu
          weight: 1
        - name: memory
          weight: 1

# High-density profile for batch workloads — pack nodes tightly
- schedulerName: batch-scheduler
  plugins:
    score:
      enabled:
      - name: NodeResourcesBalancedAllocation
        weight: 0   # Disable balanced allocation
      disabled:
      - name: NodeResourcesBalancedAllocation
  pluginConfig:
  - name: NodeResourcesFit
    args:
      scoringStrategy:
        type: MostAllocated   # Pack nodes to consolidate batch jobs
        resources:
        - name: cpu
          weight: 1
        - name: memory
          weight: 1
```

To use the batch scheduler, specify `schedulerName` in the pod spec:

```yaml
spec:
  schedulerName: batch-scheduler
  containers:
  - name: batch-worker
    image: myregistry.example.com/batch-worker:v1.0.0
```

### Custom Scheduler Plugin Development

For specialized scheduling requirements, implement a custom plugin that conforms to the scheduler framework interface. The framework exposes extension points at each phase:

```go
// pkg/scheduler/plugin/tenantaware/plugin.go
package tenantaware

import (
    "context"
    "fmt"

    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/kubernetes/pkg/scheduler/framework"
)

const Name = "TenantAwareScheduling"

type TenantAwarePlugin struct {
    handle framework.Handle
}

var _ framework.FilterPlugin = &TenantAwarePlugin{}
var _ framework.ScorePlugin = &TenantAwarePlugin{}

func (t *TenantAwarePlugin) Name() string { return Name }

// Filter: prevent cross-tenant pod placement on dedicated nodes
func (t *TenantAwarePlugin) Filter(
    ctx context.Context,
    state *framework.CycleState,
    pod *corev1.Pod,
    nodeInfo *framework.NodeInfo,
) *framework.Status {
    podTenant, ok := pod.Labels["tenant.example.com/id"]
    if !ok {
        return framework.NewStatus(framework.Success)
    }

    nodeTenant, ok := nodeInfo.Node().Labels["tenant.example.com/dedicated"]
    if !ok {
        return framework.NewStatus(framework.Success)
    }

    if podTenant != nodeTenant {
        return framework.NewStatus(
            framework.Unschedulable,
            fmt.Sprintf("node dedicated to tenant %s, pod belongs to tenant %s",
                nodeTenant, podTenant),
        )
    }
    return framework.NewStatus(framework.Success)
}

// Score: prefer nodes in the same tenant zone
func (t *TenantAwarePlugin) Score(
    ctx context.Context,
    state *framework.CycleState,
    pod *corev1.Pod,
    nodeName string,
) (int64, *framework.Status) {
    podTenant, ok := pod.Labels["tenant.example.com/id"]
    if !ok {
        return framework.MinNodeScore, framework.NewStatus(framework.Success)
    }

    nodeInfo, err := t.handle.SnapshotSharedLister().NodeInfos().Get(nodeName)
    if err != nil {
        return 0, framework.AsStatus(err)
    }

    if nodeInfo.Node().Labels["tenant.example.com/zone"] == podTenant+"-zone" {
        return framework.MaxNodeScore, framework.NewStatus(framework.Success)
    }
    return framework.MinNodeScore, framework.NewStatus(framework.Success)
}

func (t *TenantAwarePlugin) ScoreExtensions() framework.ScoreExtensions {
    return nil
}

func New(obj runtime.Object, h framework.Handle) (framework.Plugin, error) {
    return &TenantAwarePlugin{handle: h}, nil
}
```

The plugin is compiled into a custom scheduler binary and configured in the KubeSchedulerConfiguration:

```yaml
profiles:
- schedulerName: tenant-scheduler
  plugins:
    filter:
      enabled:
      - name: TenantAwareScheduling
    score:
      enabled:
      - name: TenantAwareScheduling
        weight: 3
```

## The Descheduler

The descheduler corrects placement decisions over time. While the scheduler only acts on pod creation, the descheduler evicts pods that are no longer optimally placed due to:
- Node label changes after scheduling
- Cluster topology changes (node additions/removals)
- Rebalancing after disruptions

### Descheduler Installation

```bash
helm repo add descheduler https://kubernetes-sigs.github.io/descheduler/
helm repo update

helm install descheduler descheduler/descheduler \
  --namespace kube-system \
  --create-namespace \
  --version 0.29.0 \
  --set kind=Deployment \
  --set schedule="*/5 * * * *" \
  --set-json 'deschedulerPolicy.profiles=[{"name":"default","pluginConfig":[{"name":"DefaultEvictor","args":{"nodeFit":true,"priorityThreshold":{"name":"batch"}}}]}]'
```

### Descheduler Policy Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: descheduler-policy
  namespace: kube-system
data:
  policy.yaml: |
    apiVersion: "descheduler/v1alpha2"
    kind: "DeschedulerPolicy"
    profiles:
    - name: default
      pluginConfig:
      - name: "DefaultEvictor"
        args:
          # Do not evict pods with priority at or above this class
          priorityThreshold:
            name: production-high
          # Only evict pods from nodes that have a node fit (scheduler can place them elsewhere)
          nodeFit: true
          # Skip evicting pods with local storage
          evictLocalStoragePods: false
          # Skip DaemonSet pods
          evictDaemonSetPods: false

      - name: "RemoveDuplicates"
        args:
          # Evict duplicate pods when more than one pod from the same
          # ReplicaSet/StatefulSet lands on the same node
          excludeOwnerKinds:
          - "DaemonSet"

      - name: "RemovePodsViolatingNodeAffinity"
        args:
          # Evict pods that no longer satisfy their node affinity rules
          # (e.g., after node labels were removed)
          nodeAffinityType:
          - "requiredDuringSchedulingIgnoredDuringExecution"

      - name: "RemovePodsViolatingNodeTaints"
        args: {}

      - name: "RemovePodsViolatingTopologySpreadConstraint"
        args:
          # Rebalance pods that violate topology spread constraints
          constraints:
          - DoNotSchedule
          - ScheduleAnyway

      - name: "LowNodeUtilization"
        args:
          # Evict pods from overutilized nodes to underutilized nodes
          thresholds:
            cpu: 20
            memory: 20
            pods: 20
          targetThresholds:
            cpu: 50
            memory: 50
            pods: 50
          # Use extended resources in utilization calculation
          useDeviationThresholds: false

      - name: "HighNodeUtilization"
        args:
          # Pack pods onto fewer nodes to enable scale-down
          # (opposite of LowNodeUtilization — only enable one)
          thresholds:
            cpu: 20
            memory: 20
```

Deploy as a CronJob for periodic rebalancing:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: descheduler
  namespace: kube-system
spec:
  schedule: "*/15 * * * *"
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: descheduler
          priorityClassName: system-cluster-critical
          containers:
          - name: descheduler
            image: registry.k8s.io/descheduler/descheduler:v0.29.0
            command:
            - /bin/descheduler
            args:
            - --policy-config-map-name=descheduler-policy
            - --policy-config-map-namespace=kube-system
            - --dry-run=false
            - --v=3
            resources:
              requests:
                cpu: 100m
                memory: 128Mi
              limits:
                cpu: 500m
                memory: 512Mi
          restartPolicy: Never
```

### Descheduler RBAC

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: descheduler
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: descheduler
rules:
- apiGroups: [""]
  resources: ["nodes"]
  verbs: ["get", "watch", "list"]
- apiGroups: [""]
  resources: ["namespaces"]
  verbs: ["get", "watch", "list"]
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "watch", "list", "delete"]
- apiGroups: [""]
  resources: ["pods/eviction"]
  verbs: ["create"]
- apiGroups: ["scheduling.k8s.io"]
  resources: ["priorityclasses"]
  verbs: ["get", "watch", "list"]
- apiGroups: ["apps"]
  resources: ["deployments", "replicasets", "statefulsets", "daemonsets"]
  verbs: ["get", "watch", "list"]
- apiGroups: ["policy"]
  resources: ["poddisruptionbudgets"]
  verbs: ["get", "watch", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: descheduler
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: descheduler
subjects:
- kind: ServiceAccount
  name: descheduler
  namespace: kube-system
```

## GPU and Special Hardware Scheduling

### NVIDIA GPU Operator

The GPU Operator automates the lifecycle of all software components needed for GPU nodes: drivers, container toolkit, device plugin, and DCGM exporter.

```bash
# Add NVIDIA Helm repository
helm repo add nvidia https://helm.ngc.nvidia.com/nvidia
helm repo update

# Install the GPU Operator
helm install gpu-operator nvidia/gpu-operator \
  --namespace gpu-operator \
  --create-namespace \
  --version v23.9.0 \
  --set operator.defaultRuntime=containerd \
  --set driver.version=535.104.05 \
  --set toolkit.version=1.14.3-centos7 \
  --set devicePlugin.version=0.14.3 \
  --set dcgmExporter.version=3.3.0-3.2.0-ubuntu22.04 \
  --set mig.strategy=mixed
```

### GPU Resource Requests

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: gpu-test
  namespace: ml-platform
spec:
  tolerations:
  - key: nvidia.com/gpu
    operator: Exists
    effect: NoSchedule
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
        - matchExpressions:
          - key: nvidia.com/gpu.product
            operator: In
            values:
            - NVIDIA-A100-SXM4-40GB
            - NVIDIA-A100-SXM4-80GB
  containers:
  - name: cuda-app
    image: nvcr.io/nvidia/cuda:12.3.0-base-ubuntu22.04
    command: ["nvidia-smi"]
    resources:
      requests:
        nvidia.com/gpu: 2
        cpu: "8"
        memory: 32Gi
      limits:
        nvidia.com/gpu: 2   # Must equal requests for GPU resources
        cpu: "16"
        memory: 64Gi
  restartPolicy: Never
```

GPU resources (`nvidia.com/gpu`) are extended resources that must have equal requests and limits. The device plugin allocates specific GPU devices to the container, and the container can only see the allocated GPUs.

### MIG (Multi-Instance GPU) Scheduling

NVIDIA A100 and H100 GPUs support MIG partitioning, exposing GPU slices as allocatable resources:

```yaml
# Request a 1g.5gb MIG slice (1/7 of an A100)
resources:
  requests:
    nvidia.com/mig-1g.5gb: 1
  limits:
    nvidia.com/mig-1g.5gb: 1

# Request a 3g.20gb MIG slice (3/7 of an A100)
resources:
  requests:
    nvidia.com/mig-3g.20gb: 1
  limits:
    nvidia.com/mig-3g.20gb: 1
```

Available MIG profiles for A100 40GB:
- `1g.5gb` — 1 GPC, 5GB memory (7 per GPU)
- `2g.10gb` — 2 GPCs, 10GB memory
- `3g.20gb` — 3 GPCs, 20GB memory
- `4g.20gb` — 4 GPCs, 20GB memory
- `7g.40gb` — Full GPU

Configure the MIG strategy in the GPU Operator:

```yaml
# ClusterPolicy for mixed MIG strategy — each GPU can have different partitioning
apiVersion: nvidia.com/v1
kind: ClusterPolicy
metadata:
  name: cluster-policy
spec:
  mig:
    strategy: mixed
  migManager:
    enabled: true
  devicePlugin:
    config:
      name: device-plugin-config
      default: all-disabled
---
# ConfigMap defining MIG partitioning per node
apiVersion: v1
kind: ConfigMap
metadata:
  name: device-plugin-config
  namespace: gpu-operator
data:
  a100-40gb-config: |
    version: v1
    flags:
      migStrategy: mixed
    mig-configs:
      all-1g.5gb:
        - devices: all
          mig-enabled: true
          mig-devices:
            1g.5gb: 7
      all-3g.20gb:
        - devices: all
          mig-enabled: true
          mig-devices:
            3g.20gb: 2
```

Apply MIG config to specific nodes via label:

```bash
kubectl label node gpu-node-1 nvidia.com/mig.config=all-1g.5gb
kubectl label node gpu-node-2 nvidia.com/mig.config=all-3g.20gb
```

### Time-Slicing GPU Configuration

For development and testing, time-slicing allows multiple pods to share a single physical GPU (with no memory isolation):

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: time-slicing-config
  namespace: gpu-operator
data:
  config.yaml: |
    version: v1
    sharing:
      timeSlicing:
        renameByDefault: false
        failRequestsGreaterThanOne: false
        resources:
        - name: nvidia.com/gpu
          replicas: 4   # 4 virtual GPUs per physical GPU
```

```bash
# Apply time-slicing to specific nodes
kubectl label node dev-gpu-node-1 \
  nvidia.com/device-plugin.config=time-slicing-config

# Pods request nvidia.com/gpu: 1 as normal, but up to 4 can share the physical GPU
```

## Advanced Scheduling Patterns

### Bin Packing with Resource Ratios

For batch workloads where you want to minimize wasted capacity by packing pods tightly:

```yaml
# Job with explicit bin-packing scheduler
apiVersion: batch/v1
kind: Job
metadata:
  name: data-processing
  namespace: batch
spec:
  parallelism: 50
  completions: 200
  template:
    spec:
      schedulerName: batch-scheduler
      priorityClassName: batch
      containers:
      - name: worker
        image: myregistry.example.com/batch-worker:v2.1.0
        resources:
          # Precise resource sizing prevents waste
          requests:
            cpu: 750m
            memory: 1536Mi
          limits:
            cpu: "1"
            memory: 2Gi
      restartPolicy: OnFailure
```

### Guaranteed QoS with Resource Matching

Pods in the `Guaranteed` QoS class receive scheduling priority for eviction protection and benefit from dedicated CPU pinning when CPUManager is enabled:

```yaml
# Guaranteed QoS: limits must equal requests for ALL containers
spec:
  containers:
  - name: latency-sensitive
    resources:
      requests:
        cpu: "4"       # Integer CPUs required for CPU pinning
        memory: 8Gi
      limits:
        cpu: "4"       # Must equal requests
        memory: 8Gi
  initContainers:
  - name: init
    resources:
      requests:
        cpu: 100m
        memory: 64Mi
      limits:
        cpu: 100m     # Must also match for Guaranteed QoS
        memory: 64Mi
```

For CPU pinning (CPUManager policy `static`), integer CPU requests are required. The kubelet on the node must also be configured with `--cpu-manager-policy=static`.

### Spot Instance Handling

Design workloads to gracefully handle spot/preemptible node termination:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: spot-tolerant-worker
  namespace: batch
spec:
  replicas: 20
  selector:
    matchLabels:
      app: spot-tolerant-worker
  template:
    metadata:
      labels:
        app: spot-tolerant-worker
    spec:
      priorityClassName: spot-batch
      terminationGracePeriodSeconds: 30
      tolerations:
      - key: cloud.google.com/gke-spot
        operator: Exists
        effect: NoSchedule
      - key: eks.amazonaws.com/capacity-type
        operator: Equal
        value: SPOT
        effect: NoSchedule
      # Prefer spot nodes, fall back to on-demand
      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            preference:
              matchExpressions:
              - key: eks.amazonaws.com/capacity-type
                operator: In
                values:
                - SPOT
          - weight: 10
            preference:
              matchExpressions:
              - key: eks.amazonaws.com/capacity-type
                operator: In
                values:
                - ON_DEMAND
      topologySpreadConstraints:
      - maxSkew: 3
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: ScheduleAnyway
        labelSelector:
          matchLabels:
            app: spot-tolerant-worker
      containers:
      - name: worker
        image: myregistry.example.com/spot-worker:v1.3.0
        lifecycle:
          preStop:
            exec:
              # Checkpoint progress before termination
              command: ["/bin/sh", "-c", "/app/checkpoint.sh"]
        resources:
          requests:
            cpu: 500m
            memory: 1Gi
```

## Scheduling Diagnostics

### Diagnosing Pending Pods

```bash
#!/bin/bash
# diagnose-scheduling.sh — analyze why pods are Pending

NAMESPACE=${1:-default}

# Find all Pending pods
PENDING_PODS=$(kubectl get pods -n "$NAMESPACE" \
  --field-selector status.phase=Pending \
  -o jsonpath='{.items[*].metadata.name}')

for POD in $PENDING_PODS; do
  echo "============================================"
  echo "Pod: $POD"
  echo "============================================"
  
  # Get scheduling events
  kubectl describe pod "$POD" -n "$NAMESPACE" \
    | grep -A 20 "Events:"
  
  # Check resource requests vs node capacity
  echo ""
  echo "--- Resource Requests ---"
  kubectl get pod "$POD" -n "$NAMESPACE" -o json \
    | jq -r '.spec.containers[].resources.requests | 
      "CPU: \(.cpu // "0"), Memory: \(.memory // "0")"'
  
  # Check node affinity requirements
  echo ""
  echo "--- Node Affinity ---"
  kubectl get pod "$POD" -n "$NAMESPACE" -o json \
    | jq -r '.spec.affinity.nodeAffinity // "none"'
  
  # Check topology spread constraints
  echo ""
  echo "--- Topology Spread Constraints ---"
  kubectl get pod "$POD" -n "$NAMESPACE" -o json \
    | jq -r '.spec.topologySpreadConstraints // "none"'

  # Check node availability by matching labels
  echo ""
  echo "--- Nodes by Zone ---"
  kubectl get nodes \
    -L topology.kubernetes.io/zone \
    -L node.kubernetes.io/instance-type \
    --no-headers \
    | awk '{printf "%-30s %-15s %-20s\n", $1, $6, $7}'
done
```

### Scheduler Extender Debugging

```bash
# Check scheduler logs for filter/score decisions
kubectl logs -n kube-system \
  -l component=kube-scheduler \
  --since=5m \
  | grep -E "(Filtered|Scored|Selected|Preempt|nominatedNode)"

# Increase scheduler verbosity temporarily (edit the static pod manifest)
# /etc/kubernetes/manifests/kube-scheduler.yaml
# Add: - --v=5

# Check scheduler performance metrics
kubectl get --raw /metrics | grep scheduler_scheduling_duration

# Useful scheduler metrics:
# scheduler_scheduling_duration_seconds — end-to-end scheduling latency
# scheduler_framework_extension_point_duration_seconds — per-plugin latency
# scheduler_pending_pods — pods waiting in the scheduling queue
# scheduler_preemption_attempts_total — preemption attempts
# scheduler_preemption_victims — number of pods preempted
```

### Simulating Scheduling Decisions

Use `kubectl auth can-i` and dry-run to simulate scheduling without affecting the cluster:

```bash
# Check if a pod spec would be schedulable
cat <<EOF | kubectl apply --dry-run=server -f -
apiVersion: v1
kind: Pod
metadata:
  name: test-scheduling
  namespace: production
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
        - matchExpressions:
          - key: topology.kubernetes.io/zone
            operator: In
            values:
            - us-east-1a
  topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: DoNotSchedule
    labelSelector:
      matchLabels:
        app: test-scheduling
  containers:
  - name: test
    image: nginx:1.25
    resources:
      requests:
        cpu: 500m
        memory: 512Mi
EOF
```

### Scheduling Policy Audit

```bash
#!/bin/bash
# audit-scheduling-policies.sh

echo "=== Pods Without Priority Class ==="
kubectl get pods --all-namespaces \
  -o json \
  | jq -r '.items[] | 
    select(.spec.priorityClassName == null or .spec.priorityClassName == "") | 
    "\(.metadata.namespace)/\(.metadata.name)"' \
  | sort

echo ""
echo "=== Pods Without Resource Requests ==="
kubectl get pods --all-namespaces \
  -o json \
  | jq -r '.items[] | 
    .metadata as $meta | 
    .spec.containers[] | 
    select(.resources.requests == null) | 
    "\($meta.namespace)/\($meta.name)/\(.name)"' \
  | sort

echo ""
echo "=== Priority Class Distribution ==="
kubectl get pods --all-namespaces \
  -o jsonpath='{range .items[*]}{.spec.priorityClassName}{"\n"}{end}' \
  | sort | uniq -c | sort -rn

echo ""
echo "=== TopologySpread Coverage ==="
kubectl get deployments --all-namespaces \
  -o json \
  | jq -r '.items[] | 
    select(.spec.template.spec.topologySpreadConstraints == null) | 
    "\(.metadata.namespace)/\(.metadata.name) — NO topology spread"' \
  | sort

echo ""
echo "=== StatefulSets Without Anti-Affinity ==="
kubectl get statefulsets --all-namespaces \
  -o json \
  | jq -r '.items[] | 
    select(.spec.template.spec.affinity.podAntiAffinity == null) | 
    "\(.metadata.namespace)/\(.metadata.name) — NO pod anti-affinity"' \
  | sort
```

## Prometheus Monitoring for Scheduler Health

```yaml
# PrometheusRule for scheduler metrics
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kubernetes-scheduler-alerts
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
  - name: scheduler.rules
    interval: 30s
    rules:
    - alert: KubernetesSchedulerHighPendingPods
      expr: |
        scheduler_pending_pods{queue="active"} > 50
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "High number of pending pods in scheduler queue"
        description: "{{ $value }} pods have been pending in the active scheduling queue for over 5 minutes."

    - alert: KubernetesSchedulerHighPreemptions
      expr: |
        rate(scheduler_preemption_attempts_total[5m]) > 5
      for: 2m
      labels:
        severity: warning
      annotations:
        summary: "High pod preemption rate"
        description: "Scheduler is preempting pods at {{ $value }}/s. This may indicate resource pressure."

    - alert: KubernetesSchedulerHighLatency
      expr: |
        histogram_quantile(0.99,
          rate(scheduler_scheduling_duration_seconds_bucket[5m])
        ) > 10
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Scheduler P99 latency above 10s"
        description: "99th percentile scheduling latency is {{ $value }}s."

    - alert: KubernetesPodsUnschedulable
      expr: |
        kube_pod_status_unschedulable > 0
      for: 10m
      labels:
        severity: critical
      annotations:
        summary: "Pods cannot be scheduled"
        description: "{{ $value }} pods in namespace {{ $labels.namespace }} have been unschedulable for more than 10 minutes."

    - alert: KubernetesNodeUtilizationImbalanced
      expr: |
        (
          max(sum by (node) (
            kube_pod_container_resource_requests{resource="cpu"}
          )) -
          min(sum by (node) (
            kube_pod_container_resource_requests{resource="cpu"}
          ))
        ) /
        avg(kube_node_status_allocatable{resource="cpu"}) > 0.5
      for: 30m
      labels:
        severity: info
      annotations:
        summary: "Node CPU request distribution is imbalanced"
        description: "CPU request imbalance across nodes exceeds 50% of average node capacity. Consider running the descheduler."
```

## Production Scheduling Configuration Reference

### Complete Production Workload Template

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: production-service
  namespace: production
  annotations:
    # Document scheduling decisions
    scheduling.support.tools/intent: "zone-distributed, node-separated, high-priority"
spec:
  replicas: 6
  selector:
    matchLabels:
      app: production-service
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
      maxSurge: 2
  template:
    metadata:
      labels:
        app: production-service
        version: v4.2.0
        tier: frontend
    spec:
      # Priority class for production workloads
      priorityClassName: production-high

      # Graceful termination window
      terminationGracePeriodSeconds: 60

      # Service account for IRSA/Workload Identity
      serviceAccountName: production-service

      # Topology spread: one zone constraint (hard) + one node constraint (soft)
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: production-service
        matchLabelKeys:
        - pod-template-hash
        minDomains: 3
      - maxSkew: 2
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: ScheduleAnyway
        labelSelector:
          matchLabels:
            app: production-service
        matchLabelKeys:
        - pod-template-hash

      # Node affinity: prefer c6i.4xlarge or c6a.4xlarge compute nodes
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: node-role.kubernetes.io/worker
                operator: Exists
              - key: kubernetes.io/arch
                operator: In
                values:
                - amd64
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 80
            preference:
              matchExpressions:
              - key: node.kubernetes.io/instance-type
                operator: In
                values:
                - c6i.4xlarge
                - c6a.4xlarge
                - c6g.4xlarge
          - weight: 40
            preference:
              matchExpressions:
              - key: node.kubernetes.io/instance-type
                operator: In
                values:
                - c6i.2xlarge
                - c6a.2xlarge

        # Pod anti-affinity: no two pods on the same node
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: production-service
            topologyKey: kubernetes.io/hostname

      # Security context
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 2000
        seccompProfile:
          type: RuntimeDefault

      containers:
      - name: production-service
        image: myregistry.example.com/production-service:v4.2.0
        imagePullPolicy: IfNotPresent
        ports:
        - name: http
          containerPort: 8080
        - name: metrics
          containerPort: 9090

        resources:
          requests:
            cpu: "1"
            memory: 2Gi
          limits:
            cpu: "2"
            memory: 4Gi

        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 5
          failureThreshold: 3

        livenessProbe:
          httpGet:
            path: /live
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10
          failureThreshold: 3

        lifecycle:
          preStop:
            exec:
              command: ["/bin/sh", "-c", "sleep 5"]

        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop:
            - ALL

      # Pod Disruption Budget (reference; create separately)
      # Min available: 4 of 6 pods must always be running
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: production-service-pdb
  namespace: production
spec:
  minAvailable: 4
  selector:
    matchLabels:
      app: production-service
```

This reference configuration combines:
- Hard zone distribution (`DoNotSchedule`) with `minDomains: 3` to detect degraded multi-zone setup
- Soft node distribution (`ScheduleAnyway`) to prevent same-node colocation without blocking placement
- Required worker node affinity with preferred instance type scoring
- Required pod anti-affinity at node level (ensures each of 6 pods lands on a unique node)
- `matchLabelKeys` to scope spread calculation to the current ReplicaSet revision
- PodDisruptionBudget to maintain 4/6 minimum availability during drains and descheduler evictions

The interaction between `podAntiAffinity` (required, at node level) and `topologySpreadConstraints` (zone level) requires at least 6 available worker nodes across 3 zones — make sure your cluster capacity planning accounts for this.

## Summary

Kubernetes scheduling decisions compound across the filtering and scoring pipeline, and the interaction between affinity rules, topology spread constraints, priority classes, and descheduler policies can produce unexpected results when cluster conditions change. The key operational practices are:

1. Use `topologySpreadConstraints` with `matchLabelKeys` for even distribution during rolling updates; avoid expressing the same constraint through pod anti-affinity alone.
2. Combine required zone spread with `minDomains` to make degraded multi-zone configurations visible rather than silently concentrating workloads.
3. Define a priority class hierarchy that matches your operational tiers, and assign `preemptionPolicy: Never` to batch jobs that should not disrupt production workloads.
4. Run the descheduler on a regular schedule to correct placement drift from label changes, node additions, and disruption events.
5. For GPU workloads, use node affinity with GPU model labels alongside the `nvidia.com/gpu` extended resource request to target specific hardware generations.
6. Monitor scheduler pending pod counts, preemption rates, and scheduling latency via Prometheus to detect resource pressure before it becomes an outage.
