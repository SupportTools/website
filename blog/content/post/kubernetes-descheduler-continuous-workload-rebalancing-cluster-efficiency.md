---
title: "Kubernetes Descheduler: Continuous Workload Rebalancing for Cluster Efficiency"
date: 2030-11-30T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Descheduler", "Cluster Management", "Resource Optimization", "FinOps", "Scheduling", "Production"]
categories: ["Kubernetes", "Cluster Management"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to the Kubernetes Descheduler: built-in and custom eviction policies, CronJob vs Deployment operating modes, PodDisruptionBudget interaction, production tuning, and monitoring for continuous workload rebalancing."
more_link: "yes"
url: "/kubernetes-descheduler-continuous-workload-rebalancing-cluster-efficiency/"
---

The Kubernetes scheduler makes optimal placement decisions at pod creation time using the information available in that moment. It does not revisit those decisions. Over time, cluster conditions change: nodes are cordoned and uncordoned after maintenance, new nodes join the cluster, pod resource usage diverges from requests, and taint/toleration configurations evolve. The result is a progressively suboptimal distribution of workloads — hot spots on some nodes, underutilized capacity on others, and violations of placement constraints that didn't exist when the pods were first scheduled. The Descheduler continuously corrects these imbalances by evicting pods so the scheduler can place them better on the next scheduling cycle. This guide covers all built-in Descheduler policies, the two operating modes, PodDisruptionBudget interaction, production tuning, and comprehensive monitoring.

<!--more-->

# Kubernetes Descheduler: Continuous Workload Rebalancing for Cluster Efficiency

## The Scheduling Drift Problem

Consider a 10-node cluster running a stateless API deployment with 30 replicas. When initially deployed, the scheduler distributes them evenly at 3 pods per node. Over the next week:

- 2 nodes are cordoned for maintenance, forcing pods to reschedule onto the remaining 8 nodes
- The maintenance nodes are uncordoned and rejoin the cluster — but no pods move back
- 2 new nodes are added to handle increased load — they start empty
- The result: 8 nodes with 3–4 pods each, 2 new nodes with 0 pods

The scheduler will only place new pods on the empty nodes. Existing pods never move. The Descheduler fixes this by evicting some pods from the crowded nodes, allowing the scheduler to place them on the underutilized ones.

## Installing the Descheduler

The Descheduler is maintained by SIG-Scheduling and is not bundled with Kubernetes.

```bash
# Install via Helm (recommended for production)
helm repo add descheduler https://kubernetes-sigs.github.io/descheduler/
helm repo update

# Install with default configuration
helm install descheduler descheduler/descheduler \
  --namespace kube-system \
  --set schedule="*/5 * * * *"    # Run every 5 minutes as a CronJob

# Or deploy as a continuously running Deployment
helm install descheduler descheduler/descheduler \
  --namespace kube-system \
  --set kind=Deployment \
  --set deschedulingInterval=5m
```

## Two Operating Modes

### CronJob Mode (Periodic)

```yaml
# CronJob mode runs descheduling on a fixed schedule
apiVersion: batch/v1
kind: CronJob
metadata:
  name: descheduler
  namespace: kube-system
spec:
  schedule: "*/10 * * * *"   # Every 10 minutes
  concurrencyPolicy: Forbid  # Never run two descheduler instances simultaneously
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: descheduler
          restartPolicy: OnFailure
          priorityClassName: system-cluster-critical
          containers:
            - name: descheduler
              image: registry.k8s.io/descheduler/descheduler:v0.30.0
              command:
                - /bin/descheduler
                - --policy-config-file=/policy-dir/policy.yaml
                - --v=3
              volumeMounts:
                - mountPath: /policy-dir
                  name: policy-volume
          volumes:
            - name: policy-volume
              configMap:
                name: descheduler-policy
```

**Advantages of CronJob mode**:
- Simple to understand: runs once, evaluates all nodes, exits
- Predictable eviction bursts — you know when evictions happen
- Easy to disable temporarily (suspend the CronJob)

**Disadvantages**:
- Not reactive to sudden changes (a node draining won't be rebalanced until next scheduled run)
- Resources released by evictions pile up between runs

### Deployment Mode (Continuous)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: descheduler
  namespace: kube-system
spec:
  replicas: 1   # Must be single-replica — multiple deschedulers would conflict
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
          image: registry.k8s.io/descheduler/descheduler:v0.30.0
          command:
            - /bin/descheduler
            - --policy-config-file=/policy-dir/policy.yaml
            - --descheduling-interval=5m   # Evaluate every 5 minutes
            - --v=2
          resources:
            requests:
              cpu: 100m
              memory: 256Mi
            limits:
              cpu: 500m
              memory: 512Mi
          volumeMounts:
            - mountPath: /policy-dir
              name: policy-volume
      volumes:
        - name: policy-volume
          configMap:
            name: descheduler-policy
```

**Advantages of Deployment mode**:
- Reacts to cluster changes without waiting for the next cron trigger
- Better for dynamic clusters with frequent node additions/removals

**Disadvantages**:
- Harder to reason about when evictions will occur
- Requires careful policy tuning to prevent continuous low-level disruption

## Policy Configuration

The Descheduler is controlled by a policy YAML that lists which plugins to enable and their parameters.

```yaml
# descheduler-policy-configmap.yaml
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
              evictLocalStoragePods: false      # Don't evict pods using emptyDir
              evictSystemCriticalPods: false    # Don't evict system-critical pods
              ignorePvcPods: false              # Evict PVC pods if needed (careful!)
              evictFailedBarePods: true         # Evict failed pods without owner
              nodeFit: true                     # Only evict if better node exists

          # LowNodeUtilization parameters
          - name: "LowNodeUtilization"
            args:
              thresholds:
                cpu: 20      # Node under-utilized if CPU < 20%
                memory: 20   # Node under-utilized if memory < 20%
                pods: 20     # Node under-utilized if pod count < 20% of capacity
              targetThresholds:
                cpu: 50      # Don't target nodes above 50% CPU
                memory: 50   # Don't target nodes above 50% memory
                pods: 50     # Don't target nodes above 50% of pod capacity

          # RemoveDuplicates parameters
          - name: "RemoveDuplicates"
            args:
              excludeOwnerKinds:
                - "ReplicaSet"    # Still evict RS pods for rebalancing
              excludeNamespaces:
                - "kube-system"
                - "monitoring"

          # RemovePodsViolatingNodeTaints parameters
          - name: "RemovePodsViolatingNodeTaints"
            args:
              excludeNamespaces:
                - "kube-system"
              includedNamespaces: []  # Empty = all namespaces

        plugins:
          balance:
            enabled:
              - "LowNodeUtilization"
              - "RemoveDuplicates"
          deschedule:
            enabled:
              - "RemovePodsViolatingNodeTaints"
              - "RemovePodsViolatingNodeAffinity"
              - "RemovePodsViolatingTopologySpreadConstraint"
              - "RemovePodsHavingTooManyRestarts"
```

## Built-In Plugins

### LowNodeUtilization

**What it does**: Identifies under-utilized nodes (below `thresholds`) and over-utilized nodes (above `targetThresholds`). Evicts pods from over-utilized nodes so they reschedule onto under-utilized ones.

```yaml
- name: "LowNodeUtilization"
  args:
    thresholds:
      cpu: 20      # Nodes using < 20% CPU are "under-utilized"
      memory: 20   # Nodes using < 20% memory are "under-utilized"
      pods: 20     # Nodes with < 20% of capacity in pods are "under-utilized"
    targetThresholds:
      cpu: 50      # Evict pods from nodes using > 50% CPU
      memory: 50   # Evict pods from nodes using > 50% memory
      pods: 50     # Evict pods from nodes with > 50% of pod capacity used
    # Optional: use requested resources instead of actual usage
    useRequestedToCapacityRatioThresholds: false
    # Optional: weight each resource dimension differently
    numberOfNodes: 0   # 0 = only activate if at least one node is under-utilized
```

**When to use**: Large clusters with significant variance in pod density after node maintenance cycles.

**Caution**: `thresholds` and `targetThresholds` use request-based utilization by default. A node running pods that heavily over-consume their requests will appear "under-utilized" despite being hot. Use actual usage metrics if available.

### HighNodeUtilization

The inverse of LowNodeUtilization — designed for bin-packing scenarios (typically used with cluster autoscaler scale-down):

```yaml
- name: "HighNodeUtilization"
  args:
    thresholds:
      cpu: 20      # Nodes using < 20% CPU are candidates for consolidation
      memory: 20
```

`HighNodeUtilization` evicts pods from lightly-loaded nodes, concentrating workloads onto fewer nodes. The Cluster Autoscaler can then scale down the now-empty nodes.

### RemoveDuplicates

**What it does**: Ensures no two pods from the same ReplicaSet (or Deployment/StatefulSet) run on the same node, unless there are more replicas than nodes.

```yaml
- name: "RemoveDuplicates"
  args:
    excludeOwnerKinds:
      - "Job"          # Don't evict Job pods — they might be running one-off tasks
    excludeNamespaces:
      - "monitoring"   # Prometheus pods can co-locate
```

**When to use**: After node maintenance when many pods of the same workload accumulated on a single node while others were down.

### RemovePodsViolatingNodeTaints

**What it does**: Evicts pods that are running on nodes with taints they cannot tolerate. This happens when taints are added to nodes after pods were already scheduled there.

```yaml
- name: "RemovePodsViolatingNodeTaints"
  args:
    excludeTaints:
      - "node-role.kubernetes.io/control-plane"  # Don't evict control plane pods
    includedNamespaces: []   # Apply to all namespaces
    excludeNamespaces:
      - "kube-system"
```

**Common scenario**: An operator adds `dedicated=database:NoSchedule` to a set of nodes for database workloads. Pods that were already running there without the toleration need to be evicted.

### RemovePodsViolatingNodeAffinity

**What it does**: Evicts pods that are running on nodes that no longer satisfy their `requiredDuringSchedulingIgnoredDuringExecution` node affinity rules.

```yaml
- name: "RemovePodsViolatingNodeAffinity"
  args:
    nodeAffinityType:
      - "requiredDuringSchedulingIgnoredDuringExecution"
```

**Common scenario**: Pod has node affinity for `env=production` label. The node's label changes to `env=staging`. The pod continues running (the scheduler ignores this after scheduling) until the Descheduler evicts it.

### RemovePodsViolatingTopologySpreadConstraints

**What it does**: Evicts pods that cause topology spread constraint violations. This is especially important after node failures or replacements that changed the available topology.

```yaml
- name: "RemovePodsViolatingTopologySpreadConstraint"
  args:
    includeSoftConstraints: true   # Also enforce soft (WhenUnsatisfiable: ScheduleAnyway)
    namespaces:
      exclude: ["kube-system"]
```

**Common scenario**: A Deployment uses `topologySpreadConstraints` to distribute across 3 AZs. A node in AZ-A fails, causing multiple pods to reschedule into AZ-B. After AZ-A recovers, the Descheduler evicts excess pods from AZ-B to restore balance.

### RemovePodsHavingTooManyRestarts

**What it does**: Evicts pods that have exceeded a restart threshold. These pods are likely in a crash loop and may benefit from rescheduling to a different node.

```yaml
- name: "RemovePodsHavingTooManyRestarts"
  args:
    podRestartThreshold: 100       # Evict after 100 restarts
    includingInitContainers: true  # Count init container restarts too
```

**Caution**: This can create a feedback loop if the pod's crash is not node-specific. Set a high threshold and pair with PDB to avoid cascading evictions.

### PodLifeTime

**What it does**: Evicts pods older than a specified age. Useful for ensuring pods regularly pick up updated configuration or are redistributed as the cluster evolves.

```yaml
- name: "PodLifeTime"
  args:
    maxPodLifeTimeSeconds: 604800   # 7 days
    states:
      - "Pending"     # Evict pods stuck in Pending for 7+ days
      - "Running"     # Also evict long-running pods for redistribution
    namespaces:
      include:
        - "batch"     # Only apply to batch namespace
```

**When to use sparingly**: Aggressive PodLifeTime policies can cause unnecessary churn. Reserve for pods that legitimately need periodic redistribution (batch jobs, development namespaces).

## PodDisruptionBudget Interaction

The Descheduler's DefaultEvictor respects PodDisruptionBudgets. Before evicting any pod, the Descheduler checks whether the eviction would violate the workload's PDB. If it would, the pod is skipped.

```yaml
# Ensure all production deployments have PDBs
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-server-pdb
  namespace: production
spec:
  selector:
    matchLabels:
      app: api-server
  minAvailable: "66%"    # Keep at least 2/3 of pods running
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: cache-pdb
  namespace: production
spec:
  selector:
    matchLabels:
      app: redis-cache
  minAvailable: 2        # Always keep at least 2 Redis nodes up
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: worker-pdb
  namespace: production
spec:
  selector:
    matchLabels:
      app: background-worker
  maxUnavailable: 1      # Allow up to 1 worker to be evicted at a time
```

### PDB Deadlock Prevention

If all pods of a workload are on nodes the Descheduler wants to drain, and the PDB prevents any eviction, the Descheduler cannot make progress. This is not a bug — it is the correct behavior. The solution is to ensure PDB allows enough disruption for the Descheduler to function:

```bash
# Check if any PDBs are blocking evictions
kubectl get pdb -A -o wide
# NAME           MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS   AGE
# api-server-pdb  66%            N/A               2                     10d
# cache-pdb       2              N/A               0                     5d   ← 0 = blocked!

# Identify pods blocked from eviction
kubectl get pdb cache-pdb -n production -o yaml | grep -A5 status
# disruptionsAllowed: 0    ← Descheduler cannot evict any cache pods
```

## Production Policy Configuration

This is a production-ready policy that balances rebalancing aggressiveness with workload stability:

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

    # Global eviction limits to prevent cascading disruption
    maxNoOfPodsToEvictPerNode: 5        # Never evict more than 5 pods from one node per cycle
    maxNoOfPodsToEvictPerNamespace: 20  # Never evict more than 20 pods from one namespace per cycle
    maxNoOfPodsToEvictTotal: 50         # Hard cap: maximum 50 total evictions per descheduling cycle

    profiles:
      - name: production-rebalance
        pluginConfig:
          - name: "DefaultEvictor"
            args:
              evictLocalStoragePods: false     # Never evict pods with emptyDir volumes
              evictSystemCriticalPods: false   # Never touch system-critical pods
              ignorePvcPods: false             # Allow PVC pod eviction (scheduler handles rebinding)
              evictFailedBarePods: true        # Clean up failed pods without controllers
              nodeFit: true                    # Only evict if a suitable destination node exists

          - name: "LowNodeUtilization"
            args:
              thresholds:
                cpu: 15       # Under-utilized: < 15% CPU
                memory: 15    # Under-utilized: < 15% memory
                pods: 10      # Under-utilized: < 10% pod density
              targetThresholds:
                cpu: 60       # Over-utilized: > 60% CPU (evict from these nodes)
                memory: 60    # Over-utilized: > 60% memory
                pods: 60      # Over-utilized: > 60% pod density
              numberOfNodes: 1  # Only activate if at least 1 node is under-utilized

          - name: "RemoveDuplicates"
            args:
              excludeOwnerKinds:
                - "Job"
                - "DaemonSet"
              excludeNamespaces:
                - "kube-system"

          - name: "RemovePodsViolatingNodeTaints"
            args:
              excludeNamespaces:
                - "kube-system"

          - name: "RemovePodsViolatingNodeAffinity"
            args:
              nodeAffinityType:
                - "requiredDuringSchedulingIgnoredDuringExecution"

          - name: "RemovePodsViolatingTopologySpreadConstraint"
            args:
              includeSoftConstraints: false  # Only enforce hard constraints in production
              excludeNamespaces:
                - "kube-system"

          - name: "RemovePodsHavingTooManyRestarts"
            args:
              podRestartThreshold: 50
              includingInitContainers: false

        plugins:
          balance:
            enabled:
              - "LowNodeUtilization"
              - "RemoveDuplicates"
          deschedule:
            enabled:
              - "RemovePodsViolatingNodeTaints"
              - "RemovePodsViolatingNodeAffinity"
              - "RemovePodsViolatingTopologySpreadConstraint"
              - "RemovePodsHavingTooManyRestarts"
```

## RBAC Configuration

```yaml
# descheduler-rbac.yaml
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
    resources: ["pods"]
    verbs: ["get", "watch", "list", "delete"]
  - apiGroups: [""]
    resources: ["pods/eviction"]
    verbs: ["create"]
  - apiGroups: ["policy"]
    resources: ["poddisruptionbudgets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["replicasets", "replicationcontrollers", "deployments", "statefulsets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["namespaces"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["coordination.k8s.io"]
    resources: ["leases"]
    verbs: ["get", "list", "watch", "create", "update"]
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["create", "update", "patch"]
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

## Monitoring Descheduler Activity

The Descheduler exposes Prometheus metrics at `:10258/metrics` (default):

```yaml
# Helm value override to enable metrics
metrics:
  enabled: true
  port: 10258

# ServiceMonitor for Prometheus Operator
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: descheduler
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: descheduler
  namespaceSelector:
    matchNames:
      - kube-system
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
```

### Key Descheduler Metrics

```
# Total evictions by plugin
descheduler_pods_evicted_total{plugin="LowNodeUtilization"} 42
descheduler_pods_evicted_total{plugin="RemoveDuplicates"} 8
descheduler_pods_evicted_total{plugin="RemovePodsViolatingTopologySpreadConstraint"} 3

# Policy errors (e.g., PDB violations preventing eviction)
descheduler_evictions_total{result="skipped"} 15

# Descheduling loop duration
descheduler_descheduling_loop_duration_seconds_bucket{le="60"} 100
descheduler_descheduling_loop_duration_seconds_sum 3456
descheduler_descheduling_loop_duration_seconds_count 100
```

### Kubernetes Event Monitoring

The Descheduler creates Kubernetes events for every eviction. Monitor these for unexpected activity:

```bash
# Watch descheduler events in real time
kubectl get events -n kube-system \
  --field-selector reason=Evicted \
  --watch

# Count evictions per namespace in the last hour
kubectl get events -A \
  --field-selector reason=Evicted \
  -o json \
  | jq '.items[] | select(.eventTime > (now - 3600 | strftime("%Y-%m-%dT%H:%M:%SZ"))) | .involvedObject.namespace' \
  | sort | uniq -c | sort -rn
```

### Prometheus Alerting Rules

```yaml
# descheduler-prometheus-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: descheduler-rules
  namespace: monitoring
spec:
  groups:
    - name: descheduler
      rules:
        # Alert on high eviction rate — may indicate unstable configuration
        - alert: DeschedulerHighEvictionRate
          expr: |
            rate(descheduler_pods_evicted_total[5m]) * 300 > 20
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Descheduler is evicting pods at a high rate"
            description: "{{ $value }} evictions in the last 5 minutes by plugin {{ $labels.plugin }}"

        # Alert if descheduler has not run recently (CronJob mode)
        - alert: DeschedulerNotRunning
          expr: |
            time() - max(descheduler_descheduling_loop_duration_seconds_count) > 1800
          for: 0m
          labels:
            severity: warning
          annotations:
            summary: "Descheduler has not run in 30 minutes"

        # Alert if descheduling cycles are taking too long
        - alert: DeschedulerSlowCycle
          expr: |
            histogram_quantile(0.95,
              rate(descheduler_descheduling_loop_duration_seconds_bucket[30m])
            ) > 120
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "Descheduler cycles taking >2 minutes (p95)"
            description: "Large clusters or misconfigured policies may cause slow cycles"

        # Alert if descheduler is encountering errors
        - alert: DeschedulerErrors
          expr: |
            rate(descheduler_evictions_total{result="error"}[5m]) > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Descheduler is encountering eviction errors"
```

## Custom Eviction Policy Script

For teams that need finer control than the built-in policies allow, this Go program implements a custom eviction policy targeting pods with specific annotation patterns:

```go
// custom-descheduler/main.go
// Custom eviction tool: evicts pods older than a configurable age in specific namespaces,
// unless they have the annotation "descheduler.alpha.kubernetes.io/evict: never".
package main

import (
	"context"
	"fmt"
	"os"
	"time"

	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/apimachinery/pkg/util/wait"
)

const (
	evictNeverAnnotation = "descheduler.alpha.kubernetes.io/evict"
	defaultMaxAge        = 7 * 24 * time.Hour
)

type Config struct {
	Namespace  string
	MaxAge     time.Duration
	DryRun     bool
	LabelSelector string
}

func main() {
	cfg := Config{
		Namespace: os.Getenv("TARGET_NAMESPACE"),
		MaxAge:    defaultMaxAge,
		DryRun:    os.Getenv("DRY_RUN") == "true",
	}

	if cfg.Namespace == "" {
		fmt.Fprintln(os.Stderr, "TARGET_NAMESPACE environment variable required")
		os.Exit(1)
	}

	kubeconfig := os.Getenv("KUBECONFIG")
	if kubeconfig == "" {
		kubeconfig = os.Getenv("HOME") + "/.kube/config"
	}

	config, err := clientcmd.BuildConfigFromFlags("", kubeconfig)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error building kubeconfig: %v\n", err)
		os.Exit(1)
	}

	k8s, err := kubernetes.NewForConfig(config)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error creating client: %v\n", err)
		os.Exit(1)
	}

	if err := runEviction(context.Background(), k8s, cfg); err != nil {
		fmt.Fprintf(os.Stderr, "Eviction run failed: %v\n", err)
		os.Exit(1)
	}
}

func runEviction(ctx context.Context, k8s kubernetes.Interface, cfg Config) error {
	pods, err := k8s.CoreV1().Pods(cfg.Namespace).List(ctx, metav1.ListOptions{
		LabelSelector: cfg.LabelSelector,
	})
	if err != nil {
		return fmt.Errorf("listing pods: %w", err)
	}

	now := time.Now()
	var evicted, skipped, protected int

	for _, pod := range pods.Items {
		pod := pod // capture range variable

		// Skip pods protected by annotation
		if pod.Annotations[evictNeverAnnotation] == "never" {
			protected++
			continue
		}

		// Skip pods that are not Running
		if pod.Status.Phase != corev1.PodRunning {
			skipped++
			continue
		}

		// Skip pods without an owner (bare pods — don't evict, they won't reschedule)
		if len(pod.OwnerReferences) == 0 {
			skipped++
			continue
		}

		// Calculate pod age
		age := now.Sub(pod.CreationTimestamp.Time)
		if age < cfg.MaxAge {
			skipped++
			continue
		}

		// Attempt eviction
		if cfg.DryRun {
			fmt.Printf("[DRY RUN] Would evict pod %s/%s (age: %v)\n",
				pod.Namespace, pod.Name, age.Round(time.Minute))
			evicted++
			continue
		}

		err := evictPodWithRetry(ctx, k8s, &pod)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Failed to evict %s/%s: %v\n",
				pod.Namespace, pod.Name, err)
			continue
		}

		fmt.Printf("Evicted pod %s/%s (age: %v)\n",
			pod.Namespace, pod.Name, age.Round(time.Minute))
		evicted++

		// Rate limit evictions
		time.Sleep(2 * time.Second)
	}

	fmt.Printf("\nSummary: evicted=%d, skipped=%d, protected=%d\n",
		evicted, skipped, protected)
	return nil
}

func evictPodWithRetry(ctx context.Context, k8s kubernetes.Interface, pod *corev1.Pod) error {
	eviction := &policyv1.Eviction{
		ObjectMeta: metav1.ObjectMeta{
			Name:      pod.Name,
			Namespace: pod.Namespace,
		},
		DeleteOptions: &metav1.DeleteOptions{
			GracePeriodSeconds: func() *int64 {
				v := int64(30)
				return &v
			}(),
		},
	}

	// Retry up to 3 times with backoff for transient errors (PDB disruption budget temporarily full)
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			backoff := time.Duration(attempt*attempt) * 10 * time.Second
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(backoff):
			}
		}

		err := k8s.CoreV1().Pods(pod.Namespace).EvictV1(ctx, eviction)
		if err == nil {
			return nil
		}
		lastErr = err

		// Don't retry on permanent errors
		if isPermanentError(err) {
			return lastErr
		}
	}
	return lastErr
}

func isPermanentError(err error) bool {
	// 429 Too Many Requests = PDB violation = don't retry immediately
	// Other errors may be retried
	errStr := err.Error()
	return false == (errStr == "" || 
		contains(errStr, "429") || 
		contains(errStr, "TooManyRequests"))
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && containsString(s, substr))
}

func containsString(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

// Ensure wait package import is used
var _ = wait.PollUntilContextTimeout
```

## Node Utilization Reporting Tool

Before enabling the Descheduler's `LowNodeUtilization` plugin, use this tool to understand your cluster's current utilization distribution:

```bash
#!/usr/bin/env bash
# node-utilization-report.sh
# Reports CPU and memory utilization per node using kubectl top

set -euo pipefail

echo "=== Node Utilization Report ==="
echo ""
echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# Get node capacities
echo "--- Node Capacities ---"
kubectl get nodes -o custom-columns=\
"NAME:.metadata.name,CPU:.status.capacity.cpu,MEMORY:.status.capacity.memory,PODS:.status.capacity.pods" \
  --no-headers | column -t

echo ""
echo "--- Current Usage (kubectl top) ---"
kubectl top nodes --no-headers 2>/dev/null | \
  awk '
  BEGIN { print "NAME                     CPU(cores)    CPU%    MEMORY(bytes)   MEMORY%" }
  { print $1, $2, $3, $4, $5 }
  ' | column -t || echo "metrics-server not available"

echo ""
echo "--- Pods Per Node ---"
kubectl get pods -A --field-selector=status.phase=Running \
  -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}' \
  | sort | uniq -c | sort -rn | head -20 \
  | awk '{print $2, $1}' | column -t

echo ""
echo "=== End Report ==="
```

## Tuning for Large Clusters

For clusters with 100+ nodes, the Descheduler's default behavior needs adjustment to avoid excessive disruption:

```yaml
# Large cluster policy: conservative eviction limits
apiVersion: "descheduler/v1alpha2"
kind: "DeschedulerPolicy"

# Strict global limits for large clusters
maxNoOfPodsToEvictPerNode: 3          # At most 3 pods per node per cycle
maxNoOfPodsToEvictPerNamespace: 10    # At most 10 per namespace per cycle
maxNoOfPodsToEvictTotal: 30           # Hard cap at 30 total per cycle

profiles:
  - name: large-cluster
    pluginConfig:
      - name: "DefaultEvictor"
        args:
          nodeFit: true              # Critical for large clusters — never evict without a better target
          evictLocalStoragePods: false
          evictSystemCriticalPods: false

      - name: "LowNodeUtilization"
        args:
          thresholds:
            cpu: 10         # Only consider nodes under 10% utilized (very conservative)
            memory: 10
            pods: 10
          targetThresholds:
            cpu: 70         # Only evict from nodes above 70%
            memory: 70
            pods: 70
          numberOfNodes: 5  # Require at least 5 under-utilized nodes before activating

    plugins:
      balance:
        enabled:
          - "LowNodeUtilization"
      deschedule:
        enabled:
          - "RemovePodsViolatingNodeTaints"
          - "RemovePodsViolatingNodeAffinity"
```

## Descheduler with Cluster Autoscaler

The Descheduler and Cluster Autoscaler can work together:

1. **Scale-down preparation**: Use `HighNodeUtilization` to consolidate pods onto fewer nodes. The Cluster Autoscaler can then safely scale down empty nodes.

2. **Preventing eviction loops**: The Cluster Autoscaler adds nodes when pods are unschedulable. If the Descheduler immediately evicts pods from those new nodes back to the Autoscaler's threshold, an eviction loop occurs. Prevent this by setting Descheduler `thresholds` high enough that newly scaled-up nodes are not immediately considered "over-utilized".

3. **Coordination via annotations**: Annotate pods created by the Cluster Autoscaler's scale-up events with a no-evict annotation during the stabilization period.

```bash
# Temporarily disable descheduler during cluster scaling operations
kubectl annotate cronjob descheduler -n kube-system \
  cluster-autoscaler.kubernetes.io/safe-to-evict="false"

# Or suspend the CronJob
kubectl patch cronjob descheduler -n kube-system \
  -p '{"spec": {"suspend": true}}'

# Re-enable after scaling stabilizes
kubectl patch cronjob descheduler -n kube-system \
  -p '{"spec": {"suspend": false}}'
```

## Common Issues and Solutions

### Issue: Descheduler Evicts the Same Pods Repeatedly

**Symptom**: The same set of pods are evicted every time the Descheduler runs, then rescheduled to the same nodes, then evicted again.

**Root Cause**: The scheduler places pods back onto the nodes the Descheduler wants them off of, because no better alternative exists given current constraints (affinity, resource availability, etc.).

**Solution**:
1. Enable `nodeFit: true` in DefaultEvictor to prevent eviction when no better node exists
2. Verify target nodes have sufficient capacity to accept evicted pods
3. Check if pod affinity rules force placement back to the same nodes

### Issue: Descheduler Cannot Evict Any Pods (All Blocked by PDB)

**Symptom**: Descheduler logs show "pod X cannot be evicted" for every candidate pod.

**Root Cause**: PDBs have `disruptionsAllowed: 0` because the deployment is at minimum availability.

**Solution**:
1. Check `kubectl get pdb -A` for deployments with 0 allowed disruptions
2. Scale up the deployment before running the Descheduler
3. Relax PDB from `minAvailable: 100%` to `minAvailable: 90%`

### Issue: Descheduler Takes Too Long on Large Clusters

**Symptom**: Descheduling cycle takes 5+ minutes on a 200-node cluster.

**Root Cause**: Policy evaluation touches every pod on every node for each enabled plugin.

**Solution**:
1. Limit plugins to those actually needed — each additional plugin multiplies evaluation time
2. Use `includedNamespaces` to scope plugins to specific namespaces
3. Increase `deschedulingInterval` in Deployment mode to reduce frequency
4. Enable the `LowNodeUtilization` `numberOfNodes` threshold to skip activation when cluster is balanced

### Issue: Descheduler Evicting StatefulSet Pods

**Symptom**: StatefulSet pods are evicted by LowNodeUtilization, causing database restarts.

**Root Cause**: StatefulSet pods have no special protection by default.

**Solution**: Annotate StatefulSet pods to prevent eviction:

```yaml
# In StatefulSet pod template
metadata:
  annotations:
    descheduler.alpha.kubernetes.io/evict: "never"
```

Or configure the DefaultEvictor to ignore StatefulSets:

```yaml
- name: "DefaultEvictor"
  args:
    excludeOwnerKinds:
      - "StatefulSet"
```

## Summary

The Kubernetes Descheduler completes the scheduling feedback loop: where the scheduler optimizes placement at pod creation time, the Descheduler continuously corrects the drift that accumulates over a cluster's operational lifetime. The key operational principles:

1. Start with `Off`-mode observation using the Descheduler's `--dry-run` flag before enabling evictions.
2. Every workload that accepts evictions must have a PodDisruptionBudget — the Descheduler is the enforcer that will test your PDB configuration regularly.
3. Enable `nodeFit: true` in DefaultEvictor to prevent the eviction-then-reschedule-back loop.
4. Set conservative global limits (`maxNoOfPodsToEvictTotal`, `maxNoOfPodsToEvictPerNode`) and tighten only after observing stable behavior.
5. Monitor eviction rates with Prometheus — a suddenly high eviction rate indicates either a cluster configuration change or a misconfigured policy.
6. In clusters using Cluster Autoscaler, coordinate scale-up events with Descheduler pauses to prevent oscillation.
7. Use the `LowNodeUtilization` plugin's `numberOfNodes` threshold to disable rebalancing when the cluster is already well-balanced — there is no value in evictions when no nodes are significantly under-utilized.

With proper configuration and monitoring, the Descheduler can reduce cluster CPU waste by 15–25% in production environments that experience regular node maintenance cycles and workload evolution.
