---
title: "Descheduler: Automatic Pod Rebalancing for Kubernetes Clusters"
date: 2027-03-04T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Descheduler", "Pod Scheduling", "Optimization", "Cluster Management"]
categories: ["Kubernetes", "Operations", "Optimization"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to deploying and tuning the Kubernetes Descheduler for automatic pod rebalancing, including all eviction strategies, PodDisruptionBudget respect, Prometheus monitoring, and production anti-flapping configuration."
more_link: "yes"
url: "/descheduler-kubernetes-pod-rebalancing-optimization-guide/"
---

The Kubernetes scheduler makes placement decisions at pod creation time, using the cluster state that exists at that moment. When nodes are added, removed, or their capacity changes, pods already running may be sub-optimally placed — clustered on a small number of nodes, violating affinity rules set after initial scheduling, or sitting on nodes with stale taints. The **Descheduler** addresses this by periodically evaluating running pods against the current cluster state and evicting those that no longer satisfy scheduling constraints or that would benefit from being rescheduled elsewhere.

This guide covers every eviction strategy, the `DeschedulerPolicy` CRD, deployment modes, eviction rate limiting, PodDisruptionBudget integration, Prometheus monitoring, and production anti-flapping practices.

<!--more-->

## How Descheduler Works

Descheduler does not schedule pods — it only evicts them. The default scheduler then reschedules each evicted pod according to current node capacity and constraints. The cycle is:

1. Descheduler evaluates all pods against configured strategies
2. For each eligible pod, it checks PodDisruptionBudgets and eviction rate limits
3. Descheduler calls the Eviction API — the pod is terminated gracefully
4. The scheduler places the evicted pod on a more suitable node

Pods protected by PodDisruptionBudgets are never evicted if doing so would violate the budget. DaemonSet pods, static pods, mirror pods, and pods with `ownerRef` pointing to a Job that has already completed are never evicted.

## Deployment Modes

### CronJob Mode (Recommended for Production)

Running Descheduler as a CronJob gives predictable windows for eviction, making it easier to reason about when disruptions will occur.

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: descheduler
  namespace: kube-system
spec:
  schedule: "*/20 * * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        metadata:
          labels:
            app: descheduler
        spec:
          priorityClassName: system-cluster-critical
          serviceAccountName: descheduler
          restartPolicy: Never
          containers:
            - name: descheduler
              image: registry.k8s.io/descheduler/descheduler:v0.30.1
              imagePullPolicy: IfNotPresent
              command:
                - /bin/descheduler
              args:
                - --policy-config-file=/policy-dir/policy.yaml
                - --v=3
                - --descheduling-interval=0
              ports:
                - containerPort: 10258
                  protocol: TCP
              livenessProbe:
                failureThreshold: 3
                httpGet:
                  path: /healthz
                  port: 10258
                  scheme: HTTPS
                initialDelaySeconds: 3
                periodSeconds: 10
              resources:
                requests:
                  cpu: 100m
                  memory: 128Mi
                limits:
                  cpu: 500m
                  memory: 256Mi
              securityContext:
                allowPrivilegeEscalation: false
                capabilities:
                  drop:
                    - ALL
                readOnlyRootFilesystem: true
                runAsNonRoot: true
              volumeMounts:
                - mountPath: /policy-dir
                  name: policy-volume
          volumes:
            - name: policy-volume
              configMap:
                name: descheduler-policy-configmap
```

### Deployment Mode (Continuous)

Deployment mode runs Descheduler as a long-lived process on a configurable interval. This is appropriate when the cluster changes frequently (spot node replacement, rapid scale events) and periodic eviction is insufficient.

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
      priorityClassName: system-cluster-critical
      serviceAccountName: descheduler
      containers:
        - name: descheduler
          image: registry.k8s.io/descheduler/descheduler:v0.30.1
          command:
            - /bin/descheduler
          args:
            - --policy-config-file=/policy-dir/policy.yaml
            - --descheduling-interval=5m
            - --v=3
            - --metrics-bind-address=:10258
          ports:
            - containerPort: 10258
              protocol: TCP
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 256Mi
          volumeMounts:
            - mountPath: /policy-dir
              name: policy-volume
      volumes:
        - name: policy-volume
          configMap:
            name: descheduler-policy-configmap
```

## RBAC

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
  - apiGroups: ["policy"]
    resources: ["poddisruptionbudgets"]
    verbs: ["get", "watch", "list"]
  - apiGroups: ["apps"]
    resources: ["replicasets", "statefulsets", "daemonsets", "deployments"]
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

## DeschedulerPolicy Configuration

The `DeschedulerPolicy` is a YAML document mounted as a ConfigMap. Each strategy can be individually enabled, tuned, and filtered.

### Complete Production Policy

```yaml
# descheduler-policy.yaml
apiVersion: descheduler/v1alpha2
kind: DeschedulerPolicy
profiles:
  - name: production-rebalancing
    pluginConfig:
      # ---- RemoveDuplicates ----
      - name: RemoveDuplicates
        args:
          # Namespaces containing critical single-replica workloads to protect
          namespaces:
            exclude:
              - kube-system
              - monitoring
              - cert-manager

      # ---- LowNodeUtilization ----
      - name: LowNodeUtilization
        args:
          thresholds:
            cpu: 20
            memory: 20
            pods: 10
          targetThresholds:
            cpu: 50
            memory: 50
            pods: 40
          # useDeviationThresholds: when true, thresholds are relative to average utilization
          useDeviationThresholds: false
          evictableNamespaces:
            exclude:
              - kube-system
              - monitoring

      # ---- HighNodeUtilization (for bin-packing to reduce node count) ----
      - name: HighNodeUtilization
        args:
          thresholds:
            cpu: 40
            memory: 40
            pods: 20

      # ---- RemovePodsViolatingInterPodAntiAffinity ----
      - name: RemovePodsViolatingInterPodAntiAffinity
        args:
          namespaces:
            exclude:
              - kube-system

      # ---- RemovePodsViolatingNodeAffinity ----
      - name: RemovePodsViolatingNodeAffinity
        args:
          nodeAffinityType:
            - requiredDuringSchedulingIgnoredDuringExecution
          namespaces:
            exclude:
              - kube-system

      # ---- RemovePodsViolatingNodeTaints ----
      - name: RemovePodsViolatingNodeTaints
        args:
          # Also evict pods that tolerate taints that no longer exist on any node
          includePreferNoSchedule: true
          namespaces:
            exclude:
              - kube-system

      # ---- RemovePodsViolatingTopologySpreadConstraint ----
      - name: RemovePodsViolatingTopologySpreadConstraint
        args:
          constraints:
            - DoNotSchedule
            - ScheduleAnyway
          namespaces:
            exclude:
              - kube-system

      # ---- RemoveFailedPods ----
      - name: RemoveFailedPods
        args:
          reasons:
            - OutOfcpu
            - OutOfmemory
            - Error
            - OOMKilled
            - Evicted
          includingInitContainers: true
          excludeOwnerKinds:
            - Job
          minPodLifetimeSeconds: 3600

      # ---- RemovePodsHavingTooManyRestarts ----
      - name: RemovePodsHavingTooManyRestarts
        args:
          podRestartThreshold: 100
          includingInitContainers: true
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
          - RemoveFailedPods
          - RemovePodsHavingTooManyRestarts
```

## Strategy Deep Dives

### RemoveDuplicates

**RemoveDuplicates** evicts pods so that no two pods from the same ReplicaSet, ReplicationController, StatefulSet, or Job run on the same node — provided the cluster has enough nodes to spread them. This is especially relevant after a cluster scale-up when the scheduler placed all replicas on existing nodes before new ones became available.

The strategy respects pod topology spread constraints but does not attempt to achieve full balance — it only evicts duplicates beyond the first pod per owner per node.

### LowNodeUtilization

**LowNodeUtilization** identifies nodes below `thresholds` utilization (by CPU, memory, and/or pod count) and evicts pods from nodes above `targetThresholds` to redistribute load. The thresholds are expressed as percentages of allocatable capacity.

Key tuning considerations:

- Setting `thresholds` and `targetThresholds` too close causes flapping — a node oscillates between underutilized and overutilized as pods are moved
- `useDeviationThresholds: true` calculates thresholds relative to the cluster average, which is more stable on heterogeneous node types
- The strategy only evicts pods from *high-utilization nodes*; it does not force pods onto specific low-utilization nodes

### HighNodeUtilization

**HighNodeUtilization** is the complement of `LowNodeUtilization` for bin-packing scenarios. It evicts pods from nodes that have *low* utilization (below `thresholds`) to concentrate workload and allow Cluster Autoscaler to drain and remove underutilized nodes. This strategy is mutually exclusive with `LowNodeUtilization` in the same profile.

### RemovePodsViolatingInterPodAntiAffinity

After pods are scheduled, their affinity requirements are satisfied at placement time but not re-evaluated during the pod's lifetime. If new pods are deployed that create anti-affinity violations with existing pods, this strategy detects and evicts the offending older pods so they are rescheduled to compliant nodes.

### RemovePodsViolatingNodeAffinity

When node labels change (for example, a node is re-classified from `zone=us-east-1a` to `zone=us-east-1b`), existing pods with `requiredDuringSchedulingIgnoredDuringExecution` node affinity rules may no longer match their current node. This strategy evicts those pods.

Only `requiredDuringSchedulingIgnoredDuringExecution` is actionable — preferred rules are not enforced by eviction.

### RemovePodsViolatingNodeTaints

When node taints are added after pods are scheduled, existing pods that do not tolerate the new taint continue running (because taints use `IgnoredDuringExecution` semantics by default). This strategy evicts those pods, enforcing taint compliance retroactively.

### RemovePodsViolatingTopologySpreadConstraint

**TopologySpreadConstraints** with `whenUnsatisfiable: DoNotSchedule` are only enforced at scheduling time. When node availability changes (scale-up or node failure), spread may become unbalanced. This strategy detects and evicts pods that violate spread constraints so they are redistributed.

Including `ScheduleAnyway` constraints also allows softer rebalancing — pods placed on sub-optimal nodes due to temporary pressure can be moved once better nodes are available.

### RemoveFailedPods

Pods in a terminal failed state (OOMKilled, Error) that are owned by a Deployment or ReplicaSet are normally replaced by the controller. However, pods with `restartPolicy: Never` owned by a Job can sit in Failed state indefinitely. This strategy cleans them up, with configurable minimum lifetime to avoid prematurely removing recently failed pods that are still being investigated.

### RemovePodsHavingTooManyRestarts

Pods with crash loops consume node resources (CPU for restart overhead, memory for leaked resources) without providing value. This strategy evicts pods exceeding a restart threshold, allowing them to be rescheduled and potentially landing on a healthier node if the restarts are caused by a node-specific issue.

## Eviction Rate Limiting and PDB Respect

### Global Eviction Rate Limiting

```yaml
apiVersion: descheduler/v1alpha2
kind: DeschedulerPolicy
profiles:
  - name: production-rebalancing
    pluginConfig:
      - name: DefaultEvictor
        args:
          # Never evict more than 10 pods per cycle across all strategies
          maxPodLifeTimeSeconds: 86400
          evictLocalStoragePods: false
          evictSystemCriticalPods: false
          nodeFit: true
          minReplicas: 2
          # PDB: always respected by default
          ignorePodDisruptionBudget: false
    plugins:
      balance:
        enabled:
          - RemoveDuplicates
          - LowNodeUtilization
      deschedule:
        enabled:
          - RemovePodsViolatingNodeAffinity
          - RemovePodsViolatingNodeTaints
```

The `DefaultEvictor` plugin wraps all evictions. Critical flags:

- `evictLocalStoragePods: false` — prevents eviction of pods with `emptyDir` or `hostPath` volumes (avoids evicting logging agents)
- `nodeFit: true` — only evicts a pod if there is at least one other node that could accept it
- `minReplicas: 2` — never evicts a pod if its owning controller has fewer than 2 replicas (protects single-replica deployments)
- `ignorePodDisruptionBudget: false` — the default; PDBs are always respected

### Namespace and Priority Class Filters

```yaml
- name: RemovePodsHavingTooManyRestarts
  args:
    podRestartThreshold: 50
    namespaces:
      include:
        - production
        - staging
    priorityThreshold:
      # Only evict pods with priority below system-cluster-critical (2000000000)
      value: 1000000000
```

Using `priorityThreshold` protects system-critical pods from eviction regardless of restart count. Setting `namespaces.include` restricts the strategy to production and staging, leaving development namespaces unaffected.

## Helm Deployment

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
schedule: "*/15 * * * *"
suspend: false

image:
  repository: registry.k8s.io/descheduler/descheduler
  tag: v0.30.1
  pullPolicy: IfNotPresent

priorityClassName: system-cluster-critical

resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 256Mi

deschedulerPolicy:
  profiles:
    - name: production
      pluginConfig:
        - name: DefaultEvictor
          args:
            nodeFit: true
            minReplicas: 2
            evictLocalStoragePods: false
            evictSystemCriticalPods: false
            ignorePodDisruptionBudget: false
        - name: RemoveDuplicates
          args:
            namespaces:
              exclude:
                - kube-system
        - name: LowNodeUtilization
          args:
            thresholds:
              cpu: 20
              memory: 20
              pods: 10
            targetThresholds:
              cpu: 50
              memory: 50
              pods: 40
        - name: RemovePodsViolatingNodeAffinity
          args:
            nodeAffinityType:
              - requiredDuringSchedulingIgnoredDuringExecution
        - name: RemovePodsViolatingTopologySpreadConstraint
          args:
            constraints:
              - DoNotSchedule
        - name: RemovePodsHavingTooManyRestarts
          args:
            podRestartThreshold: 100
            includingInitContainers: true
      plugins:
        balance:
          enabled:
            - RemoveDuplicates
            - LowNodeUtilization
            - RemovePodsViolatingTopologySpreadConstraint
        deschedule:
          enabled:
            - RemovePodsViolatingNodeAffinity
            - RemovePodsHavingTooManyRestarts

serviceAccount:
  create: true

rbac:
  create: true

podAnnotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "10258"
  prometheus.io/path: "/metrics"

leaderElection:
  enabled: false
```

## Monitoring Evictions with Prometheus

Descheduler exposes metrics on port `10258` at `/metrics`.

### ServiceMonitor

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: descheduler
  namespace: monitoring
  labels:
    release: prometheus
spec:
  namespaceSelector:
    matchNames:
      - kube-system
  selector:
    matchLabels:
      app.kubernetes.io/name: descheduler
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
      scheme: https
      tlsConfig:
        insecureSkipVerify: true
```

### Key Metrics

```promql
# Total pod evictions per strategy over the last hour
increase(descheduler_pods_evicted_total[1h]) by (strategy, namespace)

# Eviction rate (evictions per minute)
rate(descheduler_pods_evicted_total[5m]) * 60

# Strategy execution duration (p95)
histogram_quantile(0.95,
  rate(descheduler_strategy_duration_seconds_bucket[10m])
) by (strategy)

# Nodes considered unfit for receiving evicted pods
descheduler_nodes_not_fit_for_evicted_pod_total
```

### Alerting Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: descheduler-alerts
  namespace: monitoring
  labels:
    release: prometheus
spec:
  groups:
    - name: descheduler
      interval: 60s
      rules:
        - alert: DeschedulerHighEvictionRate
          expr: |
            rate(descheduler_pods_evicted_total[10m]) > 0.5
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Descheduler eviction rate is high"
            description: "Descheduler is evicting {{ $value | humanize }} pods/sec. Check for scheduling instability."

        - alert: DeschedulerNoSuitableNodes
          expr: |
            increase(descheduler_nodes_not_fit_for_evicted_pod_total[30m]) > 10
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "Descheduler cannot find suitable replacement nodes"
            description: "{{ $value }} pods could not be placed on a better node after eviction. Check cluster capacity."

        - alert: DeschedulerStrategyErrors
          expr: |
            increase(descheduler_strategy_errors_total[15m]) > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Descheduler strategy {{ $labels.strategy }} encountered errors"
            description: "{{ $value }} errors in strategy {{ $labels.strategy }} in the last 15 minutes."
```

## Anti-Flapping Production Recommendations

### Problem: Eviction Cycles

If `LowNodeUtilization` thresholds are not spaced far enough apart, pods are evicted from high-utilization nodes and land on low-utilization nodes, which then become high-utilization nodes, which triggers further evictions in the next cycle.

**Solution**: Maintain a gap of at least 30 percentage points between `thresholds` and `targetThresholds`.

```yaml
# Anti-flapping gap: 20% → 50% (30-point gap)
- name: LowNodeUtilization
  args:
    thresholds:
      cpu: 20
      memory: 20
    targetThresholds:
      cpu: 50
      memory: 50
```

### Problem: CronJob Interval Too Frequent

Running Descheduler every minute on a cluster with frequent pod churn (HPA scaling) means eviction decisions are stale by the time the pod reschedules.

**Solution**: Match the Descheduler interval to the HPA stabilization window. If HPA has a 5-minute cooldown, run Descheduler every 10-15 minutes.

### Problem: Evicting Pods Without a Safe Landing Zone

With `nodeFit: false`, Descheduler evicts pods even when no other node can accept them, causing pods to be Pending indefinitely.

**Solution**: Always set `nodeFit: true` in the `DefaultEvictor` configuration.

### Problem: Single-Replica Deployments Disrupted

`RemoveDuplicates` and `LowNodeUtilization` may evict the single replica of a Deployment, causing downtime.

**Solution**: Set `minReplicas: 2` in `DefaultEvictor` to prevent eviction of any pod whose controller has fewer than 2 replicas. For critical single-replica workloads, annotate the pod with `descheduler.alpha.kubernetes.io/evict: "false"`.

```yaml
# Opt out individual pods from eviction
apiVersion: v1
kind: Pod
metadata:
  annotations:
    descheduler.alpha.kubernetes.io/evict: "false"
```

### Problem: New Nodes Not Filling Quickly Enough

After a scale-up, Descheduler may evict pods before the new nodes have fully warmed up (image pull, kubelet registration). Evicted pods can end up back on old nodes if the new node is not yet schedulable.

**Solution**: Set `maxPodLifeTimeSeconds` in `DefaultEvictor` to avoid evicting recently scheduled pods, and use `nodeFit: true` to confirm a landing zone exists before eviction.

```yaml
- name: DefaultEvictor
  args:
    nodeFit: true
    # Do not evict pods scheduled within the last 10 minutes
    minPodAgeSeconds: 600
```

## Operational Runbook

### Checking What Would Be Evicted (Dry Run)

Descheduler does not have a native dry-run mode, but running it with verbose logging on a dedicated profile with all strategies disabled except the one being tested gives a view of eviction candidates without executing them.

```bash
# Add --dry-run flag (available in v0.28+)
kubectl -n kube-system set env cronjob/descheduler \
  DESCHEDULER_ARGS="--policy-config-file=/policy-dir/policy.yaml --dry-run --v=4"

# Review the logs after the next CronJob run
kubectl -n kube-system logs -l app=descheduler --tail=500 | \
  grep -E "Evicting pod|Would evict"

# Restore normal operation
kubectl -n kube-system set env cronjob/descheduler DESCHEDULER_ARGS-
```

### Temporarily Suspending Descheduler

During cluster maintenance windows or after a major deployment, suspend the CronJob to prevent unexpected evictions.

```bash
kubectl -n kube-system patch cronjob descheduler \
  -p '{"spec": {"suspend": true}}'

# Re-enable after maintenance
kubectl -n kube-system patch cronjob descheduler \
  -p '{"spec": {"suspend": false}}'
```

### Checking PDB Protection

```bash
# List all PodDisruptionBudgets and their current allowed disruptions
kubectl get pdb -A -o custom-columns=\
"NAMESPACE:.metadata.namespace,NAME:.metadata.name,\
MIN-AVAIL:.spec.minAvailable,MAX-UNAVAIL:.spec.maxUnavailable,\
DESIRED:.status.desiredHealthy,CURRENT:.status.currentHealthy,\
DISRUPTIONS-ALLOWED:.status.disruptionsAllowed"
```

## Summary

The Descheduler fills a critical gap in the Kubernetes scheduling lifecycle by continuously evaluating whether running pods are optimally placed given the current cluster state. Deploying it as a CronJob with a carefully tuned `DeschedulerPolicy` — balanced `LowNodeUtilization` thresholds, `nodeFit: true` eviction safety, `minReplicas: 2` protection, and PDB enforcement — enables automated rebalancing without introducing instability. Pairing Descheduler with Prometheus metrics and Alertmanager rules provides visibility into eviction rates and flags unusual patterns before they cause availability issues.
