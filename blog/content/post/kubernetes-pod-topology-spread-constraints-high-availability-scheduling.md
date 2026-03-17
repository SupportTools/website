---
title: "Kubernetes Pod Topology Spread Constraints: High-Availability Scheduling Strategies"
date: 2030-05-20T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Scheduling", "High Availability", "Topology", "Pod Affinity", "Production", "Resilience"]
categories:
- Kubernetes
- High Availability
- Operations
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise patterns for topology spread constraints, failure domain awareness, zone and node spreading, combining with pod anti-affinity, and production scheduling configuration."
more_link: "yes"
url: "/kubernetes-pod-topology-spread-constraints-high-availability-scheduling/"
---

Pod placement in Kubernetes directly determines application resilience. An application with ten replicas all scheduled to the same availability zone provides no protection against a zone-level failure. Topology Spread Constraints, introduced in Kubernetes 1.18 and promoted to stable in 1.24, give operators fine-grained control over how replicas distribute across failure domains—availability zones, physical nodes, racks, or any custom topology key—without requiring anti-affinity rules that become brittle as replica counts change.

<!--more-->

## Understanding Topology Spread Constraints

A Topology Spread Constraint tells the scheduler how unevenly pods may be distributed across a given topology dimension. The core parameters are:

- **`maxSkew`**: Maximum allowed difference in pod counts between the most-loaded and least-loaded topology domain
- **`topologyKey`**: Node label key that defines the failure domain (e.g., `topology.kubernetes.io/zone`)
- **`whenUnsatisfiable`**: Action when constraint cannot be satisfied (`DoNotSchedule` or `ScheduleAnyway`)
- **`labelSelector`**: Which pods count toward the distribution calculation

### The Skew Calculation

```
skew = max(pods in any single domain) - min(pods in any single domain)
```

With `maxSkew: 1`, the scheduler ensures no domain has more than one extra pod compared to the least-loaded domain.

```
# maxSkew: 1 with 3 zones and 6 pods:
# VALID:     Zone-A: 2, Zone-B: 2, Zone-C: 2  (skew = 0)
# VALID:     Zone-A: 3, Zone-B: 2, Zone-C: 1  (skew = 2) ← violates maxSkew=1? No.
# Wait: max(3) - min(1) = 2, which exceeds maxSkew=1
# Actually VALID: Zone-A: 2, Zone-B: 2, Zone-C: 2
# and Zone-A: 3, Zone-B: 2, Zone-C: 1 is INVALID with maxSkew=1

# Correct reading:
# Zone-A: 3, Zone-B: 2, Zone-C: 1 → max=3, min=1, skew=2 > maxSkew=1 = INVALID
# Zone-A: 2, Zone-B: 2, Zone-C: 2 → skew=0 ≤ maxSkew=1 = VALID
# Zone-A: 3, Zone-B: 2, Zone-C: 2 → skew=1 ≤ maxSkew=1 = VALID
```

## Basic Zone Spreading

### Simple Three-Zone Distribution

```yaml
# deployment-zone-spread.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: production
spec:
  replicas: 9
  selector:
    matchLabels:
      app: api-server
  template:
    metadata:
      labels:
        app: api-server
        version: "2.1.0"
        team: platform
    spec:
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: api-server
      containers:
        - name: api-server
          image: registry.example.com/api-server:2.1.0
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
            limits:
              cpu: 1000m
              memory: 512Mi
```

With 9 replicas and 3 zones (`us-east-1a`, `us-east-1b`, `us-east-1c`), this ensures exactly 3 pods per zone.

### Verifying Pod Distribution

```bash
# Check actual pod distribution across zones
kubectl get pods -n production \
  -l app=api-server \
  -o wide \
  | awk 'NR>1 {print $7}' \
  | sort \
  | uniq -c \
  | sort -rn

# More detailed: group by node zone label
kubectl get pods -n production \
  -l app=api-server \
  -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}' \
  | while read node; do
      kubectl get node "${node}" \
        -o jsonpath="{.metadata.labels['topology\.kubernetes\.io/zone']}"
      echo ""
    done \
  | sort | uniq -c

# View topology spread constraint status on a pod
kubectl describe pod api-server-6b8d94f5c-xk7p2 -n production \
  | grep -A 10 "Topology Spread"
```

## Multi-Dimensional Spreading

For maximum resilience, apply spreading at multiple topology levels simultaneously. A pod should survive zone failures AND be distributed across nodes within each zone.

### Zone and Node Spreading

```yaml
# deployment-multi-spread.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: production
spec:
  replicas: 12
  selector:
    matchLabels:
      app: payment-service
  template:
    metadata:
      labels:
        app: payment-service
    spec:
      topologySpreadConstraints:
        # Constraint 1: spread across availability zones
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: payment-service

        # Constraint 2: spread across individual nodes within zones
        - maxSkew: 2
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: payment-service
      containers:
        - name: payment-service
          image: registry.example.com/payment-service:3.0.0
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 2Gi
```

With 12 replicas, 3 zones, and multiple nodes per zone:
- Zone constraint ensures 4 pods per zone
- Node constraint ensures no single node has more than 2 extra pods vs. the least-loaded node

### Regional Spreading with Custom Labels

For multi-region deployments where Kubernetes cluster spans regions:

```yaml
topologySpreadConstraints:
  # First: ensure cross-region distribution
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/region
    whenUnsatisfiable: DoNotSchedule
    labelSelector:
      matchLabels:
        app: global-service

  # Second: within each region, distribute across zones
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: ScheduleAnyway  # Soft constraint within region
    labelSelector:
      matchLabels:
        app: global-service

  # Third: never put two pods on the same node
  - maxSkew: 1
    topologyKey: kubernetes.io/hostname
    whenUnsatisfiable: ScheduleAnyway
    labelSelector:
      matchLabels:
        app: global-service
```

## Combining with Pod Anti-Affinity

Topology spread constraints and pod anti-affinity serve complementary purposes:
- **Topology spread**: Distributes replicas proportionally, scales naturally with replica count
- **Anti-affinity**: Provides binary rules (must not co-locate), useful for hard isolation requirements

### Layered Strategy

```yaml
# deployment-layered-placement.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-processor
  namespace: production
spec:
  replicas: 6
  selector:
    matchLabels:
      app: order-processor
  template:
    metadata:
      labels:
        app: order-processor
    spec:
      # Topology spread: zone-level distribution
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: order-processor

      affinity:
        podAntiAffinity:
          # Hard rule: no two pods on the same node (absolute requirement)
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchExpressions:
                  - key: app
                    operator: In
                    values:
                      - order-processor
              topologyKey: kubernetes.io/hostname
              namespaces:
                - production

          # Soft rule: prefer not to co-locate with the database
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 80
              podAffinityTerm:
                labelSelector:
                  matchExpressions:
                    - key: app
                      operator: In
                      values:
                        - postgres-primary
                topologyKey: kubernetes.io/hostname

        # Node affinity: require nodes labeled for production workloads
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: node-role
                    operator: In
                    values:
                      - worker
                  - key: workload-type
                    operator: In
                    values:
                      - general
                      - memory-optimized

      containers:
        - name: order-processor
          image: registry.example.com/order-processor:1.5.0
          resources:
            requests:
              cpu: 300m
              memory: 512Mi
            limits:
              cpu: 1500m
              memory: 1Gi
```

## The `ScheduleAnyway` vs `DoNotSchedule` Decision

### When to Use DoNotSchedule (Hard Constraint)

```yaml
# Use DoNotSchedule for stateful services where co-location causes data loss risk
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: DoNotSchedule  # Never violate zone distribution
    labelSelector:
      matchLabels:
        app: kafka-broker
```

Appropriate cases:
- Stateful applications where zone co-location risks data loss
- SLA requirements that explicitly mandate zone redundancy
- Regulatory compliance requiring geographic distribution

### When to Use ScheduleAnyway (Soft Constraint)

```yaml
# Use ScheduleAnyway for stateless services where availability matters more than perfect distribution
topologySpreadConstraints:
  - maxSkew: 2
    topologyKey: kubernetes.io/hostname
    whenUnsatisfiable: ScheduleAnyway  # Prefer spread but allow co-location if needed
    labelSelector:
      matchLabels:
        app: web-frontend
```

Appropriate cases:
- Stateless services where some imbalance is acceptable
- Development or staging environments
- Services where availability is more important than strict distribution

## MinDomains: Ensuring Minimum Zone Coverage

The `minDomains` field (stable in 1.30) specifies the minimum number of topology domains that must be eligible. If fewer than `minDomains` domains exist with matching pods, the constraint is considered unsatisfiable.

```yaml
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: DoNotSchedule
    minDomains: 3          # Require pods in at least 3 zones
    labelSelector:
      matchLabels:
        app: critical-service
```

This prevents all pods from running in a single zone when only one zone has available capacity—a common failure mode during zone-level capacity events.

## NodeTaintsPolicy and NodeAffinityPolicy

These fields (stable in 1.26) control whether nodes with taints or non-matching affinity rules count toward the spread calculation.

```yaml
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: DoNotSchedule
    labelSelector:
      matchLabels:
        app: api-server
    # Only count nodes that the pod can actually be scheduled on
    nodeAffinityPolicy: Honor     # Default: Honor (respect node affinity)
    nodeTaintsPolicy: Honor       # Default: Ignore (ignore tainted nodes)
```

| Policy | Behavior |
|--------|----------|
| `nodeAffinityPolicy: Honor` | Only count nodes matching pod's nodeAffinity |
| `nodeAffinityPolicy: Ignore` | Count all nodes regardless of affinity |
| `nodeTaintsPolicy: Honor` | Exclude tainted nodes from calculation unless tolerated |
| `nodeTaintsPolicy: Ignore` | Count tainted nodes even if pod cannot schedule there |

## Cluster-Level Default Topology Constraints

Operators can configure cluster-wide default topology spread constraints in the kube-scheduler configuration. These apply to all pods without explicit constraints.

```yaml
# kube-scheduler-config.yaml
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
profiles:
  - schedulerName: default-scheduler
    pluginConfig:
      - name: PodTopologySpread
        args:
          defaultConstraints:
            - maxSkew: 1
              topologyKey: topology.kubernetes.io/zone
              whenUnsatisfiable: ScheduleAnyway
            - maxSkew: 2
              topologyKey: kubernetes.io/hostname
              whenUnsatisfiable: ScheduleAnyway
          defaultingType: List  # Replace default constraints with this list
```

## StatefulSet Topology Spreading

StatefulSets present unique scheduling challenges because pods have stable identities. The ordinal suffixes (`-0`, `-1`, etc.) mean that a simple `labelSelector` for all replicas works correctly.

```yaml
# statefulset-topology.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: elasticsearch
  namespace: production
spec:
  replicas: 6
  serviceName: elasticsearch
  selector:
    matchLabels:
      app: elasticsearch
      role: data
  template:
    metadata:
      labels:
        app: elasticsearch
        role: data
    spec:
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: elasticsearch
              role: data

        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: elasticsearch
              role: data

      # Guarantee no two data nodes share a node
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: elasticsearch
                  role: data
              topologyKey: kubernetes.io/hostname

      containers:
        - name: elasticsearch
          image: docker.elastic.co/elasticsearch/elasticsearch:8.12.0
          env:
            - name: discovery.seed_hosts
              value: "elasticsearch-0.elasticsearch,elasticsearch-1.elasticsearch,elasticsearch-2.elasticsearch"
            - name: cluster.initial_master_nodes
              value: "elasticsearch-0,elasticsearch-1,elasticsearch-2"
          resources:
            requests:
              cpu: "2"
              memory: 8Gi
            limits:
              cpu: "4"
              memory: 16Gi
          volumeMounts:
            - name: data
              mountPath: /usr/share/elasticsearch/data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: premium-rwo
        resources:
          requests:
            storage: 500Gi
```

## Handling Uneven Zone Capacity

In real clusters, availability zones often have different node counts or different available capacity. This can cause topology spread constraints to block scheduling when a zone has insufficient capacity.

### Practical Workaround: Zone-Specific Node Pools

```bash
# Label nodes by zone to verify distribution before applying constraints
kubectl get nodes -o custom-columns=\
'NAME:.metadata.name,ZONE:.metadata.labels.topology\.kubernetes\.io/zone,CPU:.status.allocatable.cpu,MEM:.status.allocatable.memory'

# Check current pod distribution before changing constraints
kubectl get pods -n production -l app=api-server -o wide \
  | awk 'NR>1 {print $7}' \
  | sort | uniq -c
```

### Pod Disruption Budget Integration

```yaml
# Combine topology constraints with PDBs for safe disruptions
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-server-pdb
  namespace: production
spec:
  minAvailable: "66%"   # At minimum, 2 of 3 zones must have pods
  selector:
    matchLabels:
      app: api-server
```

## Debugging Scheduling Failures

### Identifying Why Pods Are Pending

```bash
# Check pending pods in a namespace
kubectl get pods -n production --field-selector=status.phase=Pending

# Get detailed scheduling failure reason
kubectl describe pod api-server-pending-xyz -n production \
  | grep -A 20 "Events:"

# Common messages and meanings:
# "0/12 nodes available: 3 node(s) didn't match pod topology spread constraints"
#   → Not enough nodes per zone to satisfy maxSkew
# "0/12 nodes available: 12 node(s) had taint {key:value:NoSchedule}"
#   → All nodes tainted; check nodeAffinityPolicy and nodeTaintsPolicy

# Check scheduler events
kubectl get events -n production \
  --field-selector reason=FailedScheduling \
  --sort-by='.lastTimestamp' \
  | tail -20
```

### Simulating Scheduling with Descheduler

```bash
# Install descheduler to rebalance existing pods
kubectl apply -f https://github.com/kubernetes-sigs/descheduler/releases/latest/download/descheduler.yaml

# Configure descheduler with RemovePodsViolatingTopologySpreadConstraint
cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: descheduler-policy-configmap
  namespace: kube-system
data:
  policy.yaml: |
    apiVersion: descheduler/v1alpha2
    kind: DeschedulerPolicy
    profiles:
      - name: topology-rebalance
        pluginConfig:
          - name: RemovePodsViolatingTopologySpreadConstraint
            args:
              constraints:
                - DoNotSchedule
                - ScheduleAnyway
              includeSoftConstraints: true
        plugins:
          balance:
            enabled:
              - RemovePodsViolatingTopologySpreadConstraint
EOF
```

## Topology Constraints for Horizontal Pod Autoscaler

When HPA scales pods up or down, topology constraints continue to apply. This interaction requires careful configuration to avoid scaling failures.

```yaml
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
  minReplicas: 3    # Must be >= number of zones for hard zone constraint to work
  maxReplicas: 30   # Should be divisible by number of zones for clean distribution
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - type: Pods
          value: 3       # Scale down at most 3 pods per minute (one per zone)
          periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
        - type: Pods
          value: 3       # Scale up in multiples of zone count
          periodSeconds: 30
```

## Production Topology Constraint Checklist

```bash
#!/bin/bash
# scripts/check-topology-constraints.sh
# Validates that all Deployments in a namespace have topology spread constraints.

NAMESPACE="${1:-production}"

echo "Checking topology spread constraints in namespace: ${NAMESPACE}"
echo ""

kubectl get deployments -n "${NAMESPACE}" -o json \
  | jq -r '
    .items[] |
    {
      name: .metadata.name,
      replicas: .spec.replicas,
      hasZoneConstraint: (
        (.spec.template.spec.topologySpreadConstraints // [])
        | map(select(.topologyKey == "topology.kubernetes.io/zone"))
        | length > 0
      ),
      hasNodeConstraint: (
        (.spec.template.spec.topologySpreadConstraints // [])
        | map(select(.topologyKey == "kubernetes.io/hostname"))
        | length > 0
      )
    } |
    "\(.name) | replicas=\(.replicas) | zone_constraint=\(.hasZoneConstraint) | node_constraint=\(.hasNodeConstraint)"
  ' \
  | column -t -s "|"
```

Topology spread constraints, combined with pod anti-affinity and carefully tuned PodDisruptionBudgets, form the scheduling foundation for applications that must survive zone failures with minimal operator intervention. The key insight is that spreading must be designed in concert with replica counts, zone counts, and node counts to ensure the scheduler always has a valid placement that satisfies all constraints.
