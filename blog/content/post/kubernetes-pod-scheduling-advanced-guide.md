---
title: "Kubernetes Pod Scheduling: Affinity, Anti-Affinity, Taints, Tolerations, and Priority Classes"
date: 2027-05-18T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Scheduling", "Affinity", "Taints", "Priority", "Resource Management"]
categories: ["Kubernetes", "Platform Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-focused guide to advanced Kubernetes pod scheduling covering node affinity, pod affinity and anti-affinity, taints and tolerations, priority classes, topology spread constraints, scheduling framework plugins, and the descheduler for workload rebalancing."
more_link: "yes"
url: "/kubernetes-pod-scheduling-advanced-guide/"
---

The Kubernetes scheduler is responsible for finding the optimal node for each pod, balancing resource availability, topology constraints, operator-defined preferences, and workload priorities. For simple workloads on homogeneous clusters, default scheduler behavior works adequately. For production clusters running heterogeneous workloads across multiple availability zones, hardware profiles, and criticality tiers, the full scheduling feature set becomes essential.

This guide covers the complete Kubernetes scheduling toolkit: node affinity, pod affinity and anti-affinity, taints and tolerations, topology spread constraints, priority classes with preemption, scheduling framework extension points, and the descheduler for continuous cluster rebalancing.

<!--more-->

## Kubernetes Scheduler Architecture

### Scheduling Cycle Overview

The kube-scheduler processes pods through two phases:

```
Pending Pod Queue
      │
      ▼
┌─────────────────────────────────────────────┐
│           FILTERING PHASE                   │
│  Filter plugins run against each node       │
│  Eliminates nodes that cannot host the pod  │
│                                             │
│  NodeUnschedulable, NodeAffinity,           │
│  TaintToleration, NodePorts,                │
│  VolumeBinding, PodTopologySpread,          │
│  NodeResourcesFit, etc.                     │
└─────────────────────────────────────────────┘
      │
      ▼ (feasible nodes remain)
┌─────────────────────────────────────────────┐
│           SCORING PHASE                     │
│  Score plugins rank feasible nodes          │
│  Higher score = better fit                  │
│                                             │
│  NodeAffinity, InterPodAffinity,            │
│  NodeResourcesBalancedAllocation,           │
│  ImageLocality, TaintToleration,            │
│  TopologySpreadConstraint, etc.             │
└─────────────────────────────────────────────┘
      │
      ▼ (highest-scored node selected)
   Bind Pod to Node
```

### Viewing Scheduler Configuration

```bash
# Check scheduler configuration
kubectl get pod -n kube-system -l component=kube-scheduler -o yaml | \
  grep -A 5 "config"

# For managed clusters, inspect the scheduler ConfigMap
kubectl get configmap -n kube-system kube-scheduler-config -o yaml 2>/dev/null || \
  echo "Using default scheduler configuration"

# View scheduling decisions in events
kubectl get events --all-namespaces \
  --field-selector reason=Scheduled \
  --sort-by='.lastTimestamp' | tail -20

kubectl get events --all-namespaces \
  --field-selector reason=FailedScheduling \
  --sort-by='.lastTimestamp' | tail -20
```

## Node Affinity

### requiredDuringSchedulingIgnoredDuringExecution

The `required` scheduling affinity acts as a hard constraint — pods will not be scheduled on nodes that do not match. `IgnoredDuringExecution` means existing pods are not evicted if node labels change after scheduling.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: gpu-workload
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          # Multiple terms are ORed together
          - matchExpressions:
              # Expressions within a term are ANDed
              - key: kubernetes.io/os
                operator: In
                values: ["linux"]
              - key: nvidia.com/gpu.present
                operator: In
                values: ["true"]
              - key: node.kubernetes.io/instance-type
                operator: In
                values:
                  - "p3.8xlarge"
                  - "p3.16xlarge"
                  - "p4d.24xlarge"
          # Alternative: any instance with A100 GPU
          - matchExpressions:
              - key: kubernetes.io/os
                operator: In
                values: ["linux"]
              - key: nvidia.com/gpu.product
                operator: In
                values: ["A100-SXM4-40GB", "A100-SXM4-80GB"]
  containers:
    - name: training
      image: pytorch/pytorch:2.2.0-cuda12.1-cudnn8-runtime
      resources:
        limits:
          nvidia.com/gpu: "4"
```

Available operators for `matchExpressions`:
- `In`: label value is in the provided list
- `NotIn`: label value is not in the list
- `Exists`: label key exists (no values)
- `DoesNotExist`: label key does not exist
- `Gt`: label value (as integer) is greater than the provided value
- `Lt`: label value (as integer) is less than the provided value

### preferredDuringSchedulingIgnoredDuringExecution

Soft preferences influence scoring but do not block scheduling if unmet:

```yaml
spec:
  affinity:
    nodeAffinity:
      # Preferred: try to schedule in us-east-1a first
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 80  # 1-100; higher weight = stronger preference
          preference:
            matchExpressions:
              - key: topology.kubernetes.io/zone
                operator: In
                values: ["us-east-1a"]
        - weight: 60
          preference:
            matchExpressions:
              - key: topology.kubernetes.io/zone
                operator: In
                values: ["us-east-1b"]
        - weight: 20
          preference:
            matchExpressions:
              - key: node.kubernetes.io/instance-type
                operator: In
                values: ["m5.2xlarge", "m5.4xlarge"]
      # Required: must be Linux
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - key: kubernetes.io/os
                operator: In
                values: ["linux"]
```

### Node Affinity for Dedicated Node Pools

A common pattern separates specialized hardware from general workloads:

```yaml
# Label nodes for specific workload types
# kubectl label node worker-gpu-01 workload-type=gpu
# kubectl label node worker-gpu-02 workload-type=gpu
# kubectl label node worker-high-mem-01 workload-type=high-memory

apiVersion: v1
kind: Pod
metadata:
  name: analytics-job
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - key: workload-type
                operator: In
                values: ["high-memory"]
              - key: kubernetes.io/arch
                operator: In
                values: ["amd64"]
  containers:
    - name: analytics
      image: analytics:v3.0.0
      resources:
        requests:
          memory: "128Gi"
          cpu: "8"
        limits:
          memory: "256Gi"
          cpu: "16"
```

## Pod Affinity and Anti-Affinity

### Pod Affinity: Co-location

Pod affinity schedules pods on nodes where pods matching the selector are already running. Use cases include co-locating application tiers that communicate heavily to reduce latency.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cache
  namespace: payments
spec:
  replicas: 3
  selector:
    matchLabels:
      app: cache
  template:
    metadata:
      labels:
        app: cache
        tier: cache
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-api
  namespace: payments
spec:
  replicas: 3
  selector:
    matchLabels:
      app: payment-api
  template:
    metadata:
      labels:
        app: payment-api
    spec:
      affinity:
        podAffinity:
          # Schedule payment-api pods on nodes that have cache pods
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchExpressions:
                    - key: tier
                      operator: In
                      values: ["cache"]
                # topologyKey defines the "co-location" domain
                topologyKey: kubernetes.io/hostname
                namespaces:
                  - payments
```

### topologyKey Semantics

The `topologyKey` defines the granularity of co-location or spread:

| topologyKey | Meaning |
|-------------|---------|
| `kubernetes.io/hostname` | Same node |
| `topology.kubernetes.io/zone` | Same availability zone |
| `topology.kubernetes.io/region` | Same region |
| `node.kubernetes.io/instance-type` | Same instance type group |
| Custom label | Any user-defined topology domain |

### Pod Anti-Affinity: Spreading for HA

Pod anti-affinity ensures pods of the same deployment are spread across nodes or zones:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-api
  namespace: payments
spec:
  replicas: 6
  template:
    spec:
      affinity:
        podAntiAffinity:
          # HARD requirement: no two pods on the same node
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchExpressions:
                  - key: app
                    operator: In
                    values: ["payment-api"]
              topologyKey: kubernetes.io/hostname
          # SOFT preference: spread across zones
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchExpressions:
                    - key: app
                      operator: In
                      values: ["payment-api"]
                topologyKey: topology.kubernetes.io/zone
```

### Anti-Affinity Pitfalls

Hard anti-affinity with `requiredDuringScheduling` can cause pods to remain Pending if insufficient nodes exist:

```bash
# Diagnose anti-affinity scheduling failures
kubectl describe pod payment-api-7d4f8b9c5-xxxxx | grep -A 30 "Events:"

# Common output:
# Warning  FailedScheduling  <timestamp>  default-scheduler
#   0/6 nodes are available: 3 node(s) had untolerated taint {node.kubernetes.io/not-ready: },
#   3 node(s) didn't match pod anti-affinity rules.

# Check actual pod distribution
kubectl get pods -n payments -l app=payment-api \
  -o custom-columns="NAME:.metadata.name,NODE:.spec.nodeName,ZONE:.metadata.labels['topology\.kubernetes\.io/zone']"
```

## Taints and Tolerations

### Taint Effects

Taints prevent pods from being scheduled on nodes unless the pod tolerates the taint:

| Effect | Behavior |
|--------|----------|
| `NoSchedule` | Pods without toleration will not be scheduled on this node |
| `PreferNoSchedule` | Scheduler prefers not to place pods here, but will if necessary |
| `NoExecute` | Existing pods without toleration are evicted; new pods not scheduled |

### Applying Taints

```bash
# Taint a node for GPU-only workloads
kubectl taint node worker-gpu-01 workload-type=gpu:NoSchedule

# Taint multiple nodes
kubectl taint nodes -l workload-type=gpu dedicated=gpu:NoSchedule

# Remove a taint
kubectl taint node worker-gpu-01 workload-type=gpu:NoSchedule-

# View current taints
kubectl get nodes -o custom-columns=\
"NAME:.metadata.name,TAINTS:.spec.taints[*].key"

kubectl describe node worker-gpu-01 | grep Taints
```

### Tolerations

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: gpu-training-job
spec:
  # Tolerate the GPU node taint
  tolerations:
    - key: "workload-type"
      operator: "Equal"
      value: "gpu"
      effect: "NoSchedule"
    # Tolerate node not-ready for up to 5 minutes before eviction
    - key: "node.kubernetes.io/not-ready"
      operator: "Exists"
      effect: "NoExecute"
      tolerationSeconds: 300
    # Tolerate unreachable nodes for up to 5 minutes
    - key: "node.kubernetes.io/unreachable"
      operator: "Exists"
      effect: "NoExecute"
      tolerationSeconds: 300
  # Combine with node affinity to ensure placement on GPU nodes
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - key: workload-type
                operator: In
                values: ["gpu"]
  containers:
    - name: training
      image: pytorch/pytorch:2.2.0
      resources:
        limits:
          nvidia.com/gpu: "1"
```

### Dedicated Node Pools Pattern

The combination of taints and node affinity creates dedicated node pools that accept only specific workloads:

```yaml
# Node configuration (applied via cloud provider or node template):
# Taints: [dedicated=monitoring:NoSchedule]
# Labels: [node-role=monitoring]

# Prometheus StatefulSet tolerating the monitoring node pool
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: prometheus
  namespace: monitoring
spec:
  replicas: 2
  template:
    spec:
      tolerations:
        - key: dedicated
          operator: Equal
          value: monitoring
          effect: NoSchedule
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: node-role
                    operator: In
                    values: ["monitoring"]
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: prometheus
              topologyKey: kubernetes.io/hostname
      containers:
        - name: prometheus
          image: prom/prometheus:v2.51.0
```

### System-Managed Taints

Kubernetes automatically applies taints based on node conditions:

```bash
# List automatically applied taints
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.taints[*].key}{"\n"}{end}'

# Common automatic taints:
# node.kubernetes.io/not-ready              - Node is not ready
# node.kubernetes.io/unreachable            - Node is unreachable
# node.kubernetes.io/out-of-disk           - Node is out of disk (deprecated)
# node.kubernetes.io/memory-pressure        - Node has memory pressure
# node.kubernetes.io/disk-pressure          - Node has disk pressure
# node.kubernetes.io/pid-pressure           - Node has PID pressure
# node.kubernetes.io/network-unavailable    - Node network is unavailable
# node.kubernetes.io/unschedulable          - Node is cordoned
```

### Taint-Based Eviction Tuning

For workloads tolerating node issues, tune eviction tolerations:

```yaml
spec:
  tolerations:
    # Allow pod to remain on not-ready node for 10 minutes
    # before eviction (default is 300s)
    - key: "node.kubernetes.io/not-ready"
      operator: "Exists"
      effect: "NoExecute"
      tolerationSeconds: 600

    # Stateful workloads may need longer tolerance
    - key: "node.kubernetes.io/unreachable"
      operator: "Exists"
      effect: "NoExecute"
      tolerationSeconds: 600

    # Tolerate memory pressure — for pods that can handle it
    - key: "node.kubernetes.io/memory-pressure"
      operator: "Exists"
      effect: "NoSchedule"
```

## PriorityClass and Preemption

### Defining Priority Classes

```yaml
# System-level priority (reserved for cluster infrastructure)
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: system-critical
value: 2000000000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: "Critical cluster infrastructure. Must not be preempted."
---
# High priority for production workloads
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: high-priority-production
value: 1000000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: "Production workloads requiring immediate scheduling."
---
# Default priority for most workloads
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: standard-priority
value: 100000
globalDefault: true  # Applied when no PriorityClass is specified
preemptionPolicy: PreemptLowerPriority
description: "Standard workloads. Default for all non-specified pods."
---
# Low priority for batch and best-effort jobs
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: low-priority-batch
value: 10000
globalDefault: false
preemptionPolicy: Never  # Will not preempt other pods
description: "Batch and best-effort workloads. Can be preempted."
---
# Non-preempting class for background tasks
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: background-tasks
value: 1000
globalDefault: false
preemptionPolicy: Never
description: "Background tasks that should not block or preempt."
```

### Using Priority Classes in Workloads

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-gateway
  namespace: finance
spec:
  template:
    spec:
      priorityClassName: high-priority-production
      containers:
        - name: gateway
          image: payment-gateway:v5.0.0
---
apiVersion: batch/v1
kind: Job
metadata:
  name: monthly-report-generator
  namespace: finance
spec:
  template:
    spec:
      priorityClassName: low-priority-batch
      restartPolicy: OnFailure
      containers:
        - name: reporter
          image: report-generator:v1.0.0
```

### Preemption Behavior

When a high-priority pod cannot be scheduled, the scheduler can preempt (evict) lower-priority pods to make room:

```bash
# Watch preemption events
kubectl get events --all-namespaces \
  --field-selector reason=Preempting \
  --sort-by='.lastTimestamp'

# Check if a pod was preempted
kubectl describe pod <pod-name> | grep -A 5 "Preempted"

# View pending pods awaiting scheduling
kubectl get pods --all-namespaces --field-selector status.phase=Pending \
  -o custom-columns="NAMESPACE:.metadata.namespace,NAME:.metadata.name,PRIORITY:.spec.priority,AGE:.metadata.creationTimestamp"
```

### Preemption with PodDisruptionBudgets

PDBs interact with preemption — the scheduler respects PDBs during preemption:

```yaml
# PDB protects at least 1 pod during preemption
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-gateway-pdb
  namespace: finance
spec:
  minAvailable: 2  # At least 2 pods must remain available
  selector:
    matchLabels:
      app: payment-gateway
```

If preempting a pod would violate its PDB, the scheduler skips it and looks for other victims.

## Topology Spread Constraints

Topology spread constraints are the modern replacement for manual anti-affinity rules for distributing pods across failure domains.

### Basic Spread Configuration

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-frontend
  namespace: production
spec:
  replicas: 12
  template:
    spec:
      topologySpreadConstraints:
        # Spread evenly across zones (hard constraint)
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule  # DoNotSchedule | ScheduleAnyway
          labelSelector:
            matchLabels:
              app: web-frontend
          minDomains: 3  # Require at least 3 zones (Kubernetes 1.24+)
          matchLabelKeys:
            - pod-template-hash  # Consider only pods from the same ReplicaSet

        # Also spread across nodes within each zone (soft constraint)
        - maxSkew: 2
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels:
              app: web-frontend
```

`maxSkew` defines the maximum allowed difference in pod count between the topology domain with the most pods and the one with the fewest. `maxSkew: 1` means at most 1 pod difference across zones.

### Advanced Topology Spread

```yaml
spec:
  topologySpreadConstraints:
    # Spread by node pool (custom topology key)
    - maxSkew: 1
      topologyKey: node-pool
      whenUnsatisfiable: DoNotSchedule
      labelSelector:
        matchLabels:
          app: api-server
      # nodeAffinityPolicy: Honor (default) | Ignore
      # nodeTaintsPolicy: Honor | Ignore (default)
      nodeAffinityPolicy: Honor   # Respect nodeAffinity when counting pods
      nodeTaintsPolicy: Honor     # Respect taints when counting eligible nodes

    # Cross-namespace spread — count pods from other namespaces
    - maxSkew: 2
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: ScheduleAnyway
      labelSelector:
        matchLabels:
          component: api
      matchLabelKeys: []
```

### Interaction Between Topology Spread and Anti-Affinity

When combining topology spread constraints with pod anti-affinity, constraints compound:

```yaml
spec:
  # Must spread across zones (topology spread)
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: DoNotSchedule
      labelSelector:
        matchLabels:
          app: payment-api

  # Within each zone, no two pods on the same node (anti-affinity)
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchExpressions:
              - key: app
                operator: In
                values: ["payment-api"]
          topologyKey: kubernetes.io/hostname
```

This achieves maximum fault tolerance: pods spread across zones with no zone hosting multiple pods on the same node.

## Scheduler Profiles

Multiple scheduler profiles allow different scheduling behaviors for different workload types without running separate scheduler instances.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kube-scheduler-config
  namespace: kube-system
data:
  config.yaml: |
    apiVersion: kubescheduler.config.k8s.io/v1
    kind: KubeSchedulerConfiguration
    profiles:
      # Default profile for most workloads
      - schedulerName: default-scheduler
        plugins:
          score:
            enabled:
              - name: NodeResourcesBalancedAllocation
                weight: 1
              - name: NodeResourcesFit
                weight: 1
              - name: InterPodAffinity
                weight: 1
              - name: PodTopologySpread
                weight: 2

      # High-throughput profile for batch workloads
      - schedulerName: batch-scheduler
        plugins:
          score:
            disabled:
              - name: InterPodAffinity
            enabled:
              - name: NodeResourcesBalancedAllocation
                weight: 2
        pluginConfig:
          - name: NodeResourcesFit
            args:
              scoringStrategy:
                type: MostAllocated  # Pack nodes tightly for batch

      # Spread profile for stateless services
      - schedulerName: spread-scheduler
        plugins:
          score:
            enabled:
              - name: PodTopologySpread
                weight: 5
        pluginConfig:
          - name: PodTopologySpread
            args:
              defaultConstraints:
                - maxSkew: 1
                  topologyKey: topology.kubernetes.io/zone
                  whenUnsatisfiable: ScheduleAnyway
              defaultingType: List
```

Using a custom scheduler profile:

```yaml
spec:
  schedulerName: batch-scheduler  # Use the batch-optimized profile
```

## Descheduler for Cluster Rebalancing

The Kubernetes descheduler (a separate component) evicts pods to trigger rescheduling when the cluster becomes unbalanced — a condition the scheduler alone cannot fix since it only places new pods.

### Installation

```bash
helm repo add descheduler https://kubernetes-sigs.github.io/descheduler/
helm repo update

helm install descheduler descheduler/descheduler \
  --namespace kube-system \
  --version 0.29.0 \
  --set schedule="*/20 * * * *" \  # Run every 20 minutes
  --set kind=CronJob
```

### Descheduler Policy Configuration

```yaml
apiVersion: "descheduler/v1alpha2"
kind: "DeschedulerPolicy"
profiles:
  - name: default
    pluginConfig:
      - name: DefaultEvictor
        args:
          evictSystemCriticalPods: false
          evictFailedBarePods: false
          evictLocalStoragePods: true
          nodeFit: true
          minReplicas: 2  # Don't evict from deployments with < 2 replicas
          minPodAge: 5m   # Only evict pods running for at least 5 minutes

      # Remove duplicate pods from the same node
      - name: RemoveDuplicates
        args:
          namespaces:
            exclude:
              - kube-system
              - monitoring

      # Evict pods violating topology spread constraints
      - name: RemovePodsViolatingTopologySpreadConstraint
        args:
          constraints:
            - DoNotSchedule
          namespaces:
            include: []  # All namespaces

      # Rebalance nodes by pod count
      - name: LowNodeUtilization
        args:
          thresholds:
            cpu: 20
            memory: 20
            pods: 20
          targetThresholds:
            cpu: 50
            memory: 50
            pods: 50
          # numberOfNodes: 0 (evict from all under-utilized nodes)

      # Remove pods violating anti-affinity rules
      - name: RemovePodsViolatingInterPodAntiAffinity
        args: {}

      # Remove pods violating node affinity
      - name: RemovePodsViolatingNodeAffinity
        args:
          nodeAffinityType:
            - requiredDuringSchedulingIgnoredDuringExecution

      # Remove pods violating node taints
      - name: RemovePodsViolatingNodeTaints
        args: {}

    plugins:
      balance:
        enabled:
          - RemoveDuplicates
          - LowNodeUtilization
          - RemovePodsViolatingTopologySpreadConstraint
      deschedule:
        enabled:
          - RemovePodsViolatingInterPodAntiAffinity
          - RemovePodsViolatingNodeAffinity
          - RemovePodsViolatingNodeTaints
```

### Descheduler Deployment

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: descheduler-policy-config
  namespace: kube-system
data:
  policy.yaml: |
    # (descheduler policy as above)
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: descheduler
  namespace: kube-system
spec:
  schedule: "*/20 * * * *"
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      template:
        spec:
          priorityClassName: system-cluster-critical
          serviceAccountName: descheduler
          containers:
            - name: descheduler
              image: registry.k8s.io/descheduler/descheduler:v0.29.0
              args:
                - --policy-config-file=/policy-dir/policy.yaml
                - --v=3
              resources:
                requests:
                  cpu: 500m
                  memory: 256Mi
              volumeMounts:
                - mountPath: /policy-dir
                  name: policy-volume
          restartPolicy: Never
          volumes:
            - name: policy-volume
              configMap:
                name: descheduler-policy-config
```

## Scheduling Framework Plugins

### Custom Scheduler Plugin Development

The scheduling framework provides extension points for custom logic:

```go
package main

import (
    "context"
    "fmt"

    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/kubernetes/pkg/scheduler/framework"
)

const PluginName = "CostAwarePlugin"

// CostAwarePlugin prefers nodes in cheaper regions
type CostAwarePlugin struct {
    handle framework.Handle
}

var _ framework.ScorePlugin = &CostAwarePlugin{}

func (p *CostAwarePlugin) Name() string {
    return PluginName
}

// Score assigns a score based on the node's cost tier label
func (p *CostAwarePlugin) Score(
    ctx context.Context,
    state *framework.CycleState,
    pod *corev1.Pod,
    nodeName string,
) (int64, *framework.Status) {
    nodeInfo, err := p.handle.SnapshotSharedLister().NodeInfos().Get(nodeName)
    if err != nil {
        return 0, framework.NewStatus(
            framework.Error,
            fmt.Sprintf("getting node info: %v", err),
        )
    }

    node := nodeInfo.Node()
    costTier, ok := node.Labels["cloud.example.com/cost-tier"]
    if !ok {
        // No cost label — use middle score
        return 50, nil
    }

    // Higher score = more preferred by the scheduler
    switch costTier {
    case "spot":
        // Strongly prefer spot instances for batch workloads
        if isBatchWorkload(pod) {
            return 100, nil
        }
        // Avoid spot for stateful workloads
        if isStatefulWorkload(pod) {
            return 0, nil
        }
        return 60, nil
    case "on-demand":
        return 80, nil
    case "reserved":
        return 90, nil
    default:
        return 50, nil
    }
}

func (p *CostAwarePlugin) ScoreExtensions() framework.ScoreExtensions {
    return nil
}

func isBatchWorkload(pod *corev1.Pod) bool {
    ownerKind, ok := pod.Labels["app.kubernetes.io/component"]
    return ok && ownerKind == "batch-job"
}

func isStatefulWorkload(pod *corev1.Pod) bool {
    for _, volume := range pod.Spec.Volumes {
        if volume.PersistentVolumeClaim != nil {
            return true
        }
    }
    return false
}

// New creates a new instance of the plugin
func New(_ context.Context, _ runtime.Object, handle framework.Handle) (framework.Plugin, error) {
    return &CostAwarePlugin{handle: handle}, nil
}
```

## Production Scheduling Checklist

### Deployment Configuration Review

```bash
#!/bin/bash
# scheduling-audit.sh: Audit pod scheduling configuration

echo "=== Pod Scheduling Configuration Audit ==="
echo ""

# Pods with no resource requests
echo "--- Pods without resource requests ---"
kubectl get pods --all-namespaces -o json | \
  jq -r '.items[] |
    select(
      .spec.containers[] |
      (has("resources") and .resources.requests == null) or
      (has("resources") == false)
    ) |
    "\(.metadata.namespace)/\(.metadata.name)"' | \
  sort | uniq

echo ""
echo "--- Deployments with no anti-affinity ---"
kubectl get deployments --all-namespaces -o json | \
  jq -r '.items[] |
    select(
      .spec.template.spec.affinity == null and
      .spec.template.spec.topologySpreadConstraints == null and
      .spec.replicas > 1
    ) |
    "\(.metadata.namespace)/\(.metadata.name) (replicas: \(.spec.replicas))"'

echo ""
echo "--- Pods using default service account ---"
kubectl get pods --all-namespaces -o json | \
  jq -r '.items[] |
    select(.spec.serviceAccountName == "default" or .spec.serviceAccountName == null) |
    "\(.metadata.namespace)/\(.metadata.name)"' | head -20

echo ""
echo "--- Nodes with scheduling pressure ---"
kubectl get nodes -o json | \
  jq -r '.items[] |
    select(
      .status.conditions[] |
      select(.type == "MemoryPressure" or .type == "DiskPressure") |
      .status == "True"
    ) |
    "\(.metadata.name): PRESSURE DETECTED"'
```

### Common Scheduling Anti-Patterns

```yaml
# ANTI-PATTERN 1: Hard anti-affinity with exact replica count
# If a node fails, the deployment cannot self-heal
# Fix: Use topology spread constraints instead
spec:
  replicas: 3
  template:
    spec:
      # BAD: With 3 nodes and 3 replicas, node failure = pending pods
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: my-app
              topologyKey: kubernetes.io/hostname
      # BETTER: Soft anti-affinity + topology spread
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: ScheduleAnyway  # Allow same-node if necessary
          labelSelector:
            matchLabels:
              app: my-app
```

```yaml
# ANTI-PATTERN 2: nodeSelector instead of nodeAffinity
# nodeSelector is being deprecated for nodeAffinity
# BAD:
spec:
  nodeSelector:
    kubernetes.io/os: linux
    node-pool: gpu

# BETTER:
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - key: kubernetes.io/os
                operator: In
                values: ["linux"]
              - key: node-pool
                operator: In
                values: ["gpu"]
```

```yaml
# ANTI-PATTERN 3: No PriorityClass on production workloads
# During resource pressure, production workloads compete with test workloads
# BAD: No priorityClassName set
spec:
  containers: [...]

# BETTER: Explicit priority for all workloads
spec:
  priorityClassName: high-priority-production
  containers: [...]
```

## Summary

Kubernetes scheduling is a layered system where simple configurations solve simple problems and composable primitives solve complex ones. Key takeaways for production operations:

- Use `requiredDuringScheduling` constraints only when the constraint must be absolute — use `preferred` for soft guidance
- Combine topology spread constraints with pod anti-affinity for maximum fault tolerance
- Taint dedicated node pools and require tolerations to prevent workload contamination across hardware types
- Assign meaningful PriorityClasses to all workloads, ensuring production traffic can preempt batch jobs during resource pressure
- Deploy the descheduler to correct scheduling drift — the scheduler only places new pods and cannot rebalance existing placements
- Monitor for `FailedScheduling` events as they indicate either resource exhaustion or overly restrictive constraints
- The scheduling framework provides extension points for custom logic when built-in primitives are insufficient
