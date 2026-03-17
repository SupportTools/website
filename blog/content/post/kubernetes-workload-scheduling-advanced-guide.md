---
title: "Kubernetes Advanced Workload Scheduling: Priorities, Preemption, and Topology"
date: 2028-04-02T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Scheduling", "PriorityClass", "Topology", "Descheduler", "Affinity", "Production"]
categories: ["Kubernetes", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Kubernetes advanced scheduling covering PriorityClass and preemption mechanics, topology spread constraints, inter-pod affinity with weights, node affinity for scheduling and execution rules, Descheduler strategies, and scheduling profiles and plugins."
more_link: "yes"
url: "/kubernetes-workload-scheduling-advanced-guide/"
---

Kubernetes scheduling at scale requires deliberate configuration of priorities, topology constraints, and affinity rules. The default scheduler's bin-packing behavior optimizes for resource utilization but frequently produces suboptimal placement for production workloads — critical services share nodes with batch jobs, replicas cluster on the same failure domain, and high-priority workloads starve when cluster capacity is tight. This guide covers every lever available for controlling workload placement in production clusters.

<!--more-->

## PriorityClass and Preemption Mechanics

PriorityClass assigns a numeric priority to pods. When the cluster is resource-constrained and a high-priority pod cannot be scheduled, the scheduler may preempt (evict) lower-priority pods to free capacity.

### PriorityClass Hierarchy

```yaml
# System-critical: reserved for Kubernetes system components
# DO NOT use for application pods
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: system-critical
value: 2000000000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: "Reserved for critical Kubernetes system components."

# Platform-critical: infrastructure services (monitoring, ingress, dns)
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: platform-critical
value: 1000000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: "Platform infrastructure services. Never preempted by application workloads."

# Production workloads: user-facing services
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: production
value: 100000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: "Production user-facing workloads."

# Staging workloads
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: staging
value: 10000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: "Staging and pre-production workloads."

# Batch/background jobs: lowest priority, first to be preempted
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: batch
value: 1000
globalDefault: true  # Applied when no priorityClassName is set
preemptionPolicy: PreemptLowerPriority
description: "Background batch jobs. Will be preempted by higher-priority workloads."

# Never preempts others (for best-effort tasks)
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: best-effort
value: 100
globalDefault: false
preemptionPolicy: Never  # Will not preempt, will be preempted
description: "Best-effort tasks that should never displace other workloads."
```

### Applying PriorityClass to Workloads

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-api
  namespace: production
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
      priorityClassName: production  # High priority; preempts batch
      containers:
        - name: payment-api
          image: registry.example.com/payment-api:v2.1.0
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 2Gi
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: report-generator
  namespace: production
spec:
  schedule: "0 2 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          priorityClassName: batch  # Low priority; first to be preempted
          restartPolicy: OnFailure
          containers:
            - name: generator
              image: registry.example.com/report-gen:v1.0.0
```

### Preemption Behavior

When the scheduler cannot place a pod due to insufficient resources:

1. The scheduler finds a set of nodes where the pod could fit if lower-priority pods were removed.
2. It selects the node with the minimum number of preemptible pods.
3. Pods are preempted using graceful termination (respecting `terminationGracePeriodSeconds`).
4. PodDisruptionBudgets are respected during preemption — a pod will not be preempted if doing so would violate its PDB.

```bash
# Monitor preemption events
kubectl get events --all-namespaces \
  --field-selector reason=Preempting \
  --sort-by='.lastTimestamp'

# Check if a pod has been nominated for a node (preemption in progress)
kubectl get pods -n production -o json | jq '
  .items[] |
  select(.status.nominatedNodeName != null) |
  {name: .metadata.name, nominatedNode: .status.nominatedNodeName}
'
```

## Topology Spread Constraints

Topology spread constraints control how pods distribute across failure domains (zones, nodes, racks). They replace the older `podAntiAffinity` pattern with a more flexible and predictable model.

### Zone-Level Spreading

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: production
spec:
  replicas: 6
  selector:
    matchLabels:
      app: api-server
  template:
    metadata:
      labels:
        app: api-server
        tier: frontend
    spec:
      topologySpreadConstraints:
        # Spread evenly across availability zones
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: api-server
          # Count only pods in Ready state for skew calculation
          matchLabelKeys:
            - pod-template-hash
          nodeAffinityPolicy: Honor
          nodeTaintsPolicy: Honor

        # Additionally spread across nodes within each zone
        - maxSkew: 2
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: ScheduleAnyway  # Soft constraint at node level
          labelSelector:
            matchLabels:
              app: api-server
      containers:
        - name: api-server
          image: registry.example.com/api-server:v3.0.0
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
```

### Understanding maxSkew and whenUnsatisfiable

**maxSkew** defines the maximum difference in pod count between the most-loaded and least-loaded topology domain.

With `replicas: 6` across 3 zones:
- Ideal: 2/2/2 (skew = 0)
- Acceptable with maxSkew=1: 3/2/1 (skew = 2, violates) → 2/2/2 or 3/2/1 is NOT acceptable; 3/3/0 is NOT acceptable; only distributions where max-min ≤ maxSkew=1 are acceptable

**whenUnsatisfiable** controls what happens when the constraint cannot be satisfied:
- `DoNotSchedule`: Pod stays Pending. Use for hard requirements (zone HA).
- `ScheduleAnyway`: Pod is scheduled on the best-fit node. Use for soft preferences (node spreading within zones).

### Multi-Tier Spreading for High Availability

```yaml
# For a 9-replica deployment across 3 zones and 9 nodes (3 per zone):
topologySpreadConstraints:
  # Hard: must spread across zones
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: DoNotSchedule
    labelSelector:
      matchLabels:
        app: critical-service
  # Soft: prefer spreading across nodes
  - maxSkew: 1
    topologyKey: kubernetes.io/hostname
    whenUnsatisfiable: ScheduleAnyway
    labelSelector:
      matchLabels:
        app: critical-service
```

### Minimum Domain Count

```yaml
# Require pods to spread across at least 2 zones
- maxSkew: 1
  minDomains: 2
  topologyKey: topology.kubernetes.io/zone
  whenUnsatisfiable: DoNotSchedule
  labelSelector:
    matchLabels:
      app: api-server
```

## Inter-Pod Affinity and Anti-Affinity

### Required Anti-Affinity (Hard)

Ensure no two replicas of the same deployment run on the same node:

```yaml
spec:
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchExpressions:
              - key: app
                operator: In
                values:
                  - payment-api
          topologyKey: kubernetes.io/hostname
```

Note: `IgnoredDuringExecution` means that if a node label changes after a pod is scheduled, the pod is NOT evicted. The constraint is only enforced at scheduling time.

### Weighted Preferred Anti-Affinity

Use weights to express preferences without hard requirements:

```yaml
spec:
  affinity:
    podAntiAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        # Strong preference: avoid same node as other replicas (weight 100)
        - weight: 100
          podAffinityTerm:
            labelSelector:
              matchLabels:
                app: api-server
            topologyKey: kubernetes.io/hostname
        # Moderate preference: avoid same zone as other replicas (weight 50)
        - weight: 50
          podAffinityTerm:
            labelSelector:
              matchLabels:
                app: api-server
            topologyKey: topology.kubernetes.io/zone
```

The scheduler sums weights for each candidate node and selects the highest-scoring option.

### Co-location Affinity (Pods That Should Be Together)

Place cache sidecars on the same node as the application they serve:

```yaml
# Cache pod: schedule on same node as the corresponding app pod
spec:
  affinity:
    podAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app: payment-api
          topologyKey: kubernetes.io/hostname
```

## Node Affinity

Node affinity replaces `nodeSelector` with a richer expression syntax.

### Required Node Affinity (Hard)

```yaml
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              # Must be in US regions
              - key: topology.kubernetes.io/region
                operator: In
                values:
                  - us-east-1
                  - us-west-2
              # Must not be a spot instance (for critical workloads)
              - key: node.kubernetes.io/instance-lifecycle
                operator: NotIn
                values:
                  - spot
              # Must have local NVMe storage
              - key: node.feature/local-nvme
                operator: Exists
```

### Scheduling vs Execution Affinity Rules

Kubernetes supports two rule types:
- `requiredDuringSchedulingIgnoredDuringExecution`: Enforced only at scheduling. Running pods are not evicted if the rule is violated later.
- `requiredDuringSchedulingRequiredDuringExecution`: (Alpha) Also enforced at execution; pods are evicted if the rule is violated.

```yaml
# Soft scheduling preference: prefer high-memory nodes
spec:
  affinity:
    nodeAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 80
          preference:
            matchExpressions:
              - key: node.kubernetes.io/memory-gb
                operator: Gt
                values: ["32"]
        - weight: 20
          preference:
            matchExpressions:
              - key: topology.kubernetes.io/zone
                operator: In
                values: ["us-east-1a"]  # Prefer primary zone
```

## Taints and Tolerations

Taints prevent pods from scheduling on nodes unless they explicitly tolerate the taint.

### Dedicated Node Pools

```bash
# Taint GPU nodes to prevent non-GPU workloads
kubectl taint nodes gpu-node-1 gpu-node-2 gpu-node-3 \
  nvidia.com/gpu=present:NoSchedule

# Taint spot instances to allow opt-in only
kubectl taint nodes spot-node-1 spot-node-2 \
  node.kubernetes.io/spot=true:NoSchedule

# Taint infra nodes
kubectl taint nodes infra-node-1 infra-node-2 \
  node-role.kubernetes.io/infra=true:NoSchedule
```

```yaml
# Pod that tolerates the spot taint (batch job that accepts interruption)
spec:
  tolerations:
    - key: "node.kubernetes.io/spot"
      operator: "Equal"
      value: "true"
      effect: "NoSchedule"
  # Combine with node affinity to ensure placement on spot nodes
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - key: node.kubernetes.io/instance-lifecycle
                operator: In
                values: ["spot"]
```

### Common System Taints

```yaml
# Tolerate all system taints (for DaemonSet pods)
tolerations:
  - operator: Exists
    effect: NoSchedule
  - operator: Exists
    effect: NoExecute
  - operator: Exists
    effect: PreferNoSchedule
```

## Descheduler

The Kubernetes scheduler places pods at creation time but does not move them as cluster conditions change. The Descheduler fills this gap by periodically evicting pods that violate current scheduling policies, allowing the scheduler to re-place them optimally.

### Installation

```bash
helm repo add descheduler https://kubernetes-sigs.github.io/descheduler/
helm repo update

helm install descheduler descheduler/descheduler \
  --namespace kube-system \
  --set schedule="*/5 * * * *" \
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
          # Never evict pods from critical namespaces
          evictSystemCriticalPods: false
          evictFailedBarePods: true
          evictLocalStoragePods: false
          # Respect PDBs
          ignorePvcPods: false
          nodeFit: true
    plugins:
      balance:
        enabled:
          # Evict duplicate pods on the same node
          - RemoveDuplicates
          # Move pods to less-loaded nodes
          - LowNodeUtilization
          # Spread pods violating topology constraints
          - RemovePodsViolatingTopologySpreadConstraint

      deschedule:
        enabled:
          # Evict pods violating node affinity after node labels change
          - RemovePodsViolatingNodeAffinity
          # Evict pods violating taints (node taint added after scheduling)
          - RemovePodsViolatingNodeTaints
          # Evict pods violating inter-pod affinity (co-scheduling rules)
          - RemovePodsViolatingInterPodAntiAffinity
          # Evict long-running pods older than threshold
          - PodLifeTime

      evict:
        enabled:
          # Pods in Failed phase
          - RemoveFailedPods
          # Pods with eviction overhead
          - RemovePodsHavingTooManyRestarts
---
# Plugin-specific configuration
apiVersion: "descheduler/v1alpha2"
kind: "DeschedulerPolicy"
profiles:
  - name: production-profile
    pluginConfig:
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
          # Only evict if the difference between over/under utilized nodes is large
          useDeviationThresholds: true

      - name: RemoveDuplicates
        args:
          # Only consider same namespace as duplicates
          excludeOwnerKinds:
            - DaemonSet

      - name: RemovePodsViolatingTopologySpreadConstraint
        args:
          # Only evict pods violating hard constraints
          constraints:
            - DoNotSchedule

      - name: PodLifeTime
        args:
          maxPodLifeTimeSeconds: 604800  # 7 days
          podStatusPhases:
            - Running
          labelSelector:
            matchLabels:
              # Only rotate stateless background pods
              enable-rotation: "true"

      - name: RemovePodsHavingTooManyRestarts
        args:
          podRestartThreshold: 10
          includingInitContainers: true

      - name: RemoveFailedPods
        args:
          reasons:
            - OutOfCpu
            - CreateContainerConfigError
          includingInitContainers: true
          excludeOwnerKinds:
            - Job
```

## Scheduling Profiles and Plugins

Kubernetes scheduler supports multiple profiles, each with a different set of plugins enabled. This allows running a single scheduler binary that handles different workload classes differently.

```yaml
# kube-scheduler configuration
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
profiles:
  # Default profile: standard bin-packing
  - schedulerName: default-scheduler
    plugins:
      score:
        enabled:
          - name: NodeResourcesFit
            weight: 1
          - name: InterPodAffinity
            weight: 2
          - name: NodeAffinity
            weight: 2
          - name: TopologySpreadConstraint
            weight: 2
        disabled:
          # Disable least-requested to prefer bin-packing
          - name: NodeResourcesLeastAllocated

  # Spread profile: maximize distribution for HA workloads
  - schedulerName: spread-scheduler
    plugins:
      score:
        enabled:
          - name: NodeResourcesLeastAllocated  # Prefer empty nodes
            weight: 3
          - name: TopologySpreadConstraint
            weight: 5
        disabled:
          - name: NodeResourcesMostAllocated

  # GPU profile: specialized for ML workloads
  - schedulerName: gpu-scheduler
    plugins:
      filter:
        enabled:
          - name: NodeResourcesFit
      score:
        enabled:
          - name: NodeResourcesFit
            weight: 10  # Heavily weight resource fit
    pluginConfig:
      - name: NodeResourcesFit
        args:
          scoringStrategy:
            type: MostAllocated
            resources:
              - name: nvidia.com/gpu
                weight: 10
              - name: cpu
                weight: 1
              - name: memory
                weight: 1
```

Assign workloads to specific scheduler profiles:

```yaml
spec:
  schedulerName: spread-scheduler  # Use the HA scheduler profile
  # ... rest of pod spec
```

## Scheduling Debugging

```bash
# Diagnose why a pod is Pending
kubectl describe pod <POD_NAME> -n <NAMESPACE>
# Look for Events section: "FailedScheduling" events contain the reason

# Common reasons:
# - "0/10 nodes are available: 3 Insufficient cpu" -> Not enough CPU
# - "0/10 nodes are available: 10 node(s) didn't match pod anti-affinity" -> Anti-affinity too strict
# - "0/10 nodes are available: 5 node(s) had taint {key: value}, that the pod didn't tolerate" -> Missing toleration

# Check scheduler logs for detailed scheduling decisions
kubectl logs -n kube-system -l component=kube-scheduler --tail=100 \
  | grep <POD_NAME>

# Use scheduler simulation (dry run)
# The scheduler extender framework can provide simulation APIs

# Check resource availability per node
kubectl describe nodes | grep -A 5 "Allocated resources:"

# Find nodes that match a pod's requirements without scheduling it
kubectl get nodes -o json | jq '
  .items[] |
  {name: .metadata.name,
   labels: .metadata.labels,
   capacity: .status.capacity,
   allocatable: .status.allocatable}
'

# Check topology domains
kubectl get nodes -L topology.kubernetes.io/zone,kubernetes.io/hostname \
  | column -t
```

## ResourceQuota and LimitRange Integration with Scheduling

ResourceQuotas and LimitRanges interact directly with scheduling. A pod that cannot be created due to namespace quota exhaustion will remain Pending with a quota-related event rather than a scheduler event.

### Namespace Quotas for Scheduling Boundaries

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: production-quota
  namespace: team-payments
spec:
  hard:
    # Total resource limits
    requests.cpu: "20"
    requests.memory: "40Gi"
    limits.cpu: "80"
    limits.memory: "160Gi"
    # Pod count by priority class
    count/pods: "100"
    # Require pods to use PriorityClass
    pods: "100"
    # Priority-specific quotas (requires ScopeSelector)
  scopeSelector:
    matchExpressions:
      - operator: In
        scopeName: PriorityClass
        values: ["production", "staging", "batch"]
---
# Scoped quota: limit batch job resource consumption
apiVersion: v1
kind: ResourceQuota
metadata:
  name: batch-quota
  namespace: team-payments
spec:
  hard:
    requests.cpu: "10"
    requests.memory: "20Gi"
  scopeSelector:
    matchExpressions:
      - operator: In
        scopeName: PriorityClass
        values: ["batch"]
```

### LimitRange for Default Resource Requirements

Without LimitRange defaults, pods without explicit resource requests are scheduled as BestEffort QoS, which the node OOM killer evicts first:

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: default-limits
  namespace: team-payments
spec:
  limits:
    - type: Container
      # Default requests applied when not specified
      defaultRequest:
        cpu: 100m
        memory: 128Mi
      # Default limits applied when not specified
      default:
        cpu: 500m
        memory: 512Mi
      # Maximum limits any container can request
      max:
        cpu: "8"
        memory: "16Gi"
      # Minimum requests (prevents requesting 0 CPU/memory)
      min:
        cpu: 10m
        memory: 16Mi
      # Limit/request ratio (prevents memory limits from being 100x requests)
      maxLimitRequestRatio:
        cpu: "10"
        memory: "4"
    - type: Pod
      max:
        cpu: "16"
        memory: "32Gi"
    - type: PersistentVolumeClaim
      max:
        storage: 100Gi
      min:
        storage: 1Gi
```

## Vertical Pod Autoscaler (VPA) for Right-Sizing

VPA analyzes historical resource usage and adjusts requests to match actual consumption, directly improving scheduling efficiency:

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: api-service-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-service
  updatePolicy:
    # Off: only generate recommendations (safe for production evaluation)
    # Initial: only apply on pod creation (no in-place updates)
    # Recreate: evict pods to apply new recommendations
    # Auto: use in-place updates when available, else recreate
    updateMode: "Off"
  resourcePolicy:
    containerPolicies:
      - containerName: api-service
        minAllowed:
          cpu: 100m
          memory: 128Mi
        maxAllowed:
          cpu: "4"
          memory: 4Gi
        controlledResources: ["cpu", "memory"]
        # Only update requests, not limits
        controlledValues: RequestsOnly
```

Check VPA recommendations without applying them:

```bash
# View VPA recommendations
kubectl get vpa api-service-vpa -n production -o json | jq '
  .status.recommendation.containerRecommendations[] |
  {
    container: .containerName,
    lower_bound: .lowerBound,
    target: .target,
    upper_bound: .upperBound,
    uncapped_target: .uncappedTarget
  }
'

# Apply VPA recommendation to deployment (manual apply for safety)
VPA_CPU=$(kubectl get vpa api-service-vpa -n production \
  -o jsonpath='{.status.recommendation.containerRecommendations[0].target.cpu}')
VPA_MEM=$(kubectl get vpa api-service-vpa -n production \
  -o jsonpath='{.status.recommendation.containerRecommendations[0].target.memory}')

echo "VPA recommends: cpu=${VPA_CPU} memory=${VPA_MEM}"

kubectl set resources deployment api-service -n production \
  --requests="cpu=${VPA_CPU},memory=${VPA_MEM}"
```

## Pod Scheduling Observability

### Scheduler Event Monitoring

```yaml
# PrometheusRule for scheduling metrics
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kubernetes-scheduling-alerts
  namespace: monitoring
spec:
  groups:
    - name: scheduling
      rules:
        - alert: PodPendingTooLong
          expr: |
            kube_pod_status_phase{phase="Pending"} == 1
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "Pod pending for more than 15 minutes"
            description: >
              Pod {{ $labels.namespace }}/{{ $labels.pod }} has been
              Pending for more than 15 minutes.

        - alert: HighPodPreemptionRate
          expr: |
            rate(scheduler_pod_preemption_victims[5m]) > 5
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High pod preemption rate"
            description: >
              More than 5 pods per second are being preempted.
              Check for resource pressure and PriorityClass configuration.

        - alert: SchedulerUnhealthy
          expr: |
            up{job="kube-scheduler"} == 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Kubernetes scheduler is down"
```

## Summary

Kubernetes scheduling is a multi-dimensional optimization problem. PriorityClass with preemption ensures that critical workloads are always schedulable at the expense of lower-priority batch jobs. Topology spread constraints provide predictable high-availability distribution across failure domains without the brittleness of hard anti-affinity rules.

The combination of required node affinity (for hard placement requirements), preferred node affinity with weights (for soft preferences), and topology spread constraints (for distribution) covers the full range of production scheduling requirements. The Descheduler completes the picture by continuously correcting placement drift that accumulates as nodes are added, removed, and relabeled over time.

ResourceQuota and LimitRange integration ensures that namespace-level resource governance aligns with the scheduling constraints, preventing any single team from exhausting cluster capacity. VPA right-sizing closes the loop by adjusting resource requests to match actual consumption, improving both scheduling efficiency and cost.

Scheduling profiles enable running specialized scheduling logic for different workload classes — a spread profile for stateless services, a bin-packing profile for batch jobs, and a GPU-aware profile for ML workloads — all within a single scheduler instance.
