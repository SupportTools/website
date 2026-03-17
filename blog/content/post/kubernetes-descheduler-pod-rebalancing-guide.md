---
title: "Kubernetes Descheduler: Automatic Pod Rebalancing and Eviction Policies"
date: 2028-10-26T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Scheduling", "Descheduler", "Resource Management", "Performance"]
categories:
- Kubernetes
- Resource Management
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Kubernetes Descheduler installation, eviction policies, tuning configuration, PodDisruptionBudget integration, HPA compatibility, and observability for automatic pod rebalancing."
more_link: "yes"
url: "/kubernetes-descheduler-pod-rebalancing-guide/"
---

The Kubernetes scheduler places pods optimally at creation time, but cluster conditions change. Nodes come and go, resource usage drifts, and affinity rules become violated as the cluster evolves. The Descheduler solves this by periodically evicting pods that violate policy, allowing the scheduler to place them on better nodes. This guide covers every built-in policy, safe configuration for production, integration with HPA and PodDisruptionBudgets, and metrics for understanding what the descheduler is doing.

<!--more-->

# Kubernetes Descheduler: Production Rebalancing Guide

## Why the Descheduler is Necessary

Consider these common scenarios where the scheduler's initial placement becomes suboptimal:

1. A node is drained for maintenance, pods are rescheduled to remaining nodes, and then the node returns to service with spare capacity — but the pods remain concentrated on the other nodes.
2. A new node with better hardware (more CPU/memory) is added, but existing pods don't migrate to it.
3. A node's utilization climbs over time and exceeds the `LowNodeUtilization` thresholds you've set.
4. An operator applies new pod affinity rules, but already-running pods don't move to satisfy the new rules.
5. Pods that have been crashing repeatedly continue to accumulate restarts on the same node.

The Descheduler runs as a CronJob (or continuously in `WatcherMode`) and evicts pods in these situations, letting the scheduler re-place them correctly.

## Installation via Helm

```bash
helm repo add descheduler https://kubernetes-sigs.github.io/descheduler/
helm repo update

helm install descheduler descheduler/descheduler \
  --namespace kube-system \
  --set schedule="*/5 * * * *" \
  --set deschedulingInterval=5m \
  --version 0.30.1
```

Verify:

```bash
kubectl -n kube-system get cronjobs
# NAME           SCHEDULE       SUSPEND   ACTIVE   LAST SCHEDULE
# descheduler    */5 * * * *    False     0        2m

kubectl -n kube-system get pods -l app.kubernetes.io/name=descheduler
```

## Descheduler Configuration Deep Dive

The full configuration is supplied as a ConfigMap. All policies are opt-in — only those listed in the ConfigMap are active.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: descheduler-policy-configmap
  namespace: kube-system
data:
  policy.yaml: |
    apiVersion: "descheduler/v1alpha2"
    kind: "DeschedulerPolicy"
    profiles:
    - name: default
      pluginConfig:
      - name: DefaultEvictor
        args:
          # Respect PodDisruptionBudgets — never evict if it would break the PDB
          evictFailedBarePods: false
          evictLocalStoragePods: false
          evictSystemCriticalPods: false
          ignorePvcPods: true
          # Only evict pods from nodes above this utilization threshold
          nodeFit: true
          # Do not evict pods in these namespaces
          namespaces:
            exclude:
            - kube-system
            - monitoring
            - cert-manager
      plugins:
        balance:
          enabled:
          - RemoveDuplicates
          - LowNodeUtilization
          - HighNodeUtilization
        deschedule:
          enabled:
          - RemovePodsViolatingNodeAffinity
          - RemovePodsViolatingNodeTaints
          - RemovePodsViolatingInterPodAntiAffinity
          - RemovePodsHavingTooManyRestarts
        filter:
          enabled:
          - DefaultEvictor

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
          useDeviationThresholds: false
          evictableNamespaces:
            exclude:
            - kube-system

      - name: HighNodeUtilization
        args:
          thresholds:
            cpu: 80
            memory: 80
          evictableNamespaces:
            exclude:
            - kube-system

      - name: RemoveDuplicates
        args:
          excludeOwnerKinds:
          - "DaemonSet"
          - "StatefulSet"

      - name: RemovePodsViolatingNodeAffinity
        args:
          nodeAffinityType:
          - "requiredDuringSchedulingIgnoredDuringExecution"
          - "preferredDuringSchedulingIgnoredDuringExecution"
          evictableNamespaces:
            exclude:
            - kube-system

      - name: RemovePodsViolatingNodeTaints
        args:
          excludedTaints:
          - "node.kubernetes.io/unschedulable"
          evictableNamespaces:
            exclude:
            - kube-system

      - name: RemovePodsViolatingInterPodAntiAffinity

      - name: RemovePodsHavingTooManyRestarts
        args:
          podRestartThreshold: 100
          includingInitContainers: true

      - name: PodLifeTime
        args:
          maxPodLifeTimeSeconds: 604800  # 7 days
          states:
          - "Pending"
          - "PodInitializing"
          - "ContainerCreating"
          evictableNamespaces:
            exclude:
            - kube-system
            - production
```

## Policy Details

### LowNodeUtilization

This is the most commonly used policy. It identifies underutilized nodes and evicts pods from overutilized nodes so they can be rescheduled onto the less-loaded nodes.

```yaml
- name: LowNodeUtilization
  args:
    # Nodes below ALL these thresholds are considered "underutilized"
    thresholds:
      cpu: 20     # 20% CPU utilization
      memory: 20  # 20% memory utilization
      pods: 20    # 20% of node pod capacity

    # Pods are evicted from nodes above ANY of these thresholds
    targetThresholds:
      cpu: 50
      memory: 50
      pods: 50

    # useDeviationThresholds: thresholds are relative to mean utilization
    # rather than absolute percentages
    useDeviationThresholds: false

    # numberOfNodes: only act if at least this many nodes are underutilized
    numberOfNodes: 1
```

**Important**: The descheduler will only evict pods from "overutilized" nodes if there are underutilized nodes available to receive them. If the cluster is uniformly loaded, no evictions occur.

### HighNodeUtilization

The inverse of `LowNodeUtilization`. Used with cluster autoscaler to consolidate workloads onto fewer nodes, allowing others to be scaled down.

```yaml
- name: HighNodeUtilization
  args:
    # Evict pods from nodes BELOW these thresholds to consolidate workloads
    thresholds:
      cpu: 20
      memory: 20
```

Combined with cluster autoscaler, this policy enables bin-packing: pods are evicted from lightly-used nodes, those nodes become empty, and the cluster autoscaler removes them.

### RemoveDuplicates

If a Deployment, ReplicaSet, or Job has multiple pods scheduled on the same node (which can happen after mass rescheduling events), `RemoveDuplicates` evicts the extras to ensure spread.

```yaml
- name: RemoveDuplicates
  args:
    excludeOwnerKinds:
    - "DaemonSet"  # DaemonSets intentionally run one pod per node
    - "StatefulSet" # StatefulSets may legitimately co-locate
    evictableNamespaces:
      include:
      - production
      - staging
```

### RemovePodsViolatingNodeAffinity

If node labels change after pod scheduling (a common occurrence with node pool upgrades), pods may be running on nodes they shouldn't be. This policy evicts them.

```yaml
- name: RemovePodsViolatingNodeAffinity
  args:
    nodeAffinityType:
    # Evict pods violating "required" affinity rules
    - "requiredDuringSchedulingIgnoredDuringExecution"
    # Also evict pods violating "preferred" affinity rules
    - "preferredDuringSchedulingIgnoredDuringExecution"
```

### RemovePodsHavingTooManyRestarts

Pods stuck in a restart loop degrade node health and consume resources. This policy evicts high-restart pods, allowing them to reschedule (potentially to a different node with a fresh environment).

```yaml
- name: RemovePodsHavingTooManyRestarts
  args:
    podRestartThreshold: 100
    includingInitContainers: true
```

### PodLifeTime

Evict pods that have been in a non-running state for too long, which typically indicates a stuck or misconfigured workload.

```yaml
- name: PodLifeTime
  args:
    maxPodLifeTimeSeconds: 86400  # 24 hours
    # Only evict pods in these states
    states:
    - "Pending"
    - "PodInitializing"
    - "ContainerCreating"
    labelSelector:
      matchLabels:
        descheduler/evict-on-timeout: "true"
```

## Protecting Stateful Workloads with PodDisruptionBudgets

PodDisruptionBudgets (PDBs) are the critical safety mechanism for the descheduler. Without them, the descheduler can evict too many replicas simultaneously, causing service downtime.

```yaml
# Protect stateless deployments — always keep at least 2 pods running
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-server-pdb
  namespace: production
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: api-server
---
# Alternative: use percentage-based PDB
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: worker-pdb
  namespace: production
spec:
  maxUnavailable: 10%
  selector:
    matchLabels:
      app: worker
---
# Single-replica services: protect completely from descheduler eviction
# by setting maxUnavailable: 0 (this prevents all voluntary disruptions)
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: singleton-service-pdb
  namespace: production
spec:
  maxUnavailable: 0
  selector:
    matchLabels:
      app: singleton-service
```

The DefaultEvictor plugin respects PDBs automatically. If evicting a pod would violate its PDB, the descheduler skips it and logs the reason.

### Opt specific pods out of descheduling

```yaml
# Annotate a pod to prevent descheduler eviction
apiVersion: v1
kind: Pod
metadata:
  name: critical-stateful-pod
  namespace: production
  annotations:
    descheduler.alpha.kubernetes.io/evict: "false"
spec:
  containers:
  - name: app
    image: myapp:latest
```

You can also annotate at the namespace level to exclude entire namespaces:

```bash
kubectl annotate namespace production \
  descheduler.alpha.kubernetes.io/evict=false
```

## CronJob Configuration

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: descheduler
  namespace: kube-system
spec:
  schedule: "*/15 * * * *"  # Every 15 minutes
  concurrencyPolicy: Forbid   # Never run concurrent descheduler instances
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: descheduler
          priorityClassName: system-cluster-critical
          restartPolicy: Never
          containers:
          - name: descheduler
            image: registry.k8s.io/descheduler/descheduler:v0.30.1
            imagePullPolicy: IfNotPresent
            command:
            - /bin/descheduler
            - --policy-config-file=/policy-dir/policy.yaml
            - --v=3
            - --dry-run=false
            ports:
            - containerPort: 10258
              name: metrics
              protocol: TCP
            livenessProbe:
              failureThreshold: 3
              httpGet:
                path: /healthz
                port: 10258
                scheme: HTTPS
            resources:
              requests:
                cpu: 500m
                memory: 256Mi
              limits:
                cpu: 1000m
                memory: 512Mi
            volumeMounts:
            - mountPath: /policy-dir
              name: policy-volume
          volumes:
          - name: policy-volume
            configMap:
              name: descheduler-policy-configmap
```

## Integration with HPA

The descheduler can interfere with HPA if not configured carefully. When the descheduler evicts pods and they are rescheduling, HPA may briefly see fewer ready pods and scale up. Configure the interplay:

```yaml
# Ensure HPA doesn't scale down too aggressively during descheduling
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-server-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  minReplicas: 3
  maxReplicas: 20
  behavior:
    scaleDown:
      # Wait 5 minutes after a scale down before allowing another
      stabilizationWindowSeconds: 300
      policies:
      - type: Pods
        value: 1
        periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 30
      policies:
      - type: Pods
        value: 2
        periodSeconds: 60
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 60
```

Set the descheduler's `LowNodeUtilization` target thresholds to be consistent with HPA scaling thresholds. If HPA scales based on 60% CPU, the descheduler's targetThreshold should be around 60-70% to avoid a conflict where the descheduler evicts pods HPA just scheduled.

## Dry Run Mode for Safe Testing

Always test new descheduler policies in dry-run mode before enabling evictions:

```bash
# Run descheduler once in dry-run mode
kubectl run descheduler-dryrun \
  --restart=Never \
  --image=registry.k8s.io/descheduler/descheduler:v0.30.1 \
  -n kube-system \
  -- /bin/descheduler \
    --policy-config-file=/etc/descheduler/policy.yaml \
    --dry-run=true \
    --v=4

# Check what would be evicted
kubectl logs descheduler-dryrun -n kube-system | grep "evicting pod"
```

## Observability

The descheduler exposes Prometheus metrics on port 10258.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: descheduler
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: descheduler
  endpoints:
  - port: metrics
    scheme: https
    tlsConfig:
      insecureSkipVerify: true
    interval: 30s
```

Key metrics:

```
# Number of pods evicted by policy
descheduler_pods_evicted{namespace="production", strategy="LowNodeUtilization"} 12

# Eviction errors
descheduler_pod_evictions_total{result="error"} 0

# Number of times the descheduler ran
descheduler_build_info
```

### Grafana dashboard queries

```
# Eviction rate per strategy over last hour
sum by (strategy) (increase(descheduler_pods_evicted[1h]))

# Total pods evicted today
sum(increase(descheduler_pods_evicted[24h]))

# Namespaces most affected by evictions
topk(10, sum by (namespace) (increase(descheduler_pods_evicted[1h])))
```

### Alert rules

```yaml
groups:
- name: descheduler
  rules:
  - alert: DeschedulerHighEvictionRate
    expr: sum(rate(descheduler_pods_evicted[5m])) > 10
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Descheduler is evicting pods at a high rate ({{ $value }}/sec)"
      description: "High eviction rate may indicate misconfigured policy or a cluster imbalance that cannot be resolved."

  - alert: DeschedulerEvictionErrors
    expr: sum(increase(descheduler_pod_evictions_total{result="error"}[5m])) > 0
    for: 1m
    labels:
      severity: warning
    annotations:
      summary: "Descheduler is failing to evict pods"
```

## Correlating Descheduler Actions with Application Impact

When pods are evicted, there will be brief disruptions. Correlate with application metrics:

```bash
# Find pods that were recently evicted by the descheduler
kubectl get events \
  --all-namespaces \
  --field-selector reason=Evicted \
  --sort-by='.metadata.creationTimestamp' \
  | grep -i descheduler

# View descheduler log output for a specific run
kubectl logs -n kube-system \
  -l app.kubernetes.io/name=descheduler \
  --since=30m \
  | grep -E "(evict|error|skip)"

# Check if PDBs are blocking evictions
kubectl get events \
  --all-namespaces \
  --field-selector reason=NotTriggerScaleUp \
  | grep pdb
```

## Namespace-Level Tuning

Apply different eviction policies to different namespaces using multiple profiles:

```yaml
apiVersion: "descheduler/v1alpha2"
kind: "DeschedulerPolicy"
profiles:
# Aggressive rebalancing for stateless services
- name: stateless
  pluginConfig:
  - name: DefaultEvictor
    args:
      evictableNamespaces:
        include:
        - production
        - staging
  - name: LowNodeUtilization
    args:
      thresholds:
        cpu: 30
        memory: 30
      targetThresholds:
        cpu: 60
        memory: 60
  plugins:
    balance:
      enabled:
      - LowNodeUtilization
      - RemoveDuplicates
    deschedule:
      enabled:
      - RemovePodsViolatingNodeAffinity
    filter:
      enabled:
      - DefaultEvictor

# Conservative policy for data processing jobs
- name: conservative
  pluginConfig:
  - name: DefaultEvictor
    args:
      evictableNamespaces:
        include:
        - data-processing
      ignorePvcPods: true
  - name: RemovePodsHavingTooManyRestarts
    args:
      podRestartThreshold: 50
  plugins:
    deschedule:
      enabled:
      - RemovePodsHavingTooManyRestarts
    filter:
      enabled:
      - DefaultEvictor
```

## Summary

The Kubernetes Descheduler completes the scheduling lifecycle by handling the scenarios the initial scheduler can never address:

- Use `LowNodeUtilization` to rebalance workloads after node additions or maintenance events.
- Use `HighNodeUtilization` with cluster autoscaler to consolidate workloads and enable node scale-down.
- Use `RemoveDuplicates` to ensure Deployment replicas are spread across nodes.
- Use `RemovePodsViolatingNodeAffinity` to enforce new affinity rules on already-running pods.
- Always configure PodDisruptionBudgets before enabling the descheduler in production — they are the primary safety mechanism.
- Test with `--dry-run=true` and review eviction logs before enabling automatic evictions.
- Schedule conservatively — every 15-30 minutes is sufficient for most clusters; more frequent runs increase risk.
