---
title: "Kubernetes PodDisruptionBudget Patterns: High Availability Guarantees"
date: 2029-11-23T00:00:00-05:00
draft: false
tags: ["Kubernetes", "PodDisruptionBudget", "High Availability", "Cluster Autoscaler", "SRE"]
categories: ["Kubernetes", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Kubernetes PodDisruptionBudget patterns: minAvailable vs maxUnavailable, percentage vs absolute values, PDB interaction with cluster autoscaler, voluntary vs involuntary disruptions, and debugging blocked node drains."
more_link: "yes"
url: "/kubernetes-poddisruptionbudget-patterns-high-availability-guide/"
---

PodDisruptionBudgets (PDBs) are one of Kubernetes' most powerful — and most misunderstood — reliability primitives. When configured correctly, they prevent cluster operations (node drains, cluster upgrades, autoscaler scale-downs) from violating your application's availability guarantees. When configured incorrectly, they silently block all cluster maintenance, creating operational nightmares. This guide covers every aspect of PDB behavior: the difference between voluntary and involuntary disruptions, the subtleties of minAvailable versus maxUnavailable, percentage calculations, cluster autoscaler interactions, and systematic debugging of blocked drains.

<!--more-->

# Kubernetes PodDisruptionBudget Patterns: High Availability Guarantees

## Voluntary vs Involuntary Disruptions

Before examining PDB mechanics, understand what they protect against — and what they don't.

### Voluntary Disruptions

Voluntary disruptions are intentional operations performed by cluster administrators or automation:
- Node drain (`kubectl drain`)
- Node cordon + pod eviction
- Cluster autoscaler scale-down
- Rolling deployments (via Deployment controller)
- StatefulSet rolling updates
- Explicit `kubectl delete pod`
- PodDisruptionBudget eviction requests via the Eviction API

**PDBs protect against voluntary disruptions.** The eviction API checks PDB constraints before allowing a pod to be evicted.

### Involuntary Disruptions

Involuntary disruptions are unplanned failures:
- Node hardware failure
- Node kernel panic
- Network partition isolating a node
- Accidental `kubectl delete node`
- Resource pressure causing OOM kills
- Storage failure causing pod crash

**PDBs do NOT protect against involuntary disruptions.** A hardware failure that takes down 5 nodes will kill all pods on those nodes regardless of any PDB. PDBs are a coordination mechanism, not a reliability mechanism for failures.

This distinction is critical: a PDB with `minAvailable: 3` for a 3-replica deployment provides zero protection against a single node failure that happens to host 2 of the 3 replicas. You still need pod anti-affinity rules, multiple replicas, and proper readiness probes for actual fault tolerance.

## PDB Structure

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-service-pdb
  namespace: production
spec:
  # Selector must match the pods this PDB protects
  selector:
    matchLabels:
      app: payment-service
      tier: backend

  # Specify EITHER minAvailable OR maxUnavailable — never both
  minAvailable: 2   # At least 2 pods must be Available
  # OR
  # maxUnavailable: 1  # At most 1 pod can be Unavailable
```

```yaml
# PDB status (observed state)
status:
  currentHealthy: 3    # Pods currently considered healthy (Running + Ready)
  desiredHealthy: 2    # Minimum required (from minAvailable)
  disruptionsAllowed: 1  # Current number of disruptions that can be tolerated
  expectedPods: 3      # Total pods matched by selector
  observedGeneration: 1
  conditions:
    - lastTransitionTime: "2029-11-23T10:00:00Z"
      message: ""
      observedGeneration: 1
      reason: SufficientPods
      status: "True"
      type: DisruptionAllowed
```

## minAvailable vs maxUnavailable

### minAvailable

Specifies the minimum number of pods that must be Available at any point during voluntary disruptions.

```yaml
# Absolute value: at least 2 pods must be Available
spec:
  minAvailable: 2

# Percentage: at least 75% of pods must be Available
# Rounded DOWN (floor)
spec:
  minAvailable: "75%"
```

**Calculation with absolute minAvailable:**
```
disruptionsAllowed = currentHealthy - minAvailable
If currentHealthy = 3, minAvailable = 2:
  disruptionsAllowed = 3 - 2 = 1  ✓ (one eviction permitted)

If currentHealthy = 2, minAvailable = 2:
  disruptionsAllowed = 2 - 2 = 0  ✗ (eviction blocked)
```

### maxUnavailable

Specifies the maximum number of pods that can be Unavailable at any point.

```yaml
# Absolute value: at most 1 pod can be Unavailable
spec:
  maxUnavailable: 1

# Percentage: at most 25% of pods can be Unavailable
# Rounded DOWN (floor), then subtracted from expectedPods
spec:
  maxUnavailable: "25%"
```

**Calculation with absolute maxUnavailable:**
```
disruptionsAllowed = expectedPods - currentHealthy + maxUnavailable -
                     max(0, expectedPods - currentHealthy)
Simplified:
  currentUnavailable = expectedPods - currentHealthy
  disruptionsAllowed = maxUnavailable - currentUnavailable

If expectedPods = 3, currentHealthy = 3, maxUnavailable = 1:
  currentUnavailable = 0
  disruptionsAllowed = 1 - 0 = 1  ✓

If expectedPods = 3, currentHealthy = 2, maxUnavailable = 1:
  currentUnavailable = 1
  disruptionsAllowed = 1 - 1 = 0  ✗ (already at max)
```

### Choosing Between minAvailable and maxUnavailable

**Use minAvailable when:**
- You have a fixed minimum quorum requirement (e.g., Raft/Paxos consensus needs at least `(N/2)+1` voters)
- The service is unavailable below a certain replica count regardless of total size
- You need to express "never go below X replicas" for SLA purposes

```yaml
# etcd 5-node cluster: needs at least 3 for quorum
spec:
  minAvailable: 3
```

**Use maxUnavailable when:**
- You want a relative percentage that scales with the deployment size
- The availability threshold scales proportionally with replica count
- You're expressing rolling update semantics

```yaml
# Large deployment: at most 10% disrupted at once
spec:
  maxUnavailable: "10%"
```

## Percentage Calculation Subtleties

Percentages in PDBs are subject to floor/ceiling rounding that can produce surprising results:

```yaml
# 5 replicas, minAvailable: "50%"
# floor(5 * 0.50) = floor(2.5) = 2
# So minAvailable = 2, disruptionsAllowed = 5 - 2 = 3
# You intended to allow 50% down, but actually 60% (3/5) can be evicted

# 5 replicas, maxUnavailable: "20%"
# floor(5 * 0.20) = floor(1.0) = 1
# So maxUnavailable = 1, disruptionsAllowed = 1
# Works as expected

# 3 replicas, maxUnavailable: "50%"
# floor(3 * 0.50) = floor(1.5) = 1
# So maxUnavailable = 1, not 1.5 (rounds down)
# Only 1 eviction allowed, not 1.5 or 2
```

Always verify the computed `disruptionsAllowed` after applying percentages:

```bash
kubectl get pdb -n production -o custom-columns=\
'NAME:.metadata.name,MIN:.spec.minAvailable,MAX:.spec.maxUnavailable,ALLOWED:.status.disruptionsAllowed,CURRENT:.status.currentHealthy,EXPECTED:.status.expectedPods'
```

## PDB and the Cluster Autoscaler

The cluster autoscaler (CA) respects PDB constraints when choosing which nodes to scale down. This interaction requires careful design.

### How CA Evaluates PDBs for Scale-Down

1. CA identifies a candidate node for scale-down (underutilized)
2. CA simulates the eviction of all pods on that node
3. For each pod, CA checks if evicting it would violate its PDB
4. If any pod's eviction would violate its PDB, CA skips that node

### CA and PDB Configuration

```yaml
# Properly configured PDB for CA compatibility
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: analytics-worker-pdb
  namespace: production
spec:
  selector:
    matchLabels:
      app: analytics-worker
  maxUnavailable: "20%"  # Allows CA to scale down 20% of workers at once
```

```yaml
# ANTI-PATTERN: PDB that blocks all CA scale-down
# If minAvailable == totalReplicas, CA can NEVER remove any node with these pods
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: blocking-pdb  # DON'T DO THIS
spec:
  selector:
    matchLabels:
      app: my-service
  minAvailable: 3  # 3 replicas, minAvailable = 3 = totalReplicas
  # disruptionsAllowed = 3 - 3 = 0
  # CA can never evict any pod!
```

### Cluster Autoscaler Annotations

```yaml
# Prevent CA from scaling down specific nodes
kubectl annotate node worker-01 cluster-autoscaler.kubernetes.io/scale-down-disabled=true

# Mark pods as safe to evict (bypass PDB for CA)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: batch-worker
spec:
  template:
    metadata:
      annotations:
        # CA will evict these pods without PDB checking
        cluster-autoscaler.kubernetes.io/safe-to-evict: "true"

# For pods that should NEVER be evicted by CA
metadata:
  annotations:
    cluster-autoscaler.kubernetes.io/safe-to-evict: "false"
```

### CA Scale-Down Eligibility Check Script

```bash
#!/usr/bin/env bash
# check-ca-eligibility.sh — Identify nodes blocked from CA scale-down by PDBs

for node in $(kubectl get nodes -o name | sed 's/node\///'); do
    echo "=== Node: $node ==="

    # Get pods on this node (excluding DaemonSet pods)
    pods=$(kubectl get pods --all-namespaces \
        --field-selector "spec.nodeName=$node" \
        -o json | jq -r '
        .items[] |
        select(.metadata.ownerReferences // [] |
               map(.kind) | contains(["DaemonSet"]) | not) |
        .metadata.namespace + "/" + .metadata.name
    ')

    if [ -z "$pods" ]; then
        echo "  No non-DaemonSet pods — eligible for scale-down"
        continue
    fi

    blocked=false
    for pod_ref in $pods; do
        ns=$(echo $pod_ref | cut -d'/' -f1)
        pod=$(echo $pod_ref | cut -d'/' -f2)

        # Find PDB that covers this pod
        pdb_info=$(kubectl get pdb -n $ns -o json | jq -r --arg pod "$pod" '
            .items[] |
            . as $pdb |
            .spec.selector.matchLabels as $selector |
            # Simple label match check
            ($pdb.status.disruptionsAllowed // 0) as $allowed |
            if $allowed == 0 then
                "\(.metadata.name): disruptionsAllowed=0 (BLOCKED)"
            else
                "\(.metadata.name): disruptionsAllowed=\($allowed) (OK)"
            end
        ' 2>/dev/null)

        if echo "$pdb_info" | grep -q BLOCKED; then
            echo "  BLOCKED: $pod_ref — $pdb_info"
            blocked=true
        fi
    done

    if ! $blocked; then
        echo "  All pods OK for eviction"
    fi
done
```

## Debugging Blocked Drains

A stuck `kubectl drain` is one of the most common Kubernetes operational issues. Here is a systematic debugging approach.

### Step 1: Check What is Blocking

```bash
# Drain with verbose output
kubectl drain worker-03 --ignore-daemonsets --delete-emptydir-data --dry-run=client

# Or check the eviction API directly
kubectl get events -n production --sort-by=.lastTimestamp | \
    grep -i "evict\|disrupt\|pdb"

# Check PDB status across all namespaces
kubectl get pdb --all-namespaces -o wide
# NAME                     NAMESPACE   MIN   MAX   ALLOWED   CURRENT   EXPECTED   AGE
# payment-service-pdb      production  2     N/A   0         2         2          45d
# analytics-worker-pdb     production  N/A   20%   0         5         5          12d

# Identify PDBs with 0 disruptions allowed
kubectl get pdb --all-namespaces \
    -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}: allowed={.status.disruptionsAllowed} current={.status.currentHealthy} expected={.status.expectedPods}{"\n"}{end}' | \
    grep "allowed=0"
```

### Step 2: Understand Why Disruptions Are 0

```bash
# Get detailed PDB status
kubectl describe pdb payment-service-pdb -n production

# Output:
# Name:           payment-service-pdb
# Namespace:      production
# Min available:  2
# Selector:       app=payment-service,tier=backend
# Status:
#     Allowed disruptions:  0
#     Current:              2
#     Desired:              2
#     Total:                2
# Events:
#   Warning  NoPodToDisrupt  5m  disruption-controller
#     Cannot evict pod as it would violate the pod's disruption budget.

# Current = Desired = 2, so disruptionsAllowed = 0
# The deployment only has 2 ready pods and minAvailable = 2
```

### Step 3: Common Causes and Fixes

```bash
# Cause 1: Deployment is scaled down or pods are unhealthy
kubectl get pods -n production -l app=payment-service
# NAME                        READY   STATUS    RESTARTS   AGE
# payment-server-abc123-xyz   1/1     Running   0          2d
# payment-server-def456-uvw   0/1     Pending   0          5m  ← This pod is not Ready!

# Fix: Investigate why the pod is Pending
kubectl describe pod payment-server-def456-uvw -n production | grep -A5 Events

# Cause 2: Deployment has too few replicas for the PDB
kubectl get deployment payment-service -n production
# NAME              READY   UP-TO-DATE   AVAILABLE   AGE
# payment-service   2/2     2            2           45d
# PDB requires minAvailable=2 but only 2 replicas exist → always 0 allowed

# Fix: Scale up or adjust PDB
kubectl scale deployment payment-service -n production --replicas=3
# OR
kubectl patch pdb payment-service-pdb -n production \
    --type='json' -p='[{"op":"replace","path":"/spec/minAvailable","value":1}]'

# Cause 3: PDB selector doesn't match any pods (misconfiguration)
kubectl get pods -n production --show-labels | grep payment-service
# Check that labels match the PDB selector exactly

# Cause 4: Rolling update in progress is consuming the disruption budget
kubectl get rs -n production -l app=payment-service
# Check if a ReplicaSet rollout is ongoing
```

### Step 4: Temporarily Adjust PDB for Emergency Maintenance

```bash
# Option A: Temporarily set maxUnavailable to allow the drain
kubectl patch pdb payment-service-pdb -n production --type='json' \
    -p='[{"op":"replace","path":"/spec/minAvailable","value":1}]'

kubectl drain worker-03 --ignore-daemonsets --delete-emptydir-data

# Restore original PDB after drain
kubectl patch pdb payment-service-pdb -n production --type='json' \
    -p='[{"op":"replace","path":"/spec/minAvailable","value":2}]'

# Option B: Delete PDB temporarily (more drastic)
kubectl get pdb -n production -o yaml > /tmp/pdb-backup.yaml
kubectl delete pdb payment-service-pdb -n production

kubectl drain worker-03 --ignore-daemonsets --delete-emptydir-data

kubectl apply -f /tmp/pdb-backup.yaml

# Option C: Force eviction bypassing PDB (use only in true emergencies)
# This uses the eviction API with force override
kubectl drain worker-03 --ignore-daemonsets --delete-emptydir-data \
    --disable-eviction=true  # Uses DELETE instead of eviction API
```

## Production PDB Patterns

### Stateful Services (Databases, Queues)

```yaml
# Pattern: Raft/Paxos quorum (PostgreSQL HA, etcd, Consul)
# Never allow quorum to be lost
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: postgres-ha-pdb
  namespace: database
spec:
  selector:
    matchLabels:
      app: postgres
      role: ha-cluster  # Both primary and replicas
  minAvailable: 2  # Quorum for 3-node cluster (N/2 + 1 = 2)
```

```yaml
# Pattern: Message queue with minimum consumer count
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: rabbitmq-pdb
  namespace: messaging
spec:
  selector:
    matchLabels:
      app: rabbitmq
  minAvailable: 2  # Never below 2 for clustering
```

### Stateless Services (Web, API)

```yaml
# Pattern: Percentage-based for horizontally scaled services
# Scales correctly as replica count changes
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-gateway-pdb
  namespace: production
spec:
  selector:
    matchLabels:
      app: api-gateway
  maxUnavailable: "25%"  # At most 25% down during any maintenance
```

```yaml
# Pattern: Absolute minimum for critical single-tenant services
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-processor-pdb
  namespace: production
spec:
  selector:
    matchLabels:
      app: payment-processor
  minAvailable: 2  # SLA requires at least 2 for N+1 redundancy
```

### Batch and Worker Services

```yaml
# Pattern: Allow high disruption for batch workers
# CA needs to scale these down aggressively during off-hours
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: batch-worker-pdb
  namespace: production
spec:
  selector:
    matchLabels:
      app: batch-worker
  maxUnavailable: "50%"  # Half can be evicted at once
```

### Deployment-Level PDB Template

```yaml
# Complete production pattern: Deployment + PDB + HPA
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: production
spec:
  replicas: 4
  selector:
    matchLabels:
      app: payment-service
      version: v2
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0    # Never go below desired during rollout
      maxSurge: 1          # One extra pod during rollout

  template:
    metadata:
      labels:
        app: payment-service
        version: v2
    spec:
      # Spread pods across nodes and zones
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: payment-service
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels:
              app: payment-service

      containers:
        - name: payment-service
          image: payment-service:v2.0.0
          readinessProbe:
            httpGet:
              path: /healthz/ready
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 3
            failureThreshold: 3

---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-service-pdb
  namespace: production
spec:
  selector:
    matchLabels:
      app: payment-service
  # With 4 replicas, maxUnavailable 25% = floor(4*0.25) = 1
  # So at most 1 pod can be disrupted at once
  maxUnavailable: "25%"

---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: payment-service-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-service
  minReplicas: 4
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
```

## PDB Status Monitoring

```bash
# Monitor PDB health across the cluster
kubectl get pdb --all-namespaces \
    -o custom-columns=\
'NAMESPACE:.metadata.namespace,NAME:.metadata.name,MIN:.spec.minAvailable,MAX:.spec.maxUnavailable,ALLOWED:.status.disruptionsAllowed,CURRENT:.status.currentHealthy,EXPECTED:.status.expectedPods'

# Alert when disruptionsAllowed = 0 for extended period
# (via Prometheus if using kube-state-metrics)
```

### Prometheus Alerting for PDBs

```yaml
# pdb-alerts.yaml
groups:
  - name: pdb
    rules:
      - alert: PDBDisruptionsAllowedZero
        expr: kube_poddisruptionbudget_status_disruptions_allowed == 0
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "PDB {{ $labels.namespace }}/{{ $labels.poddisruptionbudget }} allows 0 disruptions"
          description: |
            PDB has disruptionsAllowed=0 for 30+ minutes.
            This will block node drains and cluster upgrades.

      - alert: PDBCurrentHealthyBelowDesired
        expr: |
          kube_poddisruptionbudget_status_current_healthy <
          kube_poddisruptionbudget_status_desired_healthy
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "PDB {{ $labels.namespace }}/{{ $labels.poddisruptionbudget }} below desired health"
          description: |
            Current healthy pods ({{ $value }}) is below the minimum required by PDB.
```

## Summary

PodDisruptionBudgets are a coordination mechanism that protects your applications during voluntary cluster operations. They work by making the Kubernetes eviction API respect your availability guarantees before proceeding with any eviction. Key principles: PDBs only protect against voluntary disruptions; choose minAvailable for quorum-sensitive stateful systems and maxUnavailable for proportionally-scaled stateless services; always ensure the configured minimum is achievable given your actual replica count; and periodically audit PDB configurations to prevent them from silently blocking cluster maintenance. The combination of PDBs, pod anti-affinity, readiness probes, and graceful shutdown handling forms the complete picture of Kubernetes application reliability.
