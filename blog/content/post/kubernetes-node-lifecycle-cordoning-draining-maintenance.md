---
title: "Kubernetes Node Lifecycle: Cordoning, Draining, and Maintenance Windows"
date: 2029-11-13T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Node Management", "Maintenance", "Operations", "Pod Disruption Budgets", "Graceful Shutdown"]
categories:
- Kubernetes
- Operations
- SRE
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Kubernetes node lifecycle management: node conditions and taints, API-driven eviction, pod disruption budgets during drain, graceful node shutdown, and production maintenance window procedures."
more_link: "yes"
url: "/kubernetes-node-lifecycle-cordoning-draining-maintenance/"
---

Node maintenance is a routine operational task that, done incorrectly, causes unnecessary service disruptions. This post covers the complete Kubernetes node lifecycle: from understanding node conditions and taints, to executing zero-downtime drains with PodDisruptionBudget awareness, to the graceful node shutdown feature introduced in Kubernetes 1.21 that handles unexpected node reboots.

<!--more-->

# Kubernetes Node Lifecycle: Cordoning, Draining, and Maintenance Windows

## Node Conditions and Status

The Kubernetes control plane continuously monitors nodes and updates their condition status. Understanding these conditions is the starting point for any maintenance procedure.

```bash
# View all node conditions
kubectl describe node worker-1 | grep -A 20 "Conditions:"

# Or with JSON
kubectl get node worker-1 -o jsonpath='{.status.conditions[*]}' | jq -r '.'

# Programmatic check
kubectl get node worker-1 -o json | jq '
  .status.conditions[] |
  select(.status == "True") |
  {type: .type, reason: .reason, message: .message}'
```

### Node Condition Types

| Condition | Normal Value | Meaning When Abnormal |
|-----------|-------------|----------------------|
| Ready | True | Node is not ready to accept pods |
| MemoryPressure | False | Node is running low on memory |
| DiskPressure | False | Node disk is almost full |
| PIDPressure | False | Too many processes on the node |
| NetworkUnavailable | False | Network is not configured correctly |

```bash
# Watch all nodes with conditions
kubectl get nodes -o custom-columns=\
'NAME:.metadata.name,STATUS:.status.conditions[-1].type,READY:.status.conditions[?(@.type=="Ready")].status,\
DISK:.status.conditions[?(@.type=="DiskPressure")].status,\
MEMORY:.status.conditions[?(@.type=="MemoryPressure")].status'

# Check taint status
kubectl get nodes -o json | jq -r '
  .items[] |
  select(.spec.taints != null and (.spec.taints | length) > 0) |
  .metadata.name + ": " + (.spec.taints | map(.key + "=" + (.value // "nil") + ":" + .effect) | join(","))'
```

## Taints Applied During Lifecycle Events

Kubernetes automatically applies taints during node lifecycle transitions:

```bash
# Taints applied automatically:
# node.kubernetes.io/not-ready:NoExecute          - when Ready=False
# node.kubernetes.io/unreachable:NoExecute         - when node is unreachable
# node.kubernetes.io/out-of-disk:NoSchedule        - when DiskPressure=True
# node.kubernetes.io/memory-pressure:NoSchedule    - when MemoryPressure=True
# node.kubernetes.io/pid-pressure:NoSchedule       - when PIDPressure=True
# node.kubernetes.io/disk-pressure:NoSchedule      - when DiskPressure=True
# node.kubernetes.io/unschedulable:NoSchedule      - when cordoned
# node.kubernetes.io/network-unavailable:NoSchedule - when NetworkUnavailable=True

# Check taints on a node
kubectl get node worker-1 -o jsonpath='{.spec.taints}'

# The eviction timeout for not-ready/unreachable
# Default: pods are evicted after 300 seconds (5 minutes)
# Controlled by: --default-not-ready-toleration-seconds (kube-apiserver)
#                --default-unreachable-toleration-seconds (kube-apiserver)

# Override default toleration in pod spec:
```

```yaml
# Pod with custom eviction tolerations
apiVersion: v1
kind: Pod
spec:
  tolerations:
  # Tolerate not-ready for 10 minutes before eviction
  - key: "node.kubernetes.io/not-ready"
    operator: "Exists"
    effect: "NoExecute"
    tolerationSeconds: 600
  # Tolerate unreachable for 10 minutes
  - key: "node.kubernetes.io/unreachable"
    operator: "Exists"
    effect: "NoExecute"
    tolerationSeconds: 600
  containers:
  - name: app
    image: myapp:latest
```

## Cordoning Nodes

Cordoning marks a node as unschedulable by adding the `node.kubernetes.io/unschedulable:NoSchedule` taint. Existing pods continue running; no new pods are scheduled.

```bash
# Cordon a single node
kubectl cordon worker-1

# Verify
kubectl get node worker-1 -o jsonpath='{.spec.unschedulable}'  # true

# Cordon multiple nodes matching a label
kubectl cordon $(kubectl get nodes -l node-type=worker -o name | tr '\n' ' ')

# Cordon all nodes in a specific zone (for zone maintenance)
ZONE="us-east-1a"
kubectl get nodes -l topology.kubernetes.io/zone=$ZONE -o name | \
    xargs kubectl cordon

# Uncordon
kubectl uncordon worker-1

# Check what's scheduled vs unschedulable
kubectl get nodes --field-selector=spec.unschedulable=true
```

## The drain Command in Detail

`kubectl drain` combines several operations:

1. Cordons the node (marks it unschedulable)
2. Evicts pods via the Eviction API (respecting PodDisruptionBudgets)
3. Waits for pods to terminate (with a configurable timeout)
4. Skips DaemonSet pods (they'll restart on the same node anyway)

```bash
# Basic drain
kubectl drain worker-1 \
    --ignore-daemonsets \
    --delete-emptydir-data \
    --timeout=300s

# With grace period for slow-stopping pods
kubectl drain worker-1 \
    --ignore-daemonsets \
    --delete-emptydir-data \
    --timeout=600s \
    --grace-period=120

# Drain with force (bypass PDB - use only in emergencies)
kubectl drain worker-1 \
    --ignore-daemonsets \
    --force \
    --disable-eviction

# List what would be drained (dry-run)
kubectl drain worker-1 \
    --ignore-daemonsets \
    --delete-emptydir-data \
    --dry-run

# Drain flags explained:
# --ignore-daemonsets: Don't evict DaemonSet-managed pods
# --delete-emptydir-data: Delete pods with emptyDir volumes (data will be lost)
# --timeout: How long to wait for drain to complete
# --grace-period: Override pod terminationGracePeriodSeconds
# --force: Delete even pods not managed by a controller (stateful risk!)
# --disable-eviction: Use DELETE instead of Eviction API (bypasses PDBs)
# --pod-selector: Only drain specific pods (useful for partial drain)
```

### What Happens During drain

```
kubectl drain --ignore-daemonsets worker-1

Step 1: Cordon the node
   kubectl cordon worker-1

Step 2: For each evictable pod:
   POST /api/v1/namespaces/{ns}/pods/{pod}/eviction

   If PDB is configured:
     - Check if eviction would violate PDB
     - If yes: retry until PDB allows it (or timeout)
     - If no: proceed with eviction

Step 3: Delete pods (if using --force or no controller)

Step 4: Wait for all pods to terminate (poll status)

Step 5: Return success when all pods are gone
```

## Eviction API Deep Dive

The Eviction API is the correct way to programmatically remove pods from nodes. Unlike a direct DELETE, it consults PodDisruptionBudgets:

```go
// Go: Evict a pod using the Eviction API
package maintenance

import (
    "context"
    "fmt"
    "time"

    policyv1 "k8s.io/api/policy/v1"
    apierrors "k8s.io/apimachinery/pkg/api/errors"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes"
)

// EvictPod creates an Eviction object for a pod
func EvictPod(ctx context.Context, client kubernetes.Interface, namespace, podName string) error {
    eviction := &policyv1.Eviction{
        ObjectMeta: metav1.ObjectMeta{
            Name:      podName,
            Namespace: namespace,
        },
        DeleteOptions: &metav1.DeleteOptions{
            GracePeriodSeconds: ptr(int64(30)),
        },
    }

    err := client.PolicyV1().Evictions(namespace).Evict(ctx, eviction)
    if err != nil {
        if apierrors.IsTooManyRequests(err) {
            // 429: PDB is blocking eviction - need to retry later
            return fmt.Errorf("eviction blocked by PDB: %w", err)
        }
        if apierrors.IsNotFound(err) {
            // Pod already gone - success
            return nil
        }
        return fmt.Errorf("evicting pod %s/%s: %w", namespace, podName, err)
    }
    return nil
}

// DrainNode evicts all eligible pods from a node
func DrainNode(ctx context.Context, client kubernetes.Interface, nodeName string) error {
    pods, err := getEvictablePods(ctx, client, nodeName)
    if err != nil {
        return err
    }

    // Cordon first
    if err := cordonNode(ctx, client, nodeName); err != nil {
        return err
    }

    // Evict all pods with retry for PDB-blocked evictions
    for _, pod := range pods {
        if err := evictWithRetry(ctx, client, pod.Namespace, pod.Name, 5*time.Minute); err != nil {
            return fmt.Errorf("evicting pod %s/%s: %w", pod.Namespace, pod.Name, err)
        }
    }

    // Wait for all pods to terminate
    return waitForPodsTerminated(ctx, client, nodeName, 10*time.Minute)
}

func evictWithRetry(ctx context.Context, client kubernetes.Interface, ns, name string, timeout time.Duration) error {
    deadline := time.Now().Add(timeout)
    backoff := 5 * time.Second

    for time.Now().Before(deadline) {
        err := EvictPod(ctx, client, ns, name)
        if err == nil {
            return nil
        }

        if apierrors.IsTooManyRequests(err) {
            // PDB blocking - wait and retry
            select {
            case <-ctx.Done():
                return ctx.Err()
            case <-time.After(backoff):
                if backoff < 30*time.Second {
                    backoff *= 2
                }
            }
            continue
        }

        return err // Non-retriable error
    }

    return fmt.Errorf("timeout waiting for eviction of %s/%s", ns, name)
}

func getEvictablePods(ctx context.Context, client kubernetes.Interface, nodeName string) ([]podRef, error) {
    pods, err := client.CoreV1().Pods("").List(ctx, metav1.ListOptions{
        FieldSelector: fmt.Sprintf("spec.nodeName=%s", nodeName),
    })
    if err != nil {
        return nil, fmt.Errorf("listing pods on %s: %w", nodeName, err)
    }

    var evictable []podRef
    for _, pod := range pods.Items {
        // Skip DaemonSet pods
        if isDaemonSetPod(&pod) {
            continue
        }
        // Skip static pods (not evictable)
        if isStaticPod(&pod) {
            continue
        }
        // Skip mirror pods
        if isMirrorPod(&pod) {
            continue
        }
        evictable = append(evictable, podRef{Namespace: pod.Namespace, Name: pod.Name})
    }
    return evictable, nil
}

type podRef struct{ Namespace, Name string }

func isDaemonSetPod(pod interface{ GetOwnerReferences() []metav1.OwnerReference }) bool {
    for _, ref := range pod.GetOwnerReferences() {
        if ref.Kind == "DaemonSet" {
            return true
        }
    }
    return false
}

func ptr[T any](v T) *T { return &v }
```

## PodDisruptionBudgets During Maintenance

PodDisruptionBudgets (PDBs) protect services from having too many pods evicted simultaneously. Understanding how they interact with drain is critical.

### Creating Effective PDBs

```yaml
# pdb-web.yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: web-pdb
  namespace: production
spec:
  # EITHER minAvailable OR maxUnavailable, not both
  # minAvailable: 2              # Always keep 2 pods running
  maxUnavailable: 1              # Only 1 pod can be disrupted at a time

  selector:
    matchLabels:
      app: web-frontend

# For a 3-replica deployment with maxUnavailable: 1:
# - drain node 1: evicts 1 pod (now 2 running) ✓
# - scheduler places pod on another node
# - Once pod is Running, drain node 2: evicts 1 more pod ✓
# - etc.
```

```yaml
# pdb-statefulset.yaml - More conservative for stateful workloads
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: db-pdb
  namespace: production
spec:
  minAvailable: "100%"          # No disruptions allowed (use maxUnavailable: 0 for same effect)
  # OR
  # maxUnavailable: 0           # Equivalent: zero allowed disruptions
  selector:
    matchLabels:
      app: postgres
```

### Checking PDB Status During Drain

```bash
# Watch PDB status during drain operations
watch -n2 'kubectl get pdb -A'

# Detailed PDB status
kubectl describe pdb web-pdb

# Example output:
# Name:           web-pdb
# Namespace:      production
# Min available:  N/A
# Max unavailable: 1
# Allowed disruptions: 1
# Current:         3 pods

# If "Allowed disruptions: 0", drain will block waiting for recovery
# This happens when:
# - A pod is already terminated/CrashLooping
# - Deployment has fewer replicas than expected

# List what's blocking a drain
kubectl get events -n production --field-selector reason=DisruptionBlocked

# Check which pods can be disrupted right now
kubectl get pdb -A -o json | jq -r '.items[] |
  .metadata.namespace + "/" + .metadata.name +
  ": " + (.status.disruptionsAllowed | tostring) + " disruptions allowed"'
```

### Handling PDB-Protected Workloads

```bash
# If drain is stuck because of a PDB, check why
# Scenario: Deployment has 2 replicas, PDB requires minAvailable: 2
# This means zero disruptions are allowed - drain will block forever

# Option 1: Scale up temporarily to allow disruption
kubectl scale deployment web-frontend --replicas=3 -n production
# Now: 3 pods, minAvailable: 2, disruptions allowed: 1
kubectl drain worker-1 --ignore-daemonsets --delete-emptydir-data

# Option 2: Temporarily modify PDB (risky - document and revert)
kubectl patch pdb web-pdb -n production \
    --type='json' \
    -p='[{"op": "replace", "path": "/spec/maxUnavailable", "value": 1}]'

kubectl drain worker-1 --ignore-daemonsets --delete-emptydir-data

kubectl patch pdb web-pdb -n production \
    --type='json' \
    -p='[{"op": "replace", "path": "/spec/maxUnavailable", "value": 0}]'

# Option 3: Emergency force drain (bypasses PDB - use only in true emergency)
# WARNING: This can cause service outages
kubectl drain worker-1 --force --disable-eviction --ignore-daemonsets
```

## Graceful Node Shutdown (Kubernetes 1.21+)

Before Kubernetes 1.21, if a node was shut down abruptly (reboot, power off), pods were not given an opportunity to terminate gracefully. The kubelet would simply stop and pods would be stuck in `Terminating` state until the node came back.

Graceful Node Shutdown hooks into the systemd inhibitor lock to delay shutdown until pods are terminated.

### Configuration

```yaml
# /var/lib/kubelet/config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
# Graceful node shutdown settings
shutdownGracePeriod: 120s              # Total shutdown grace period
shutdownGracePeriodCriticalPods: 30s   # Time reserved for critical pods
```

The shutdown process:

```
1. Kubelet detects systemd "prepare shutdown" inhibitor
2. Signals all non-critical pods to terminate (120s - 30s = 90s window)
3. After 90 seconds, signals critical pods (system-node-critical, system-cluster-critical)
4. After 30 more seconds (total 120s), allows shutdown to proceed
```

```bash
# Verify graceful shutdown is configured
cat /var/lib/kubelet/config.yaml | grep -A2 shutdown

# Check if kubelet holds the systemd inhibitor lock
systemd-inhibit --list | grep kubelet

# Output when shutdown is imminent:
# Who: kubelet (uid:0 pid:1234)
# What: shutdown
# Why: Kubelet needs time to manage pods termination

# Test graceful shutdown behavior
sudo systemctl reboot  # kubelet will delay up to shutdownGracePeriod

# Monitor pod termination during shutdown
kubectl get events -A --field-selector reason=GracefulNodeShutdown
```

### Priority-Based Shutdown Groups

Kubernetes 1.24+ added priority-based shutdown groups for more granular control:

```yaml
# /var/lib/kubelet/config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
shutdownGracePeriod: 300s
shutdownGracePeriodCriticalPods: 60s

# Fine-grained shutdown: process different priority levels differently
shutdownGracePeriodByPodPriority:
- priority: 2000000000      # system-node-critical (highest)
  shutdownGracePeriodSeconds: 60
- priority: 1000000000      # system-cluster-critical
  shutdownGracePeriodSeconds: 45
- priority: 100              # High-priority application pods
  shutdownGracePeriodSeconds: 30
- priority: 0                # Default priority (lowest)
  shutdownGracePeriodSeconds: 10
```

### PriorityClass Configuration

```yaml
# Define priority classes for shutdown ordering
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: high-priority
value: 100
globalDefault: false
description: "High priority workloads that need more graceful shutdown time"
---
# Assign to workloads that need longer shutdown windows
apiVersion: apps/v1
kind: Deployment
metadata:
  name: database-proxy
spec:
  template:
    spec:
      priorityClassName: high-priority
      terminationGracePeriodSeconds: 120  # Must be <= shutdown group's grace period
      containers:
      - name: proxy
        image: myproxy:latest
        lifecycle:
          preStop:
            exec:
              command: ["/bin/sh", "-c", "sleep 10 && proxy shutdown --graceful"]
```

## Production Maintenance Window Procedures

### Pre-Maintenance Checklist

```bash
#!/bin/bash
# pre-drain-check.sh - Validate cluster health before draining a node

set -euo pipefail

NODE=${1:?Usage: $0 <node-name>}
NAMESPACE=${2:-""}

echo "=== Pre-drain checks for node: $NODE ==="

# 1. Check node exists and is Ready
NODE_STATUS=$(kubectl get node $NODE -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')
if [ "$NODE_STATUS" != "True" ]; then
    echo "ERROR: Node $NODE is not Ready (status: $NODE_STATUS)"
    exit 1
fi
echo "✓ Node is Ready"

# 2. Check cluster has enough nodes to absorb the load
TOTAL_NODES=$(kubectl get nodes --no-headers | wc -l)
READY_NODES=$(kubectl get nodes --no-headers | grep " Ready" | wc -l)
if [ $((READY_NODES - 1)) -lt $((TOTAL_NODES / 2)) ]; then
    echo "WARNING: Draining will leave <50% of nodes active"
fi
echo "✓ Cluster nodes: $READY_NODES/$TOTAL_NODES ready"

# 3. Check PDB health - any with 0 disruptions allowed?
BLOCKED_PDBS=$(kubectl get pdb -A -o json | jq -r '
    .items[] |
    select(.status.disruptionsAllowed == 0) |
    .metadata.namespace + "/" + .metadata.name')

if [ -n "$BLOCKED_PDBS" ]; then
    echo "WARNING: PDBs with 0 disruptions allowed (drain may block):"
    echo "$BLOCKED_PDBS"
else
    echo "✓ All PDBs have disruptions available"
fi

# 4. Count pods on the node
POD_COUNT=$(kubectl get pods --all-namespaces \
    --field-selector="spec.nodeName=$NODE" \
    --no-headers 2>/dev/null | wc -l)
echo "✓ Pods on node: $POD_COUNT"

# 5. Check for statefulset pods (may need special handling)
STATEFUL_PODS=$(kubectl get pods --all-namespaces \
    --field-selector="spec.nodeName=$NODE" \
    -o json 2>/dev/null | jq -r '
    .items[] |
    select(.metadata.ownerReferences[]?.kind == "StatefulSet") |
    .metadata.namespace + "/" + .metadata.name')

if [ -n "$STATEFUL_PODS" ]; then
    echo "WARNING: StatefulSet pods on node (check PVs):"
    echo "$STATEFUL_PODS"
fi

# 6. Check cluster-autoscaler won't scale down replacement nodes
CA_ANNOTATION=$(kubectl get nodes -o json | jq -r '
    .items[] |
    select(.metadata.annotations["cluster-autoscaler.kubernetes.io/scale-down-disabled"] == "true") |
    .metadata.name')
if [ -n "$CA_ANNOTATION" ]; then
    echo "INFO: Scale-down disabled on: $CA_ANNOTATION"
fi

echo ""
echo "=== Pre-drain check complete ==="
echo "Proceed with: kubectl drain $NODE --ignore-daemonsets --delete-emptydir-data"
```

### Automated Maintenance with Node Maintenance Operator

```yaml
# NodeMaintenance custom resource (using Node Maintenance Operator)
apiVersion: nodemaintenance.medik8s.io/v1beta1
kind: NodeMaintenance
metadata:
  name: worker-1-maintenance
spec:
  nodeName: worker-1
  reason: "Kernel upgrade - scheduled maintenance window"

# The operator will:
# 1. Cordon the node
# 2. Drain with appropriate timeouts
# 3. Report status via .status.phase
# 4. Handle PDB retries automatically
```

### Rolling Node Drain Script

```bash
#!/bin/bash
# rolling-drain.sh - Drain nodes one at a time with health checks

set -euo pipefail

NODES=$@
if [ -z "$NODES" ]; then
    echo "Usage: $0 node1 node2 node3..."
    exit 1
fi

DRAIN_TIMEOUT=600
SETTLE_TIME=60

drain_node() {
    local node=$1
    echo "=== Draining $node ==="

    # Pre-check
    ./pre-drain-check.sh $node || {
        echo "Pre-drain check failed for $node, skipping"
        return 1
    }

    # Drain
    kubectl drain $node \
        --ignore-daemonsets \
        --delete-emptydir-data \
        --timeout=${DRAIN_TIMEOUT}s \
        --grace-period=120

    echo "Node $node drained successfully"

    # Wait for workloads to settle
    echo "Waiting ${SETTLE_TIME}s for workloads to settle..."
    sleep $SETTLE_TIME

    # Check cluster health after drain
    wait_for_cluster_healthy 120

    echo "=== $node drain complete ==="
}

wait_for_cluster_healthy() {
    local timeout=$1
    local elapsed=0

    while [ $elapsed -lt $timeout ]; do
        PENDING=$(kubectl get pods -A --field-selector=status.phase=Pending \
            --no-headers 2>/dev/null | wc -l)
        NOT_READY=$(kubectl get pods -A \
            --no-headers 2>/dev/null | grep -vE "Running|Completed|Succeeded" | \
            grep -v Terminating | wc -l)

        if [ "$PENDING" -eq 0 ] && [ "$NOT_READY" -eq 0 ]; then
            echo "Cluster healthy: 0 pending, 0 not-ready pods"
            return 0
        fi

        echo "Waiting for cluster health: $PENDING pending, $NOT_READY not-ready (${elapsed}s)"
        sleep 10
        elapsed=$((elapsed + 10))
    done

    echo "WARNING: Cluster not fully healthy after ${timeout}s"
    kubectl get pods -A --no-headers | grep -vE "Running|Completed|Succeeded" | head -20
    return 1
}

# Process nodes sequentially
for node in $NODES; do
    drain_node $node || {
        echo "ERROR: Failed to drain $node"
        exit 1
    }

    echo ""
    echo "Perform maintenance on $node and uncordon when ready:"
    echo "  kubectl uncordon $node"
    echo ""
    read -p "Press Enter after uncordoning $node to continue..."

    # Wait for node to be Ready again
    echo "Waiting for $node to be Ready..."
    kubectl wait node/$node --for=condition=Ready --timeout=300s

    echo "Node $node is Ready"
    sleep 30  # Let workloads re-schedule
done

echo "=== All nodes processed ==="
```

### Annotating Nodes for Maintenance Windows

```bash
# Document maintenance on a node
kubectl annotate node worker-1 \
    maintenance.mycompany.com/window="2029-11-13T02:00:00Z/2029-11-13T04:00:00Z" \
    maintenance.mycompany.com/reason="Kernel upgrade from 5.15 to 6.1" \
    maintenance.mycompany.com/owner="ops-team@mycompany.com" \
    maintenance.mycompany.com/ticket="OPS-12345"

# Find nodes currently in maintenance
kubectl get nodes -o json | jq -r '
    .items[] |
    select(.metadata.annotations["maintenance.mycompany.com/window"] != null) |
    .metadata.name + ": " + .metadata.annotations["maintenance.mycompany.com/window"]'

# View scheduled maintenance in next 24 hours
TOMORROW=$(date -d "+24 hours" -u +"%Y-%m-%dT%H:%M:%SZ")
kubectl get nodes -o json | jq -r --arg tomorrow "$TOMORROW" '
    .items[] |
    select(
        .metadata.annotations["maintenance.mycompany.com/window"] != null and
        (.metadata.annotations["maintenance.mycompany.com/window"] | split("/")[0]) < $tomorrow
    ) |
    .metadata.name + ": " + .metadata.annotations["maintenance.mycompany.com/window"]'
```

## Monitoring and Alerting

```yaml
# Prometheus rules for node maintenance alerting
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: node-maintenance
  namespace: monitoring
spec:
  groups:
  - name: node-lifecycle
    rules:
    - alert: NodeCordoned
      expr: kube_node_spec_unschedulable == 1
      for: 1h
      labels:
        severity: warning
      annotations:
        summary: "Node {{ $labels.node }} has been cordoned for >1 hour"
        description: "Verify maintenance is in progress or uncordon if maintenance is complete"

    - alert: NodeNotReady
      expr: kube_node_status_condition{condition="Ready",status="true"} == 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Node {{ $labels.node }} is NotReady"

    - alert: TooManyCordonedNodes
      expr: sum(kube_node_spec_unschedulable) / count(kube_node_info) > 0.3
      for: 10m
      labels:
        severity: critical
      annotations:
        summary: ">30% of cluster nodes are cordoned"

    - alert: PDBBlockingDrain
      expr: kube_poddisruptionbudget_status_disruptions_allowed == 0
      for: 30m
      labels:
        severity: warning
      annotations:
        summary: "PDB {{ $labels.namespace }}/{{ $labels.poddisruptionbudget }} blocking disruptions for >30m"

    - alert: NodeDrainStuck
      expr: |
        (kube_node_spec_unschedulable == 1) and
        (count by (node) (kube_pod_info{node=~".*"} * on(pod, namespace) group_left() kube_pod_status_phase{phase="Running"}) > 0)
      for: 20m
      labels:
        severity: warning
      annotations:
        summary: "Node {{ $labels.node }} is cordoned but still has Running pods after 20 minutes"
```

## Post-Maintenance Validation

```bash
#!/bin/bash
# post-maintenance-check.sh

NODE=${1:?Usage: $0 <node-name>}

echo "=== Post-maintenance validation for $NODE ==="

# Uncordon
kubectl uncordon $NODE
echo "✓ Node uncordoned"

# Wait for node to be Ready
kubectl wait node/$NODE --for=condition=Ready --timeout=120s
echo "✓ Node is Ready"

# Check kubelet version (confirm upgrade if applicable)
kubectl get node $NODE -o jsonpath='{.status.nodeInfo.kubeletVersion}'
echo ""

# Check OS image
kubectl get node $NODE -o jsonpath='{.status.nodeInfo.osImage}'
echo ""

# Check allocatable resources
kubectl describe node $NODE | grep -A5 "Allocatable:"

# Verify node can schedule pods (test pod)
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: test-scheduling-$NODE
  namespace: default
spec:
  nodeName: $NODE
  containers:
  - name: test
    image: busybox:latest
    command: ["/bin/sh", "-c", "echo 'scheduling test passed'; sleep 5"]
  restartPolicy: Never
  tolerations:
  - operator: "Exists"
EOF

kubectl wait pod/test-scheduling-$NODE --for=condition=Ready --timeout=60s || true
kubectl logs test-scheduling-$NODE
kubectl delete pod test-scheduling-$NODE

echo "✓ Pod scheduling validated"
echo "=== Post-maintenance validation complete ==="
```

## Summary

Kubernetes node lifecycle management requires understanding the full flow from node conditions through to graceful termination:

- **Cordoning** prevents new pods from scheduling; existing pods continue running; use it before any maintenance operation
- **Drain** evicts pods via the Eviction API, which respects PodDisruptionBudgets; always prefer drain over direct pod deletion
- **PodDisruptionBudgets** control how many pods can be disrupted simultaneously; size them to allow at least one disruption (otherwise drain will block indefinitely unless you scale up first)
- **Eviction API** (POST to `/pods/{name}/eviction`) is safer than DELETE because it checks PDBs; use it in any automation
- **Graceful Node Shutdown** (1.21+) hooks into systemd to allow pods to terminate before a reboot; configure `shutdownGracePeriod` to be greater than your longest-running preStop hook
- **Priority-based shutdown** (1.24+) gives different pod priority classes different grace periods during shutdown
- **Rolling drain scripts** process one node at a time, verify cluster health between nodes, and wait for workloads to re-settle before proceeding to the next node

The combination of PDBs on all critical workloads and proper drain procedures ensures that node maintenance never causes unnecessary service disruptions.
