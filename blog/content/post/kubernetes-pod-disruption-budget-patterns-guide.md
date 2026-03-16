---
title: "Kubernetes PodDisruptionBudgets: Ensuring Availability During Voluntary Disruptions"
date: 2027-05-08T00:00:00-05:00
draft: false
tags: ["Kubernetes", "PodDisruptionBudget", "High Availability", "Operations", "Maintenance"]
categories: ["Kubernetes", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Kubernetes PodDisruptionBudgets covering minAvailable, maxUnavailable, selector patterns, interaction with drain/autoscaler/rolling updates, common pitfalls, and monitoring."
more_link: "yes"
url: "/kubernetes-pod-disruption-budget-patterns-guide/"
---

Node drains are the most common cause of unplanned application downtime in mature Kubernetes environments—and they are entirely preventable. When a platform team drains a node for maintenance, upgrades, or replacement, Kubernetes evicts pods sequentially. Without a PodDisruptionBudget, the scheduler evicts pods without regard for whether doing so would violate application availability requirements. A three-replica deployment can go to zero replicas during a rolling node upgrade if the pods happen to land on nodes being drained simultaneously.

PodDisruptionBudgets (PDBs) are the control mechanism that prevents this. A PDB tells the eviction API: "do not evict pods from this selector if doing so would violate these availability constraints." Node drain, the cluster autoscaler, and other voluntary disruption sources all respect PDB constraints before evicting a pod.

<!--more-->

## Executive Summary

PodDisruptionBudgets are a critical but frequently misconfigured component of Kubernetes high-availability design. This guide covers the full operational picture: PDB semantics (minAvailable vs maxUnavailable, absolute counts vs percentages), creation patterns for Deployments and StatefulSets, interactions with node drain, the cluster autoscaler, and rolling deployments, diagnosis and remediation of PDB violations, multi-AZ PDB design principles, and Prometheus alerting for PDB health.

## PDB Concepts and Semantics

### Disruption Types

Kubernetes distinguishes between two disruption categories:

```
Voluntary disruptions (PDB applies):
  - kubectl drain node
  - Cluster Autoscaler scale-down
  - Node upgrade / OS patching
  - Pod eviction via Eviction API
  - kubectl delete pod (via Eviction API when --grace-period > 0)

Involuntary disruptions (PDB does NOT apply):
  - Node hardware failure (power loss, kernel panic)
  - OOM kill (kubelet enforcement)
  - Node network partition
  - Pod crash (CrashLoopBackOff)
  - Preemption for higher-priority pod
```

### minAvailable vs maxUnavailable

Both fields specify a constraint on how many pods may be disrupted simultaneously, but from opposite perspectives:

```yaml
# minAvailable: "at least N pods must remain available"
spec:
  minAvailable: 2    # absolute: at least 2 pods available
  minAvailable: 75%  # percentage: at least 75% of desired replicas available

# maxUnavailable: "at most N pods may be simultaneously unavailable"
spec:
  maxUnavailable: 1    # absolute: at most 1 pod may be unavailable
  maxUnavailable: 25%  # percentage: at most 25% unavailable at once
```

Key difference: `minAvailable` is safer for StatefulSets where quorum matters; `maxUnavailable` is more intuitive for stateless Deployments.

### Percentage vs Absolute Values

```yaml
# Example: Deployment with 4 replicas
# PDB: maxUnavailable: 25%
# → floor(0.25 × 4) = 1 pod may be unavailable
# → 3 pods must be available during disruption

# PDB: minAvailable: 75%
# → ceil(0.75 × 4) = 3 pods must be available
# → 1 pod may be unavailable

# Critical edge case: 1 replica with minAvailable: 1
# → 0 pods may be evicted ever (PDB blocks all voluntary disruptions)
# → This is a common deadlock scenario — see Pitfalls section
```

### Disruption Budget Status

```bash
# Check PDB status
kubectl get pdb -n production

# Example output:
# NAME           MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS   AGE
# api-pdb        3               N/A               1                     14d
# frontend-pdb   N/A             1                 1                     14d
# postgres-pdb   2               N/A               0                     14d
#                                                  ↑
#                                    0 = PDB is currently blocking disruptions
```

## Creating PDBs for Common Workload Types

### Stateless Deployment PDB

```yaml
# Deployment with 4 replicas
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-service
  namespace: production
spec:
  replicas: 4
  selector:
    matchLabels:
      app: api-service
  template:
    metadata:
      labels:
        app: api-service
    spec:
      containers:
      - name: api
        image: example.com/api:v1.2.3
---
# PDB: allow up to 1 pod to be unavailable at a time
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-service-pdb
  namespace: production
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: api-service
```

### High-Replica Service with Percentage PDB

```yaml
# For a service with 20+ replicas, percentage-based PDB scales better
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: worker-pdb
  namespace: production
spec:
  maxUnavailable: 20%   # allow up to 20% disruption at once
  selector:
    matchLabels:
      app: worker
      tier: processing
```

### StatefulSet PDB — Quorum Protection

For stateful services like databases and Zookeeper, maintaining quorum is critical. A 3-node Kafka cluster loses write availability below 2 nodes; a 5-node etcd cluster loses quorum below 3 nodes.

```yaml
# Zookeeper 3-node cluster — maintain quorum (minimum 2 of 3)
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: zookeeper-pdb
  namespace: data
spec:
  minAvailable: 2     # must have at least 2 of 3 nodes
  selector:
    matchLabels:
      app: zookeeper
      component: server
---
# Kafka 3-broker cluster — maintain replication factor
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: kafka-pdb
  namespace: data
spec:
  minAvailable: 2     # maintain at least 2 brokers for RF=2
  selector:
    matchLabels:
      app: kafka
      component: broker
---
# etcd 5-node cluster — maintain quorum (minimum 3 of 5)
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: etcd-pdb
  namespace: etcd
spec:
  minAvailable: 3     # floor((5+1)/2) = 3 for majority quorum
  selector:
    matchLabels:
      app: etcd
```

### PostgreSQL Primary + Standby PDB

```yaml
# PostgreSQL with 1 primary + 2 standbys (via Patroni/CloudNative PG)
# Only 1 standby can be unavailable at a time
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: postgres-pdb
  namespace: data
spec:
  minAvailable: 2     # keep primary + at least 1 standby available
  selector:
    matchLabels:
      app.kubernetes.io/name: postgresql
      app.kubernetes.io/component: primary,standby
```

### PDB with Complex Label Selectors

```yaml
# Protect pods in multiple release tracks with a single PDB
# (useful when label selector covers blue/green deployments)
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-service-pdb
  namespace: production
spec:
  maxUnavailable: 1
  selector:
    matchExpressions:
    - key: app
      operator: In
      values:
      - payment-service
      - payment-service-canary
    - key: environment
      operator: In
      values:
      - production
```

## Interaction with Node Drain

### How Drain Respects PDBs

`kubectl drain` calls the Kubernetes Eviction API for each pod. The Eviction API checks PDB constraints before allowing the eviction to proceed.

```bash
# Drain with respect for PDB (default behaviour)
kubectl drain node-1 \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --grace-period=30

# Drain output when PDB blocks eviction:
# evicting pod production/api-service-abc123
# error when evicting pods/"api-service-abc123" -n "production"
# (will retry after 5s): Cannot evict pod as it would violate the
# pod's disruption budget. The disruption budget api-service-pdb
# needs 3 healthy pods and has 3 currently

# The drain command waits indefinitely until the PDB allows eviction
# (i.e., until one of the blocked pods becomes available on another node)
```

### Drain with Timeout

```bash
# Drain with a maximum wait time before reporting failure
kubectl drain node-1 \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --grace-period=30 \
  --timeout=300s   # fail if drain doesn't complete in 5 minutes

# Check which PDB is blocking the drain
kubectl get pdb -A \
  -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,DISRUPTIONS:.status.disruptionsAllowed'
```

### Force Drain — Use with Extreme Caution

```bash
# Force drain IGNORES PDB — only use for emergency node evacuation
# This WILL cause service disruption
kubectl drain node-1 \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --force \
  --grace-period=0   # immediate eviction, no graceful shutdown

# Better alternative: identify and fix the PDB issue first
kubectl describe pdb api-service-pdb -n production
```

### Automating Node Maintenance with PDB Awareness

```bash
#!/bin/bash
# safe-node-drain.sh — waits for PDB-safe drain window

NODE="${1}"
TIMEOUT="${2:-600}"  # seconds

if [[ -z "$NODE" ]]; then
  echo "Usage: $0 <node-name> [timeout-seconds]"
  exit 1
fi

echo "Checking PDB status before draining ${NODE}..."

# Check for any PDB with 0 allowed disruptions
BLOCKING_PDBS=$(kubectl get pdb -A \
  -o jsonpath='{range .items[?(@.status.disruptionsAllowed==0)]}{.metadata.namespace}/{.metadata.name}{"\n"}{end}')

if [[ -n "$BLOCKING_PDBS" ]]; then
  echo "WARNING: The following PDBs currently block all disruptions:"
  echo "$BLOCKING_PDBS"
  echo ""
  echo "Waiting up to ${TIMEOUT}s for disruptions to be allowed..."

  ELAPSED=0
  while [[ -n "$BLOCKING_PDBS" && $ELAPSED -lt $TIMEOUT ]]; do
    sleep 10
    ELAPSED=$((ELAPSED + 10))
    BLOCKING_PDBS=$(kubectl get pdb -A \
      -o jsonpath='{range .items[?(@.status.disruptionsAllowed==0)]}{.metadata.namespace}/{.metadata.name}{"\n"}{end}')
  done

  if [[ -n "$BLOCKING_PDBS" ]]; then
    echo "ERROR: PDBs still blocking after ${TIMEOUT}s. Aborting drain."
    exit 1
  fi
fi

echo "No blocking PDBs. Proceeding with drain..."
kubectl drain "$NODE" \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --grace-period=30 \
  --timeout="${TIMEOUT}s"

echo "Node ${NODE} drained successfully."
```

## Interaction with Cluster Autoscaler

The Cluster Autoscaler (CA) respects PDBs during scale-down operations. If evicting a pod from an underutilized node would violate the pod's PDB, the CA will not remove that node.

### CA Configuration for PDB Awareness

```yaml
# Cluster Autoscaler deployment — PDB-related flags
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cluster-autoscaler
  namespace: kube-system
spec:
  template:
    spec:
      containers:
      - name: cluster-autoscaler
        image: registry.k8s.io/autoscaling/cluster-autoscaler:v1.30.0
        command:
        - ./cluster-autoscaler
        - --cloud-provider=aws
        - --node-group-auto-discovery=asg:tag=k8s.io/cluster-autoscaler/enabled,k8s.io/cluster-autoscaler/prod-cluster
        # Maximum time CA will wait for a PDB-blocked eviction to succeed
        - --max-pod-eviction-time=2m
        # Scale down delay after PDB respecting
        - --scale-down-delay-after-add=10m
        # Skip nodes where pods have local storage (respect storage PDBs)
        - --skip-nodes-with-local-storage=false
        # CA will not scale down if it would result in PDB violation
        # This is the default behaviour — PDB awareness is always on
```

### Diagnosing CA Stuck on Scale-Down

```bash
# Check CA logs for PDB-related scale-down blocks
kubectl logs -n kube-system \
  -l app=cluster-autoscaler \
  --tail=200 \
  | grep -i "pdb\|disruption\|cannot be removed"

# Look for messages like:
# "Scale-down candidate node-X removed from candidates: pod/api-abc
#  cannot be removed, it would violate PDB api-service-pdb"

# Check which nodes are candidates for scale-down
kubectl get cm -n kube-system cluster-autoscaler-status -o yaml \
  | grep -A5 "ScaleDown"
```

## Interaction with Rolling Deployments

Rolling deployments use a different mechanism than the Eviction API, so they do NOT directly respect PDBs. However, PDB and Deployment rolling update strategy should be configured consistently.

### Aligning PDB with Rolling Update Strategy

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-service
  namespace: production
spec:
  replicas: 5
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1        # allow 1 extra pod during rollout
      maxUnavailable: 1  # allow 1 pod unavailable during rollout
  # ...
---
# PDB should be consistent with rolling update strategy
# With 5 replicas and maxUnavailable=1:
# - Rolling update allows 4 pods minimum
# - PDB should match or be slightly more permissive
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-service-pdb
  namespace: production
spec:
  maxUnavailable: 1   # consistent with Deployment strategy
  selector:
    matchLabels:
      app: api-service
```

### Why PDB + Rolling Update Can Conflict

```
Scenario: 5-replica Deployment, maxUnavailable=1, PDB minAvailable=5

Rolling update starts:
  Step 1: Terminate old pod → 4 pods running (1 unavailable)
  Step 2: Rolling update proceeds (maxUnavailable=1 satisfied)
  ← PDB says 5 must be available, but only 4 are → PDB would block eviction
  ← But rolling update doesn't use Eviction API → PDB NOT consulted
  ← Result: rolling update succeeds BUT node drain during rollout would fail
```

```yaml
# CORRECT: Leave headroom for simultaneous rolling update + node drain
# 5 replicas, need at least 4 healthy for the service to function

# Deployment strategy
strategy:
  rollingUpdate:
    maxSurge: 1
    maxUnavailable: 1

# PDB: protect against 2 simultaneous disruptions
# (1 from rolling update + 1 from node drain)
spec:
  minAvailable: 3   # 5 - 2 = 3; allows rolling update AND one drain simultaneously
```

## Common PDB Pitfalls

### Pitfall 1: Single-Replica Deployment with minAvailable=1

```yaml
# DANGEROUS CONFIGURATION
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: single-replica-pdb
  namespace: production
spec:
  minAvailable: 1   # with only 1 replica, this BLOCKS ALL VOLUNTARY DISRUPTIONS
  selector:
    matchLabels:
      app: legacy-service   # if this deployment has replicas: 1
```

```bash
# Detect this pattern
kubectl get pdb -A -o json | jq -r '
.items[] | {
  namespace: .metadata.namespace,
  pdb: .metadata.name,
  minAvailable: .spec.minAvailable,
  disruptionsAllowed: .status.disruptionsAllowed,
  currentHealthy: .status.currentHealthy,
  desiredHealthy: .status.desiredHealthy
} | select(.disruptionsAllowed == 0)
'
```

Resolution options:

```yaml
# Option 1: Scale the deployment to at least 2 replicas
# Option 2: Change PDB to minAvailable: 0 if service can tolerate brief outage
# Option 3: Remove the PDB if the service is truly non-critical

# If you MUST have a single replica, use maxUnavailable: 0 explicitly
# and document that drain will require --force
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: single-replica-pdb
  namespace: production
  annotations:
    note: "Single replica — node drain requires --force or scale up first"
spec:
  maxUnavailable: 0   # explicit: 0 disruptions allowed (same effect but clearer intent)
  selector:
    matchLabels:
      app: legacy-service
```

### Pitfall 2: PDB Selector Matching No Pods

```yaml
# PDB with selector that doesn't match any running pods
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: orphaned-pdb
  namespace: production
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: deleted-service  # this service was removed but PDB wasn't
```

```bash
# Find PDBs with no matching pods
kubectl get pdb -A -o json | jq -r '
.items[] | select(.status.currentHealthy == null or .status.currentHealthy == 0) |
"\(.metadata.namespace)/\(.metadata.name): currentHealthy=\(.status.currentHealthy)"
'

# Clean up orphaned PDBs
kubectl delete pdb orphaned-pdb -n production
```

### Pitfall 3: PDB Percentage Rounding with Small Replica Counts

```yaml
# 3-replica deployment with maxUnavailable: 50%
# floor(0.5 × 3) = 1 pod may be unavailable
# But if you expect to drain 2 nodes simultaneously, this blocks

# 2-replica deployment with maxUnavailable: 50%
# floor(0.5 × 2) = 1 pod may be unavailable
# This is correct for 2 replicas

# 1-replica deployment with maxUnavailable: 50%
# floor(0.5 × 1) = 0 pods may be unavailable
# BLOCKS ALL DISRUPTIONS — same as the single-replica trap
```

### Pitfall 4: PDB During Deployment Scale-Down

```bash
# If you scale a deployment from 5 to 3 replicas while a PDB requires minAvailable=4,
# the scale-down will succeed (Deployment controller doesn't use Eviction API),
# but subsequent node drains will be blocked because only 3 pods exist
# and minAvailable=4 cannot be satisfied.

# Always update PDB when scaling down
kubectl scale deployment api-service --replicas=3 -n production
kubectl patch pdb api-service-pdb -n production \
  --type='json' \
  -p='[{"op": "replace", "path": "/spec/minAvailable", "value": 2}]'
```

## Multi-AZ PDB Design

### The Multi-AZ Drain Problem

In a 3-AZ cluster, nodes in one AZ may need to be drained simultaneously (for AZ-level maintenance). A naive PDB allows only 1 pod unavailable, which would force pods to be drained one at a time even within an AZ.

```yaml
# 6-replica deployment spread across 3 AZs (2 pods per AZ)
# PDB should allow draining an entire AZ at once

apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-service-multiaz-pdb
  namespace: production
spec:
  # Allow up to 2 pods unavailable (all pods in one AZ)
  # With 6 replicas: 6 - 2 = 4 pods minimum
  maxUnavailable: 2
  selector:
    matchLabels:
      app: api-service
```

### Topology Spread + PDB Coordination

```yaml
# Deployment with topology spread to ensure even distribution
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-service
  namespace: production
spec:
  replicas: 6
  template:
    spec:
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: api-service
      containers:
      - name: api
        image: example.com/api:v1.2.3
---
# PDB aligned with topology spread: allow 1 AZ worth of pods to be unavailable
# 6 replicas / 3 AZs = 2 pods per AZ
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-service-pdb
  namespace: production
spec:
  # minAvailable: 4 = 6 - 2 (one AZ worth)
  minAvailable: 4
  selector:
    matchLabels:
      app: api-service
```

### Per-AZ PDB Pattern

For StatefulSets where AZ isolation is critical:

```yaml
# PDB for pods in zone-a only
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: kafka-zone-a-pdb
  namespace: data
spec:
  maxUnavailable: 1
  selector:
    matchExpressions:
    - key: app
      operator: In
      values:
      - kafka
    - key: topology.kubernetes.io/zone
      operator: In
      values:
      - us-east-1a
```

## Diagnosing and Remediating PDB Issues

### Diagnosis Script

```bash
#!/bin/bash
# pdb-health-check.sh — comprehensive PDB diagnostics

echo "=== PodDisruptionBudget Health Check ==="
echo ""

# List all PDBs with current status
echo "--- All PDBs ---"
kubectl get pdb -A \
  -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,MIN_AVAILABLE:.spec.minAvailable,MAX_UNAVAILABLE:.spec.maxUnavailable,CURRENT:.status.currentHealthy,DESIRED:.status.desiredHealthy,DISRUPTIONS_ALLOWED:.status.disruptionsAllowed'

echo ""
echo "--- PDBs Blocking All Disruptions (disruptionsAllowed=0) ---"
kubectl get pdb -A -o json | jq -r '
.items[] |
select(.status.disruptionsAllowed == 0) |
"\(.metadata.namespace)/\(.metadata.name)\t" +
"currentHealthy=\(.status.currentHealthy)\t" +
"desiredHealthy=\(.status.desiredHealthy)\t" +
"minAvailable=\(.spec.minAvailable // "N/A")\t" +
"maxUnavailable=\(.spec.maxUnavailable // "N/A")"
'

echo ""
echo "--- PDBs with 0 Matching Pods ---"
kubectl get pdb -A -o json | jq -r '
.items[] |
select(.status.currentHealthy == 0 and .status.disruptionsAllowed == 0) |
"\(.metadata.namespace)/\(.metadata.name): no pods matching selector"
'

echo ""
echo "--- Node Drain Simulation (dry run) ---"
for NODE in $(kubectl get nodes -o jsonpath='{.items[*].metadata.name}'); do
  echo "Node: $NODE"
  kubectl get pods -A \
    --field-selector="spec.nodeName=${NODE}" \
    -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{"\n"}{end}' \
  | head -5
  echo "..."
done
```

### Remediation Runbook

```bash
# Scenario: drain is stuck because PDB blocks eviction

# Step 1: Identify which PDB is blocking
kubectl get pdb -A \
  -o jsonpath='{range .items[?(@.status.disruptionsAllowed==0)]}{.metadata.namespace} {.metadata.name}{"\n"}{end}'

# Step 2: Check why disruptionsAllowed is 0
PDB_NAMESPACE="production"
PDB_NAME="api-service-pdb"

kubectl describe pdb "$PDB_NAME" -n "$PDB_NAMESPACE"
# Look for: currentHealthy, desiredHealthy, disruptionsAllowed

# Step 3a: If currentHealthy < desiredHealthy — pods are unhealthy
# Find unhealthy pods
kubectl get pods -n "$PDB_NAMESPACE" \
  -o wide \
  | grep -v "Running\|Completed"

# Fix unhealthy pods first, then retry drain

# Step 3b: If all pods are healthy but disruptionsAllowed=0
# → PDB constraint too tight for current replica count
# Option: temporarily increase replicas
kubectl scale deployment api-service \
  --replicas=6 \
  -n "$PDB_NAMESPACE"

# Wait for new pods to be ready
kubectl rollout status deployment/api-service -n "$PDB_NAMESPACE"

# Now drain should succeed
kubectl drain "$NODE" --ignore-daemonsets --delete-emptydir-data

# After drain, restore replica count
kubectl scale deployment api-service \
  --replicas=4 \
  -n "$PDB_NAMESPACE"

# Step 4: If pod is stuck evicting (stuck in Terminating state)
# Check if pod is stuck on the terminating node
kubectl get pod -n "$PDB_NAMESPACE" -o wide | grep Terminating

# Force delete stuck pod (last resort — may cause brief unavailability)
kubectl delete pod <stuck-pod> -n "$PDB_NAMESPACE" \
  --grace-period=0 \
  --force
```

## Monitoring and Alerting

### Prometheus Metrics for PDB

```yaml
# PrometheusRule for PDB monitoring
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: pdb-alerts
  namespace: monitoring
spec:
  groups:
  - name: pdb.rules
    interval: 30s
    rules:
    # Alert when PDB is blocking all disruptions for an extended period
    - alert: PDBBlockingDisruptions
      expr: |
        kube_poddisruptionbudget_status_disruptions_allowed == 0
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "PDB blocking all disruptions"
        description: >
          PDB {{ $labels.namespace }}/{{ $labels.poddisruptionbudget }}
          has been blocking all disruptions for 15+ minutes.
          This may prevent node maintenance.

    # Alert when PDB has fewer healthy pods than desired
    - alert: PDBHealthy
      expr: |
        kube_poddisruptionbudget_status_current_healthy
        <
        kube_poddisruptionbudget_status_desired_healthy
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "PDB has fewer healthy pods than desired"
        description: >
          PDB {{ $labels.namespace }}/{{ $labels.poddisruptionbudget }}
          has {{ $value }} healthy pods, needs {{ with query "kube_poddisruptionbudget_status_desired_healthy{namespace=\"%s\",poddisruptionbudget=\"%s\"}" $labels.namespace $labels.poddisruptionbudget }}{{ . | first | value }}{{ end }}.

    # Alert when no PDB exists for a critical deployment
    # (requires kube-state-metrics with custom relabeling)
    - alert: CriticalDeploymentNoPDB
      expr: |
        kube_deployment_labels{label_require_pdb="true"}
        unless on(namespace, label_app)
        (kube_poddisruptionbudget_status_current_healthy > 0)
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Critical deployment missing PDB"
        description: >
          Deployment {{ $labels.namespace }}/{{ $labels.deployment }}
          is marked as requiring a PDB but none exists.

    # Alert on PDB budget exhaustion (< 20% budget remaining)
    - alert: PDBBudgetLow
      expr: |
        (kube_poddisruptionbudget_status_disruptions_allowed
        /
        kube_poddisruptionbudget_status_expected_pods) < 0.2
      for: 10m
      labels:
        severity: info
      annotations:
        summary: "PDB disruption budget running low"
        description: >
          PDB {{ $labels.namespace }}/{{ $labels.poddisruptionbudget }}
          has only {{ $value | humanizePercentage }} of its disruption
          budget remaining.
```

### Grafana Dashboard Queries

```promql
# Current PDB status overview
# Number of PDBs blocking all disruptions
count(kube_poddisruptionbudget_status_disruptions_allowed == 0)

# PDB disruption budget utilisation heatmap
kube_poddisruptionbudget_status_disruptions_allowed
/ on(namespace, poddisruptionbudget)
kube_poddisruptionbudget_status_expected_pods

# Healthy vs desired pods per PDB
(
  kube_poddisruptionbudget_status_current_healthy
  - kube_poddisruptionbudget_status_desired_healthy
) < 0

# Node drain readiness: nodes with all pods PDB-protected
# (custom metric requiring node->pod->pdb correlation)
count by (node) (
  kube_pod_info * on(namespace, pod) group_left()
  (kube_poddisruptionbudget_status_disruptions_allowed > 0)
)
```

## PDB Automation and Policy

### OPA/Gatekeeper Policy to Require PDB for Deployments

```yaml
# ConstraintTemplate: require PDB for Deployments with replicas >= 2
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
        input.review.object.kind == "Deployment"
        input.review.object.spec.replicas >= 2
        namespace := input.review.object.metadata.namespace
        not namespace_has_pdb(namespace, input.review.object.metadata.name)
        msg := sprintf(
          "Deployment %v/%v has %v replicas but no PodDisruptionBudget",
          [namespace, input.review.object.metadata.name, input.review.object.spec.replicas]
        )
      }

      namespace_has_pdb(namespace, name) {
        # In a real implementation, you would check external data source
        # or use a sync mechanism to check PDB existence
        input.review.object.metadata.annotations["pdb.policy/exempt"] == "true"
      }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: RequirePDB
metadata:
  name: require-pdb-for-replicated-deployments
spec:
  match:
    kinds:
    - apiGroups: ["apps"]
      kinds: ["Deployment"]
    namespaces:
    - production
    - staging
```

### Automated PDB Creation via Admission Webhook

For platform teams that want automatic PDB creation without burdening development teams:

```yaml
# Example: Kyverno ClusterPolicy to auto-create PDB
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: auto-create-pdb
spec:
  rules:
  - name: create-pdb-for-deployment
    match:
      any:
      - resources:
          kinds:
          - Deployment
          namespaces:
          - production
          - staging
    generate:
      synchronize: true
      apiVersion: policy/v1
      kind: PodDisruptionBudget
      name: "{{request.object.metadata.name}}-pdb"
      namespace: "{{request.object.metadata.namespace}}"
      data:
        spec:
          maxUnavailable: 1
          selector:
            matchLabels:
              "{{request.object.spec.selector.matchLabels}}"
```

## Quick Reference: PDB Configuration Cheat Sheet

```yaml
# Deployment, 3+ replicas, stateless, allow 1 unavailable
spec:
  maxUnavailable: 1

# Deployment, 2 replicas, need both available most of the time
spec:
  minAvailable: 1   # allow only 1 disruption — never minAvailable: 2 with 2 replicas!

# StatefulSet, 3-node quorum (Zookeeper, etcd, Kafka)
spec:
  minAvailable: 2   # majority quorum: floor(3/2)+1 = 2

# StatefulSet, 5-node quorum (etcd)
spec:
  minAvailable: 3   # majority quorum: floor(5/2)+1 = 3

# High-replica stateless service (20+ pods), AZ-aware
spec:
  maxUnavailable: 25%  # allow one AZ worth of pods (roughly)

# Critical single-instance service (document explicitly)
spec:
  maxUnavailable: 0   # explicit: ALL disruptions blocked
  # Note: require --force to drain nodes running this pod

# Service that can tolerate brief full outage during maintenance
# (no PDB needed — but document the decision)
```

PodDisruptionBudgets are one of the highest-value, lowest-cost reliability investments in a Kubernetes platform. A few dozen lines of YAML prevent the most common class of maintenance-induced outages. The key discipline is maintaining PDB configurations alongside replica counts—a PDB that was correct for 5 replicas may silently become a deadlock when the deployment is scaled to 1 replica during cost optimisation, and catching that scenario before the next node drain requires the monitoring and alerting patterns described in this guide.
