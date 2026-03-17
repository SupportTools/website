---
title: "Kubernetes Pod Affinity and Anti-Affinity: Topology Constraints for HA Deployments"
date: 2029-03-08T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Scheduling", "High Availability", "Topology", "Anti-Affinity", "StatefulSets"]
categories:
- Kubernetes
- Operations
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Kubernetes pod affinity, anti-affinity, and topology spread constraints for achieving high availability across zones and nodes, including StatefulSet scheduling patterns and common scheduling deadlocks."
more_link: "yes"
url: "/kubernetes-pod-affinity-anti-affinity-topology-constraints-ha-deep-dive/"
---

Pod scheduling in Kubernetes is deterministic but not automatic — the scheduler places pods on nodes that satisfy resource requests, but it has no innate understanding of high availability. Without affinity rules, a 3-replica Deployment can legitimately place all three pods on the same node. A single node failure then takes down the entire service. Affinity and anti-affinity rules, combined with `topologySpreadConstraints`, give operators precise control over where pods land relative to each other and the underlying infrastructure topology. This post covers the complete scheduling API with production-grade configurations for multi-zone HA deployments.

<!--more-->

## The Scheduling Taxonomy

Kubernetes offers four interrelated scheduling directives:

| Directive | Scope | Effect |
|-----------|-------|--------|
| `nodeSelector` | Node labels | Hard requirement: node must match |
| `nodeAffinity` | Node labels | Required or preferred: node-level constraints |
| `podAffinity` | Pod labels | Co-locate with matching pods |
| `podAntiAffinity` | Pod labels | Separate from matching pods |
| `topologySpreadConstraints` | Pod labels + topology keys | Spread evenly across topology domains |

For HA workloads, `podAntiAffinity` and `topologySpreadConstraints` are the primary tools. `podAffinity` is primarily used for co-location optimization (placing pods near their data sources).

## Required vs. Preferred Scheduling

### requiredDuringSchedulingIgnoredDuringExecution

This is a hard rule. If no node satisfies the condition, the pod remains `Pending` indefinitely. Use this for strict HA requirements:

```yaml
# Pod must NOT be placed on any node that already runs a pod with matching labels
spec:
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app: payment-api
              version: "v2"
          topologyKey: kubernetes.io/hostname
```

### preferredDuringSchedulingIgnoredDuringExecution

This is a soft rule with a weight (1-100). The scheduler adds weight to nodes satisfying the rule during scoring. Use for best-effort spreading:

```yaml
spec:
  affinity:
    podAntiAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          podAffinityTerm:
            labelSelector:
              matchLabels:
                app: payment-api
            topologyKey: kubernetes.io/hostname
        - weight: 50
          podAffinityTerm:
            labelSelector:
              matchLabels:
                app: payment-api
            topologyKey: topology.kubernetes.io/zone
```

## Zone-Level Anti-Affinity for Multi-AZ Deployments

### Three-Zone HA Pattern

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-api
  namespace: production
spec:
  replicas: 6  # 2 per zone in a 3-zone cluster
  selector:
    matchLabels:
      app: payment-api
  template:
    metadata:
      labels:
        app: payment-api
        component: api-server
    spec:
      affinity:
        # Hard: never put two pods from this deployment in the same zone
        # This requires exactly 3 AZs to schedule 3+ replicas
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchExpressions:
                  - key: app
                    operator: In
                    values:
                      - payment-api
              topologyKey: topology.kubernetes.io/zone
              namespaceSelector: {}

      topologySpreadConstraints:
        # Distribute evenly across zones (max skew of 1 between zones)
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: payment-api
          minDomains: 3  # Require all 3 zones to be available

        # Also spread across nodes within each zone
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels:
              app: payment-api

      containers:
        - name: api-server
          image: acme-registry.internal/payments/api:v2.14.3
          resources:
            requests:
              cpu: "500m"
              memory: "512Mi"
            limits:
              cpu: "2000m"
              memory: "2Gi"
```

### Verifying Zone Distribution

```bash
# Check pod distribution across zones
kubectl get pods -n production -l app=payment-api \
  -o custom-columns='NAME:.metadata.name,NODE:.spec.nodeName,STATUS:.status.phase' | \
  sort -k2

# Join with node zone labels
for pod in $(kubectl get pods -n production -l app=payment-api -o name); do
    node=$(kubectl get $pod -n production -o jsonpath='{.spec.nodeName}')
    zone=$(kubectl get node $node -o jsonpath='{.metadata.labels.topology\.kubernetes\.io/zone}')
    echo "$pod -> $node -> $zone"
done
```

## StatefulSet Anti-Affinity Patterns

StatefulSets require careful affinity configuration because replicas have stable identities. Using `podAntiAffinity` with `matchLabels` on the StatefulSet's pod template labels ensures spreading:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis-cluster
  namespace: cache
spec:
  serviceName: redis-cluster
  replicas: 6  # 3 masters + 3 replicas, 2 per zone
  selector:
    matchLabels:
      app: redis-cluster
  template:
    metadata:
      labels:
        app: redis-cluster
        component: cache
    spec:
      affinity:
        podAntiAffinity:
          # Hard: no two Redis pods on the same node
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: redis-cluster
              topologyKey: kubernetes.io/hostname

          # Preferred: try to spread across zones
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 80
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    app: redis-cluster
                topologyKey: topology.kubernetes.io/zone

      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels:
              app: redis-cluster

      terminationGracePeriodSeconds: 30
      containers:
        - name: redis
          image: redis:7.2.4-alpine
          ports:
            - name: redis
              containerPort: 6379
            - name: gossip
              containerPort: 16379
          resources:
            requests:
              cpu: "250m"
              memory: "4Gi"
            limits:
              cpu: "1000m"
              memory: "4Gi"
          readinessProbe:
            exec:
              command:
                - redis-cli
                - ping
            initialDelaySeconds: 5
            periodSeconds: 5
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: gp3-encrypted
        resources:
          requests:
            storage: 50Gi
```

## Co-Location Affinity: Placing Pods Near Data

Some workloads benefit from being on the same node as their data tier (to avoid network latency). `podAffinity` achieves this:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: event-processor
  namespace: streaming
spec:
  replicas: 3
  selector:
    matchLabels:
      app: event-processor
  template:
    metadata:
      labels:
        app: event-processor
    spec:
      affinity:
        podAffinity:
          # Prefer to land on nodes that run Kafka brokers (reduces network hops)
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 90
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    app: kafka
                    component: broker
                topologyKey: kubernetes.io/hostname

        # But still spread across zones to maintain HA
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    app: event-processor
                topologyKey: topology.kubernetes.io/zone
```

## Node Affinity for Instance Type Targeting

```yaml
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          # Require nodes in specific AZs only
          - matchExpressions:
              - key: topology.kubernetes.io/zone
                operator: In
                values:
                  - us-east-1a
                  - us-east-1b
                  - us-east-1c
              # Require nodes with NVMe local storage
              - key: node.kubernetes.io/instance-type
                operator: In
                values:
                  - r6gd.4xlarge
                  - r6gd.8xlarge
                  - r6gd.16xlarge

      preferredDuringSchedulingIgnoredDuringExecution:
        # Prefer newer generation instances
        - weight: 100
          preference:
            matchExpressions:
              - key: node.kubernetes.io/instance-type
                operator: In
                values:
                  - r6gd.8xlarge
                  - r6gd.16xlarge
        # Avoid spot instances for this critical workload
        - weight: -100
          preference:
            matchExpressions:
              - key: eks.amazonaws.com/capacityType
                operator: In
                values:
                  - SPOT
```

## topologySpreadConstraints Deep Dive

`topologySpreadConstraints` is the preferred approach for spreading since Kubernetes 1.19 stable. It provides finer control than anti-affinity:

```yaml
# Advanced topology spread: distribute across zones AND racks within zones
spec:
  topologySpreadConstraints:
    # Primary: even zone distribution with hard enforcement
    - maxSkew: 1
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: DoNotSchedule
      labelSelector:
        matchLabels:
          app: database-proxy
      minDomains: 3
      nodeAffinityPolicy: Honor    # Only count nodes matching nodeAffinity
      nodeTaintsPolicy: Honor      # Don't count nodes with unmatched taints
      matchLabelKeys:
        - pod-template-hash         # Use hash to only spread same-version pods together

    # Secondary: soft rack-level spreading within zones
    - maxSkew: 2
      topologyKey: topology.kubernetes.io/rack
      whenUnsatisfiable: ScheduleAnyway
      labelSelector:
        matchLabels:
          app: database-proxy
```

## Diagnosing Scheduling Failures

### The 2-Node Anti-Affinity Deadlock

A classic mistake: `requiredDuringScheduling` anti-affinity on `kubernetes.io/hostname` with fewer nodes than replicas. The scheduler cannot place replica 3 when only 2 nodes are available.

```bash
# Diagnose pending pods
kubectl describe pod payment-api-xyz -n production | tail -20
# Events:
#   Warning  FailedScheduling  0s/5s  default-scheduler
#     0/3 nodes are available:
#     3 node(s) didn't match pod anti-affinity rules. preemption: 0/3 nodes are available:
#     3 Preemption is not helpful for pod anti-affinity.

# Check how many nodes are in each zone
kubectl get nodes -L topology.kubernetes.io/zone | awk '{print $NF}' | sort | uniq -c
```

### Checking Effective Scheduling Topology

```bash
#!/bin/bash
# audit-scheduling-spread.sh — verify actual vs desired pod distribution
set -euo pipefail

NAMESPACE="${1:?Usage: $0 <namespace> <label-selector>}"
SELECTOR="${2:?}"

echo "=== Zone Distribution ==="
kubectl get pods -n "${NAMESPACE}" -l "${SELECTOR}" \
  -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}' | \
while read -r node; do
    kubectl get node "${node}" \
      -o jsonpath="{.metadata.labels['topology\.kubernetes\.io/zone']}{\"\\n\"}"
done | sort | uniq -c | sort -rn

echo ""
echo "=== Node Distribution ==="
kubectl get pods -n "${NAMESPACE}" -l "${SELECTOR}" \
  -o custom-columns='POD:.metadata.name,NODE:.spec.nodeName' | \
  awk '{print $2}' | sort | uniq -c | sort -rn

echo ""
echo "=== Pending Pods ==="
kubectl get pods -n "${NAMESPACE}" -l "${SELECTOR}" \
  --field-selector status.phase=Pending
```

## PodDisruptionBudget Integration

Anti-affinity rules ensure spread at scheduling time. PodDisruptionBudgets enforce spread during voluntary disruptions (node drains):

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-api-pdb
  namespace: production
spec:
  minAvailable: "67%"  # At least 2 of 3 zones worth of pods must be running
  selector:
    matchLabels:
      app: payment-api
      component: api-server
```

```yaml
# For StatefulSets, be more conservative
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: redis-cluster-pdb
  namespace: cache
spec:
  maxUnavailable: 1   # Never allow more than 1 replica to be down at once
  selector:
    matchLabels:
      app: redis-cluster
```

## Production Anti-Patterns

### Anti-Pattern 1: Hostname Anti-Affinity Without Adequate Nodes

```yaml
# Wrong: hard anti-affinity when replicas > node count
# This leaves the deployment perpetually under-replicated
affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchLabels:
            app: my-service
        topologyKey: kubernetes.io/hostname

# Correct: use preferred for hostname, required only for zone
affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchLabels:
            app: my-service
        topologyKey: topology.kubernetes.io/zone
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          labelSelector:
            matchLabels:
              app: my-service
          topologyKey: kubernetes.io/hostname
```

### Anti-Pattern 2: Missing matchLabelKeys for Rolling Deployments

During a rolling update, two ReplicaSets coexist. Without `matchLabelKeys: [pod-template-hash]`, anti-affinity rules treat old and new pods as the same workload and may prevent new pods from scheduling:

```yaml
# Kubernetes 1.29+ feature: matchLabelKeys ensures constraints only
# apply between pods of the same ReplicaSet
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: DoNotSchedule
    labelSelector:
      matchLabels:
        app: payment-api
    matchLabelKeys:
      - pod-template-hash  # Differentiates old vs new ReplicaSet pods
```

### Anti-Pattern 3: Ignoring minDomains

Without `minDomains`, a 3-zone deployment will schedule all replicas into 1 zone if only 1 zone has available capacity. `minDomains: 3` enforces that all 3 zones must accept pods:

```yaml
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: DoNotSchedule
    minDomains: 3  # Require all 3 zones — fail rather than concentrate
    labelSelector:
      matchLabels:
        app: payment-api
```

## Summary

Production HA scheduling in Kubernetes requires composing multiple mechanisms:

- **`requiredDuringScheduling` zone anti-affinity** ensures replicas never share a zone, providing hard failure isolation
- **`preferredDuringScheduling` hostname anti-affinity** distributes within a zone without creating unschedulable conditions
- **`topologySpreadConstraints`** provides precise skew control with `minDomains` enforcement and `matchLabelKeys` for rolling update safety
- **`PodDisruptionBudgets`** protect running distributions from collapsing during maintenance
- **`nodeAffinity`** targets specific instance types and excludes spot capacity for critical workloads

The combination of `requiredDuringScheduling` zone anti-affinity + `topologySpreadConstraints` with `maxSkew: 1` + a PDB with `minAvailable: 67%` is the standard pattern for three-zone active-active services.
