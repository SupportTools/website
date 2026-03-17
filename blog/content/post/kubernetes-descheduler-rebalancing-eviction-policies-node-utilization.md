---
title: "Kubernetes Descheduler: Rebalancing Pods, Eviction Policies, and Node Utilization"
date: 2030-03-31T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Descheduler", "Scheduling", "Pod Eviction", "Node Utilization", "Cluster Management"]
categories: ["Kubernetes", "Operations", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to the Kubernetes Descheduler for automated cluster rebalancing, covering RemoveDuplicates, LowNodeUtilization, RemovePodsViolatingNodeAffinity strategies, eviction configuration, and scheduling maintenance windows."
more_link: "yes"
url: "/kubernetes-descheduler-rebalancing-eviction-policies-node-utilization/"
---

The Kubernetes scheduler makes pod placement decisions at the moment a pod is created. It does not continuously re-evaluate those decisions. Once a pod is running on a node, it stays there until it is deleted, the node fails, or something explicitly moves it. This creates a class of cluster imbalance problems that the scheduler cannot solve on its own.

Consider what happens when you add nodes to your cluster during a scaling event: existing pods continue running on the original nodes, and new pods land on the new nodes. After the traffic peak passes and new pods are removed, you are left with overloaded original nodes and underutilized new nodes. Or consider pods scheduled before a NodeAffinity rule was added — they are now running on nodes they should not be on.

The Kubernetes Descheduler solves these problems by running periodically, identifying pods that should be moved based on configurable policies, evicting them, and allowing the scheduler to reschedule them onto more appropriate nodes.

<!--more-->

## Descheduler Architecture

The Descheduler is not part of the Kubernetes core — it is a separately deployed component from the sig-scheduling project. It runs as a CronJob or Deployment and interacts with the API server to:

1. List nodes and pods according to its configured policies
2. Identify pods that are candidates for eviction
3. Evict those pods (via the Eviction API)
4. The scheduler then reschedules the evicted pods based on current cluster state

```
Descheduler (CronJob/Deployment)
        │
        │ 1. List nodes + pods
        ▼
  Kubernetes API Server
        │
        │ 2. Apply policy plugins to identify candidates
        ▼
  Policy Plugins
  ┌──────────────────────────────────────────┐
  │ RemoveDuplicates                          │
  │ LowNodeUtilization                        │
  │ HighNodeUtilization                       │
  │ RemovePodsViolatingNodeAffinity           │
  │ RemovePodsViolatingInterPodAntiAffinity   │
  │ RemovePodsHavingTooManyRestarts           │
  │ PodLifeTime                               │
  └──────────────────────────────────────────┘
        │
        │ 3. Evict selected pods
        ▼
  Kubernetes Eviction API
        │
        │ 4. Pods rescheduled by scheduler
        ▼
  New Placement on Better Nodes
```

## Installation

### Helm Installation

```bash
# Add the descheduler Helm chart repository
helm repo add descheduler https://kubernetes-sigs.github.io/descheduler/
helm repo update

# Install descheduler as a CronJob (runs every 2 minutes)
helm install descheduler descheduler/descheduler \
  --namespace kube-system \
  --set schedule="*/2 * * * *" \
  --set kind=CronJob \
  --version 0.31.0

# Or install as a Deployment for continuous operation
helm install descheduler descheduler/descheduler \
  --namespace kube-system \
  --set kind=Deployment \
  --set deschedulerPolicy.profiles[0].name=default \
  --version 0.31.0
```

### Manual RBAC and Deployment

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

## Descheduler Policy Configuration

The descheduler policy is defined in a ConfigMap and controls which strategies run and with what parameters.

### Complete Production Policy

```yaml
# descheduler-policy.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: descheduler-policy
  namespace: kube-system
data:
  policy.yaml: |
    apiVersion: "descheduler/v1alpha2"
    kind: DeschedulerPolicy

    # Global node filter — never consider nodes matching this selector for eviction
    nodeSelector: "descheduler.io/exclude!=true"

    # Maximum number of pods to evict per node per iteration
    maxNoOfPodsToEvictPerNode: 10

    # Maximum number of pods to evict per namespace per iteration
    maxNoOfPodsToEvictPerNamespace: 20

    # Maximum total pods to evict per iteration
    maxNoOfPodsToEvictTotal: 100

    # Profiles are independent sets of plugins that run together
    profiles:
      - name: default
        pluginConfig:
          # ─────────────────────────────────────────────────────
          # RemoveDuplicates
          # Ensures no two pods from the same ReplicaSet/
          # Deployment are on the same node when other nodes
          # are available.
          # ─────────────────────────────────────────────────────
          - name: RemoveDuplicates
            args:
              excludeOwnerKinds:
                - "DaemonSet"
              # Only evict pods in these namespaces (empty = all)
              namespaces:
                include: []
                exclude:
                  - kube-system
                  - monitoring

          # ─────────────────────────────────────────────────────
          # LowNodeUtilization
          # Evicts pods from over-utilized nodes so they can
          # reschedule onto under-utilized nodes.
          # ─────────────────────────────────────────────────────
          - name: LowNodeUtilization
            args:
              thresholds:
                # A node is "underutilized" below these thresholds
                cpu: 30
                memory: 30
                pods: 20
              targetThresholds:
                # A node is "overutilized" above these thresholds
                cpu: 70
                memory: 70
                pods: 80
              # Use extended resources (GPUs, etc.)
              useDeviationThresholds: false
              # Nodes below thresholds are targets for receiving pods
              # Nodes above targetThresholds are sources for eviction

          # ─────────────────────────────────────────────────────
          # HighNodeUtilization
          # For bin-packing mode: evict pods from underutilized
          # nodes to enable node scale-down.
          # Use EITHER LowNodeUtilization OR HighNodeUtilization,
          # not both.
          # ─────────────────────────────────────────────────────
          # - name: HighNodeUtilization
          #   args:
          #     thresholds:
          #       cpu: 20
          #       memory: 20

          # ─────────────────────────────────────────────────────
          # RemovePodsViolatingNodeAffinity
          # Evicts pods running on nodes that no longer satisfy
          # their nodeAffinity rules (rules may have changed).
          # ─────────────────────────────────────────────────────
          - name: RemovePodsViolatingNodeAffinity
            args:
              nodeAffinityType:
                - "requiredDuringSchedulingIgnoredDuringExecution"
              namespaces:
                exclude:
                  - kube-system

          # ─────────────────────────────────────────────────────
          # RemovePodsViolatingInterPodAntiAffinity
          # Evicts pods that violate inter-pod anti-affinity rules.
          # ─────────────────────────────────────────────────────
          - name: RemovePodsViolatingInterPodAntiAffinity
            args:
              namespaces:
                exclude:
                  - kube-system

          # ─────────────────────────────────────────────────────
          # RemovePodsViolatingNodeTaints
          # Evicts pods that no longer tolerate a taint that has
          # been added to their current node.
          # ─────────────────────────────────────────────────────
          - name: RemovePodsViolatingNodeTaints
            args:
              includingPreferNoSchedule: false
              namespaces:
                exclude:
                  - kube-system

          # ─────────────────────────────────────────────────────
          # RemovePodsHavingTooManyRestarts
          # Evicts pods with excessive restart counts to force
          # them to reschedule on a potentially healthier node.
          # ─────────────────────────────────────────────────────
          - name: RemovePodsHavingTooManyRestarts
            args:
              podRestartThreshold: 100
              includingInitContainers: true

          # ─────────────────────────────────────────────────────
          # PodLifeTime
          # Evicts pods older than the specified age.
          # Useful for pods that should be regularly recycled
          # (e.g., to pick up ConfigMap changes, rotate connections).
          # ─────────────────────────────────────────────────────
          - name: PodLifeTime
            args:
              maxPodLifeTimeSeconds: 604800   # 7 days
              # Only evict pods in specific namespaces
              namespaces:
                include:
                  - application-namespace
              # Only evict pods with specific labels
              labelSelector:
                matchLabels:
                  recycle: "enabled"

        plugins:
          balance:
            enabled:
              - RemoveDuplicates
              - LowNodeUtilization
          deschedule:
            enabled:
              - RemovePodsViolatingNodeAffinity
              - RemovePodsViolatingInterPodAntiAffinity
              - RemovePodsViolatingNodeTaints
              - RemovePodsHavingTooManyRestarts
              - PodLifeTime
```

### CronJob Deployment

```yaml
# descheduler-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: descheduler
  namespace: kube-system
  labels:
    app: descheduler
spec:
  # Run every 5 minutes during business hours, hourly overnight
  schedule: "*/5 8-18 * * 1-5"
  # schedule: "0 * * * *"    # hourly (less aggressive)
  # schedule: "*/2 * * * *"  # every 2 min (most responsive)
  concurrencyPolicy: Forbid   # Don't run if previous is still running
  failedJobsHistoryLimit: 3
  successfulJobsHistoryLimit: 5
  jobTemplate:
    spec:
      backoffLimit: 3
      template:
        metadata:
          labels:
            app: descheduler
        spec:
          serviceAccountName: descheduler
          restartPolicy: Never
          priorityClassName: system-cluster-critical
          securityContext:
            runAsNonRoot: true
            runAsUser: 1000
            seccompProfile:
              type: RuntimeDefault
          containers:
            - name: descheduler
              image: registry.k8s.io/descheduler/descheduler:v0.31.0
              imagePullPolicy: IfNotPresent
              command:
                - /bin/descheduler
                - --policy-config-file=/policy-dir/policy.yaml
                - --v=3
                - --dry-run=false    # set to true to preview without evicting
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
                  drop: ["ALL"]
                readOnlyRootFilesystem: true
              volumeMounts:
                - mountPath: /policy-dir
                  name: policy-volume
          volumes:
            - name: policy-volume
              configMap:
                name: descheduler-policy
```

## Strategy Deep Dives

### LowNodeUtilization: Optimal Configuration

`LowNodeUtilization` is the most impactful strategy for maintaining cluster health. Its behavior depends critically on threshold tuning.

```yaml
# Understanding LowNodeUtilization thresholds
#
# "underutilized" node: ALL metrics below thresholds
# "overutilized" node: ANY metric above targetThresholds
# "appropriately utilized" node: between thresholds
#
# Example with cpu=30, memory=30 (thresholds)
#         and cpu=70, memory=70 (targetThresholds):
#
#   Node A: 15% CPU, 20% memory → UNDERUTILIZED (receives pods)
#   Node B: 50% CPU, 45% memory → APPROPRIATE (no action)
#   Node C: 80% CPU, 60% memory → OVERUTILIZED (pods evicted)
#   Note: Node C has CPU > 70 so it IS overutilized, even though
#         memory is only 60%

- name: LowNodeUtilization
  args:
    thresholds:
      cpu: 30
      memory: 30
      pods: 20
    targetThresholds:
      cpu: 70
      memory: 70
      pods: 80
    # evictableNamespaces — restrict which namespaces can be evicted
    evictableNamespaces:
      exclude:
        - kube-system
        - monitoring
        - cert-manager
    # numberOfNodes — only run if at least this many underutilized nodes exist
    # Prevents churning when cluster is uniformly loaded
    numberOfNodes: 2
```

### RemoveDuplicates: Spread Enforcement

```yaml
# RemoveDuplicates ensures horizontal spread of replica pods
# It moves pods off nodes where >1 pod from the same owner exists
# when other available nodes exist.

- name: RemoveDuplicates
  args:
    excludeOwnerKinds:
      - "DaemonSet"    # DaemonSets are always per-node by design
      - "Job"          # Job pods are intentionally parallel
    namespaces:
      exclude:
        - kube-system
```

```yaml
# Example scenario:
# 3-replica Deployment "api-server", 5 nodes
#
# Before RemoveDuplicates:
#   node-1: api-server-abc, api-server-def   (2 pods!)
#   node-2: api-server-ghi
#   node-3: (empty)
#   node-4: (empty)
#   node-5: (empty)
#
# After RemoveDuplicates:
#   node-1: api-server-abc
#   node-2: api-server-ghi
#   node-3: api-server-def (rescheduled)
#   node-4: (empty)
#   node-5: (empty)
```

### PodLifeTime for Connection Rotation

```yaml
# PodLifeTime is useful for workloads where:
# - Long-running connections need periodic rotation
# - Pods need to pick up new ConfigMap values without restart
# - You want to limit blast radius of a stuck pod

- name: PodLifeTime
  args:
    maxPodLifeTimeSeconds: 259200   # 3 days
    # States that qualify for eviction
    podStatusPhases:
      - Running
      - Pending
    namespaces:
      include:
        - long-running-services
    labelSelector:
      matchExpressions:
        - key: lifetime-managed
          operator: In
          values: ["true"]
    # Only evict if the pod has been in a specific state
    states:
      - Running
```

## Protecting Pods from Descheduler Eviction

The Descheduler respects standard Kubernetes eviction protections.

### PodDisruptionBudgets

```yaml
# PDB prevents descheduler from evicting too many replicas at once
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-server-pdb
  namespace: production
spec:
  minAvailable: "75%"   # Always keep at least 75% of replicas running
  selector:
    matchLabels:
      app: api-server
```

```yaml
# Stricter PDB for critical services
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-service-pdb
  namespace: production
spec:
  maxUnavailable: 1   # Absolute: at most 1 pod unavailable at a time
  selector:
    matchLabels:
      app: payment-service
```

### Annotation-Based Exclusion

```yaml
# Prevent specific pods from being evicted by descheduler
apiVersion: v1
kind: Pod
metadata:
  annotations:
    # Prevent all descheduler evictions for this pod
    descheduler.alpha.kubernetes.io/evict: "false"
spec:
  # ...
```

```yaml
# In DeschedulerPolicy, use evictionLimiter to add global excludes
profiles:
  - name: default
    plugins:
      filter:
        enabled:
          - DefaultEvictor

    pluginConfig:
      - name: DefaultEvictor
        args:
          # Never evict Guaranteed QoS pods
          evictSystemCriticalPods: false
          evictDaemonSetPods: false
          evictLocalStoragePods: false
          # Only evict if node is not under memory pressure
          nodeFit: true
          # Minimum pod age before it can be evicted (avoid evicting newly started pods)
          minPodAge: "5m"
          # Pods with this priority class are never evicted
          priorityThreshold:
            name: "system-cluster-critical"
```

## Maintenance Window Scheduling

Running the Descheduler only during specific windows prevents disruptions during peak traffic.

### Business Hours Only

```yaml
# CronJob that only runs during business hours on weekdays
apiVersion: batch/v1
kind: CronJob
metadata:
  name: descheduler-business-hours
  namespace: kube-system
spec:
  # Run every 15 minutes, Mon-Fri, 9 AM - 5 PM UTC
  schedule: "*/15 9-17 * * 1-5"
  concurrencyPolicy: Forbid
  # ...
```

### Maintenance Window CronJobs

```yaml
# CronJob for aggressive rebalancing during maintenance window
apiVersion: batch/v1
kind: CronJob
metadata:
  name: descheduler-maintenance
  namespace: kube-system
spec:
  # Every Saturday at 2 AM UTC
  schedule: "0 2 * * 6"
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: descheduler
          restartPolicy: Never
          containers:
            - name: descheduler
              image: registry.k8s.io/descheduler/descheduler:v0.31.0
              command:
                - /bin/descheduler
                - --policy-config-file=/policy-dir/maintenance-policy.yaml
                - --v=3
              volumeMounts:
                - mountPath: /policy-dir
                  name: policy-volume
          volumes:
            - name: policy-volume
              configMap:
                name: descheduler-maintenance-policy
```

```yaml
# More aggressive maintenance policy
apiVersion: v1
kind: ConfigMap
metadata:
  name: descheduler-maintenance-policy
  namespace: kube-system
data:
  maintenance-policy.yaml: |
    apiVersion: "descheduler/v1alpha2"
    kind: DeschedulerPolicy
    maxNoOfPodsToEvictPerNode: 50
    maxNoOfPodsToEvictPerNamespace: 100
    maxNoOfPodsToEvictTotal: 500
    profiles:
      - name: maintenance
        pluginConfig:
          - name: LowNodeUtilization
            args:
              thresholds:
                cpu: 40     # More aggressive thresholds
                memory: 40
              targetThresholds:
                cpu: 80
                memory: 80
          - name: RemoveDuplicates
            args:
              excludeOwnerKinds:
                - "DaemonSet"
          - name: RemovePodsViolatingNodeAffinity
            args:
              nodeAffinityType:
                - "requiredDuringSchedulingIgnoredDuringExecution"
                - "preferredDuringSchedulingIgnoredDuringExecution"
        plugins:
          balance:
            enabled:
              - RemoveDuplicates
              - LowNodeUtilization
          deschedule:
            enabled:
              - RemovePodsViolatingNodeAffinity
```

### External Trigger via Kubernetes Job

For maintenance windows triggered by deployment pipelines:

```bash
#!/usr/bin/env bash
# trigger-descheduler.sh — run descheduler as part of a deployment pipeline

set -euo pipefail

NAMESPACE="kube-system"
JOB_NAME="descheduler-triggered-$(date +%s)"

echo "Creating descheduler job: $JOB_NAME"

kubectl create job "$JOB_NAME" \
  --from=cronjob/descheduler \
  -n "$NAMESPACE"

echo "Waiting for descheduler job to complete..."
kubectl wait job "$JOB_NAME" \
  -n "$NAMESPACE" \
  --for=condition=complete \
  --timeout=120s

echo "Descheduler completed"
kubectl logs job/"$JOB_NAME" -n "$NAMESPACE"

# Clean up
kubectl delete job "$JOB_NAME" -n "$NAMESPACE"
```

## Observability and Metrics

The Descheduler exposes Prometheus metrics when run with `--v=3` or higher.

```yaml
# ServiceMonitor for Prometheus scraping
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: descheduler
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: descheduler
  endpoints:
    - port: metrics
      interval: 60s
      path: /metrics
```

```yaml
# Grafana dashboard queries for descheduler monitoring
# (expressed as Prometheus PromQL)

# Total pods evicted per strategy over 24h
# descheduler_pods_evicted{plugin="LowNodeUtilization"} - offset 24h

# Pods evicted rate
# rate(descheduler_pods_evicted_total[5m])

# Errors
# descheduler_eviction_errors_total

# Nodes above target threshold
# (count of nodes where descheduler flagged as overutilized)
```

```bash
# Check descheduler effectiveness via Kubernetes events
kubectl get events -n production \
  --field-selector='reason=Evicted' \
  --sort-by='.lastTimestamp' | tail -20

# Detailed eviction events with reason
kubectl get events -A \
  --field-selector='reason=Evicted' \
  -o jsonpath='{range .items[*]}{.lastTimestamp}{"\t"}{.involvedObject.namespace}{"\t"}{.involvedObject.name}{"\t"}{.message}{"\n"}{end}' \
  | sort | tail -30

# Node utilization before and after descheduler run
kubectl top nodes
```

## Dry-Run Testing

Before enabling evictions, always test with `--dry-run=true`:

```bash
# Run descheduler in dry-run mode to see what would be evicted
kubectl create job descheduler-dry-run \
  --from=cronjob/descheduler \
  -n kube-system \
  --dry-run=client \
  -o yaml | \
  kubectl apply -f -

# Get dry-run output
kubectl logs job/descheduler-dry-run -n kube-system 2>/dev/null | \
  grep -E '(evict|Would|would)' | head -30

# Example dry-run output:
# I0326 10:00:01.000000       1 node_utilization.go:245] "Node is underutilized"
#   node="worker-05" usage={"cpu":"823m","memory":"2.1Gi","pods":"8"}
# I0326 10:00:01.000000       1 node_utilization.go:270] "Node is overutilized"
#   node="worker-01" usage={"cpu":"7.4","memory":"28.2Gi","pods":"45"}
# I0326 10:00:01.000000       1 descheduler.go:163] "Dry run is enabled, pod won't be evicted"
#   pod="production/api-server-abc12"
```

## Troubleshooting Common Issues

```bash
# Pods not being evicted — check PDBs
kubectl get pdb -A | grep -v '100%\|N/A'
# If minAvailable = total replicas, descheduler cannot evict any pods

# Check PDB status for a specific deployment
kubectl get pdb -n production api-server-pdb -o yaml

# Pods evicted but immediately rescheduled to same node
# This means the scheduler has no better option
# Check if other nodes have capacity
kubectl describe nodes | grep -E '(Name:|Allocated|cpu|memory)' | paste - - - - -

# Descheduler not running
kubectl get cronjob descheduler -n kube-system
kubectl get jobs -n kube-system | grep descheduler | tail -5

# Check descheduler logs
kubectl logs -n kube-system \
  "$(kubectl get pods -n kube-system -l app=descheduler -o name | tail -1)" \
  --tail=100

# Verify RBAC is correct
kubectl auth can-i create pods/eviction \
  --as=system:serviceaccount:kube-system:descheduler -n production

# Check if nodeSelector is filtering nodes
kubectl get nodes --show-labels | grep 'descheduler.io/exclude'
```

### Safe Eviction Validation

```bash
#!/usr/bin/env bash
# validate-eviction-safety.sh — check if descheduler can safely evict
# Run this before enabling aggressive settings

set -euo pipefail

echo "=== Pod Distribution Analysis ==="
kubectl get pods -A -o wide \
  --field-selector='status.phase=Running' | \
  awk '{print $8}' | sort | uniq -c | sort -rn | head -20

echo ""
echo "=== Pods Without PDB ==="
# Find deployments with no matching PDB
kubectl get deployments -A -o json | python3 - << 'PYEOF'
import json, sys, subprocess

data = json.load(sys.stdin)
for item in data['items']:
    name = item['metadata']['name']
    ns = item['metadata']['namespace']
    replicas = item['spec'].get('replicas', 1)
    if replicas < 2:
        continue

    # Check for PDB
    result = subprocess.run(
        ['kubectl', 'get', 'pdb', '-n', ns, '--no-headers'],
        capture_output=True, text=True
    )
    if not result.stdout.strip():
        print(f"WARNING: {ns}/{name} ({replicas} replicas) has no PDB")
PYEOF

echo ""
echo "=== Node Utilization Summary ==="
kubectl top nodes 2>/dev/null || echo "Metrics server not available"
```

## Key Takeaways

The Descheduler is the missing piece in Kubernetes cluster maintenance that prevents the gradual accumulation of suboptimal pod placement over time.

The most important configuration decision is which eviction mode to use. `LowNodeUtilization` should be your primary tool for general-purpose clusters — it redistributes pods from over-loaded to under-loaded nodes. `HighNodeUtilization` is the correct choice for clusters running a Cluster Autoscaler where you want to consolidate pods onto fewer nodes to enable scale-down of underutilized nodes.

PodDisruptionBudgets are not optional when running the Descheduler. Without PDBs, the Descheduler can evict multiple replicas of the same service simultaneously, causing brief service degradation. Add PDBs to every multi-replica Deployment and StatefulSet, and use `minAvailable: "75%"` as the default for services that can tolerate brief single-pod unavailability.

Run the Descheduler in dry-run mode for at least one week before enabling actual evictions on a production cluster. Review the logs to understand which pods would be evicted and why. The two most common surprises are: pods being evicted that have no PDB (add one), and pods being evicted but rescheduled back to the same node (indicates the cluster has no better placement options — address the root cause rather than letting the Descheduler loop).

The maintenance window pattern — running an aggressive policy once per week during low-traffic hours, supplemented by a conservative policy during business hours — provides the best balance between cluster efficiency and minimal disruption to running workloads.
