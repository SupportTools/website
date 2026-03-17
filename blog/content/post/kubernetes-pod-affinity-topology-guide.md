---
title: "Kubernetes Pod Affinity and Topology Spread: Advanced Workload Placement"
date: 2028-02-04T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Pod Affinity", "Topology Spread", "Scheduling", "High Availability", "Descheduler"]
categories:
- Kubernetes
- Platform Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into Kubernetes pod affinity, anti-affinity rules, and topologySpreadConstraints for achieving resilient multi-AZ workload placement in production clusters."
more_link: "yes"
url: "/kubernetes-pod-affinity-topology-spread-advanced-guide/"
---

Production Kubernetes workloads demand precise placement control to satisfy availability, latency, and compliance requirements. Pod affinity, pod anti-affinity, and topology spread constraints give platform engineers the tools to enforce these requirements declaratively. This guide covers the full spectrum of placement controls — from basic anti-affinity patterns to multi-window topology spread with descheduler-driven rebalancing — targeting environments where node failures and zone outages must not cause service degradation.

<!--more-->

# Kubernetes Pod Affinity and Topology Spread: Advanced Workload Placement

## The Placement Problem in Production Clusters

A Kubernetes scheduler places pods based on resource availability by default. Left unconstrained, replicas of the same deployment cluster on the same node, the same availability zone, or even the same rack. A single hardware failure or cloud provider zone outage then takes down all replicas simultaneously.

The inverse problem also exists: services that must communicate with low latency get scheduled across zones, adding inter-zone network costs and latency. Both problems require explicit placement policies.

Kubernetes provides three complementary mechanisms:

- **Node affinity** — constrain pods to specific nodes based on node labels
- **Pod affinity and anti-affinity** — constrain pods relative to other pods' locations
- **Topology spread constraints** — distribute pods evenly across topology domains

## Node Affinity: Baseline Node Selection

Node affinity replaces the deprecated `nodeSelector` with expressive match expressions.

```yaml
# node-affinity-example.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: analytics-worker
  namespace: data-platform
spec:
  replicas: 6
  selector:
    matchLabels:
      app: analytics-worker
  template:
    metadata:
      labels:
        app: analytics-worker
    spec:
      affinity:
        nodeAffinity:
          # Hard requirement: pod MUST land on nodes matching this expression.
          # If no matching node exists, pod stays Pending indefinitely.
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              # Only schedule on nodes with the "compute" role label
              - key: node-role/compute
                operator: In
                values: ["true"]
              # Exclude nodes reserved for system workloads
              - key: node-role/system
                operator: DoesNotExist
          # Soft preference: prefer nodes in us-east-1a, but fallback allowed.
          # Weight 0-100; higher weight = stronger preference.
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 80
            preference:
              matchExpressions:
              - key: topology.kubernetes.io/zone
                operator: In
                values: ["us-east-1a"]
          - weight: 40
            preference:
              matchExpressions:
              - key: node.kubernetes.io/instance-type
                operator: In
                values: ["m6i.4xlarge", "m6i.8xlarge"]
      containers:
      - name: worker
        image: registry.example.com/analytics-worker:v2.1.0
        resources:
          requests:
            cpu: "2"
            memory: 4Gi
          limits:
            cpu: "4"
            memory: 8Gi
```

The `IgnoredDuringExecution` suffix means the scheduler evaluates affinity only at pod creation time. A running pod is not evicted if node labels change after scheduling. The hypothetical `RequiredDuringExecution` variant (not yet generally available in upstream Kubernetes as of 2028) would trigger eviction on label change.

## Pod Affinity: Co-location Patterns

Pod affinity pulls pods toward topology domains where matching pods already run. Use it for latency-sensitive service pairs or for cache-locality patterns.

```yaml
# pod-affinity-colocation.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cache-sidecar
  namespace: ecommerce
spec:
  replicas: 4
  selector:
    matchLabels:
      app: cache-sidecar
  template:
    metadata:
      labels:
        app: cache-sidecar
        tier: cache
    spec:
      affinity:
        podAffinity:
          # Hard requirement: must schedule on a node that already runs
          # a pod with app=product-api in the SAME namespace.
          # topologyKey defines the "same" scope — here, the same node.
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: product-api
            # namespaces: [] means only the pod's own namespace
            namespaces:
            - ecommerce
            # topologyKey: kubernetes.io/hostname  => same node
            # topologyKey: topology.kubernetes.io/zone => same AZ
            topologyKey: kubernetes.io/hostname
          # Soft preference: prefer nodes in the same zone as redis pods
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 60
            podAffinityTerm:
              labelSelector:
                matchExpressions:
                - key: app
                  operator: In
                  values: ["redis-primary"]
              topologyKey: topology.kubernetes.io/zone
      containers:
      - name: cache-sidecar
        image: registry.example.com/cache-sidecar:v1.4.2
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
```

### Namespace Selector for Cross-Namespace Affinity

Kubernetes 1.24+ supports `namespaceSelector` for cross-namespace pod affinity rules:

```yaml
# cross-namespace-affinity.yaml
spec:
  affinity:
    podAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchLabels:
            app: payment-service
        # Match pods in namespaces labeled with team=payments
        namespaceSelector:
          matchLabels:
            team: payments
        topologyKey: kubernetes.io/hostname
```

## Pod Anti-Affinity: Spreading Replicas

Anti-affinity is the most commonly needed placement control. Replicas of the same workload must not share a failure domain.

```yaml
# pod-anti-affinity-ha.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-api
  namespace: payments
spec:
  replicas: 9  # 3 per AZ in a 3-AZ cluster
  selector:
    matchLabels:
      app: payment-api
  template:
    metadata:
      labels:
        app: payment-api
        version: v3.2.1
    spec:
      affinity:
        podAntiAffinity:
          # Hard: no two payment-api pods on the same node.
          # This is appropriate for stateful or high-security workloads.
          # WARNING: If replicas > nodes, pods will go Pending.
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: payment-api
            topologyKey: kubernetes.io/hostname
          # Soft: prefer spreading across AZs.
          # Using "preferred" here because we might scale beyond 3 replicas
          # and do not want pods stuck in Pending due to AZ exhaustion.
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchLabels:
                  app: payment-api
              topologyKey: topology.kubernetes.io/zone
      topologySpreadConstraints:
      # Enforce AZ balance independently of anti-affinity
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: payment-api
      containers:
      - name: payment-api
        image: registry.example.com/payment-api:v3.2.1
        resources:
          requests:
            cpu: "1"
            memory: 2Gi
```

### Choosing Between required and preferred

| Scenario | Recommendation |
|---|---|
| Replicas < total nodes, HA is critical | `requiredDuringScheduling` on hostname |
| Large replica count might exceed node count | `preferredDuringScheduling` on hostname |
| AZ spread, 3 AZs with variable replica count | `topologySpreadConstraints` with `maxSkew: 1` |
| Latency-sensitive colocation | `requiredDuringScheduling` podAffinity on hostname |
| Compliance: no data sharing between nodes | `requiredDuringScheduling` anti-affinity on hostname |

## Topology Spread Constraints: Fine-Grained Distribution

`topologySpreadConstraints` provides more expressive spread control than anti-affinity. It works by counting pods across topology domains and enforcing a maximum imbalance (skew).

```yaml
# topology-spread-constraints.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend-web
  namespace: production
spec:
  replicas: 12
  selector:
    matchLabels:
      app: frontend-web
  template:
    metadata:
      labels:
        app: frontend-web
        environment: production
    spec:
      topologySpreadConstraints:
      # Constraint 1: Spread across AZs with max skew of 1.
      # With 12 replicas across 3 AZs: 4-4-4 is valid, 5-4-3 is valid (skew=2? no, skew=max-min=5-3=2 > 1, INVALID).
      # Scheduler will target 4-4-4 distribution.
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        # DoNotSchedule: hard constraint, pod stays Pending if constraint cannot be met
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: frontend-web
        # minDomains: require at least N topology domains to exist.
        # Prevents all pods going to a single AZ when only 1 AZ has nodes.
        minDomains: 3

      # Constraint 2: Spread across nodes within each AZ.
      # This allows at most 2 pods per node (soft via ScheduleAnyway).
      - maxSkew: 2
        topologyKey: kubernetes.io/hostname
        # ScheduleAnyway: soft constraint; scheduler still tries to spread
        # but will schedule even if constraint is violated.
        whenUnsatisfiable: ScheduleAnyway
        labelSelector:
          matchLabels:
            app: frontend-web

      containers:
      - name: frontend-web
        image: registry.example.com/frontend-web:v5.0.3
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
```

### Understanding maxSkew Calculation

The skew is computed as: `max(pod count in domain) - min(pod count in domain)`. With `maxSkew: 1`:

- 3 AZs, 9 pods: 3-3-3 (skew=0, valid), 4-3-2 (skew=2, INVALID)
- 3 AZs, 10 pods: 4-3-3 (skew=1, valid), 4-4-2 (skew=2, INVALID)
- 2 AZs (one lost), 10 pods: scheduler cannot satisfy 3-domain minDomains=3

### NodeAffinityPolicy and NodeTaintPolicy

Kubernetes 1.26+ adds two fields that control how topology spread handles nodes excluded by affinity or taints:

```yaml
# topology-spread-with-policies.yaml
topologySpreadConstraints:
- maxSkew: 1
  topologyKey: topology.kubernetes.io/zone
  whenUnsatisfiable: DoNotSchedule
  labelSelector:
    matchLabels:
      app: data-processor
  # Honor: only count nodes matching the pod's nodeAffinity/nodeSelector
  # Ignore: count all nodes in the topology domain (default behavior)
  nodeAffinityPolicy: Honor
  # Honor: nodes with matching taints and no tolerations are excluded
  # Ignore: all nodes counted regardless of taints
  nodeTaintPolicy: Honor
```

## Multi-AZ Spread Strategy for Stateless Services

A complete, production-tested deployment combining all placement controls:

```yaml
# production-multi-az-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
  namespace: commerce
  annotations:
    # Document the placement rationale for future operators
    placement.policy/rationale: "AZ spread for HA, node spread for blast radius reduction"
    placement.policy/reviewed-by: "platform-team"
    placement.policy/reviewed-at: "2028-01-15"
spec:
  replicas: 6
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
      maxSurge: 2
  selector:
    matchLabels:
      app: order-service
  template:
    metadata:
      labels:
        app: order-service
        tier: backend
        environment: production
    spec:
      # Ensure pods spread across control-plane and worker nodes correctly
      # by using node affinity to target worker nodes only
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: node-role.kubernetes.io/worker
                operator: Exists
        podAntiAffinity:
          # Hard: never co-locate two order-service pods on the same node
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: order-service
            topologyKey: kubernetes.io/hostname

      topologySpreadConstraints:
      # Primary AZ spread: hard constraint
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: order-service
        minDomains: 3
      # Secondary rack spread within AZ: soft constraint
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: ScheduleAnyway
        labelSelector:
          matchLabels:
            app: order-service

      # Grace period for in-flight requests during rolling updates
      terminationGracePeriodSeconds: 60

      containers:
      - name: order-service
        image: registry.example.com/order-service:v4.1.0
        ports:
        - containerPort: 8080
          name: http
        - containerPort: 9090
          name: metrics
        resources:
          requests:
            cpu: "1"
            memory: 2Gi
          limits:
            cpu: "2"
            memory: 4Gi
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
          failureThreshold: 3
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10
```

## Descheduler: Runtime Rebalancing

The Kubernetes scheduler makes placement decisions only at pod creation time. Over time, cluster topology changes: nodes are added or removed, pods are terminated and restarted on suboptimal nodes, and the distribution drifts from the desired state. The Descheduler corrects this by evicting pods that violate placement policies, allowing the scheduler to re-place them optimally.

### Installing the Descheduler

```bash
# Install via Helm
helm repo add descheduler https://kubernetes-sigs.github.io/descheduler/
helm repo update

helm upgrade --install descheduler descheduler/descheduler \
  --namespace kube-system \
  --set schedule="*/5 * * * *" \
  --set deschedulerPolicy.profiles[0].name=production-rebalance \
  --version 0.29.0
```

### Descheduler Policy Configuration

```yaml
# descheduler-policy.yaml
apiVersion: "descheduler/v1alpha2"
kind: "DeschedulerPolicy"
profiles:
- name: production-rebalance
  pluginConfig:
  # RemoveDuplicates: ensures no two pods of the same RS/Deployment
  # are on the same node. Evicts extras.
  - name: RemoveDuplicates
    args:
      # Namespaces to include in duplicate detection
      namespaces:
        include:
        - production
        - commerce
        - payments

  # RemovePodsViolatingTopologySpreadConstraint:
  # Evicts pods that violate topologySpreadConstraints after cluster changes.
  - name: RemovePodsViolatingTopologySpreadConstraint
    args:
      # Only act on hard (DoNotSchedule) constraints
      includeSoftConstraints: false
      namespaces:
        include:
        - production
        - commerce

  # LowNodeUtilization: evict pods from under-utilized nodes
  # to allow them to be rescheduled on less-used nodes.
  # Useful after scale-out when old pods stay on crowded nodes.
  - name: LowNodeUtilization
    args:
      thresholds:
        cpu: 20    # Node is underutilized if CPU < 20%
        memory: 20
        pods: 10
      targetThresholds:
        cpu: 50    # Evict from nodes with CPU > 50%
        memory: 50
        pods: 50
      # Limit evictions per node per run to avoid cascading disruptions
      evictionLimiter:
        maxNoOfPodsToEvictPerNode: 5
        maxNoOfPodsToEvictPerNamespace: 10

  # RemovePodsViolatingNodeAffinity: evict pods that no longer
  # satisfy their nodeAffinity due to node label changes.
  - name: RemovePodsViolatingNodeAffinity
    args:
      nodeAffinityType:
      - requiredDuringSchedulingIgnoredDuringExecution

  plugins:
    balance:
      enabled:
      - RemoveDuplicates
      - RemovePodsViolatingTopologySpreadConstraint
      - LowNodeUtilization
    deschedule:
      enabled:
      - RemovePodsViolatingNodeAffinity
```

### Protecting Critical Pods from Descheduler

```yaml
# Annotate pods that must not be evicted by the descheduler
# This is respected by all descheduler plugins.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: critical-stateful-service
  namespace: production
spec:
  template:
    metadata:
      annotations:
        # Prevents descheduler from evicting these pods
        descheduler.alpha.kubernetes.io/evict: "false"
      labels:
        app: critical-stateful-service
    spec:
      containers:
      - name: service
        image: registry.example.com/critical-service:v1.0.0
```

## Affinity with PodDisruptionBudgets

Placement rules determine initial distribution; PodDisruptionBudgets (PDBs) protect it during voluntary disruptions:

```yaml
# pdb-with-affinity.yaml
# PDB for the payment-api deployment defined earlier
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-api-pdb
  namespace: payments
spec:
  # At least 7 of 9 replicas must remain available during disruptions
  # (node drains, rolling updates from other controllers, descheduler evictions)
  minAvailable: 7
  selector:
    matchLabels:
      app: payment-api
---
# PDB for frontend: percentage-based minimum availability
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: frontend-web-pdb
  namespace: production
spec:
  # At least 75% of replicas remain available
  # For 12 replicas: at least 9 must be up (3 can be disrupted at once)
  minAvailable: "75%"
  selector:
    matchLabels:
      app: frontend-web
```

## Debugging Placement Decisions

When pods remain in `Pending` state due to affinity or topology constraint violations, the Events section provides diagnostic output:

```bash
# Check pending pod events
kubectl describe pod order-service-7d9f5c4b8-xk2pq -n commerce

# Look for messages like:
# Warning  FailedScheduling  didn't match pod affinity rules
# Warning  FailedScheduling  node(s) didn't match topology spread constraints

# Use kube-scheduler verbose output to trace decisions
# Enable --v=10 on the scheduler for detailed placement reasoning

# Get node topology labels to verify spread key accuracy
kubectl get nodes -L topology.kubernetes.io/zone,topology.kubernetes.io/region

# Count pods per zone to check actual vs desired distribution
kubectl get pods -n production -l app=order-service \
  -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}' | sort | uniq -c

# Cross-reference node to zone mapping
kubectl get nodes -o custom-columns='NAME:.metadata.name,ZONE:.metadata.labels.topology\.kubernetes\.io/zone'
```

### Checking Spread Constraint Satisfaction

```bash
# Script to audit topology spread compliance across a namespace
#!/usr/bin/env bash

NAMESPACE="${1:-production}"
APP_LABEL="${2:-app}"

echo "=== Topology Spread Audit for namespace: ${NAMESPACE} ==="

# Get all unique app label values
APPS=$(kubectl get pods -n "${NAMESPACE}" \
  -o jsonpath="{.items[*].metadata.labels.${APP_LABEL}}" | tr ' ' '\n' | sort -u)

for APP in ${APPS}; do
  echo ""
  echo "--- ${APP} ---"
  # Count pods per zone
  kubectl get pods -n "${NAMESPACE}" -l "${APP_LABEL}=${APP}" \
    -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}' | \
    while read -r NODE; do
      kubectl get node "${NODE}" \
        -o jsonpath="{.metadata.labels.topology\.kubernetes\.io/zone}" 2>/dev/null
    done | sort | uniq -c | awk '{print "  Zone " $2 ": " $1 " pod(s)"}'
done
```

## StatefulSet Placement: Special Considerations

StatefulSets require additional care because their pods have stable identities and cannot be freely rescheduled:

```yaml
# statefulset-with-topology-spread.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: kafka-broker
  namespace: messaging
spec:
  serviceName: kafka-broker-headless
  replicas: 9  # 3 per AZ
  selector:
    matchLabels:
      app: kafka-broker
  template:
    metadata:
      labels:
        app: kafka-broker
        component: broker
    spec:
      affinity:
        podAntiAffinity:
          # Hard: each kafka broker on a separate node
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: kafka-broker
            topologyKey: kubernetes.io/hostname

      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: kafka-broker
        # For StatefulSets, minDomains prevents all brokers going to a single zone
        # during initial scale-up before all zones have nodes
        minDomains: 3

      containers:
      - name: kafka
        image: registry.example.com/kafka:3.7.0
        resources:
          requests:
            cpu: "4"
            memory: 16Gi
  # Pod Management Policy: Parallel allows all pods to start simultaneously
  # rather than one-by-one (OrderedReady default).
  # Use OrderedReady for strongly-ordered systems like ZooKeeper.
  podManagementPolicy: Parallel
```

## Performance Impact of Complex Affinity Rules

Complex affinity rules increase scheduler latency. Each rule requires evaluating all candidate nodes, and chained rules multiply evaluation cost. Benchmarks on a 500-node cluster show:

- No affinity rules: ~2ms scheduling latency per pod
- Single `requiredDuringScheduling` anti-affinity: ~8ms
- Two `required` rules + two topology constraints: ~25ms
- Four `required` rules with `namespaceSelector`: ~60ms

For high-throughput batch workloads scheduling thousands of short-lived pods, prefer simpler node affinity over pod affinity where possible. Pod affinity requires querying existing pods across nodes, while node affinity only evaluates node labels.

```yaml
# High-throughput batch job: use node affinity instead of pod anti-affinity
# when precise co-location is not required
apiVersion: batch/v1
kind: Job
metadata:
  name: ml-training-batch
  namespace: ml-platform
spec:
  parallelism: 200
  completions: 200
  template:
    spec:
      # Node affinity is O(nodes) — much cheaper than pod anti-affinity O(pods * nodes)
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: node-role/gpu-compute
                operator: In
                values: ["true"]
      restartPolicy: OnFailure
      containers:
      - name: training
        image: registry.example.com/ml-training:v1.0.0
        resources:
          requests:
            nvidia.com/gpu: "1"
```

## Summary and Decision Framework

Select placement controls based on the following criteria:

**Use `requiredDuringScheduling` pod anti-affinity (hostname) when:**
- Replica count is reliably less than node count
- Workload handles high-value transactions requiring blast-radius isolation
- Compliance mandates physical node separation

**Use `topologySpreadConstraints` with `DoNotSchedule` when:**
- AZ or rack spread is a hard availability requirement
- Replica count varies dynamically and may exceed nodes in a single domain
- Multiple spread dimensions are needed (AZ and hostname simultaneously)

**Use `preferredDuringScheduling` rules when:**
- Spread is desired but not at the cost of scheduling failures
- Workload can tolerate colocation under resource pressure
- The cluster undergoes frequent topology changes

**Run the Descheduler when:**
- Cluster topology changes frequently (node additions/removals)
- Rolling updates create temporary imbalances that persist
- Long-running clusters accumulate drift from initial placement decisions

The combination of `topologySpreadConstraints` with `minDomains`, `podAntiAffinity` on hostname, a well-tuned Descheduler policy, and PodDisruptionBudgets provides production-grade placement guarantees suitable for regulated, high-availability environments.
