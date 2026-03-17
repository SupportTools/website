---
title: "Kubernetes Pod Priority and Preemption: Ensuring Critical Workload Availability"
date: 2028-11-05T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Scheduling", "Priority", "Resource Management", "SRE"]
categories:
- Kubernetes
- SRE
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Kubernetes pod priority and preemption: PriorityClass resource design, system built-in classes, preemption victim selection, interaction with PodDisruptionBudgets, and designing priority hierarchies for production clusters."
more_link: "yes"
url: "/kubernetes-pod-preemption-priority-classes-guide/"
---

When a Kubernetes cluster is under resource pressure, the scheduler must make hard decisions: which pods get to run and which get evicted. Without a defined priority hierarchy, these decisions are arbitrary — your critical payment processing service might get evicted to make room for a development pod that someone forgot to delete. Pod priority and preemption give you control over these decisions, ensuring that critical workloads always get resources even when the cluster is under load.

This guide covers the complete priority and preemption system: PriorityClass resource definition, how the scheduler uses priorities during placement and preemption, victim selection mechanics, interaction with PodDisruptionBudgets, and designing a priority hierarchy that works for real production clusters.

<!--more-->

# Kubernetes Pod Priority and Preemption: Ensuring Critical Workload Availability

## How Priority and Preemption Work

Pod scheduling in Kubernetes proceeds in two phases:

1. **Filtering**: The scheduler identifies nodes that can accommodate the pod (sufficient CPU, memory, taints/tolerations match, etc.)
2. **Scoring**: Among eligible nodes, the scheduler picks the best fit

When no node passes filtering, priority determines what happens next:

- If the pending pod has higher priority than some currently-running pods, the scheduler identifies nodes where preempting lower-priority pods would make room for the pending pod
- The scheduler selects a victim node and evicts the lower-priority pods
- The pending pod is then placed on that node

Priority is represented as an integer: higher integers = higher priority. The valid range is -2,147,483,648 to 1,000,000,000. Values above 1,000,000,000 are reserved for system components.

## PriorityClass Resource

```yaml
# PriorityClass definition
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: critical-business-services
value: 1000000
globalDefault: false
preemptionPolicy: PreemptLowerPriority  # Default behavior
description: >
  For revenue-generating services: payment processing, order management,
  user authentication. These services justify preempting any non-critical workload.
```

Key fields:
- `value`: The integer priority value (higher = more important)
- `globalDefault`: If `true`, pods without an explicit `priorityClassName` get this priority. Only one PriorityClass can have `globalDefault: true`.
- `preemptionPolicy`: Either `PreemptLowerPriority` (default) or `Never` (pod waits without preempting)
- `description`: Documentation for operators — critical because the integer value alone is not self-explanatory

## System Built-in Priority Classes

Kubernetes includes two priority classes for system components. Do not use these for application workloads:

```bash
kubectl get priorityclasses

# NAME                        VALUE         GLOBAL-DEFAULT   AGE
# system-node-critical        2000001000    false            365d
# system-cluster-critical     2000000000    false            365d
```

**`system-node-critical`** (value: 2,000,001,000): Used for node-essential DaemonSets like `kube-proxy` and `node-local-dns`. These pods should never be evicted from a node as their absence renders the node non-functional.

**`system-cluster-critical`** (value: 2,000,000,000): Used for critical cluster components like CoreDNS and the metrics-server. These are cluster-wide critical but not per-node critical.

Your highest application priority class must be below 2,000,000,000 to stay below cluster-critical components.

## Designing a Priority Hierarchy

A practical priority hierarchy for a production cluster:

```yaml
# 0. Default (no class): 0 — Development/test pods without explicit assignment

# 1. Background/batch jobs: lowest application priority
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: background-batch
value: 100
globalDefault: false
preemptionPolicy: Never  # Batch jobs should not preempt anything
description: "Background jobs, scheduled batch processing, ETL pipelines. Never preempts."
---
# 2. Non-critical services: internal tools, admin UIs
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: low-priority
value: 100000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: "Internal tools, admin interfaces, monitoring agents. Can preempt background workloads."
---
# 3. Standard services: most application workloads
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: standard-service
value: 500000
globalDefault: true  # Default for pods that don't specify a class
preemptionPolicy: PreemptLowerPriority
description: "Standard application services. Default class. Can preempt low-priority workloads."
---
# 4. High-priority services: user-facing APIs, real-time services
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: high-priority
value: 750000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: "User-facing APIs, real-time data services. Can preempt standard and below."
---
# 5. Critical business services: revenue-generating, SLA-bound
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: critical-business
value: 1000000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: "Payment, authentication, order processing. Can preempt anything below cluster-critical."
---
# 6. Infrastructure components: cluster-level tooling (not app workloads)
# These are just below system-cluster-critical
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: cluster-infrastructure
value: 1999999000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: "Cluster infrastructure: ingress controllers, cert-manager, cluster-autoscaler. Not for application workloads."
```

## Assigning Priority Classes to Pods

Set `priorityClassName` in the pod spec:

```yaml
# Payment processing service — critical-business priority
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-processor
  namespace: production
spec:
  replicas: 5
  template:
    spec:
      priorityClassName: critical-business
      containers:
        - name: payment-processor
          image: registry.example.com/payment-processor:3.2.1
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 2Gi
---
# Batch report generation — background, never preempts
apiVersion: batch/v1
kind: CronJob
metadata:
  name: daily-report-generator
  namespace: production
spec:
  schedule: "0 2 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          priorityClassName: background-batch
          containers:
            - name: report-generator
              image: registry.example.com/report-generator:1.0.0
              resources:
                requests:
                  cpu: 2000m
                  memory: 4Gi
```

## Preemption Mechanics: How Victim Selection Works

When the scheduler decides to preempt pods, it follows a specific algorithm to minimize disruption:

1. **Find preemption candidates**: Identify nodes where preempting lower-priority pods would free enough resources for the pending pod

2. **Select the node** with the minimum impact:
   - Prefer nodes where fewest PodDisruptionBudgets would be violated
   - Among those, prefer nodes where fewest higher-priority pods would be affected
   - Among those, prefer nodes where fewer pods would be preempted
   - Finally, prefer nodes with the latest-started pods (minimizes wasted work)

3. **Set nominatedNodeName**: The scheduler annotates the pending pod with the node it plans to place it on, but the pod does not immediately replace the evicted pods — it waits for the next scheduling cycle

4. **Graceful termination**: Evicted pods receive the standard termination signal and their `terminationGracePeriodSeconds` to shut down cleanly

```bash
# Observe preemption in action
kubectl describe pod payment-processor-78c9d-xxxxx | grep -A5 "Events:"
# Events:
#   Type     Reason             Age   From               Message
#   ----     ------             ----  ----               -------
#   Warning  Preempting         10s   default-scheduler  Preempted by production/payment-processor-78c9d-yyyyy on node node-01
#   Normal   Scheduled          8s    default-scheduler  Successfully assigned production/payment-processor-78c9d-yyyyy to node-01

# Check the pending pod's nominated node
kubectl get pod payment-processor-pending -o jsonpath='{.status.nominatedNodeName}'
# node-01
```

## Interaction with PodDisruptionBudgets

PodDisruptionBudgets (PDBs) protect against voluntary disruptions — preemption is a voluntary disruption. The scheduler respects PDBs during victim selection but will override them as a last resort:

```yaml
# PDB for the payment processor — protect against concurrent disruptions
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-processor-pdb
  namespace: production
spec:
  minAvailable: 3  # At least 3 of 5 replicas must be available
  selector:
    matchLabels:
      app: payment-processor
```

The scheduler behavior with PDBs:

1. If preempting a pod would violate a PDB, the scheduler first looks for other victims on other nodes
2. If no PDB-safe victims exist and the pending pod is high enough priority, the scheduler will override the PDB — **PDBs do not provide absolute protection against high-priority preemption**
3. For this reason, PDB protection is most effective when combined with adequate cluster capacity and a well-designed priority hierarchy

```yaml
# OPA Gatekeeper policy to require PDBs for critical services
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: requirepdb
spec:
  crd:
    spec:
      names:
        kind: RequirePDB
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package requirepdb

        violation[{"msg": msg}] {
          input.review.kind.kind == "Deployment"
          input.review.object.spec.template.spec.priorityClassName == "critical-business"
          not pdb_exists
          msg := sprintf("Deployment %v with critical-business priority class must have a PodDisruptionBudget", [input.review.object.metadata.name])
        }

        pdb_exists {
          pdb := data.inventory.namespace[input.review.object.metadata.namespace]["policy/v1"]["PodDisruptionBudget"][_]
          pdb.spec.selector.matchLabels[key] == input.review.object.spec.selector.matchLabels[key]
        }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: RequirePDB
metadata:
  name: critical-services-require-pdb
spec:
  match:
    kinds:
      - apiGroups: ["apps"]
        kinds: ["Deployment"]
    namespaces: ["production", "staging"]
```

## preemptionPolicy: Never — Queue Without Preempting

Setting `preemptionPolicy: Never` makes a pod queue for resources without evicting lower-priority pods. This is useful for batch jobs that should run when resources are available but should not disrupt running workloads:

```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: overnight-batch
value: 50000
preemptionPolicy: Never  # Queue, do not preempt
description: "Overnight batch jobs. Runs when cluster is idle. Never preempts other pods."
---
# This batch job will queue until enough resources are naturally available.
# It will never evict other pods to make room.
apiVersion: batch/v1
kind: Job
metadata:
  name: nightly-ml-training
spec:
  template:
    spec:
      priorityClassName: overnight-batch
      restartPolicy: OnFailure
      containers:
        - name: trainer
          image: registry.example.com/ml-trainer:latest
          resources:
            requests:
              cpu: 8000m
              memory: 32Gi
              nvidia.com/gpu: "1"
```

With `preemptionPolicy: Never`, higher-priority pods (from the perspective of other pending pods trying to preempt) still cannot preempt this pod — it is the **pending** pod's `preemptionPolicy` that controls whether IT can preempt others, not whether IT can be preempted. Preemptibility is determined by value alone: lower value pods are always potential victims for higher value pods.

## Monitoring Priority and Preemption

```bash
# Count preemption events across the cluster
kubectl get events --all-namespaces \
  --field-selector reason=Preempting \
  --sort-by='.lastTimestamp' | tail -20

# Pods currently pending that have a nominated node (awaiting preemption)
kubectl get pods --all-namespaces \
  -o jsonpath='{range .items[?(@.status.nominatedNodeName)]}{.metadata.namespace}/{.metadata.name} -> {.status.nominatedNodeName}{"\n"}{end}'

# Priority distribution of running pods
kubectl get pods --all-namespaces \
  -o jsonpath='{range .items[*]}{.spec.priorityClassName}{"\n"}{end}' | \
  sort | uniq -c | sort -rn

# Pods without a priority class (might be 0 = lowest priority)
kubectl get pods --all-namespaces \
  -o jsonpath='{range .items[?(!@.spec.priorityClassName)]}{.metadata.namespace}/{.metadata.name}{"\n"}{end}' | \
  head -20
```

### Prometheus Alerts for Preemption

```yaml
# prometheus-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: pod-priority-alerts
  namespace: monitoring
spec:
  groups:
    - name: pod.preemption
      interval: 30s
      rules:
        # Alert if critical pods are being preempted (should never happen with correct hierarchy)
        - alert: CriticalPodPreempted
          expr: |
            increase(kube_pod_preempted_total{priority_class="critical-business"}[5m]) > 0
          for: 0m
          labels:
            severity: critical
            team: platform
          annotations:
            summary: "Critical pod was preempted"
            description: "Pod {{ $labels.pod }} in namespace {{ $labels.namespace }} with critical-business priority was preempted. This indicates cluster capacity is critically low."

        # Alert if high-priority pods are stuck pending for more than 5 minutes
        - alert: HighPriorityPodStuckPending
          expr: |
            kube_pod_status_phase{phase="Pending"}
            * on(pod, namespace) group_left(priority_class)
            kube_pod_spec_volumes_persistentvolumeclaims_info{priority_class=~"critical-business|high-priority"}
            > 0
          for: 5m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "High-priority pod stuck in Pending state"
            description: "Pod {{ $labels.pod }} ({{ $labels.priority_class }}) has been Pending for >5 minutes. Cluster may need additional capacity."

        # Alert on high preemption rate (indicates chronic capacity shortage)
        - alert: HighPreemptionRate
          expr: |
            rate(scheduler_pod_preemption_victims[10m]) > 5
          for: 15m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "High pod preemption rate"
            description: "More than 5 pods per minute are being preempted. Consider adding cluster capacity."
```

## Common Pitfalls and Solutions

### Pitfall 1: All Pods at the Same Priority

Setting all pods to high priority makes preemption unpredictable — any pod can preempt any other:

```bash
# Check if you have this problem
kubectl get pods --all-namespaces \
  -o jsonpath='{range .items[*]}{.spec.priorityClassName}{"\n"}{end}' | \
  sort | uniq -c
# 847 critical-business    ← Way too many "critical" pods
# 12 standard-service
```

**Solution**: Audit each service against business impact. Only payment, auth, and order processing are truly "critical-business". Most services are "standard-service" or "high-priority".

### Pitfall 2: Missing Resource Requests

Preemption only fires when a pod cannot be scheduled due to resource constraints. If pods have no `resources.requests`, the scheduler thinks any node can fit them — no preemption fires, but the node still runs out of memory and the OOM killer fires instead:

```bash
# Find pods without resource requests
kubectl get pods --all-namespaces -o json | \
  jq -r '.items[] | select(.spec.containers[].resources.requests == null) |
  "\(.metadata.namespace)/\(.metadata.name)"'
```

**Solution**: Require resource requests via LimitRange and OPA Gatekeeper policies.

### Pitfall 3: PDB Deadlock

If all pods of a Deployment have a PDB with `minAvailable: 100%`, the scheduler can never preempt them — they effectively have infinite protection. When multiple high-priority workloads all have this configuration, the cluster can deadlock:

```yaml
# PROBLEMATIC: This PDB prevents any preemption ever
spec:
  minAvailable: 5  # Same as replicas count = 100% protection
  selector:
    matchLabels:
      app: my-service
```

```yaml
# CORRECT: Allow at least one preemption victim
spec:
  minAvailable: "80%"  # Or maxUnavailable: 1
  selector:
    matchLabels:
      app: my-service
```

### Pitfall 4: DaemonSet Preemption

DaemonSet pods should use `system-node-critical` or at minimum `cluster-infrastructure` priority. If DaemonSet pods have low priority, critical application pods can preempt them — leaving nodes without monitoring agents, CNI plugins, or log collectors:

```yaml
# DaemonSet for the CNI plugin — must never be preempted
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: calico-node
spec:
  template:
    spec:
      priorityClassName: system-node-critical
      tolerations:
        - operator: Exists  # Must run on all nodes including tainted ones
```

## Namespace-Level Defaults with LimitRange

Enforce default priority classes at the namespace level using a webhook or LimitRange (priority defaults are set via Admission controllers, not LimitRange, but you can enforce via OPA):

```yaml
# Enforce minimum priority class for production namespace
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: RequireMinimumPriority
metadata:
  name: production-minimum-priority
spec:
  match:
    kinds:
      - apiGroups: ["apps"]
        kinds: ["Deployment", "StatefulSet"]
    namespaces: ["production"]
  parameters:
    minimumValue: 500000  # Must be at least standard-service
    allowedClasses:
      - standard-service
      - high-priority
      - critical-business
```

## Complete Production Example

```yaml
# Complete deployment with all priority-related configurations
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
  namespace: production
spec:
  replicas: 6
  selector:
    matchLabels:
      app: order-service
  template:
    metadata:
      labels:
        app: order-service
    spec:
      priorityClassName: critical-business
      topologySpreadConstraints:
        # Spread across zones to reduce co-location with preemption victims
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: order-service
      containers:
        - name: order-service
          image: registry.example.com/order-service:4.2.0
          resources:
            # Accurate requests are REQUIRED for preemption to work correctly
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 2Gi
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: order-service-pdb
  namespace: production
spec:
  maxUnavailable: 1  # Allow 1 pod to be preempted at a time
  selector:
    matchLabels:
      app: order-service
```

## Summary

Pod priority and preemption provide a safety net for cluster resource contention:

1. **Define a clear hierarchy** with 4-6 levels matching your organization's service criticality
2. **Set `globalDefault: true`** on your standard-service class so unclassified pods get predictable priority
3. **Use `preemptionPolicy: Never`** for batch jobs that should queue rather than disrupt
4. **Combine PDBs with priority** — priority gets pods scheduled, PDBs control the disruption budget during preemption
5. **DaemonSets must use system-node-critical** or cluster-infrastructure priority — they must never be preemption victims
6. **Accurate resource requests are mandatory** — preemption cannot fire for pods with no requests
7. **Monitor preemption events** — frequent preemption indicates chronic capacity shortage that auto-scaling should address
