---
title: "Kubernetes Node Affinity and Topology Spread: Advanced Workload Placement"
date: 2030-12-31T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Node Affinity", "Topology Spread", "Scheduling", "High Availability", "Taints", "Tolerations"]
categories:
- Kubernetes
- Infrastructure
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes workload placement using nodeAffinity, topologySpreadConstraints, and anti-affinity rules for enterprise HA deployments."
more_link: "yes"
url: "/kubernetes-node-affinity-topology-spread-advanced-workload-placement/"
---

Placing workloads on the right nodes is one of the most impactful operational decisions in a Kubernetes cluster. Poor placement leads to noisy-neighbor problems, single points of failure, and wasted hardware capacity. This guide covers the full spectrum of Kubernetes scheduling primitives — from the simple `nodeSelector` up through `topologySpreadConstraints` and the interaction of affinity rules with taints and tolerations — with production-tested examples for every pattern.

<!--more-->

# Kubernetes Node Affinity and Topology Spread: Advanced Workload Placement

## Section 1: The Kubernetes Scheduling Decision Tree

Before diving into individual primitives, it helps to understand how the Kubernetes scheduler combines them. Each scheduling cycle processes a pod through three phases:

1. **Filtering** — eliminates nodes that cannot run the pod (resource requests, taints, required affinity rules, node selectors).
2. **Scoring** — ranks remaining nodes using priority functions (preferred affinity rules, topology spread, inter-pod affinity, image locality).
3. **Binding** — assigns the pod to the highest-scoring node.

Understanding this pipeline explains why `requiredDuringSchedulingIgnoredDuringExecution` causes pods to remain `Pending` (filter rejection) while `preferredDuringSchedulingIgnoredDuringExecution` simply reduces a node's score (no hard failure).

### Node Labels: The Foundation

All affinity rules operate on node labels. Kubeadm and managed Kubernetes providers attach a standard set automatically:

```bash
kubectl get nodes --show-labels
```

Key well-known labels:
```
kubernetes.io/hostname=worker-01
topology.kubernetes.io/region=us-east-1
topology.kubernetes.io/zone=us-east-1a
node.kubernetes.io/instance-type=m5.2xlarge
kubernetes.io/arch=amd64
kubernetes.io/os=linux
node-role.kubernetes.io/worker=
```

For bare-metal clusters you must add topology labels manually. A bootstrap script for this:

```bash
#!/bin/bash
# label-nodes.sh — assign topology labels to bare-metal nodes
# Usage: ./label-nodes.sh worker-01 rack-a us-east datacenter-1

NODE=$1
RACK=$2
REGION=$3
DATACENTER=$4

kubectl label node "$NODE" \
  topology.kubernetes.io/region="$REGION" \
  topology.kubernetes.io/zone="${REGION}-${RACK}" \
  topology.support.tools/rack="$RACK" \
  topology.support.tools/datacenter="$DATACENTER" \
  --overwrite
```

## Section 2: nodeSelector — Simple Label Matching

`nodeSelector` is the oldest and simplest mechanism. It matches a pod to nodes that have all specified labels.

```yaml
# simple-nodeselector.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gpu-inference
  namespace: ml-workloads
spec:
  replicas: 4
  selector:
    matchLabels:
      app: gpu-inference
  template:
    metadata:
      labels:
        app: gpu-inference
    spec:
      nodeSelector:
        accelerator: nvidia-a100
        kubernetes.io/os: linux
      containers:
      - name: inference
        image: registry.support.tools/inference:2.1.0
        resources:
          limits:
            nvidia.com/gpu: "1"
            memory: 32Gi
          requests:
            nvidia.com/gpu: "1"
            memory: 32Gi
```

**Limitation:** `nodeSelector` is pure AND logic with no fallback. If no node has `accelerator: nvidia-a100`, every pod stays Pending indefinitely. For production use, `nodeAffinity` is almost always the better choice.

## Section 3: nodeAffinity — Expressive Label Rules

`nodeAffinity` supports label selectors with `In`, `NotIn`, `Exists`, `DoesNotExist`, `Gt`, and `Lt` operators, plus the required/preferred split.

### 3.1 requiredDuringSchedulingIgnoredDuringExecution

Hard requirement — pod will not schedule unless the rule matches. The "IgnoredDuringExecution" suffix means existing pods are not evicted if node labels change after scheduling.

```yaml
# required-affinity.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: database-primary
  namespace: production
spec:
  replicas: 1
  selector:
    matchLabels:
      app: database
      role: primary
  template:
    metadata:
      labels:
        app: database
        role: primary
    spec:
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            # Multiple terms are OR'd together
            - matchExpressions:
              # Expressions within a term are AND'd
              - key: node-role.support.tools/database
                operator: In
                values: ["true"]
              - key: topology.kubernetes.io/zone
                operator: In
                values: ["us-east-1a", "us-east-1b"]
              - key: node.kubernetes.io/instance-type
                operator: In
                values: ["r5.4xlarge", "r5.8xlarge", "r6i.4xlarge"]
            # Fallback: any high-memory node in the region
            - matchExpressions:
              - key: topology.support.tools/memory-class
                operator: In
                values: ["high"]
              - key: topology.kubernetes.io/region
                operator: In
                values: ["us-east-1"]
      containers:
      - name: postgres
        image: postgres:16.2
        resources:
          requests:
            memory: 64Gi
            cpu: "8"
          limits:
            memory: 64Gi
            cpu: "8"
```

### 3.2 preferredDuringSchedulingIgnoredDuringExecution

Soft preference — scoring bonus, not a hard filter. Weight ranges from 1 to 100.

```yaml
# preferred-affinity.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-frontend
  namespace: production
spec:
  replicas: 12
  selector:
    matchLabels:
      app: web-frontend
  template:
    metadata:
      labels:
        app: web-frontend
    spec:
      affinity:
        nodeAffinity:
          # Strongly prefer nodes with SSD storage
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 80
            preference:
              matchExpressions:
              - key: node.kubernetes.io/storage-class
                operator: In
                values: ["nvme-ssd"]
          # Mildly prefer nodes already running our container image
          - weight: 20
            preference:
              matchExpressions:
              - key: topology.support.tools/image-cached
                operator: In
                values: ["web-frontend"]
      containers:
      - name: frontend
        image: registry.support.tools/web-frontend:3.4.1
        resources:
          requests:
            memory: 512Mi
            cpu: 250m
```

### 3.3 Combining Required and Preferred

The most resilient pattern uses required rules to enforce hard constraints and preferred rules to optimize placement within the allowed set:

```yaml
# combined-affinity.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: fintech
spec:
  replicas: 6
  selector:
    matchLabels:
      app: payment-service
  template:
    metadata:
      labels:
        app: payment-service
    spec:
      affinity:
        nodeAffinity:
          # HARD: must be on PCI-DSS compliant nodes
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: compliance.support.tools/pci-dss
                operator: In
                values: ["true"]
              - key: kubernetes.io/os
                operator: In
                values: ["linux"]
          # SOFT: prefer nodes in us-east for latency
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 60
            preference:
              matchExpressions:
              - key: topology.kubernetes.io/region
                operator: In
                values: ["us-east-1"]
          - weight: 40
            preference:
              matchExpressions:
              - key: node.kubernetes.io/instance-type
                operator: In
                values: ["c5.2xlarge", "c5.4xlarge"]
      containers:
      - name: payment
        image: registry.support.tools/payment:5.0.2
```

## Section 4: Pod Anti-Affinity for High Availability

Pod anti-affinity prevents multiple replicas of the same service from landing on the same node, zone, or rack — a critical HA requirement.

### 4.1 Node-Level Anti-Affinity

Spreads replicas across physical nodes. Essential for services where any downtime matters.

```yaml
# node-antiaffinity.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-gateway
  namespace: production
spec:
  replicas: 6
  selector:
    matchLabels:
      app: api-gateway
  template:
    metadata:
      labels:
        app: api-gateway
    spec:
      affinity:
        podAntiAffinity:
          # HARD: never two api-gateway pods on the same node
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchExpressions:
              - key: app
                operator: In
                values: ["api-gateway"]
            topologyKey: kubernetes.io/hostname
      containers:
      - name: gateway
        image: registry.support.tools/api-gateway:4.2.0
        ports:
        - containerPort: 8080
        resources:
          requests:
            memory: 1Gi
            cpu: 500m
          limits:
            memory: 2Gi
            cpu: "2"
```

### 4.2 Zone-Level Anti-Affinity

For multi-AZ clusters, spreading across availability zones survives an entire zone failure.

```yaml
# zone-antiaffinity.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-processor
  namespace: production
spec:
  replicas: 9
  selector:
    matchLabels:
      app: order-processor
  template:
    metadata:
      labels:
        app: order-processor
    spec:
      affinity:
        podAntiAffinity:
          # SOFT: prefer different zones (won't block scheduling if only 2 zones)
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchExpressions:
                - key: app
                  operator: In
                  values: ["order-processor"]
              topologyKey: topology.kubernetes.io/zone
          # HARD: never two pods on the same node
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchExpressions:
              - key: app
                operator: In
                values: ["order-processor"]
            topologyKey: kubernetes.io/hostname
      containers:
      - name: processor
        image: registry.support.tools/order-processor:2.8.0
```

### 4.3 Pod Affinity for Co-Location

The mirror of anti-affinity: schedule pods near other pods to reduce latency. Useful for sidecar-heavy architectures or when inter-service traffic dominates.

```yaml
# pod-affinity-colocation.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cache-sidecar-pool
  namespace: production
spec:
  replicas: 6
  selector:
    matchLabels:
      app: cache-pool
  template:
    metadata:
      labels:
        app: cache-pool
    spec:
      affinity:
        podAffinity:
          # Prefer placement on nodes that already run the data service
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 90
            podAffinityTerm:
              labelSelector:
                matchExpressions:
                - key: app
                  operator: In
                  values: ["data-service"]
              topologyKey: kubernetes.io/hostname
      containers:
      - name: redis-sidecar
        image: redis:7.2-alpine
        resources:
          requests:
            memory: 2Gi
            cpu: 200m
          limits:
            memory: 4Gi
```

## Section 5: Taints and Tolerations

Taints repel pods from nodes. Tolerations allow pods to override specific taints. They work orthogonally to affinity — a pod can have a toleration without having affinity, and vice versa.

### 5.1 Taint Effects

| Effect | Behavior |
|---|---|
| `NoSchedule` | New pods without toleration will not schedule on this node |
| `PreferNoSchedule` | Scheduler tries to avoid placing pods without toleration |
| `NoExecute` | Existing pods are evicted if they lack the toleration; new pods blocked |

### 5.2 Taint Examples

```bash
# Dedicate a node pool to GPU workloads
kubectl taint nodes gpu-node-01 gpu-node-02 gpu-node-03 \
  accelerator=gpu:NoSchedule

# Mark nodes for maintenance (evicts non-tolerating pods)
kubectl taint nodes worker-17 \
  node.kubernetes.io/maintenance=true:NoExecute

# Soft preference — try to keep regular workloads off edge nodes
kubectl taint nodes edge-01 edge-02 \
  topology.support.tools/edge=true:PreferNoSchedule

# Remove a taint (note the trailing minus sign)
kubectl taint nodes worker-17 node.kubernetes.io/maintenance-
```

### 5.3 Toleration Patterns

```yaml
# tolerations-examples.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-exporter
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: node-exporter
  template:
    metadata:
      labels:
        app: node-exporter
    spec:
      tolerations:
      # Tolerate ALL taints — appropriate only for system-level DaemonSets
      - operator: Exists
      # Specific GPU taint toleration
      - key: accelerator
        operator: Equal
        value: gpu
        effect: NoSchedule
      # Tolerate NoExecute with eviction grace period
      - key: node.kubernetes.io/unreachable
        operator: Exists
        effect: NoExecute
        tolerationSeconds: 300
      containers:
      - name: node-exporter
        image: prom/node-exporter:v1.7.0
        resources:
          requests:
            memory: 32Mi
            cpu: 50m
          limits:
            memory: 64Mi
```

```yaml
# gpu-workload-with-toleration.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gpu-training-job
  namespace: ml-workloads
spec:
  replicas: 3
  selector:
    matchLabels:
      app: gpu-training
  template:
    metadata:
      labels:
        app: gpu-training
    spec:
      tolerations:
      # Must tolerate GPU node taint
      - key: accelerator
        operator: Equal
        value: gpu
        effect: NoSchedule
      affinity:
        nodeAffinity:
          # AND only target GPU nodes (toleration alone doesn't attract)
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: accelerator
                operator: In
                values: ["nvidia-a100", "nvidia-h100"]
      containers:
      - name: training
        image: registry.support.tools/pytorch-trainer:2.2.0
        resources:
          limits:
            nvidia.com/gpu: "2"
            memory: 80Gi
```

**Important:** A toleration permits scheduling on a tainted node but does not attract pods there. Always pair tolerations with `nodeAffinity` or `nodeSelector` when you want dedicated node pools.

## Section 6: topologySpreadConstraints

`topologySpreadConstraints` is the most sophisticated spreading mechanism. It distributes pods across topology domains (zones, racks, nodes) based on a maximum skew tolerance.

### 6.1 Core Concepts

- **topologyKey**: The node label that defines domains (e.g., `topology.kubernetes.io/zone`).
- **maxSkew**: Maximum allowed difference between the most- and least-populated domains.
- **whenUnsatisfiable**: `DoNotSchedule` (hard) or `ScheduleAnyway` (soft).
- **labelSelector**: Which pods count toward the spread calculation.

### 6.2 Single Topology Constraint

```yaml
# zone-spread.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-api
  namespace: production
spec:
  replicas: 9
  selector:
    matchLabels:
      app: web-api
  template:
    metadata:
      labels:
        app: web-api
    spec:
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: web-api
      containers:
      - name: api
        image: registry.support.tools/web-api:6.1.0
        resources:
          requests:
            memory: 512Mi
            cpu: 250m
```

With 3 zones (us-east-1a, us-east-1b, us-east-1c) and 9 replicas, this yields exactly 3 pods per zone. If one zone has no capacity, pending pods will block until capacity appears (DoNotSchedule). Use `ScheduleAnyway` when availability matters more than spread.

### 6.3 Multi-Level Topology Spreading

Combining constraints for both zone and node spreading provides defense in depth against both zone and node failures.

```yaml
# multilevel-spread.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: checkout-service
  namespace: ecommerce
spec:
  replicas: 12
  selector:
    matchLabels:
      app: checkout-service
  template:
    metadata:
      labels:
        app: checkout-service
        tier: backend
    spec:
      topologySpreadConstraints:
      # First: spread across zones (maxSkew=1 means max 1 pod difference between zones)
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: checkout-service
      # Second: spread across nodes within zones (maxSkew=2 allows some imbalance)
      - maxSkew: 2
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: ScheduleAnyway
        labelSelector:
          matchLabels:
            app: checkout-service
      containers:
      - name: checkout
        image: registry.support.tools/checkout:3.0.5
        resources:
          requests:
            memory: 1Gi
            cpu: 500m
          limits:
            memory: 2Gi
            cpu: "2"
```

### 6.4 Custom Topology Domains: Rack Spreading

For bare-metal clusters with physical rack topology, define rack labels and spread across them:

```yaml
# rack-spread.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: distributed-cache
  namespace: caching
spec:
  replicas: 6
  selector:
    matchLabels:
      app: distributed-cache
  template:
    metadata:
      labels:
        app: distributed-cache
    spec:
      topologySpreadConstraints:
      # Spread across physical racks (custom label)
      - maxSkew: 1
        topologyKey: topology.support.tools/rack
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: distributed-cache
      # Within each rack, spread across nodes
      - maxSkew: 1
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: ScheduleAnyway
        labelSelector:
          matchLabels:
            app: distributed-cache
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: node-role.support.tools/cache
                operator: In
                values: ["true"]
      containers:
      - name: cache
        image: redis:7.2-alpine
        resources:
          requests:
            memory: 8Gi
            cpu: "2"
          limits:
            memory: 8Gi
```

### 6.5 minDomains (Kubernetes 1.25+)

`minDomains` ensures that topology spreading waits until a minimum number of domains are available. Prevents all pods from landing in a single zone during a cluster bootstrap when other zones haven't joined yet.

```yaml
# mindomain-spread.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: critical-service
  namespace: production
spec:
  replicas: 6
  selector:
    matchLabels:
      app: critical-service
  template:
    metadata:
      labels:
        app: critical-service
    spec:
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        # Don't schedule until at least 3 zones are available
        minDomains: 3
        labelSelector:
          matchLabels:
            app: critical-service
      containers:
      - name: service
        image: registry.support.tools/critical-svc:1.5.0
```

## Section 7: Advanced Combinations — Production Patterns

### 7.1 The Complete HA Deployment Pattern

This pattern combines all mechanisms for a production-grade stateless service requiring zone-level HA:

```yaml
# ha-production-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: inventory-service
  namespace: production
  annotations:
    support.tools/placement-strategy: "zone-ha-cpu-optimized"
spec:
  replicas: 9
  selector:
    matchLabels:
      app: inventory-service
      version: v3
  template:
    metadata:
      labels:
        app: inventory-service
        version: v3
        tier: backend
    spec:
      # Spread across zones first, nodes second
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: inventory-service
      - maxSkew: 2
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: ScheduleAnyway
        labelSelector:
          matchLabels:
            app: inventory-service

      affinity:
        nodeAffinity:
          # HARD: must run on linux worker nodes
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: node-role.kubernetes.io/worker
                operator: Exists
              - key: kubernetes.io/os
                operator: In
                values: ["linux"]
          # SOFT: prefer compute-optimized instances
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 70
            preference:
              matchExpressions:
              - key: node.kubernetes.io/instance-type
                operator: In
                values: ["c5.xlarge", "c5.2xlarge", "c6i.xlarge", "c6i.2xlarge"]
          - weight: 30
            preference:
              matchExpressions:
              - key: node.kubernetes.io/disk-type
                operator: In
                values: ["nvme"]

        # HARD: never two pods on the same node
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchExpressions:
              - key: app
                operator: In
                values: ["inventory-service"]
            topologyKey: kubernetes.io/hostname

      # Tolerate spot instance taint if present
      tolerations:
      - key: node.kubernetes.io/spot-instance
        operator: Exists
        effect: NoSchedule

      # Termination grace period for graceful shutdown
      terminationGracePeriodSeconds: 60

      containers:
      - name: inventory
        image: registry.support.tools/inventory:3.2.1
        ports:
        - containerPort: 8080
          name: http
        - containerPort: 9090
          name: metrics
        resources:
          requests:
            memory: 1Gi
            cpu: 500m
          limits:
            memory: 2Gi
            cpu: "2"
        readinessProbe:
          httpGet:
            path: /healthz/ready
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 5
        livenessProbe:
          httpGet:
            path: /healthz/live
            port: 8080
          initialDelaySeconds: 20
          periodSeconds: 10
```

### 7.2 StatefulSet Placement for Distributed Databases

StatefulSets require special care because pod names are stable and persistent volumes bind to zones.

```yaml
# statefulset-placement.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: cassandra
  namespace: databases
spec:
  serviceName: cassandra
  replicas: 6
  selector:
    matchLabels:
      app: cassandra
  template:
    metadata:
      labels:
        app: cassandra
        workload-type: stateful-db
    spec:
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: cassandra

      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: node-role.support.tools/database
                operator: In
                values: ["true"]
              - key: node.kubernetes.io/disk-type
                operator: In
                values: ["nvme", "ssd"]
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchExpressions:
              - key: app
                operator: In
                values: ["cassandra"]
            topologyKey: kubernetes.io/hostname

      tolerations:
      - key: node-role.support.tools/database
        operator: Equal
        value: "true"
        effect: NoSchedule

      containers:
      - name: cassandra
        image: cassandra:5.0
        ports:
        - containerPort: 9042
          name: cql
        - containerPort: 7000
          name: intra-node
        resources:
          requests:
            memory: 32Gi
            cpu: "8"
          limits:
            memory: 32Gi
            cpu: "16"
        env:
        - name: CASSANDRA_CLUSTER_NAME
          value: "production-cluster"
        - name: MAX_HEAP_SIZE
          value: "16G"
  volumeClaimTemplates:
  - metadata:
      name: cassandra-data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: fast-nvme-zone-aware
      resources:
        requests:
          storage: 2Ti
```

## Section 8: Cluster-Level Default Topology Spread

Kubernetes 1.24+ supports cluster-wide default topology spread constraints in the scheduler configuration, so individual deployments inherit them automatically.

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
      - maxSkew: 5
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: ScheduleAnyway
      defaultingType: List
  plugins:
    multiPoint:
      enabled:
      - name: PodTopologySpread
```

Individual deployments can override or augment these defaults by specifying their own `topologySpreadConstraints`.

## Section 9: Debugging Placement Decisions

### 9.1 Why Is My Pod Pending?

```bash
# Describe the pod to see scheduler events
kubectl describe pod <pod-name> -n <namespace>

# Look for events like:
# Warning  FailedScheduling  0/15 nodes are available:
#   5 node(s) had untolerated taint {node-role.support.tools/database: true},
#   4 node(s) didn't match Pod's node affinity/selector,
#   6 node(s) didn't match pod topology spread constraints.
```

### 9.2 Simulating Scheduler Decisions

```bash
# Dry-run scheduler binding (kubectl 1.26+)
kubectl debug --attach=false pod/<pending-pod> -n <namespace>

# Check node affinity matching manually
kubectl get nodes -l "node-role.support.tools/database=true" \
  -l "node.kubernetes.io/disk-type in (nvme,ssd)"

# Check taint status of nodes
kubectl get nodes -o json | \
  jq '.items[] | {name: .metadata.name, taints: .spec.taints}'
```

### 9.3 Viewing Current Pod Distribution

```bash
# Show pod distribution across zones
kubectl get pods -n production \
  -l app=web-api \
  -o wide --no-headers | \
  awk '{print $7}' | \
  xargs -I{} kubectl get node {} \
    -o jsonpath='{.metadata.labels.topology\.kubernetes\.io/zone}' \
  | sort | uniq -c

# Show pod distribution per node
kubectl get pods -n production -l app=web-api \
  -o custom-columns='NODE:.spec.nodeName' \
  --no-headers | sort | uniq -c | sort -rn
```

### 9.4 Forcing Rescheduling

Kubernetes does not rebalance running pods when topology constraints become violated (e.g., a node fails and recovers). The Descheduler handles this:

```yaml
# descheduler-policy.yaml
apiVersion: "descheduler/v1alpha1"
kind: "DeschedulerPolicy"
strategies:
  RemovePodsViolatingTopologySpreadConstraint:
    enabled: true
    params:
      includeSoftConstraints: true
  RemovePodsViolatingNodeAffinity:
    enabled: true
    params:
      nodeAffinityType:
      - "requiredDuringSchedulingIgnoredDuringExecution"
  RemovePodsHavingTooManyRestarts:
    enabled: true
    params:
      podsHavingTooManyRestarts:
        podRestartThreshold: 5
```

```bash
# Run descheduler as a one-time job
kubectl create -f descheduler-job.yaml

# Or deploy as a CronJob running every 2 hours
kubectl apply -f descheduler-cronjob.yaml
```

## Section 10: Operational Recommendations

### 10.1 Label Taxonomy

Define a consistent label taxonomy for your organization before deploying workloads:

```yaml
# Recommended node label taxonomy for enterprise clusters
#
# Topology labels (well-known)
topology.kubernetes.io/region: us-east-1
topology.kubernetes.io/zone: us-east-1a
kubernetes.io/hostname: worker-01
#
# Hardware class labels
node.kubernetes.io/instance-type: c5.2xlarge
node.kubernetes.io/disk-type: nvme         # nvme, ssd, hdd
node.support.tools/network-class: 25g       # 1g, 10g, 25g, 100g
#
# Workload role labels (who can schedule here)
node-role.support.tools/worker: "true"
node-role.support.tools/database: "true"
node-role.support.tools/gpu: "true"
node-role.support.tools/edge: "true"
#
# Compliance labels
compliance.support.tools/pci-dss: "true"
compliance.support.tools/hipaa: "true"
#
# Capacity labels
topology.support.tools/rack: rack-a
topology.support.tools/datacenter: dc-01
topology.support.tools/memory-class: high  # standard, high, ultra
```

### 10.2 Common Anti-Patterns

**Anti-pattern 1: Hard node affinity without fallback**

Do not use `requiredDuringScheduling` with only one term if that term might have no matching nodes. Always add a secondary term or use `preferredDuringScheduling` as the fallback.

**Anti-pattern 2: Anti-affinity with more replicas than nodes**

If `requiredDuringScheduling` anti-affinity prevents two pods on the same node and you have more replicas than nodes, pods will stay Pending forever. Use `preferredDuringScheduling` instead.

**Anti-pattern 3: topologySpreadConstraints without minDomains**

If you have 3 zones and deploy before all zones are online, 100% of pods can land in one zone. Set `minDomains: 3` to block scheduling until all required domains exist.

**Anti-pattern 4: Forgetting the Descheduler**

The scheduler only acts at pod creation. If a node fails and recovers, or if topology drifts over time, running pods are not rebalanced. Deploy the Kubernetes Descheduler with a topology-aware policy for continuous rebalancing.

### 10.3 Capacity Planning

```bash
# Check how many pods each zone can accept
kubectl get nodes -l topology.kubernetes.io/zone=us-east-1a \
  -o json | jq '[.items[] | {
    name: .metadata.name,
    allocatable_cpu: .status.allocatable.cpu,
    allocatable_memory: .status.allocatable.memory,
    pods: .status.allocatable.pods
  }]'

# Check current resource utilization per zone
kubectl top nodes -l topology.kubernetes.io/zone=us-east-1a
```

## Summary

Kubernetes scheduling primitives form a hierarchy of increasing expressiveness:

1. **nodeSelector** — simple AND label matching, hard requirement only.
2. **nodeAffinity** — expressive label rules with required/preferred semantics.
3. **podAffinity/podAntiAffinity** — relative placement with respect to other pods.
4. **topologySpreadConstraints** — quantitative spreading with maxSkew control.
5. **taints/tolerations** — repulsion mechanism for dedicated node pools.

For production HA workloads, the complete pattern is: `topologySpreadConstraints` for zone/node spreading, `nodeAffinity` for hardware requirements, `podAntiAffinity` as a hard backstop against node-level SPOF, and `tolerations` only where dedicated node pools require them. Pair all of this with the Kubernetes Descheduler for ongoing rebalancing, and establish a node label taxonomy before deploying workloads.
