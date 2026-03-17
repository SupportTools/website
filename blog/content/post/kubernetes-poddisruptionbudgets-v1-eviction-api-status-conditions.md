---
title: "Kubernetes PodDisruptionBudgets v1: minAvailable vs maxUnavailable, Disruption Calculation, Eviction API, and Status Conditions"
date: 2032-01-20T00:00:00-05:00
draft: false
tags: ["Kubernetes", "PodDisruptionBudget", "PDB", "High Availability", "Eviction API", "Node Maintenance"]
categories:
- Kubernetes
- Operations
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to Kubernetes PodDisruptionBudgets covering minAvailable vs maxUnavailable semantics, how the cluster autoscaler and node drain calculate disruption budgets, using the eviction API directly, status condition interpretation, and common PDB configuration mistakes that silently block node maintenance."
more_link: "yes"
url: "/kubernetes-poddisruptionbudgets-v1-eviction-api-status-conditions/"
---

PodDisruptionBudgets (PDBs) are a critical but often misunderstood Kubernetes primitive. When configured correctly, they protect production workloads from simultaneous eviction during node drains, rolling updates, and cluster autoscaler scale-downs. When misconfigured, they silently block node maintenance indefinitely or provide no actual protection. This guide covers PDB semantics exhaustively with production-ready configurations.

<!--more-->

# Kubernetes PodDisruptionBudgets: Complete Guide

## Section 1: PDB Fundamentals

A PodDisruptionBudget specifies the minimum number of replicas that must remain available during a voluntary disruption. Disruptions include:

**Voluntary disruptions (PDB applies):**
- `kubectl drain` for node maintenance
- Cluster Autoscaler scale-down
- Node updates in managed Kubernetes (GKE, EKS, AKS)
- Manual pod eviction via the Eviction API
- Anything that uses the Eviction subresource

**Involuntary disruptions (PDB does NOT apply):**
- Node failure (hardware crash, OOM kill)
- Kernel panic
- Cloud provider instance termination

### Basic PDB Resource

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-server-pdb
  namespace: production
spec:
  selector:
    matchLabels:
      app: api-server
  minAvailable: 2    # OR maxUnavailable: 1 (never both)
```

The PDB applies to all pods matching the selector in the same namespace.

## Section 2: minAvailable vs maxUnavailable

These two fields express the same constraint from opposite directions. You must use exactly one of them.

### minAvailable

`minAvailable` specifies the minimum number of pods that must be available after a disruption is allowed.

```yaml
# Absolute value: always keep at least 2 pods running
minAvailable: 2

# Percentage: keep at least 80% of pods running
# Kubernetes rounds DOWN for percentage calculations
minAvailable: "80%"
```

**Behavior with minAvailable:**
- If `replicas = 5` and `minAvailable = 2`, then up to 3 pods can be disrupted simultaneously
- If `replicas = 3` and `minAvailable = 3`, then ZERO pods can be disrupted (effectively blocks all drains)
- If `replicas = 3` and `minAvailable = "80%"`, then floor(3 * 0.8) = 2, so 1 pod can be disrupted

```yaml
# Common safe pattern: replicas=3, minAvailable=2 (allows 1 disruption at a time)
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: web-frontend-pdb
  namespace: production
spec:
  selector:
    matchLabels:
      app: web-frontend
      tier: frontend
  minAvailable: 2
```

### maxUnavailable

`maxUnavailable` specifies the maximum number of pods that may be unavailable during a disruption.

```yaml
# Absolute value: no more than 1 pod unavailable at once
maxUnavailable: 1

# Percentage: up to 20% of pods may be unavailable
maxUnavailable: "20%"
```

**Behavior with maxUnavailable:**
- If `replicas = 5` and `maxUnavailable = 1`, then at most 1 pod can be disrupted at a time
- If `replicas = 5` and `maxUnavailable = "20%"`, then floor(5 * 0.2) = 1, so 1 pod can be disrupted
- Kubernetes rounds DOWN for maxUnavailable percentage (same direction as minAvailable)

### Choosing Between Them

| Scenario | Recommended | Reason |
|----------|-------------|--------|
| High availability service | `minAvailable: 2` | Clear minimum guarantee |
| Single instance service | `maxUnavailable: 0` | Block all disruptions |
| Large deployment (>10 pods) | `maxUnavailable: "10%"` | Scales with replica count |
| Stateful set with quorum | `minAvailable: N/2+1` | Maintain quorum |
| Batch jobs (Deployments) | `maxUnavailable: 1` | Allow one at a time |

### The 0-Disruption Configuration

Setting `maxUnavailable: 0` or `minAvailable: <replicas>` blocks all voluntary disruptions. Use with extreme caution:

```yaml
# BLOCKS ALL NODE DRAINS - operator must manually delete pods
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: critical-job-pdb
spec:
  selector:
    matchLabels:
      app: payment-processor
  maxUnavailable: 0  # Zero tolerance for disruption
```

This is appropriate for:
- Payment processing services during business hours
- Active database primary instances
- Services with zero-downtime SLA requirements

Always pair 0-disruption PDBs with a process for temporarily deleting them during maintenance windows.

## Section 3: Disruption Calculation

Understanding exactly how Kubernetes calculates whether a disruption is allowed prevents surprises during drain operations.

### The Calculation

```
currentHealthy = number of pods matching selector that are "healthy"
A pod is "healthy" if:
  - Pod phase is Running
  - Pod condition Ready is True
  - Pod is not being deleted (DeletionTimestamp is nil)

desiredHealthy = max(minAvailable, replicas - maxUnavailable)

disruptionsAllowed = currentHealthy - desiredHealthy
```

Example:

```
Deployment replicas: 5
Current healthy pods: 5
PDB: maxUnavailable=1

desiredHealthy = 5 - 1 = 4
disruptionsAllowed = 5 - 4 = 1

→ One pod can be evicted
→ After eviction: currentHealthy=4, disruptionsAllowed=0
→ Must wait for replacement to become Ready before next eviction
```

### Disruption Counter in PDB Status

```bash
# View PDB disruption allowance
kubectl get pdb -n production

# NAME              MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS   AGE
# api-server-pdb    2               N/A               1                     5d

# Detailed status
kubectl describe pdb api-server-pdb -n production
```

```yaml
# Full PDB status
status:
  conditions:
    - lastTransitionTime: "2032-01-20T12:00:00Z"
      message: ""
      reason: SufficientPods
      status: "True"
      type: DisruptionAllowed
  currentHealthy: 3
  desiredHealthy: 2
  disruptionsAllowed: 1
  expectedPods: 3
  observedGeneration: 1
```

### Status Conditions

The `DisruptionAllowed` condition was added in Kubernetes 1.21:

| Condition | Status | Reason | Meaning |
|-----------|--------|--------|---------|
| DisruptionAllowed | True | SufficientPods | PDB satisfied, disruption permitted |
| DisruptionAllowed | False | InsufficientPods | Too few healthy pods, no disruption |
| DisruptionAllowed | False | NoPodControllerFound | PDB selector matches pods with no controller |
| DisruptionAllowed | True | SufficientPods | minAvailable=0 or maxUnavailable=max |

### When Drain Gets Stuck

```bash
# Node drain blocked by PDB
kubectl drain node-prod-3 --ignore-daemonsets --delete-emptydir-data

# Output:
# node/node-prod-3 cordoned
# error when evicting pods/"api-server-abc12" -n "production" (will retry after 5s):
# Cannot evict pod as it would violate the pod's disruption budget.

# Diagnose which PDB is blocking
kubectl get pods --field-selector spec.nodeName=node-prod-3 -A

# Check PDB status for each namespace
kubectl get pdb -n production -o custom-columns=\
  NAME:.metadata.name,\
  MIN:.spec.minAvailable,\
  MAX:.spec.maxUnavailable,\
  ALLOWED:.status.disruptionsAllowed,\
  HEALTHY:.status.currentHealthy,\
  EXPECTED:.status.expectedPods

# Find unhealthy pods blocking the PDB
kubectl get pods -n production -o wide | grep -v Running
```

## Section 4: The Eviction API

The Eviction API is the correct mechanism for evicting pods that respects PDBs. Direct pod deletion (`kubectl delete pod`) bypasses PDB checks.

### Eviction API v1 Structure

```yaml
apiVersion: policy/v1
kind: Eviction
metadata:
  name: api-server-abc12
  namespace: production
deleteOptions:
  gracePeriodSeconds: 30    # override pod's terminationGracePeriodSeconds
```

### Using the Eviction API via kubectl

```bash
# Graceful eviction (respects PDB)
kubectl evict pod api-server-abc12 -n production

# With custom grace period
kubectl evict pod api-server-abc12 -n production --grace-period=60

# Drain uses eviction API internally
kubectl drain node-prod-3 \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --grace-period=60 \
  --timeout=300s
```

### Direct Eviction API Call

```bash
# Using curl to call Eviction API directly
NAMESPACE="production"
POD_NAME="api-server-abc12"
K8S_API="https://kubernetes.default.svc"
TOKEN=$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)

curl -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  "${K8S_API}/api/v1/namespaces/${NAMESPACE}/pods/${POD_NAME}/eviction" \
  -d '{
    "apiVersion": "policy/v1",
    "kind": "Eviction",
    "metadata": {
      "name": "'${POD_NAME}'",
      "namespace": "'${NAMESPACE}'"
    }
  }'

# Response codes:
# 201 Created - eviction accepted
# 429 Too Many Requests - PDB blocking eviction
# 500 Internal Server Error - pod not found or other error
```

### Programmatic Eviction with Go Client

```go
package drain

import (
    "context"
    "fmt"
    "time"

    policyv1 "k8s.io/api/policy/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/util/wait"
    "k8s.io/client-go/kubernetes"
)

// EvictPod evicts a pod, retrying on PDB violations
func EvictPod(ctx context.Context, client kubernetes.Interface, namespace, podName string, gracePeriod int64) error {
    eviction := &policyv1.Eviction{
        ObjectMeta: metav1.ObjectMeta{
            Name:      podName,
            Namespace: namespace,
        },
        DeleteOptions: &metav1.DeleteOptions{
            GracePeriodSeconds: &gracePeriod,
        },
    }

    var lastErr error
    err := wait.PollUntilContextTimeout(ctx, 5*time.Second, 10*time.Minute, true,
        func(ctx context.Context) (bool, error) {
            err := client.PolicyV1().Evictions(namespace).Evict(ctx, eviction)
            if err == nil {
                return true, nil
            }

            // 429 = PDB violation, retry
            if isStatusError(err, 429) {
                lastErr = err
                return false, nil
            }

            // Other errors are fatal
            return false, err
        },
    )

    if err != nil && ctx.Err() != nil {
        return fmt.Errorf("eviction timed out (last error: %v)", lastErr)
    }
    return err
}

// WaitForPodGone waits until the pod is fully deleted
func WaitForPodGone(ctx context.Context, client kubernetes.Interface, namespace, podName, uid string) error {
    return wait.PollUntilContextTimeout(ctx, 2*time.Second, 5*time.Minute, true,
        func(ctx context.Context) (bool, error) {
            pod, err := client.CoreV1().Pods(namespace).Get(ctx, podName, metav1.GetOptions{})
            if err != nil {
                if isNotFound(err) {
                    return true, nil
                }
                return false, err
            }
            // Check UID to detect pod recreation
            if string(pod.UID) != uid {
                return true, nil
            }
            return false, nil
        },
    )
}
```

## Section 5: PDB Patterns for Common Workloads

### Stateless Web Service (3+ replicas)

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: web-api-pdb
  namespace: production
spec:
  selector:
    matchLabels:
      app: web-api
      component: server
  maxUnavailable: 1
  # With 3 replicas: 2 always healthy, 1 can be disrupted
  # With 5 replicas: 4 always healthy, 1 can be disrupted
  # Scales well with replica count changes
```

### Redis Cluster (Quorum-Based)

```yaml
# Redis cluster requires majority of nodes for writes
# With 6 nodes (3 masters, 3 replicas), maintain at least 4 healthy
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: redis-cluster-pdb
  namespace: data
spec:
  selector:
    matchLabels:
      app: redis-cluster
  minAvailable: 4    # Maintain quorum with 6 total nodes
```

### Kafka Brokers (Replication Factor Aware)

```yaml
# Kafka with replication factor 3 needs min 2 brokers for ISR
# Allow 1 broker disruption at a time
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: kafka-pdb
  namespace: messaging
spec:
  selector:
    matchLabels:
      app: kafka
      component: broker
  maxUnavailable: 1
```

### etcd Cluster (Strict Quorum)

```yaml
# etcd with 3 nodes - never allow more than 1 disruption
# etcd quorum = (n/2) + 1 = 2 for 3-node cluster
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: etcd-pdb
  namespace: kube-system
spec:
  selector:
    matchLabels:
      component: etcd
  minAvailable: 2   # Always keep quorum
```

### PostgreSQL Primary-Replica

```yaml
# PostgreSQL: protect primary strictly, allow one replica at a time
# Separate PDBs for primary vs replicas using label selectors

# Primary PDB - no disruption allowed (manual failover required)
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: postgres-primary-pdb
  namespace: data
spec:
  selector:
    matchLabels:
      app: postgres
      role: primary
  maxUnavailable: 0

---
# Replica PDB - allow one disruption at a time
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: postgres-replica-pdb
  namespace: data
spec:
  selector:
    matchLabels:
      app: postgres
      role: replica
  maxUnavailable: 1
```

### Single-Instance Critical Service

```yaml
# Service that cannot be disrupted but has no replicas yet
# This blocks all drains - use only with runbook for maintenance
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: legacy-service-pdb
  namespace: production
  annotations:
    ops.example.com/drain-procedure: "See runbook: https://wiki.example.com/drain-legacy"
spec:
  selector:
    matchLabels:
      app: legacy-service
  maxUnavailable: 0
```

## Section 6: PDB Validation and Auditing

### Checking PDB Coverage

```bash
#!/usr/bin/env bash
# Audit script: find Deployments without PDB coverage

NAMESPACE="${1:-production}"

echo "=== Deployments without PDB coverage in namespace: $NAMESPACE ==="

# Get all deployment selectors
kubectl get deployments -n "$NAMESPACE" -o json | \
  jq -r '.items[] | .metadata.name + ": " + (.spec.selector.matchLabels | to_entries | map(.key + "=" + .value) | join(","))' | \
  while IFS=': ' read -r deploy_name selector; do
    # Check if any PDB covers this selector
    covered=false
    while IFS= read -r pdb_selector; do
      if [[ "$selector" == *"$pdb_selector"* ]] || [[ "$pdb_selector" == *"$selector"* ]]; then
        covered=true
        break
      fi
    done < <(kubectl get pdb -n "$NAMESPACE" -o json | \
      jq -r '.items[].spec.selector.matchLabels | to_entries | map(.key + "=" + .value) | join(",")')

    if [ "$covered" = false ]; then
      replicas=$(kubectl get deployment "$deploy_name" -n "$NAMESPACE" -o jsonpath='{.spec.replicas}')
      echo "  MISSING PDB: $deploy_name (replicas: $replicas)"
    fi
  done
```

### PDB Status Monitoring

```yaml
# Prometheus metrics for PDB monitoring
# Available from kube-state-metrics
# kube_poddisruptionbudget_status_current_healthy
# kube_poddisruptionbudget_status_desired_healthy
# kube_poddisruptionbudget_status_disruptions_allowed
# kube_poddisruptionbudget_status_expected_pods

# Alert when PDB is blocking for too long
groups:
  - name: pdb-alerts
    rules:
      - alert: PDBBlockingDrainTooLong
        expr: |
          kube_poddisruptionbudget_status_disruptions_allowed == 0
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "PDB {{ $labels.namespace }}/{{ $labels.poddisruptionbudget }} blocking disruptions for 30+ minutes"
          description: |
            PDB has 0 allowed disruptions. Current healthy: {{ query "kube_poddisruptionbudget_status_current_healthy{namespace=\"" + $labels.namespace + "\",poddisruptionbudget=\"" + $labels.poddisruptionbudget + "\"}" | first | value }}, desired: {{ query "kube_poddisruptionbudget_status_desired_healthy{namespace=\"" + $labels.namespace + "\",poddisruptionbudget=\"" + $labels.poddisruptionbudget + "\"}" | first | value }}

      - alert: PDBCurrentLessThanDesired
        expr: |
          kube_poddisruptionbudget_status_current_healthy < kube_poddisruptionbudget_status_desired_healthy
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "PDB {{ $labels.namespace }}/{{ $labels.poddisruptionbudget }} below minimum"
          description: "Healthy pods ({{ $value }}) below desired minimum"
```

## Section 7: Common Mistakes

### Mistake 1: PDB Matches No Pods

```yaml
# BUG: selector uses 'tier' label but pods have 'component' label
spec:
  selector:
    matchLabels:
      app: api
      tier: backend   # pods actually have component: backend

# This PDB matches 0 pods - provides NO protection
# PDB status: currentHealthy=0, disruptionsAllowed=0
# Paradoxically, 0 disruptionsAllowed from 0 expected pods DOES block drains
```

Check:
```bash
kubectl get pods -n production -l app=api,tier=backend  # should return pods
```

### Mistake 2: PDB Allows Too Much

```yaml
# 3 replicas with minAvailable=1 allows 2 simultaneous disruptions
# Cluster autoscaler can scale down 2 nodes simultaneously
# Both replicas might land on same remaining node - capacity issue
spec:
  replicas: 3   # in Deployment
  # In PDB:
  minAvailable: 1   # allows 66% disruption - too permissive
```

### Mistake 3: maxUnavailable Without Enough Replicas

```yaml
# Deployment has 1 replica, PDB allows 1 disruption
# This means 100% of pods can be disrupted - PDB is useless
# Single-replica services should use maxUnavailable: 0
spec:
  selector:
    matchLabels:
      app: singleton-service
  maxUnavailable: 1   # with replicas=1, this means all pods can go
```

### Mistake 4: Forgetting UnhealthyPodEvictionPolicy

In Kubernetes 1.27+, you can configure whether unhealthy pods count toward PDB:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: app-pdb
spec:
  selector:
    matchLabels:
      app: my-app
  maxUnavailable: 1
  unhealthyPodEvictionPolicy: AlwaysAllow
  # Options:
  # IfHealthyBudget (default): unhealthy pods only evictable if budget allows
  # AlwaysAllow: unhealthy pods can always be evicted regardless of budget
  # Use AlwaysAllow to unblock drains when pods are already unhealthy
```

PodDisruptionBudgets are the contract between your application and the Kubernetes infrastructure team. Well-designed PDBs enable confident node maintenance and autoscaler operation while protecting applications from service-degrading simultaneous evictions.
