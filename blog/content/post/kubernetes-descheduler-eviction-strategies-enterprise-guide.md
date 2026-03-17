---
title: "Kubernetes Descheduler: Advanced Eviction Strategies for Enterprise Cluster Optimization"
date: 2032-02-03T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Descheduler", "Pod Eviction", "Cluster Optimization", "Scheduling", "LowNodeUtilization", "PodAntiAffinity"]
categories: ["Kubernetes", "DevOps", "Infrastructure"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to the Kubernetes Descheduler: configuring LowNodeUtilization, RemoveDuplicates, PodAntiAffinityViolation, custom profiles, and safe eviction policies for production cluster rebalancing."
more_link: "yes"
url: "/kubernetes-descheduler-eviction-strategies-enterprise-guide/"
---

Kubernetes scheduling is a one-shot operation: the scheduler places a pod on a node at creation time and never revisits that decision. Over days and weeks, cluster topology shifts — nodes are added, nodes are drained and returned, resource demands change, and the once-optimal placement becomes highly suboptimal. The Descheduler was purpose-built to correct this drift by identifying misplaced pods and evicting them so the scheduler can re-place them on better nodes.

This guide provides a production-grade deep dive into every eviction strategy the Descheduler offers, how to compose them into profiles, how to gate evictions safely, and how to operate the tool in enterprise environments with PodDisruptionBudgets, priority classes, and multiple node pools.

<!--more-->

# Kubernetes Descheduler: Advanced Eviction Strategies for Enterprise Cluster Optimization

## The Scheduling Drift Problem

Consider a cluster where a compute-intensive batch job ran on node `worker-03` for six hours. During that time, two new high-memory nodes joined the cluster. When the batch job finished, `worker-03` became lightly loaded while the new nodes remain empty. Any stateless workload that was scheduled onto `worker-03` during the batch run will stay there indefinitely — the scheduler has no mechanism to move it.

Multiply this scenario across dozens of nodes, rolling upgrades, autoscaler scale-up events, and node pool migrations, and you accumulate scheduling debt. The Descheduler pays that debt.

## Architecture Overview

The Descheduler runs as a Kubernetes `CronJob` (or a continuous `Deployment`) and operates through a simple pipeline:

1. Collect cluster state via the Kubernetes API.
2. Evaluate each configured plugin against every pod.
3. Candidate pods are checked against eviction gates (PDB, priority threshold, namespace filters).
4. Eligible pods are evicted via the Eviction API.
5. The scheduler re-places each evicted pod immediately.

The Descheduler never places pods — it only removes them. Placement remains entirely the scheduler's responsibility.

## Installation

### Helm Installation (Recommended)

```bash
helm repo add descheduler https://kubernetes-sigs.github.io/descheduler/
helm repo update

helm install descheduler descheduler/descheduler \
  --namespace kube-system \
  --version 0.31.0 \
  --set schedule="*/10 * * * *" \
  --set kind=CronJob \
  --set deschedulerPolicy.profiles[0].name=default \
  --create-namespace
```

### RBAC Requirements

The Descheduler needs read access to most cluster resources and write access to the Eviction subresource:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: descheduler
rules:
  - apiGroups: [""]
    resources:
      - nodes
      - pods
      - namespaces
      - persistentvolumeclaims
      - persistentvolumes
    verbs: ["get", "watch", "list"]
  - apiGroups: [""]
    resources: ["pods/eviction"]
    verbs: ["create"]
  - apiGroups: ["policy"]
    resources: ["poddisruptionbudgets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["storage.k8s.io"]
    resources: ["storageclasses"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["scheduling.k8s.io"]
    resources: ["priorityclasses"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["replicasets", "deployments", "statefulsets", "daemonsets"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: descheduler
subjects:
  - kind: ServiceAccount
    name: descheduler
    namespace: kube-system
roleRef:
  kind: ClusterRole
  name: descheduler
  apiGroup: rbac.authorization.k8s.io
```

## Understanding the Policy Configuration

The Descheduler v0.28+ uses a profile-based configuration model. A `DeschedulerPolicy` contains one or more named profiles, each with a set of enabled plugins and per-plugin parameters.

```yaml
apiVersion: "descheduler/v1alpha2"
kind: "DeschedulerPolicy"
profiles:
  - name: ProfileName
    pluginConfig:
      - name: PluginName
        args:
          # plugin-specific args
    plugins:
      balance:
        enabled:
          - PluginName
      # or deschedule / filter / sort
```

Plugin categories:

| Category | Purpose |
|---|---|
| `deschedule` | Evict pods that violate a condition |
| `balance` | Rebalance pods across nodes |
| `filter` | Gate which pods can be evicted |
| `sort` | Order eviction candidates |

## Plugin Reference

### LowNodeUtilization

`LowNodeUtilization` identifies under-utilized nodes and over-utilized nodes. It evicts pods from the over-utilized nodes so they can land on the under-utilized ones.

```yaml
apiVersion: "descheduler/v1alpha2"
kind: "DeschedulerPolicy"
profiles:
  - name: utilization-rebalance
    pluginConfig:
      - name: LowNodeUtilization
        args:
          thresholds:
            cpu: 30
            memory: 30
            pods: 30
          targetThresholds:
            cpu: 70
            memory: 70
            pods: 70
          numberOfNodes: 2
          evictableNamespaces:
            exclude:
              - kube-system
              - monitoring
    plugins:
      balance:
        enabled:
          - LowNodeUtilization
```

Parameter explanation:

- `thresholds`: A node is considered *under-utilized* if ALL resources are below these percentages.
- `targetThresholds`: A node is considered *over-utilized* if ANY resource exceeds these percentages.
- `numberOfNodes`: Only trigger rebalancing when at least this many nodes are under-utilized. Prevents excessive churn in large clusters.

**Production tip**: Start with conservative thresholds (`cpu: 20`, `memory: 20`) and widen them after observing behavior. Aggressive thresholds cause unnecessary churn.

### HighNodeUtilization

The inverse of `LowNodeUtilization` — designed for bin-packing scenarios where you want to consolidate workloads onto fewer nodes (useful for autoscaler cost optimization).

```yaml
- name: HighNodeUtilization
  args:
    thresholds:
      cpu: 40
      memory: 40
    evictableNamespaces:
      exclude:
        - kube-system
```

When combined with the cluster autoscaler's scale-down logic, this can significantly reduce node count during off-peak hours.

### RemoveDuplicates

Kubernetes anti-affinity rules prevent two pods of the same owner from landing on the same node at creation time, but they do not re-enforce this constraint later. `RemoveDuplicates` corrects this by evicting excess pods when multiple replicas of the same owner (ReplicaSet, Deployment, StatefulSet) land on the same node.

```yaml
- name: RemoveDuplicates
  args:
    excludeOwnerKinds:
      - "ReplicaSet"
    namespaces:
      include:
        - production
        - staging
```

**Use case**: After a node returns from maintenance (uncordoned), many pods may have been re-scheduled onto it. `RemoveDuplicates` spreads them back out.

### RemovePodsViolatingInterPodAntiAffinity (PodAntiAffinityViolation)

Hard anti-affinity rules are enforced at scheduling time. But if topology changes after scheduling (for example, a pod's labels change, or a previously absent node becomes available), the constraint may be violated. This plugin detects and corrects those violations.

```yaml
- name: RemovePodsViolatingInterPodAntiAffinity
  args:
    namespaces:
      exclude:
        - kube-system
```

**Important**: This plugin only evicts pods that violate **soft** (`preferredDuringSchedulingIgnoredDuringExecution`) anti-affinity rules. Hard rules (`requiredDuringSchedulingIgnoredDuringExecution`) are enforced by the scheduler itself.

### RemovePodsViolatingNodeAffinity

If a pod was placed on a node that no longer satisfies the pod's node affinity rules (because node labels changed), this plugin evicts it.

```yaml
- name: RemovePodsViolatingNodeAffinity
  args:
    nodeAffinityType:
      - "requiredDuringSchedulingIgnoredDuringExecution"
    namespaces:
      exclude:
        - kube-system
        - cert-manager
```

**Real-world scenario**: You labeled nodes with `tier=general` and later changed them to `tier=compute`. Pods with node affinity for `tier=general` are now misplaced. This plugin detects and corrects that.

### RemovePodsViolatingNodeTaints

Removes pods that are running on nodes whose taints no longer match the pod's tolerations.

```yaml
- name: RemovePodsViolatingNodeTaints
  args:
    excludeTaints:
      - "node.kubernetes.io/not-ready"
      - "node.kubernetes.io/unreachable"
```

**Warning**: Always exclude `not-ready` and `unreachable` taints, otherwise the Descheduler will compete with the node controller during node failures.

### RemovePodsViolatingTopologySpreadConstraint

Detects violations of `topologySpreadConstraints` and evicts pods to correct skew.

```yaml
- name: RemovePodsViolatingTopologySpreadConstraint
  args:
    constraints:
      - DoNotSchedule
      - ScheduleAnyway
    topologyBalanceNodeFit: true
    namespaces:
      exclude:
        - kube-system
```

This is the most powerful balancing tool for zone-aware deployments. After an AZ failure and recovery, pod distribution across zones becomes skewed. This plugin corrects it.

### RemovePodsHavingTooManyRestarts

Evicts pods that have restarted above a threshold, clearing CrashLoopBackOff situations that may be caused by transient node-level issues.

```yaml
- name: RemovePodsHavingTooManyRestarts
  args:
    podRestartThreshold: 100
    includingInitContainers: true
    namespaces:
      exclude:
        - kube-system
```

**Use with caution**: This plugin will evict repeatedly crashing pods, but if the crash is caused by the workload itself (not the node), eviction just delays the inevitable.

### PodLifeTime

Evicts pods older than a maximum age. Useful for enforcing immutability of long-running pods.

```yaml
- name: PodLifeTime
  args:
    maxPodLifeTimeSeconds: 604800  # 7 days
    podStatusPhases:
      - "Pending"
      - "Running"
    labelSelector:
      matchLabels:
        lifecycle: ephemeral
```

## Eviction Filtering: DefaultEvictor

All eviction plugins route their candidates through a filter plugin. The default is `DefaultEvictor`, which provides safety guards:

```yaml
- name: DefaultEvictor
  args:
    evictSystemCriticalPods: false
    evictFailedBarePods: false
    evictLocalStoragePods: false
    evictDaemonSetPods: false
    ignorePvcPods: true
    minReplicas: 2
    minPodAge: "2m"
    priorityThreshold:
      value: 10000
    nodeFit: true
    labelSelector:
      matchExpressions:
        - key: "descheduler.alpha.kubernetes.io/evict"
          operator: "NotIn"
          values:
            - "never"
```

Key parameters:

| Parameter | Default | Production Recommendation |
|---|---|---|
| `evictSystemCriticalPods` | false | Keep false unless you have a strong reason |
| `evictLocalStoragePods` | false | Set true only if pods use `emptyDir` for cache only |
| `ignorePvcPods` | false | Set true for stateful workloads |
| `minReplicas` | 1 | Set to 2 to prevent eviction of single-replica services |
| `minPodAge` | 0 | Set to `5m` to avoid evicting recently placed pods |
| `priorityThreshold` | system-cluster-critical | Pods above this priority are never evicted |

### Opting Individual Pods Out of Eviction

Add the annotation to any pod to prevent the Descheduler from touching it:

```yaml
metadata:
  annotations:
    descheduler.alpha.kubernetes.io/evict: "never"
```

## Composing Production Profiles

### Profile 1: Zone-Aware Rebalancing

For clusters spanning multiple availability zones, this profile corrects zone skew and anti-affinity violations:

```yaml
apiVersion: "descheduler/v1alpha2"
kind: "DeschedulerPolicy"
profiles:
  - name: zone-aware-rebalance
    pluginConfig:
      - name: DefaultEvictor
        args:
          evictLocalStoragePods: false
          evictSystemCriticalPods: false
          ignorePvcPods: true
          minReplicas: 2
          minPodAge: "5m"
          priorityThreshold:
            name: "system-cluster-critical"
          nodeFit: true
      - name: RemovePodsViolatingTopologySpreadConstraint
        args:
          constraints:
            - DoNotSchedule
            - ScheduleAnyway
          topologyBalanceNodeFit: true
          namespaces:
            exclude:
              - kube-system
              - monitoring
      - name: RemovePodsViolatingInterPodAntiAffinity
        args:
          namespaces:
            exclude:
              - kube-system
      - name: RemoveDuplicates
        args:
          namespaces:
            include:
              - production
    plugins:
      balance:
        enabled:
          - RemovePodsViolatingTopologySpreadConstraint
          - RemoveDuplicates
      deschedule:
        enabled:
          - RemovePodsViolatingInterPodAntiAffinity
      filter:
        enabled:
          - DefaultEvictor
```

### Profile 2: Cost Optimization (Bin-Packing)

For environments where cloud cost matters and the cluster autoscaler is enabled:

```yaml
  - name: cost-optimize
    pluginConfig:
      - name: DefaultEvictor
        args:
          evictLocalStoragePods: true
          ignorePvcPods: true
          minReplicas: 2
          nodeFit: true
      - name: HighNodeUtilization
        args:
          thresholds:
            cpu: 40
            memory: 40
          evictableNamespaces:
            exclude:
              - kube-system
              - monitoring
              - cert-manager
    plugins:
      balance:
        enabled:
          - HighNodeUtilization
      filter:
        enabled:
          - DefaultEvictor
```

### Profile 3: Affinity Compliance

For clusters with strict anti-affinity requirements (financial services, regulated workloads):

```yaml
  - name: affinity-compliance
    pluginConfig:
      - name: DefaultEvictor
        args:
          ignorePvcPods: true
          minReplicas: 3
          minPodAge: "10m"
          priorityThreshold:
            value: 100000
      - name: RemovePodsViolatingNodeAffinity
        args:
          nodeAffinityType:
            - "requiredDuringSchedulingIgnoredDuringExecution"
            - "preferredDuringSchedulingIgnoredDuringExecution"
      - name: RemovePodsViolatingNodeTaints
        args:
          excludeTaints:
            - "node.kubernetes.io/not-ready"
            - "node.kubernetes.io/unreachable"
            - "node.kubernetes.io/memory-pressure"
            - "node.kubernetes.io/disk-pressure"
    plugins:
      deschedule:
        enabled:
          - RemovePodsViolatingNodeAffinity
          - RemovePodsViolatingNodeTaints
      filter:
        enabled:
          - DefaultEvictor
```

## Interaction with PodDisruptionBudgets

The Descheduler respects PodDisruptionBudgets. Before evicting a pod, it checks whether the eviction would violate the PDB. If it would, the eviction is skipped.

**Important nuance**: The Descheduler does not retry blocked evictions in the same run. If all candidates are PDB-blocked, nothing is evicted in that cycle. Design PDBs carefully:

```yaml
# Too restrictive — blocks all descheduling
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: my-service-pdb
spec:
  maxUnavailable: 0
  selector:
    matchLabels:
      app: my-service

# Practical — allows one eviction at a time
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: my-service-pdb
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: my-service
```

For services with high replica counts, use percentage-based PDBs:

```yaml
spec:
  maxUnavailable: "10%"
```

## Deploying as a CronJob vs. Deployment

### CronJob (Recommended for Most Cases)

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
          restartPolicy: Never
          priorityClassName: system-cluster-critical
          containers:
            - name: descheduler
              image: registry.k8s.io/descheduler/descheduler:v0.31.0
              command:
                - /bin/descheduler
                - --policy-config-file=/policy/policy.yaml
                - --v=3
              volumeMounts:
                - name: policy
                  mountPath: /policy
              resources:
                requests:
                  cpu: 500m
                  memory: 256Mi
                limits:
                  cpu: 1000m
                  memory: 512Mi
          volumes:
            - name: policy
              configMap:
                name: descheduler-policy
```

### Deployment (Continuous Mode)

For clusters that need continuous rebalancing (large node pools with frequent scale events):

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
      serviceAccountName: descheduler
      containers:
        - name: descheduler
          image: registry.k8s.io/descheduler/descheduler:v0.31.0
          command:
            - /bin/descheduler
            - --policy-config-file=/policy/policy.yaml
            - --descheduling-interval=5m
            - --v=3
```

## Monitoring and Observability

The Descheduler exposes Prometheus metrics on port 10258 at `/metrics`. Key metrics:

```promql
# Total evictions per plugin
descheduler_pods_evicted_total

# Eviction errors
descheduler_pod_eviction_error_total

# Evictions blocked by PDB
rate(descheduler_pod_eviction_error_total{error="PodDisruptionBudget"}[5m])

# Eviction rate over time
rate(descheduler_pods_evicted_total[10m])
```

### Grafana Dashboard Query: Evictions by Plugin

```promql
sum by (strategy) (
  increase(descheduler_pods_evicted_total[1h])
)
```

### Alert: Excessive Eviction Rate

```yaml
- alert: DeschedulerExcessiveEvictions
  expr: rate(descheduler_pods_evicted_total[10m]) > 5
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Descheduler is evicting more than 5 pods/minute"
    description: "Check if cluster topology changes are causing a rebalancing storm"
```

### Alert: Eviction Errors Spiking

```yaml
- alert: DeschedulerEvictionErrors
  expr: increase(descheduler_pod_eviction_error_total[15m]) > 10
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Descheduler eviction errors detected"
```

## Configuring the Policy as a ConfigMap

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
      - name: production
        pluginConfig:
          - name: DefaultEvictor
            args:
              evictLocalStoragePods: false
              evictSystemCriticalPods: false
              ignorePvcPods: true
              minReplicas: 2
              minPodAge: "5m"
              priorityThreshold:
                name: system-cluster-critical
              nodeFit: true
          - name: LowNodeUtilization
            args:
              thresholds:
                cpu: 25
                memory: 25
              targetThresholds:
                cpu: 65
                memory: 65
              numberOfNodes: 3
        plugins:
          balance:
            enabled:
              - LowNodeUtilization
          filter:
            enabled:
              - DefaultEvictor
```

## Advanced: Custom Sort Order for Eviction Candidates

The `sort` plugin category controls which pods are evicted first when multiple candidates exist. The built-in sorter is `PrioritySort`:

```yaml
- name: PrioritySort
  args:
    descending: false  # evict lowest priority first (default)
```

To evict the oldest pods first:

```yaml
plugins:
  sort:
    enabled:
      - PodLifeTime
```

## Operational Best Practices

### 1. Stage Rollout

Start with `--dry-run` mode to observe what the Descheduler would evict before enabling live eviction:

```bash
/bin/descheduler \
  --policy-config-file=/policy/policy.yaml \
  --dry-run \
  --v=4
```

### 2. Namespace Exclusions

Always exclude critical namespaces:

```yaml
evictableNamespaces:
  exclude:
    - kube-system
    - kube-public
    - kube-node-lease
    - cert-manager
    - monitoring
    - ingress-nginx
    - velero
```

### 3. Schedule During Low Traffic

Align the CronJob schedule with low-traffic windows when possible:

```yaml
schedule: "30 2 * * *"  # 2:30 AM daily
```

### 4. Combine with Priority Classes

Protect critical pods with high priority classes and set `priorityThreshold` to just below that value:

```yaml
# Priority class for critical services
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: business-critical
value: 1000000
globalDefault: false

# Descheduler config — never evict business-critical pods
priorityThreshold:
  value: 999999
```

### 5. StatefulSet Safety

Never enable `RemoveDuplicates` or `LowNodeUtilization` for StatefulSet pods without careful consideration. StatefulSets have stable identity, and moving them can cause quorum issues in distributed systems (Kafka, Zookeeper, etcd). Use namespace inclusion lists to apply descheduling only to stateless namespaces.

## Troubleshooting

### Pods Not Being Evicted

1. Check if the pod is owned by a DaemonSet (never evicted by default).
2. Check if `minReplicas` is higher than the deployment's replica count.
3. Check if the pod has `descheduler.alpha.kubernetes.io/evict: never`.
4. Check if the PDB is blocking (zero `maxUnavailable` or `minAvailable` equals `replicas`).
5. Check if `minPodAge` is set too high.
6. Verify the pod's priority class is below `priorityThreshold`.

```bash
# Check Descheduler logs for eviction skip reasons
kubectl logs -n kube-system -l app=descheduler --tail=200 | grep -i "skip\|cannot\|blocked"
```

### Eviction Loops

If the same pods are repeatedly evicted and re-placed in the same locations, the scheduler constraints and descheduler thresholds are conflicting. Common cause: `LowNodeUtilization` evicts pods from an over-utilized node, but the scheduler places them back on the same node because other constraints (affinity, resource requests) force it.

Fix: add explicit `PodAntiAffinity` or `topologySpreadConstraints` to the pod spec.

### High Eviction Rate at Startup

If the Descheduler runs immediately after a large-scale cluster event (node pool replacement), it may generate hundreds of evictions in the first cycle. Mitigate by setting `numberOfNodes` to require a minimum number of under-utilized nodes, and set `minPodAge` to `10m` to avoid touching newly placed pods.

## Upgrade Considerations

When upgrading the Descheduler between minor versions, always review the changelog for:

- Plugin parameter renames
- New default behaviors
- Deprecated configuration fields

The `descheduler/v1alpha2` API is the current stable format. The old `KubeDeschedulerPolicy` format was removed in v0.28.

## Summary

The Kubernetes Descheduler is a critical operational component for any enterprise cluster that experiences dynamic topology changes. Key takeaways:

- Use `LowNodeUtilization` for general rebalancing; tune thresholds conservatively.
- Use `RemovePodsViolatingTopologySpreadConstraint` for zone-aware deployments.
- Use `RemoveDuplicates` to correct post-maintenance scheduling debt.
- Always configure `DefaultEvictor` with `minReplicas >= 2` and `ignorePvcPods: true`.
- Respect PDBs — design them with `maxUnavailable: 1` rather than `0`.
- Monitor eviction rates and set alerts for unexpected spikes.
- Run in dry-run mode first when deploying to a new cluster.
