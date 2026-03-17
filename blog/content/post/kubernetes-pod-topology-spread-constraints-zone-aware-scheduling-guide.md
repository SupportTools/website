---
title: "Kubernetes Pod Topology Spread Constraints: Zone-Aware Scheduling, maxSkew, whenUnsatisfiable, and Label Selectors"
date: 2031-11-24T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Scheduling", "Topology", "High Availability", "Zone Awareness", "Pod Scheduling", "Production"]
categories:
- Kubernetes
- Platform Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete production guide to Kubernetes Pod Topology Spread Constraints: implementing zone-aware scheduling for high availability, tuning maxSkew for flexibility vs. strict balance, choosing whenUnsatisfiable policies, combining with affinity rules, and debugging scheduling failures."
more_link: "yes"
url: "/kubernetes-pod-topology-spread-constraints-zone-aware-scheduling-guide/"
---

Topology spread constraints are the correct tool for distributing pods across failure domains in Kubernetes. Before they were introduced, teams used a combination of pod anti-affinity rules and manual zone configuration — approaches that worked but were rigid, hard to tune, and produced confusing scheduling failures. Topology spread constraints provide a first-class way to express "spread these pods across availability zones" with configurable tolerance for imbalance, and they compose cleanly with node affinity and pod affinity rules.

This guide covers the complete topology spread constraints model: the topology key concept, maxSkew semantics, whenUnsatisfiable policies, matching label selectors, combining multiple constraints, cluster-level defaults, and the diagnostic workflow for debugging scheduling failures.

<!--more-->

# Kubernetes Pod Topology Spread Constraints

## The Problem They Solve

Without topology spread constraints, distributing pods across zones requires pod anti-affinity with `topologyKey: topology.kubernetes.io/zone`:

```yaml
# Old approach: pod anti-affinity (still valid but inflexible)
affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
    - labelSelector:
        matchLabels:
          app: my-service
      topologyKey: topology.kubernetes.io/zone
```

This approach has problems:
- **Inflexible**: With 3 zones and 6 pods, the scheduler cannot place 2 pods per zone — `required` anti-affinity means at most 1 pod per zone
- **Unschedulable at scale**: With `requiredDuringScheduling`, if one zone has 0 nodes, the scheduler cannot place more pods than you have zones
- **No skew tolerance**: You cannot say "prefer balanced but allow up to N extra"

Topology spread constraints solve all of this.

## Core Concepts

### Topology Domain

A topology domain is a group of nodes that share a common label value. For availability zones:

```bash
# Nodes in us-east-1a
kubectl get nodes -l topology.kubernetes.io/zone=us-east-1a

# Node topology labels (automatically set by cloud provider)
kubectl get node <node-name> -o json | jq '.metadata.labels | {
  zone: .["topology.kubernetes.io/zone"],
  region: .["topology.kubernetes.io/region"],
  hostname: .["kubernetes.io/hostname"]
}'
```

### maxSkew

`maxSkew` defines the maximum allowed difference in pod count between any two topology domains. It is the most important parameter to understand:

```
3 zones: us-east-1a, us-east-1b, us-east-1c
6 pods, maxSkew=1:

Allowed:   2  2  2  (perfectly balanced, skew=0)
Allowed:   3  2  1  (max is 3, min is 1, skew=2... wait, that's wrong)
```

Actually, maxSkew=1 means the difference between the domain with the MOST pods and the domain with the FEWEST pods must be ≤ 1:

```
2  2  2  -> max=2, min=2, skew=0 ✓ (0 ≤ 1)
3  2  1  -> max=3, min=1, skew=2 ✗ (2 > 1)
2  2  1  -> max=2, min=1, skew=1 ✓ (1 ≤ 1)
3  2  2  -> max=3, min=2, skew=1 ✓ (1 ≤ 1)
```

### whenUnsatisfiable

When the spread constraint cannot be satisfied:

- **DoNotSchedule**: Pod remains Pending until the constraint can be satisfied. Use for strict HA requirements.
- **ScheduleAnyway**: Pod is scheduled despite the violation, but the scheduler still tries to minimize skew. Use for best-effort spreading.

## Basic Zone-Aware Deployment

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
      # Spread across availability zones
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: api-server
        # matchLabelKeys: new in 1.27 — automatically includes pod-template-hash
        # to prevent old pods from affecting new pod scheduling during rollouts
        matchLabelKeys:
        - pod-template-hash

      containers:
      - name: api-server
        image: api-server:latest
        resources:
          requests:
            cpu: 250m
            memory: 256Mi
```

### Understanding matchLabelKeys

`matchLabelKeys` is a critical addition for rolling deployments. Without it:

```
During a rolling update, old pods (ReplicaSet A) and new pods (ReplicaSet B)
both have app=api-server but different pod-template-hash values.

Without matchLabelKeys:
Zone A: [old-pod-1, old-pod-2, new-pod-1]  (3 pods)
Zone B: [old-pod-3, new-pod-2]              (2 pods)
Zone C: [new-pod-3]                         (1 pod)
New pod scheduling blocked because zone A already has 3

With matchLabelKeys: [pod-template-hash]
Each ReplicaSet's pods are evaluated independently:
Old pods: 2, 2, 2 (balanced)
New pods: 1, 1, 1 (balanced independently)
Rolling update proceeds smoothly
```

## Advanced Constraint Patterns

### Multiple Constraints (Zone + Node)

Combining constraints allows zone spreading AND even distribution within zones:

```yaml
topologySpreadConstraints:
# Primary: spread across zones (hard constraint)
- maxSkew: 1
  topologyKey: topology.kubernetes.io/zone
  whenUnsatisfiable: DoNotSchedule
  labelSelector:
    matchLabels:
      app: api-server

# Secondary: spread across nodes within each zone (soft constraint)
- maxSkew: 2
  topologyKey: kubernetes.io/hostname
  whenUnsatisfiable: ScheduleAnyway
  labelSelector:
    matchLabels:
      app: api-server
```

With these constraints:
1. The scheduler MUST place pods in a balanced zone distribution (maxSkew=1, DoNotSchedule)
2. The scheduler TRIES to spread pods across individual nodes within each zone (maxSkew=2, ScheduleAnyway — will not block scheduling)

### Custom Topology Keys

You can spread across any node label, not just the standard ones:

```bash
# Label nodes by rack for data center deployments
kubectl label node rack01-host01 topology.example.com/rack=rack01
kubectl label node rack01-host02 topology.example.com/rack=rack01
kubectl label node rack02-host01 topology.example.com/rack=rack02
kubectl label node rack02-host02 topology.example.com/rack=rack02
```

```yaml
topologySpreadConstraints:
- maxSkew: 1
  topologyKey: topology.example.com/rack
  whenUnsatisfiable: DoNotSchedule
  labelSelector:
    matchLabels:
      app: database-replica
```

### Spreading with Node Affinity

Combining topology spread with node affinity restricts WHICH nodes are considered:

```yaml
spec:
  # Only schedule on nodes with SSD storage
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
        - matchExpressions:
          - key: storage-type
            operator: In
            values: ["nvme", "ssd"]

  # AND spread evenly across zones on those SSD nodes
  topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: DoNotSchedule
    labelSelector:
      matchLabels:
        app: database
    # nodeAffinityPolicy: Honor ensures the spread only counts pods
    # on nodes that match the nodeAffinity
    nodeAffinityPolicy: Honor
    nodeTaintsPolicy: Honor
```

`nodeAffinityPolicy` and `nodeTaintsPolicy` control which nodes are counted:

- `Honor`: Only count pods on nodes that match the nodeAffinity/tolerate the taint
- `Ignore`: Count all pods on all nodes (old behavior)

### minDomains: Requiring Minimum Zone Count

```yaml
topologySpreadConstraints:
- maxSkew: 1
  minDomains: 3        # Require at least 3 zones to be available
  topologyKey: topology.kubernetes.io/zone
  whenUnsatisfiable: DoNotSchedule
  labelSelector:
    matchLabels:
      app: api-server
```

With `minDomains: 3`, if fewer than 3 zones have eligible nodes, the pods remain Pending. This is useful for HA requirements that mandate deployment in at least N zones.

## Cluster-Level Default Constraints

Set default spread constraints for all pods via `kube-scheduler` configuration:

```yaml
# kube-scheduler configuration
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
profiles:
- schedulerName: default-scheduler
  pluginConfig:
  - name: PodTopologySpread
    args:
      defaultConstraints:
      # Default: spread across zones for all pods
      - maxSkew: 3
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: ScheduleAnyway
      # Default: spread across nodes
      - maxSkew: 5
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: ScheduleAnyway
      # Only apply defaults when no constraints are explicitly set
      defaultingType: List
```

Pods can override cluster defaults by setting explicit `topologySpreadConstraints`. To opt out of defaults entirely:

```yaml
spec:
  topologySpreadConstraints: []  # Explicitly empty: opt out of defaults
```

## Production Examples

### Stateful Application (Database Replicas)

For Cassandra or similar multi-master databases, you want strict zone isolation:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: cassandra
  namespace: production
spec:
  replicas: 6  # 2 per zone in 3-zone deployment
  serviceName: cassandra
  selector:
    matchLabels:
      app: cassandra
  template:
    metadata:
      labels:
        app: cassandra
    spec:
      topologySpreadConstraints:
      # Strict zone balance: exactly 2 per zone
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: cassandra
        minDomains: 3

      # Within each zone, spread across different nodes
      - maxSkew: 1
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: cassandra

      # Hard anti-affinity to prevent two replicas on same node
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: cassandra
            topologyKey: kubernetes.io/hostname

      terminationGracePeriodSeconds: 120
```

### High-Traffic API Service

For APIs where slight imbalance is acceptable but zone failure must not cause an outage:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-api
  namespace: production
spec:
  replicas: 12
  selector:
    matchLabels:
      app: payment-api
  template:
    metadata:
      labels:
        app: payment-api
    spec:
      topologySpreadConstraints:
      # Zone spreading: strict (DoNotSchedule ensures zone failure resilience)
      - maxSkew: 2          # Allow slight imbalance for rolling updates
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: payment-api
        matchLabelKeys:
        - pod-template-hash

      # Node spreading: best effort (don't block scheduling)
      - maxSkew: 3
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: ScheduleAnyway
        labelSelector:
          matchLabels:
            app: payment-api

      # Disruption budget to prevent outage during node maintenance
      containers:
      - name: payment-api
        image: payment-api:latest
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
          limits:
            cpu: "2"
            memory: 2Gi
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-api-pdb
  namespace: production
spec:
  minAvailable: "75%"
  selector:
    matchLabels:
      app: payment-api
```

### Single-Replica Per Zone (Strict)

When you need exactly one pod per zone (e.g., a zone-local cache or DaemonSet-like deployment via Deployment):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: zone-cache
  namespace: production
spec:
  replicas: 3  # Must match number of zones
  selector:
    matchLabels:
      app: zone-cache
  template:
    metadata:
      labels:
        app: zone-cache
    spec:
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: zone-cache
        minDomains: 3

      # Hard anti-affinity ensures only 1 per zone
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: zone-cache
            topologyKey: topology.kubernetes.io/zone
```

## Debugging Scheduling Failures

### Pod Stuck in Pending

```bash
# Get pending pods
kubectl get pods -n production --field-selector=status.phase=Pending

# Describe for scheduling details
kubectl describe pod payment-api-xyz -n production

# Look for events section at the bottom
# Common messages:
# "0/9 nodes are available: 3 node(s) didn't match pod topology spread constraints."
# "0/9 nodes are available: 3 node(s) had untolerated taint"
```

### Using kubectl-topology for Visualization

```bash
# Install kubectl-topology plugin
kubectl krew install topology

# Show topology spread for all pods with label app=payment-api
kubectl topology pods -n production -l app=payment-api

# Output shows distribution across zones
# Zone us-east-1a: payment-api-1, payment-api-4, payment-api-7
# Zone us-east-1b: payment-api-2, payment-api-5, payment-api-8
# Zone us-east-1c: payment-api-3, payment-api-6, payment-api-9
```

### Manual Topology Analysis

```bash
#!/bin/bash
# topology-check.sh
# Shows pod distribution across zones for a label selector

NAMESPACE=${1:-"production"}
LABEL=${2:-"app=payment-api"}

echo "Pod distribution for $LABEL in namespace $NAMESPACE"
echo "---"

kubectl get pods -n "$NAMESPACE" -l "$LABEL" \
  -o json | \
  jq -r '.items[] |
    {
      name: .metadata.name,
      node: .spec.nodeName,
      phase: .status.phase
    } |
    "\(.phase)\t\(.node)\t\(.name)"' | \
  sort | \
  while IFS=$'\t' read -r phase node pod; do
    zone=$(kubectl get node "$node" -o jsonpath='{.metadata.labels.topology\.kubernetes\.io/zone}' 2>/dev/null)
    echo "$zone  $node  $pod  ($phase)"
  done | \
  sort

echo ""
echo "Zone counts:"
kubectl get pods -n "$NAMESPACE" -l "$LABEL" \
  -o json | \
  jq -r '.items[].spec.nodeName' | \
  while read -r node; do
    kubectl get node "$node" -o jsonpath='{.metadata.labels.topology\.kubernetes\.io/zone}'
    echo ""
  done | \
  sort | uniq -c | sort -rn
```

### Scheduler Simulation

Use `kubectl --dry-run=server` to test scheduling:

```bash
# Check if a pod would schedule
kubectl run test-pod \
  --image=nginx \
  --dry-run=server \
  -o yaml \
  --overrides='{
    "spec": {
      "topologySpreadConstraints": [{
        "maxSkew": 1,
        "topologyKey": "topology.kubernetes.io/zone",
        "whenUnsatisfiable": "DoNotSchedule",
        "labelSelector": {"matchLabels": {"app": "test-pod"}}
      }]
    }
  }'
# If it fails with "no nodes available", you can see the reason
```

## Interaction with Horizontal Pod Autoscaler

When HPA scales up replicas, topology spread constraints affect where new pods land:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: payment-api-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-api
  minReplicas: 6
  maxReplicas: 30
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70

  # Scaling behavior: scale out in increments of 3 to maintain zone balance
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 30
      policies:
      # Scale up by 3 pods at a time (1 per zone)
      - type: Pods
        value: 3
        periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      # Scale down by 3 pods at a time (1 per zone)
      - type: Pods
        value: 3
        periodSeconds: 120
```

By scaling in multiples of 3 (for a 3-zone cluster), you maintain topology balance throughout the scaling event.

## Common Pitfalls and Solutions

### Pitfall 1: All Pods in One Zone After Node Failure

If zone A loses all nodes, existing pods are already running there. New pods cannot schedule there, so they go to zones B and C. This creates imbalance.

**Solution**: Use `whenUnsatisfiable: ScheduleAnyway` for scale-out resilience, but monitor for imbalance.

```yaml
# Monitoring query for zone imbalance
# Prometheus
max(kube_pod_info{namespace="production", pod=~"payment-api.*"}) by (node)
/ on(node) kube_node_labels{label_topology_kubernetes_io_zone=~".*"}
```

### Pitfall 2: Topology Spread + Pod Affinity Deadlock

If you combine hard pod anti-affinity (required) with topology spread constraints (DoNotSchedule), you can create a situation where no node satisfies both:

**Solution**: Use topology spread constraints instead of pod anti-affinity where possible, not in addition to it.

### Pitfall 3: maxSkew Too Small for Rolling Updates

With `maxSkew: 1` and `DoNotSchedule` during a rolling update:

```
Before update: 3 pods per zone = [3, 3, 3]
Rolling update terminates one pod: [2, 3, 3] skew=1 ✓
New pod can only go to zone A: [3, 3, 3] ✓
But if two pods terminate before new ones start: [2, 2, 3] skew=1 ✓
   New pod can go to zone A or B
```

Generally `maxSkew: 1` works with rolling updates. Use `matchLabelKeys: [pod-template-hash]` to make new pods independent of old pods during the rollout.

## Summary

Pod Topology Spread Constraints are the correct, first-class mechanism for distributing pods across failure domains in Kubernetes. The key design decisions are: choose `DoNotSchedule` for strict HA requirements where zone failure protection is non-negotiable, and `ScheduleAnyway` for best-effort spreading that should not block deployments. Set `maxSkew: 1` for strict balance and `maxSkew: 2-3` when slight imbalance is acceptable during rolling updates. Use `matchLabelKeys: [pod-template-hash]` in all production deployments to prevent old pods from interfering with new pod placement during rollouts. Combine with `minDomains` when your SLO requires a minimum number of active zones. With these patterns in place, your application will survive individual zone failures without traffic loss.
