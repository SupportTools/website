---
title: "Kubernetes Descheduler: Automated Workload Rebalancing for Production Clusters"
date: 2027-10-28T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Descheduler", "Scheduling", "Resource Optimization"]
categories:
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Descheduler policies including RemoveDuplicates, LowNodeUtilization, RemovePodsViolatingNodeTaints, TopologySpreadConstraints, scheduling profiles, integration with HPA/VPA, and production tuning."
more_link: "yes"
url: "/kubernetes-descheduler-workload-rebalancing-guide/"
---

The Kubernetes scheduler places pods when they are first created, but it never revisits those placement decisions. Over time, cluster conditions change dramatically: nodes are added and removed, taints and labels change, resource consumption patterns shift, and topology spread requirements evolve. Without an active mechanism to rebalance workloads, clusters develop severe imbalances that waste capacity and create hotspots. The Descheduler solves this by periodically evicting pods from suboptimally placed positions so the scheduler can re-place them under current conditions.

<!--more-->

# Kubernetes Descheduler: Automated Workload Rebalancing for Production Clusters

## Why Clusters Drift Out of Balance

Understanding why rebalancing is needed requires understanding how Kubernetes scheduling works. The scheduler makes a placement decision at pod creation time based on current node availability, resource requests, affinity rules, and taints. It does not continuously monitor placements or move pods when conditions change.

Several common patterns cause clusters to become imbalanced:

**Cluster scale-up**: When the autoscaler adds new nodes, existing workloads continue running on the original nodes. New pods created after the scale event will land on the new nodes, but the old pods remain where they were. The cluster may have 20 pods on 5 original nodes and 0 pods on 3 new nodes.

**Taint changes**: An administrator adds a taint to a node for maintenance, then removes it after maintenance. Pods that were evicted during the taint period were rescheduled elsewhere, but they never returned to the original node after the taint was removed.

**Node label changes**: Pod affinity rules reference node labels. When labels are added or removed, pods that should now prefer different nodes remain on their original nodes indefinitely.

**Topology spread evolution**: Teams adopt `topologySpreadConstraints` after initial deployment. Existing pods violate the new constraints but are not evicted because they were placed before the constraints existed.

**Resource utilization drift**: Some nodes accumulate high utilization from pods that arrived first during deployment, while other nodes remain underutilized, even though the scheduler would spread them more evenly if placed today.

## Descheduler Architecture

The Descheduler runs as a Job, CronJob, or Deployment in your cluster. When it runs, it:

1. Queries all nodes and pods in the cluster
2. Evaluates each configured policy against the current state
3. Identifies pods that violate policy or are suboptimally placed
4. Evicts those pods (which triggers the scheduler to re-place them)
5. Respects PodDisruptionBudgets to prevent over-eviction

The Descheduler never places pods directly. It only evicts, relying on the scheduler and replication controllers to recreate evicted pods.

## Installation

### Helm Chart Installation

```bash
helm repo add descheduler https://kubernetes-sigs.github.io/descheduler/
helm repo update

helm install descheduler descheduler/descheduler \
  --namespace kube-system \
  --version 0.29.0 \
  --set schedule="*/10 * * * *" \
  --set kind=CronJob
```

### Manual Deployment with Custom Configuration

For production, deploy with a custom configuration rather than Helm defaults:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: kube-system
---
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
- apiGroups: ["policy"]
  resources: ["poddisruptionbudgets"]
  verbs: ["get", "watch", "list"]
- apiGroups: ["storage.k8s.io"]
  resources: ["storageclasses"]
  verbs: ["get", "watch", "list"]
- apiGroups: ["priority.scheduling.k8s.io"]
  resources: ["prioritylevelconfigurations"]
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

## Core Policy Configuration

The Descheduler is configured through a `DeschedulerPolicy` object in a ConfigMap. The following is a comprehensive production configuration:

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
    - name: production-rebalancing
      pluginConfig:
      - name: DefaultEvictor
        args:
          # Never evict pods with local storage
          evictLocalStoragePods: false
          # Never evict system-critical pods
          evictSystemCriticalPods: false
          # Respect PodDisruptionBudgets
          ignorePvcPods: false
          minReplicas: 2
          priorityThreshold:
            # Only evict pods below this priority class value
            value: 1000000000
      - name: RemoveDuplicates
        args:
          namespaces:
            exclude:
            - kube-system
            - monitoring
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
          useDeviationThresholds: false
          evictableNamespaces:
            exclude:
            - kube-system
      - name: RemovePodsViolatingNodeAffinity
        args:
          nodeAffinityType:
          - requiredDuringSchedulingIgnoredDuringExecution
          namespaces:
            exclude:
            - kube-system
      - name: RemovePodsViolatingNodeTaints
        args:
          excludeTaints:
          - "node.kubernetes.io/not-ready"
          - "node.kubernetes.io/unreachable"
          namespaces:
            exclude:
            - kube-system
      - name: RemovePodsViolatingInterPodAntiAffinity
        args:
          namespaces:
            exclude:
            - kube-system
      - name: RemovePodsViolatingTopologySpreadConstraint
        args:
          constraints:
          - DoNotSchedule
          namespaces:
            exclude:
            - kube-system
      plugins:
        balance:
          enabled:
          - RemoveDuplicates
          - LowNodeUtilization
          - RemovePodsViolatingTopologySpreadConstraint
        deschedule:
          enabled:
          - RemovePodsViolatingNodeAffinity
          - RemovePodsViolatingNodeTaints
          - RemovePodsViolatingInterPodAntiAffinity
```

## CronJob Deployment

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: descheduler
  namespace: kube-system
spec:
  schedule: "*/15 * * * *"
  concurrencyPolicy: Forbid
  suspend: false
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        metadata:
          labels:
            app: descheduler
        spec:
          serviceAccountName: descheduler
          priorityClassName: system-cluster-critical
          restartPolicy: Never
          containers:
          - name: descheduler
            image: registry.k8s.io/descheduler/descheduler:v0.29.0
            imagePullPolicy: IfNotPresent
            command:
            - /bin/descheduler
            args:
            - --policy-config-map-name=descheduler-policy
            - --policy-config-map-namespace=kube-system
            - --v=3
            - --dry-run=false
            ports:
            - containerPort: 10258
              name: metrics
            securityContext:
              allowPrivilegeEscalation: false
              capabilities:
                drop:
                - ALL
              readOnlyRootFilesystem: true
              runAsNonRoot: true
              runAsUser: 1000
              seccompProfile:
                type: RuntimeDefault
            resources:
              requests:
                cpu: 100m
                memory: 128Mi
              limits:
                cpu: 1000m
                memory: 512Mi
            volumeMounts:
            - mountPath: /policy-dir
              name: policy-volume
          volumes:
          - name: policy-volume
            configMap:
              name: descheduler-policy
```

## Policy Deep Dive

### RemoveDuplicates

`RemoveDuplicates` ensures that no more than one pod from a ReplicaSet, Deployment, StatefulSet, or Job runs on a single node. This policy is particularly important after cluster scale-up events when many replicas may have landed on the same nodes.

```yaml
- name: RemoveDuplicates
  args:
    # Exclude specific namespaces from this policy
    namespaces:
      exclude:
      - kube-system
      - monitoring
    # Exclude pods matching these selectors from eviction
    excludeOwnerKinds:
    - "DaemonSet"
```

Example scenario: A 3-replica Deployment has all 3 pods on node-1, node-2, and node-3. Two new nodes (node-4, node-5) are added. `RemoveDuplicates` will not evict pods here because each node only has one replica. However, if due to a rolling restart, node-1 gets 2 pods from the same ReplicaSet, `RemoveDuplicates` will evict the extra pod.

### LowNodeUtilization

`LowNodeUtilization` identifies underutilized nodes (below `thresholds`) and evicts pods from overutilized nodes (above `targetThresholds`) to allow them to reschedule onto the underutilized nodes.

```yaml
- name: LowNodeUtilization
  args:
    thresholds:
      # Nodes below ALL these thresholds are considered underutilized
      cpu: 20
      memory: 20
      pods: 10
    targetThresholds:
      # Nodes above ANY of these thresholds are candidates for eviction
      cpu: 50
      memory: 50
      pods: 50
    # When true, thresholds are expressed as deviation from the mean
    # rather than absolute values
    useDeviationThresholds: false
```

The policy works as follows:
1. Find all nodes where CPU utilization is below 20%, memory below 20%, and pod count below 10%
2. Find all nodes where CPU exceeds 50%, OR memory exceeds 50%, OR pod count exceeds 50%
3. Evict pods from the overutilized nodes until they drop below the target thresholds
4. Evicted pods can then be scheduled onto underutilized nodes

For heterogeneous clusters with different node sizes, use `useDeviationThresholds: true` to express thresholds as deviations from the cluster mean rather than absolute values.

### RemovePodsViolatingNodeTaints

This policy evicts pods that are running on nodes they should no longer tolerate based on current taint configuration:

```yaml
- name: RemovePodsViolatingNodeTaints
  args:
    # Do not evict pods because of these taints (used for node lifecycle taints)
    excludeTaints:
    - "node.kubernetes.io/not-ready"
    - "node.kubernetes.io/unreachable"
    - "node.kubernetes.io/memory-pressure"
    # Only process pods in these namespaces
    namespaces:
      include:
      - production
      - staging
```

This is most useful after operator intervention. If you add a taint to a node to prevent specific workloads and then notice a pod that predates the taint is still running there (because Kubernetes does not evict existing pods for taint violations when `NoExecute` is not used), this policy handles the cleanup.

### RemovePodsViolatingTopologySpreadConstraints

This policy is critical for maintaining `topologySpreadConstraints` compliance over time:

```yaml
- name: RemovePodsViolatingTopologySpreadConstraint
  args:
    # Only enforce DoNotSchedule constraints (hard constraints)
    constraints:
    - DoNotSchedule
    # Also enforce ScheduleAnyway (soft constraints) -- use with caution
    # - ScheduleAnyway
    namespaces:
      exclude:
      - kube-system
```

Consider a deployment with `maxSkew: 1` spread across availability zones. Initially deployed with 9 pods across 3 AZs (3 per AZ). One AZ loses a node, causing 2 pods to reschedule into another AZ. Now the distribution is 5/2/2 -- a skew of 3, violating the constraint. `RemovePodsViolatingTopologySpreadConstraint` will evict pods from the overloaded AZ so they can reschedule back to the correct distribution.

### RemovePodsViolatingNodeAffinity

```yaml
- name: RemovePodsViolatingNodeAffinity
  args:
    nodeAffinityType:
    # Only enforce required affinity (hard rules)
    - requiredDuringSchedulingIgnoredDuringExecution
    namespaces:
      exclude:
      - kube-system
      - monitoring
```

When a node's labels change after pods are scheduled, pods that should no longer run on that node (based on required affinity) will be evicted by this policy.

## Integration with HPA

The Horizontal Pod Autoscaler (HPA) adds and removes replicas based on metrics. The Descheduler works alongside HPA but requires careful coordination to avoid conflicts.

The primary concern is that the Descheduler might evict pods that HPA just created, causing churn. Mitigate this by:

1. Setting `minReplicas` in the Descheduler's DefaultEvictor to avoid evicting the minimum HPA replica count:

```yaml
- name: DefaultEvictor
  args:
    # Never evict if the owner has fewer than 3 replicas
    minReplicas: 3
    # Nodes with these labels are never eviction targets
    nodeSelector: "node.kubernetes.io/descheduler-avoid=true"
```

2. Scheduling the Descheduler to run when HPA activity is low (off-peak hours for most workloads):

```yaml
spec:
  # Run at 2 AM daily during low traffic period
  schedule: "0 2 * * *"
```

3. Annotating HPA-managed deployments to be excluded from aggressive rebalancing:

```yaml
# On the Deployment
metadata:
  annotations:
    descheduler.alpha.kubernetes.io/evict: "false"
```

## Integration with VPA

Vertical Pod Autoscaler (VPA) may trigger pod evictions to apply new resource recommendations. The Descheduler and VPA can conflict if the Descheduler evicts a pod that VPA just placed with updated resources.

To avoid conflicts, configure the Descheduler to exclude VPA-managed pods:

```yaml
- name: DefaultEvictor
  args:
    # Exclude pods with the VPA-managed label
    labelSelector:
      matchExpressions:
      - key: vpa-managed
        operator: DoesNotExist
```

Alternatively, use separate scheduling windows -- run VPA reconciliations during business hours and Descheduler during maintenance windows.

## Deployment as a Long-Running Controller

For clusters that scale frequently, running the Descheduler as a CronJob on a fixed schedule may not be responsive enough. The Descheduler can also run as a continuous Deployment:

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
    metadata:
      labels:
        app: descheduler
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
        - --descheduling-interval=10m
        - --v=3
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 256Mi
```

In this mode, `--descheduling-interval=10m` causes the Descheduler to re-evaluate policies every 10 minutes continuously.

## Monitoring Descheduler Activity

The Descheduler exposes Prometheus metrics when running as a Deployment:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: descheduler
  namespace: kube-system
  labels:
    prometheus: kube-prometheus
spec:
  selector:
    matchLabels:
      app: descheduler
  endpoints:
  - port: metrics
    interval: 30s
    path: /metrics
```

Key metrics to monitor:

| Metric | Description |
|--------|-------------|
| `descheduler_pods_evicted_total` | Total pods evicted, labeled by strategy and namespace |
| `descheduler_strategy_duration_seconds` | Time spent running each strategy |
| `descheduler_errors_total` | Errors encountered during eviction |

Create alerts for unexpected eviction rates:

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
      expr: rate(descheduler_pods_evicted_total[5m]) > 5
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Descheduler evicting pods at high rate"
        description: "Descheduler is evicting more than 5 pods per second. Check cluster balance."

    - alert: DeschedulerEvictionErrors
      expr: rate(descheduler_errors_total[5m]) > 0
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Descheduler encountering errors"
        description: "Descheduler is experiencing errors during pod eviction."
```

## Production Policies for Specific Workload Types

### Stateful Applications

For StatefulSets, be conservative. StatefulSets have stable network identities and persistent storage, and evicting their pods causes reconnection overhead:

```yaml
- name: LowNodeUtilization
  args:
    thresholds:
      cpu: 20
      memory: 20
      pods: 10
    targetThresholds:
      cpu: 70
      memory: 70
      pods: 70
    evictableNamespaces:
      exclude:
      - databases
      - storage
```

Use namespace exclusion to prevent Descheduler from touching database pods entirely.

### Batch Workloads

For batch jobs and Argo Workflows, the Descheduler should be more aggressive:

```yaml
- name: RemoveDuplicates
  args:
    namespaces:
      include:
      - batch-jobs
      - argo-workflows
```

Batch pods are generally tolerant of eviction because they can be restarted without data loss.

### GPU Workloads

GPU workloads are expensive to restart (loading model weights can take minutes). Exclude them entirely:

```yaml
- name: DefaultEvictor
  args:
    evictLocalStoragePods: false
    labelSelector:
      matchExpressions:
      - key: workload-type
        operator: NotIn
        values:
        - gpu-inference
        - gpu-training
```

## Troubleshooting Common Issues

### Pods Not Being Evicted

If the Descheduler runs but no pods are evicted when you expect them to be:

```bash
# Check Descheduler logs for why pods are being skipped
kubectl logs -n kube-system job/descheduler --tail=200 | grep -i "skip\|evict\|error"

# Common reasons for skipping:
# - Pod has a PodDisruptionBudget that would be violated
# - Pod has descheduler.alpha.kubernetes.io/evict: false annotation
# - Pod is owned by a DaemonSet
# - Pod is static (created by kubelet directly)
# - Pod has local storage (PVC with hostPath or emptyDir with data)
```

### Excessive Evictions

If the Descheduler is evicting too many pods:

```bash
# Check which strategy is causing the most evictions
kubectl logs -n kube-system job/descheduler | grep "evicted" | awk '{print $NF}' | sort | uniq -c | sort -rn

# Increase thresholds in LowNodeUtilization to be less aggressive
# Lower maxNoOfPodsToEvictPerNode and maxNoOfPodsToEvictPerNamespace
```

Add explicit limits on eviction rate:

```yaml
- name: DefaultEvictor
  args:
    maxNoOfPodsToEvictPerNode: 5
    maxNoOfPodsToEvictPerNamespace: 10
    maxNoOfPodsToEvictTotal: 20
```

### Descheduler Conflicts with PodDisruptionBudgets

```bash
# Find PDBs that are preventing eviction
kubectl get pdb --all-namespaces -o wide

# Check if PDB is blocking eviction
kubectl get pdb -n production my-app-pdb -o jsonpath='{.status}'
```

If PDBs are too restrictive and preventing necessary rebalancing, consider relaxing them during maintenance windows or adjusting `minAvailable` values.

## Best Practices for Production Use

**Test in staging first**: Run the Descheduler in dry-run mode (`--dry-run=true`) in staging before enabling in production. Review the logs to understand what it would evict.

**Start conservatively**: Begin with only the `RemovePodsViolatingNodeTaints` and `RemovePodsViolatingNodeAffinity` policies, which evict pods that definitively should not be where they are. Add balance-oriented policies like `LowNodeUtilization` only after validating the behavior.

**Monitor application SLOs**: Track error rates and latency during Descheduler runs. If evictions cause SLO degradation, adjust PDBs, add exclusions, or reduce eviction frequency.

**Coordinate with release cycles**: Avoid running aggressive Descheduler policies during deployments when application state is already in flux.

**Document policy rationale**: Each policy in your ConfigMap should have a comment explaining why it is enabled and what problem it solves. This is critical for on-call engineers who need to quickly understand why pods are being evicted.

## Conclusion

The Descheduler is an essential complement to the Kubernetes scheduler in any cluster that experiences topology changes, scaling events, or evolving placement requirements. Without it, clusters accumulate placement debt that wastes resources, creates hotspots, and makes capacity planning unreliable.

The key to successful Descheduler operation is starting with conservative policies, monitoring eviction rates carefully, and incrementally enabling more aggressive rebalancing as you validate that application workloads tolerate the disruption. Combined with proper PodDisruptionBudgets on all critical workloads, the Descheduler can operate safely in production environments with high availability requirements.

## Advanced Scheduling Profiles

The Descheduler v0.27+ supports named profiles that allow you to apply different policy sets to different workload categories within the same cluster. This eliminates the need to run multiple Descheduler instances.

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
    # Profile for stateless application workloads
    - name: stateless-workloads
      pluginConfig:
      - name: DefaultEvictor
        args:
          evictLocalStoragePods: false
          minReplicas: 3
          namespaces:
            include:
            - production
            - staging
      - name: LowNodeUtilization
        args:
          thresholds:
            cpu: 25
            memory: 25
            pods: 15
          targetThresholds:
            cpu: 60
            memory: 60
            pods: 60
      - name: RemovePodsViolatingTopologySpreadConstraint
        args:
          constraints:
          - DoNotSchedule
      plugins:
        balance:
          enabled:
          - LowNodeUtilization
          - RemovePodsViolatingTopologySpreadConstraint

    # Profile for infrastructure components - very conservative
    - name: infrastructure
      pluginConfig:
      - name: DefaultEvictor
        args:
          evictLocalStoragePods: false
          evictSystemCriticalPods: false
          minReplicas: 2
          namespaces:
            include:
            - monitoring
            - logging
            - cert-manager
      - name: RemovePodsViolatingNodeAffinity
        args:
          nodeAffinityType:
          - requiredDuringSchedulingIgnoredDuringExecution
      plugins:
        deschedule:
          enabled:
          - RemovePodsViolatingNodeAffinity

    # Profile for batch workloads - aggressive rebalancing
    - name: batch-workloads
      pluginConfig:
      - name: DefaultEvictor
        args:
          evictLocalStoragePods: true
          minReplicas: 1
          namespaces:
            include:
            - batch
            - argo-workflows
            - spark-jobs
      - name: RemoveDuplicates
        args: {}
      - name: LowNodeUtilization
        args:
          thresholds:
            cpu: 30
            memory: 30
            pods: 20
          targetThresholds:
            cpu: 80
            memory: 80
            pods: 80
      plugins:
        balance:
          enabled:
          - RemoveDuplicates
          - LowNodeUtilization
```

## HighNodeUtilization Policy

In addition to `LowNodeUtilization` which moves pods away from overloaded nodes, there is also a `HighNodeUtilization` policy that does the opposite: it consolidates pods onto fewer nodes to enable scale-down. This is useful for cost optimization when running in cloud environments with autoscaling.

```yaml
- name: HighNodeUtilization
  args:
    thresholds:
      # Evict pods from nodes where ALL metrics are below these values
      cpu: 30
      memory: 30
      pods: 20
    # Nodes with at least one metric above this are "full enough" to receive evicted pods
    targetThresholds:
      cpu: 70
      memory: 70
      pods: 70
    evictableNamespaces:
      exclude:
      - kube-system
      - monitoring
```

`HighNodeUtilization` evicts pods from underutilized nodes, consolidating workload onto fewer, more-utilized nodes. The now-empty or near-empty nodes become candidates for removal by the cluster autoscaler, reducing cloud costs.

The combination of `HighNodeUtilization` in the Descheduler and scale-down in the cluster autoscaler is a powerful cost optimization pattern:

1. Descheduler identifies underutilized nodes and evicts pods from them
2. Evicted pods reschedule onto other nodes with spare capacity
3. Emptied nodes no longer have workloads that prevent autoscaler scale-down
4. Autoscaler removes the empty nodes and reduces the node count
5. Cloud costs decrease proportionally

## Pod Lifecycle and Eviction Safety

Understanding when the Descheduler will and will not evict a pod is critical for production safety.

### Pods That Are Never Evicted

The DefaultEvictor skips these pod categories regardless of policy:

- Pods with `priorityClassName` set to `system-cluster-critical` or `system-node-critical`
- Pods owned by DaemonSets (they cannot be rescheduled anywhere else)
- Static pods (managed directly by kubelet, not through the API)
- Pods with the annotation `descheduler.alpha.kubernetes.io/evict: "false"`
- Mirror pods

### Pods That Require Special Handling

- Pods with PVCs are only evicted if `evictLocalStoragePods` is true
- Pods where eviction would violate a PodDisruptionBudget are skipped
- Pods below `minReplicas` threshold for their owner are skipped

### Graceful Eviction

The Descheduler uses the Kubernetes Eviction API, which respects the pod's `terminationGracePeriodSeconds`. This means pods get their full graceful shutdown window to finish in-flight requests before being terminated.

For workloads with long graceful shutdown periods, the Descheduler run duration will increase. If your Descheduler runs are taking too long, consider:

```bash
# Check how long the Descheduler job takes
kubectl get jobs -n kube-system | grep descheduler

# Review pod termination grace periods across namespaces
kubectl get pods --all-namespaces -o jsonpath='{range .items[*]}{.metadata.namespace}{"\t"}{.metadata.name}{"\t"}{.spec.terminationGracePeriodSeconds}{"\n"}{end}' | sort -k3 -rn | head -20
```

## Node Selector for Targeted Rebalancing

For clusters with heterogeneous node pools (on-demand vs spot, GPU vs CPU, different instance sizes), you can restrict which nodes each policy applies to using label selectors:

```yaml
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
    # Only rebalance within the on-demand node pool
    # (don't move pods from on-demand to spot accidentally)
    nodeSelector: "cloud.google.com/gke-nodepool=on-demand-pool"
```

This prevents the Descheduler from moving pods between node pools with different cost profiles, which could create unexpected billing changes.

## RBAC Audit and Security Considerations

The Descheduler requires cluster-wide pod deletion permissions, which is a significant privilege. Review these security considerations for production:

```yaml
# Restrict Descheduler to specific namespaces if possible
# Use namespace-scoped role bindings where the policy covers limited namespaces
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: descheduler-limited
  namespace: production
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "watch", "list", "delete"]
- apiGroups: [""]
  resources: ["pods/eviction"]
  verbs: ["create"]
- apiGroups: ["policy"]
  resources: ["poddisruptionbudgets"]
  verbs: ["get", "watch", "list"]
```

For clusters with strict security posture, consider:

1. Running the Descheduler as a CronJob rather than a long-running Deployment to minimize the window when it has active credentials
2. Using network policies to restrict what the Descheduler pod can access
3. Auditing all eviction events via Kubernetes audit logging
4. Using OPA/Gatekeeper policies to prevent the Descheduler service account from evicting pods in critical namespaces

```yaml
# OPA policy to prevent Descheduler from evicting pods in kube-system
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sNoEvictCritical
metadata:
  name: no-evict-critical-pods
spec:
  match:
    kinds:
    - apiGroups: [""]
      kinds: ["Pod"]
    namespaces:
    - "kube-system"
    - "cert-manager"
```

## Multi-Cluster Considerations

For organizations running multiple Kubernetes clusters, the Descheduler should be deployed consistently but may need different policies per cluster based on the cluster's purpose:

- **Production clusters**: Conservative policies, high PDB requirements, longer evaluation intervals
- **Staging clusters**: Moderate policies to simulate production rebalancing behavior
- **Development clusters**: Aggressive policies to keep costs low, less concern about disruption
- **Batch/analytics clusters**: `HighNodeUtilization` policy to consolidate workloads and minimize node count between job runs

Use a GitOps approach (Argo CD or Flux) to manage Descheduler ConfigMaps across clusters, with cluster-specific overlays via Kustomize:

```
descheduler/
  base/
    configmap.yaml      # Base policy shared across all clusters
    cronjob.yaml
    rbac.yaml
  overlays/
    production/
      kustomization.yaml
      patch-schedule.yaml    # More conservative schedule
      patch-thresholds.yaml  # Higher thresholds
    staging/
      kustomization.yaml
      patch-schedule.yaml    # More frequent runs
    batch/
      kustomization.yaml
      patch-policy.yaml     # HighNodeUtilization instead of LowNodeUtilization
```

## Conclusion (Extended)

Successful long-term operation of the Descheduler in production requires treating it as a living component of your cluster management strategy rather than a set-and-forget tool. Revisit your policy configuration quarterly as your workload mix changes, monitor eviction rates as leading indicators of cluster health issues, and ensure your on-call team understands that descheduler evictions are normal and expected behavior.

The investment in proper Descheduler configuration pays dividends in reduced cloud costs through better bin-packing, improved application reliability through proper topology spread, and reduced operational burden from manual node rebalancing during maintenance events.
