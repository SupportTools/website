---
title: "Kubernetes PodDisruptionBudget Deep Dive: Ensuring Availability During Disruptions"
date: 2028-04-09T00:00:00-05:00
draft: false
tags: ["Kubernetes", "PDB", "Availability", "Upgrades", "StatefulSet"]
categories: ["Kubernetes", "Reliability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes PodDisruptionBudgets covering minAvailable, maxUnavailable, unhealthy pod eviction policies, StatefulSet patterns, and integration with cluster autoscaler and node upgrade workflows."
more_link: "yes"
url: "/kubernetes-pod-disruption-budget-deep-dive-guide/"
---

PodDisruptionBudgets (PDBs) are one of the most misunderstood and misconfigured features in Kubernetes. Incorrect PDB configuration is a common cause of node drain failures that block cluster upgrades for hours. This guide covers every aspect of PDB design, from basic minAvailable configuration to advanced patterns for stateful workloads and integration with cluster autoscaler.

<!--more-->

# Kubernetes PodDisruptionBudget Deep Dive: Ensuring Availability During Disruptions

## What PDBs Protect Against

PodDisruptionBudgets protect against **voluntary disruptions** — cluster operations initiated by an admin or automated system that would cause pods to be evicted. These include:

- Node drain operations (`kubectl drain`)
- Node upgrades (EKS, GKE, AKS managed node pool rotation)
- Cluster autoscaler node scale-down
- Spot/preemptible instance reclamation (with PDB-aware termination)
- Manual eviction via the eviction API

PDBs do **not** protect against involuntary disruptions:
- Node failures (hardware failure, kernel crash)
- Out-of-memory kills
- Pod failures from liveness probe failures

Understanding this distinction is critical — a PDB with `minAvailable: 100%` cannot prevent a node failure from disrupting your service.

## Basic PDB Configuration

### minAvailable

`minAvailable` specifies the minimum number of pods that must remain available during a disruption. Eviction will be refused if it would drop below this threshold.

```yaml
# Absolute count: at least 2 pods must always be available
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-service-pdb
  namespace: team-payments
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: payment-service
---
# Percentage: at least 80% of pods must be available
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-gateway-pdb
  namespace: team-api
spec:
  minAvailable: "80%"
  selector:
    matchLabels:
      app: api-gateway
```

### maxUnavailable

`maxUnavailable` specifies the maximum number of pods that can be disrupted simultaneously. This is equivalent to `minAvailable = replicas - maxUnavailable`.

```yaml
# Allow at most 1 pod to be unavailable at a time
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: worker-pdb
  namespace: processing
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: background-worker
---
# Allow at most 25% of pods to be unavailable
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: cache-pdb
  namespace: caching
spec:
  maxUnavailable: "25%"
  selector:
    matchLabels:
      app: redis-cache
```

### Choosing Between minAvailable and maxUnavailable

| Scenario | Recommendation |
|----------|----------------|
| High-availability service, fixed replicas | `minAvailable: 2` (absolute) |
| Service with variable replica count | `maxUnavailable: 25%` (percentage) |
| StatefulSet with quorum requirements | `minAvailable: 2` (for 3-replica set) |
| Stateless service with HPA | `maxUnavailable: "25%"` |
| Single-replica deployment | See below — avoid `minAvailable: 1` trap |

## The Single-Replica Trap

A common and dangerous misconfiguration: setting `minAvailable: 1` on a single-replica deployment.

```yaml
# DANGEROUS: This will block ALL drain operations
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: dashboard-pdb
spec:
  minAvailable: 1      # With only 1 replica, this BLOCKS all evictions
  selector:
    matchLabels:
      app: dashboard
```

If your deployment has `replicas: 1` and `minAvailable: 1`, no node can ever be drained. Node upgrades will stall indefinitely. The correct approach:

```yaml
# Option 1: Allow disruption (single-replica = accept brief downtime)
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: dashboard-pdb
spec:
  minAvailable: 0  # Or simply: don't create a PDB for single-replica workloads
  selector:
    matchLabels:
      app: dashboard

# Option 2: Scale up first, then protect
# Change deployment to replicas: 2, then use:
spec:
  minAvailable: 1  # Now safe: can lose 1 of 2
```

## Unhealthy Pod Eviction Policy

Kubernetes 1.26+ introduced `unhealthyPodEvictionPolicy` to handle stuck disruptions caused by unhealthy pods:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: web-frontend-pdb
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: web-frontend
  unhealthyPodEvictionPolicy: AlwaysAllow
  # Options:
  # IfHealthyBudget (default): Only evict unhealthy pods if budget allows
  # AlwaysAllow: Allow eviction of unhealthy pods even if it violates budget
```

The `AlwaysAllow` policy prevents a situation where a single unhealthy pod blocks all cluster maintenance. Use it for stateless workloads where disrupting an already-unhealthy pod has no additional impact.

## StatefulSet PDB Patterns

StatefulSets require careful PDB design because they often implement distributed consensus algorithms (Raft, Paxos, Galera) that require quorum.

### Three-Node Quorum Pattern

```yaml
# For a 3-node Raft cluster (e.g., etcd, Consul, ZooKeeper)
# Quorum requires ceil(N/2) + 1 = 2 nodes minimum
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: etcd-pdb
  namespace: etcd-cluster
spec:
  minAvailable: 2  # Never go below quorum
  selector:
    matchLabels:
      app: etcd
```

### Five-Node Cluster Pattern

```yaml
# For a 5-node cluster
# Quorum = 3, so losing 2 is acceptable
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: cassandra-pdb
  namespace: cassandra
spec:
  maxUnavailable: 1  # Only drain one node at a time for safety
  selector:
    matchLabels:
      app: cassandra
```

### Per-Pod PDB for Critical Stateful Services

For stateful services where each pod holds unique state (e.g., sharded databases), create individual PDBs per pod:

```yaml
# Generate this for each StatefulSet pod with a script or operator
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: mongo-0-pdb
  namespace: mongodb
spec:
  minAvailable: 1
  selector:
    matchLabels:
      statefulset.kubernetes.io/pod-name: mongo-0
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: mongo-1-pdb
  namespace: mongodb
spec:
  minAvailable: 1
  selector:
    matchLabels:
      statefulset.kubernetes.io/pod-name: mongo-1
```

## PDB Status and Debugging

```bash
# View PDB status
kubectl get pdb -n team-payments

# Output:
# NAME                  MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS   AGE
# payment-service-pdb   2               N/A               1                     14d

# Detailed PDB status
kubectl describe pdb payment-service-pdb -n team-payments

# Key fields to watch:
# Allowed Disruptions: 0 means drain will block
# Current Healthy: pods that pass readiness checks
# Desired Healthy: minimum healthy pods required
# Expected Pods: total pods matched by selector
```

### Why Drain Blocks: Diagnosis Checklist

```bash
#!/bin/bash
# diagnose-drain-block.sh
NODE="${1:?Usage: $0 <node-name>}"

echo "=== Diagnosing drain block for node: $NODE ==="
echo ""

echo "--- Pods on node ---"
kubectl get pods --all-namespaces \
    --field-selector="spec.nodeName=$NODE" \
    -o wide

echo ""
echo "--- PDBs with zero allowed disruptions ---"
kubectl get pdb --all-namespaces -o json | \
    jq -r '.items[] | select(.status.disruptionsAllowed == 0) |
    "\(.metadata.namespace)/\(.metadata.name): disruptionsAllowed=0, currentHealthy=\(.status.currentHealthy), desiredHealthy=\(.status.desiredHealthy)"'

echo ""
echo "--- Checking for stuck evictions ---"
kubectl get events --all-namespaces --field-selector=reason=EvictionBlocked 2>/dev/null

echo ""
echo "--- Pods with no matching PDB (unprotected) ---"
for pod in $(kubectl get pods --all-namespaces --field-selector="spec.nodeName=$NODE" -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{"\n"}{end}'); do
    ns=$(echo $pod | cut -d/ -f1)
    name=$(echo $pod | cut -d/ -f2)
    labels=$(kubectl get pod -n "$ns" "$name" -o jsonpath='{.metadata.labels}')
    echo "  $pod: $labels"
done
```

### Force Drain When PDB Blocks

```bash
# Check what's blocking the drain
kubectl describe node $NODE | grep -A5 "Conditions:"

# Identify the blocking PDB
kubectl get events --all-namespaces | grep -i eviction

# Option 1: Temporarily patch PDB (for emergencies only)
kubectl patch pdb payment-service-pdb -n team-payments \
    --type='json' \
    -p='[{"op": "replace", "path": "/spec/minAvailable", "value": 0}]'

# Drain the node
kubectl drain $NODE --ignore-daemonsets --delete-emptydir-data

# Restore PDB immediately after
kubectl patch pdb payment-service-pdb -n team-payments \
    --type='json' \
    -p='[{"op": "replace", "path": "/spec/minAvailable", "value": 2}]'

# Option 2: Force evict a specific pod (last resort)
kubectl api-resources | grep eviction
# Use the eviction API with force flag
```

## Integration with Cluster Autoscaler

The cluster autoscaler respects PDBs when removing nodes. Misconfigured PDBs can prevent scale-down even when nodes are underutilized.

```yaml
# Annotation to control autoscaler behavior per pod
apiVersion: apps/v1
kind: Deployment
metadata:
  name: batch-processor
spec:
  template:
    metadata:
      annotations:
        # Allow cluster-autoscaler to evict these pods
        cluster-autoscaler.kubernetes.io/safe-to-evict: "true"
        # Or block eviction for critical pods
        # cluster-autoscaler.kubernetes.io/safe-to-evict: "false"
```

```yaml
# Cluster autoscaler configuration
# Scale-down will be blocked if PDB prevents it
apiVersion: v1
kind: ConfigMap
metadata:
  name: cluster-autoscaler-status
  namespace: kube-system
# The autoscaler logs which PDBs blocked scale-down:
# "scale down blocked by PDB: payment-service-pdb in namespace team-payments"
```

## PDB and Rolling Updates

PDBs interact with Deployment rolling update strategy. If your PDB and Deployment strategy conflict, updates can stall.

```yaml
# Deployment with 10 replicas
apiVersion: apps/v1
kind: Deployment
spec:
  replicas: 10
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0  # Always add before removing (zero-downtime)
      maxSurge: 2
---
# Compatible PDB — ensures at least 8 are always available
apiVersion: policy/v1
kind: PodDisruptionBudget
spec:
  minAvailable: 8  # 10 - 2 = 8 (aligned with maxSurge of 2)
  selector:
    matchLabels:
      app: myapp
```

The golden rule: `minAvailable + maxSurge <= replicas + maxSurge` — ensure the numbers allow the update to progress.

## PDB for Ingress Controllers

Ingress controllers are a critical dependency. PDBs are essential:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: ingress-nginx-pdb
  namespace: ingress-nginx
spec:
  minAvailable: 1  # Never go to zero
  selector:
    matchLabels:
      app.kubernetes.io/name: ingress-nginx
      app.kubernetes.io/component: controller
```

For high-traffic ingress, use percentage-based:

```yaml
spec:
  minAvailable: "50%"  # Maintain half capacity during upgrades
```

## Automated PDB Compliance Checking

```yaml
# Kyverno policy to enforce PDB existence for Deployments
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-pod-disruption-budget
spec:
  validationFailureAction: warn
  background: true
  rules:
  - name: check-pdb-exists
    match:
      any:
      - resources:
          kinds:
          - Deployment
          namespaceSelector:
            matchLabels:
              managed-by: platform-team
    validate:
      message: "Deployments with 2+ replicas should have a PodDisruptionBudget"
      deny:
        conditions:
          all:
          - key: "{{ request.object.spec.replicas }}"
            operator: GreaterThan
            value: 1
          # Check if PDB exists — requires custom function or audit approach
```

```bash
#!/bin/bash
# check-pdb-coverage.sh — Find Deployments without PDB coverage

echo "=== Deployments without PDB Coverage ==="
echo ""

for ns in $(kubectl get namespaces -o jsonpath='{.items[*].metadata.name}'); do
    deployments=$(kubectl get deployments -n "$ns" -o json 2>/dev/null)
    if [ -z "$deployments" ] || echo "$deployments" | jq -e '.items | length == 0' > /dev/null; then
        continue
    fi

    echo "Namespace: $ns"
    while IFS= read -r deploy_info; do
        name=$(echo "$deploy_info" | cut -d'|' -f1)
        replicas=$(echo "$deploy_info" | cut -d'|' -f2)
        labels=$(echo "$deploy_info" | cut -d'|' -f3-)

        if [ "$replicas" -lt 2 ]; then
            continue  # Single replica — PDB optional
        fi

        # Check if any PDB selector matches this deployment's labels
        pdb_match=$(kubectl get pdb -n "$ns" -o json | \
            jq -r --argjson labels "$labels" \
            '.items[] | select(.spec.selector.matchLabels | to_entries | all(.value == ($labels[.key] // null))) | .metadata.name' 2>/dev/null)

        if [ -z "$pdb_match" ]; then
            echo "  [WARN] $name (replicas: $replicas) - NO PDB"
        else
            echo "  [OK]   $name (replicas: $replicas) - PDB: $pdb_match"
        fi
    done < <(echo "$deployments" | jq -r '.items[] | "\(.metadata.name)|\(.spec.replicas // 0)|\(.spec.selector.matchLabels | tostring)"')
    echo ""
done
```

## PDB Monitoring with Prometheus

```yaml
# PrometheusRule for PDB alerting
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: pdb-alerts
  namespace: monitoring
spec:
  groups:
  - name: pdb-availability
    rules:
    # Alert when a PDB has no allowed disruptions for extended period
    # (may indicate blocked drain)
    - alert: PDBDisruptionsBlockedLong
      expr: |
        kube_poddisruptionbudget_status_disruptions_allowed == 0
      for: 30m
      labels:
        severity: warning
      annotations:
        summary: "PDB {{ $labels.namespace }}/{{ $labels.poddisruptionbudget }} has 0 allowed disruptions"
        description: "No voluntary disruptions allowed for 30 minutes. Check if a drain operation is blocked."

    # Alert when PDB expected pods count drops below minimum
    - alert: PDBPodCountBelowMinimum
      expr: |
        (kube_poddisruptionbudget_status_current_healthy
         < kube_poddisruptionbudget_status_desired_healthy)
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "PDB {{ $labels.namespace }}/{{ $labels.poddisruptionbudget }} below minimum healthy"

    # Alert when expected pods count is zero (selector matches nothing)
    - alert: PDBSelectsNoPods
      expr: |
        kube_poddisruptionbudget_status_expected_pods == 0
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "PDB {{ $labels.namespace }}/{{ $labels.poddisruptionbudget }} selects no pods"
        description: "PDB selector matches no pods. The PDB may be misconfigured."
```

## Managed Kubernetes Node Upgrade Patterns

### EKS Managed Node Group Upgrade

```bash
# EKS respects PDBs during managed node group updates
# Monitor the upgrade progress
aws eks describe-nodegroup \
    --cluster-name production \
    --nodegroup-name workers \
    --query 'nodegroup.{Status:status,Health:health}'

# If upgrade stalls, check PDB status across all namespaces
kubectl get pdb --all-namespaces -o wide | grep -v "^NAMESPACE" | \
    awk '{if ($6 == "0") print $0}'
```

### GKE Node Pool Upgrade

```bash
# GKE uses the eviction API and respects PDBs
# Check for blocking PDBs before initiating upgrade
gcloud container node-pools describe default-pool \
    --cluster production \
    --region us-central1 \
    --format="value(upgradeSettings)"
```

### Manual Rolling Node Upgrade

```bash
#!/bin/bash
# rolling-node-upgrade.sh
# Safely drain and upgrade nodes one at a time

NODES=$(kubectl get nodes -l kubernetes.io/role=worker -o jsonpath='{.items[*].metadata.name}')
DRAIN_TIMEOUT=600  # 10 minutes

for node in $NODES; do
    echo "=== Processing node: $node ==="

    # Check PDB status before draining
    echo "Checking PDB health..."
    pdb_blocked=$(kubectl get pdb --all-namespaces -o json | \
        jq '[.items[] | select(.status.disruptionsAllowed == 0)] | length')

    if [ "$pdb_blocked" -gt 0 ]; then
        echo "WARNING: $pdb_blocked PDB(s) with 0 allowed disruptions"
        echo "Waiting for PDBs to recover before proceeding..."
        # Wait up to 5 minutes for PDBs to recover
        for i in $(seq 1 30); do
            sleep 10
            blocked=$(kubectl get pdb --all-namespaces -o json | \
                jq '[.items[] | select(.status.disruptionsAllowed == 0)] | length')
            [ "$blocked" -eq 0 ] && break
        done
    fi

    # Cordon first (prevents new scheduling)
    kubectl cordon "$node"

    # Drain with timeout
    if ! kubectl drain "$node" \
        --ignore-daemonsets \
        --delete-emptydir-data \
        --timeout="${DRAIN_TIMEOUT}s" \
        --grace-period=30; then
        echo "ERROR: Drain failed for $node. Uncordoning."
        kubectl uncordon "$node"
        exit 1
    fi

    echo "Node $node drained. Upgrade can proceed."
    echo "Perform upgrade now. Press Enter when complete..."
    read -r

    # Uncordon after upgrade
    kubectl uncordon "$node"
    echo "Node $node uncordoned."

    # Wait for node to become ready before proceeding
    kubectl wait node "$node" --for=condition=Ready --timeout=300s

    echo "Waiting 60s for workloads to stabilize..."
    sleep 60
done

echo "=== Rolling upgrade complete ==="
```

## PDB Design Summary

Well-designed PDBs balance two competing requirements: availability and operability. A PDB that is too strict blocks cluster maintenance. One that is too lenient provides no protection during upgrades.

Follow these guidelines:

1. Every Deployment with 2+ replicas should have a PDB
2. Use `minAvailable: 1` for workloads where single-instance operation is acceptable
3. Use `minAvailable: 2` for quorum-sensitive workloads
4. Avoid `minAvailable: 100%` unless you truly need all replicas available simultaneously
5. Add `unhealthyPodEvictionPolicy: AlwaysAllow` for stateless workloads
6. Monitor `disruptionsAllowed == 0` to detect blocked drains early
7. Test your PDB configuration by performing a test drain in a non-production environment

PDBs are most valuable when they encode operational knowledge about your service's availability requirements — the right configuration depends on your SLO requirements and the nature of the workload.
