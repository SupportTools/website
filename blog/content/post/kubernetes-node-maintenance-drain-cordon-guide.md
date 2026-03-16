---
title: "Kubernetes Node Maintenance: Drain, Cordon, and Zero-Downtime Operations"
date: 2027-05-02T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Node Maintenance", "Drain", "Cordon", "Operations", "Zero Downtime"]
categories: ["Kubernetes", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Kubernetes node maintenance operations including cordoning, draining, graceful termination, PodDisruptionBudgets, planned maintenance windows, and automated node recycling patterns."
more_link: "yes"
url: "/kubernetes-node-maintenance-drain-cordon-guide/"
---

Node maintenance is one of the most operationally sensitive activities in a Kubernetes cluster. Patching a kernel vulnerability, upgrading a node's container runtime, replacing failing hardware, or rotating cloud provider instance types all require taking a node out of service. Done incorrectly, a node drain causes immediate production impact: pods terminate abruptly, load balancers briefly route to dead backends, and persistent state may be lost. This guide covers every step of safe node maintenance — from understanding the mechanics of cordon and drain, through PodDisruptionBudget interaction, StatefulSet and DaemonSet edge cases, to fully automated recycling pipelines.

<!--more-->

# Kubernetes Node Maintenance: Drain, Cordon, and Zero-Downtime Operations

## Core Mechanics

### Node Lifecycle States

A Kubernetes node passes through these states during maintenance:

```
Ready (scheduling enabled)
  │
  ▼ kubectl cordon
SchedulingDisabled (existing pods continue, no new pods)
  │
  ▼ kubectl drain
SchedulingDisabled + empty (all evictable pods removed)
  │
  ▼ maintenance performed
  │
  ▼ kubectl uncordon
Ready (scheduling re-enabled)
```

### Cordoning a Node

Cordoning marks a node as `Unschedulable`, preventing the scheduler from placing new pods on it. Existing pods continue running unaffected.

```bash
# Cordon a single node
kubectl cordon node01

# Verify the node status
kubectl get node node01
# NAME     STATUS                     ROLES    AGE   VERSION
# node01   Ready,SchedulingDisabled   worker   45d   v1.30.0

# Cordon multiple nodes matching a label
kubectl get nodes -l kubernetes.io/os=linux -o name | \
  xargs -I{} kubectl cordon {}
```

Cordoning is reversible at any time and carries no risk. It is appropriate when:
- Observing elevated error rates on a specific node and wanting to stop new pod placement while investigating
- Preparing for maintenance with a long lead time before the actual drain
- Implementing a slow rollout of node configuration changes

### Draining a Node

Drain combines cordon with eviction. The `kubectl drain` command:

1. Marks the node unschedulable (cordon)
2. Calls the Kubernetes Eviction API for each pod on the node
3. Waits for pods to terminate
4. Returns success when the node is empty of evictable pods

```bash
# Basic drain
kubectl drain node01 --ignore-daemonsets --delete-emptydir-data

# Production drain with timeout and pod filtering
kubectl drain node01 \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --grace-period=60 \
  --timeout=300s \
  --force=false \
  --dry-run=server

# Dry-run to preview what would be evicted
kubectl drain node01 \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --dry-run=server
```

Key flags:

| Flag | Default | Purpose |
|------|---------|---------|
| `--ignore-daemonsets` | false | Skip DaemonSet-managed pods (required for most drains) |
| `--delete-emptydir-data` | false | Allow eviction of pods with emptyDir volumes |
| `--grace-period` | -1 (pod's own) | Override pod termination grace period |
| `--timeout` | 0 (wait forever) | Return error if drain does not complete in time |
| `--force` | false | Force evict pods without a controller (orphaned pods) |
| `--pod-selector` | "" | Evict only pods matching this selector |
| `--disable-eviction` | false | Use DELETE instead of Eviction API (bypasses PDBs) |

### Eviction API vs Force Delete

The `kubectl drain` command uses the Kubernetes Eviction API by default. This is important: the Eviction API respects PodDisruptionBudgets. If evicting a pod would violate a PDB, the API returns `429 Too Many Requests` and the drain waits, retrying until the PDB permits eviction.

```bash
# Check if the Eviction API is being used
kubectl drain node01 --ignore-daemonsets --delete-emptydir-data 2>&1 | \
  grep -E "evicting|cannot evict|disruption budget"
```

The `--disable-eviction` flag bypasses the PDB entirely and issues a direct DELETE. This is appropriate only when:
- The PDB itself is broken (e.g., minAvailable set too high)
- Emergency maintenance where availability has already been compromised
- Testing environments where PDB enforcement is not needed

```bash
# Emergency force drain (bypasses PDB - use with caution)
kubectl drain node01 \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --disable-eviction \
  --grace-period=10 \
  --timeout=120s
```

## PodDisruptionBudget Interaction

### How PDBs Block Drains

A PodDisruptionBudget defines the minimum availability required during voluntary disruptions. When `kubectl drain` calls the Eviction API for a pod, the API checks whether evicting that pod would reduce the number of available pods below the PDB's `minAvailable` (or exceed `maxUnavailable`).

```yaml
# PDB protecting a 3-replica deployment
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: web-frontend-pdb
  namespace: production
spec:
  minAvailable: 2  # At least 2 pods must remain available
  selector:
    matchLabels:
      app: web-frontend
```

With `minAvailable: 2` and 3 running pods, the drain can evict one pod (leaving 2). The second eviction attempt returns 429 and blocks until the first pod reschedules on another node and becomes Ready.

```bash
# Watch the drain progress
kubectl drain node01 --ignore-daemonsets --delete-emptydir-data &
DRAIN_PID=$!

# In a second terminal, watch pods
watch -n 2 'kubectl get pods -n production -l app=web-frontend -o wide'

wait $DRAIN_PID
```

### PDB Configuration Best Practices

```yaml
# For a deployment with 3+ replicas: allow 1 unavailable at a time
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
---
# For critical services: ensure majority always available
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-service-pdb
  namespace: production
spec:
  minAvailable: "75%"
  selector:
    matchLabels:
      app: payment-service
---
# For StatefulSets with quorum requirements (e.g., etcd, Kafka):
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: kafka-pdb
  namespace: data-platform
spec:
  # Quorum for 5-node Kafka: need at least 3 running
  minAvailable: 3
  selector:
    matchLabels:
      app: kafka
```

### Diagnosing Drain Blocked by PDB

```bash
# Check which PDB is blocking the drain
kubectl get pdb --all-namespaces

# Detailed PDB status showing disruptions allowed
kubectl describe pdb web-frontend-pdb -n production

# Example output:
# Name:           web-frontend-pdb
# Namespace:      production
# Min available:  2
# Selector:       app=web-frontend
# Status:
#   Allowed disruptions:  1
#   Current:              3
#   Desired:              2
#   Total:                3

# Watch PDB status during drain
watch -n 5 'kubectl get pdb --all-namespaces \
  -o custom-columns="NS:.metadata.namespace,NAME:.metadata.name,MIN:.spec.minAvailable,ALLOWED:.status.disruptionsAllowed,CURRENT:.status.currentHealthy"'
```

### PDB Deadlock Resolution

A PDB deadlock occurs when no disruption is allowed because the current healthy count already equals minAvailable. This happens when:
- Pods are in `CrashLoopBackOff` or `Pending` state (not counted as available)
- The PDB has `minAvailable` equal to the total replica count
- A previous drain left pods on fewer nodes than intended

```bash
# Identify PDB deadlocks
kubectl get pdb --all-namespaces \
  -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}: allowed={.status.disruptionsAllowed}, healthy={.status.currentHealthy}, desired={.status.desiredHealthy}{"\n"}{end}' | \
  grep "allowed=0"

# Check the health of pods covered by the blocked PDB
PDB_NS=production
PDB_NAME=web-frontend-pdb
SELECTOR=$(kubectl get pdb "${PDB_NAME}" -n "${PDB_NS}" \
  -o jsonpath='{.spec.selector.matchLabels}' | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(','.join(f'{k}={v}' for k,v in d.items()))")

kubectl get pods -n "${PDB_NS}" -l "${SELECTOR}" -o wide

# Identify unhealthy pods
kubectl get pods -n "${PDB_NS}" -l "${SELECTOR}" \
  --field-selector='status.phase!=Running' -o wide
```

## DaemonSet Drain Behavior

DaemonSet pods are exempt from drain by default because they cannot be rescheduled to a different node — they run exactly once per node. The `--ignore-daemonsets` flag tells drain to skip DaemonSet pods rather than blocking on them.

```bash
# Drain that handles DaemonSets correctly
kubectl drain node01 \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --timeout=300s

# After the drain, DaemonSet pods remain on the node in a "Running" state
# This is expected behavior - they will be removed when the node is deleted
# or when the node is no longer part of the cluster
kubectl get pods --all-namespaces \
  --field-selector spec.nodeName=node01 -o wide
```

DaemonSet pods that use `hostPath` volumes or `hostNetwork: true` (like CNI plugins, log collectors, monitoring agents) continue to run on the drained node until it is deleted. This is intentional: CNI plugins must remain running to handle any cleanup of network namespaces left by recently terminated pods.

## StatefulSet Drain Behavior

StatefulSets present special challenges because their pods have persistent identity and often cannot run as two instances simultaneously.

### Risks with StatefulSets During Drain

```yaml
# StatefulSet with PDB for safe maintenance
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgresql
  namespace: database
spec:
  serviceName: postgresql-headless
  replicas: 3
  podManagementPolicy: OrderedReady
  selector:
    matchLabels:
      app: postgresql
  template:
    metadata:
      labels:
        app: postgresql
    spec:
      # Anti-affinity to ensure pods are on different nodes
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: postgresql
            topologyKey: kubernetes.io/hostname
      terminationGracePeriodSeconds: 60
      containers:
      - name: postgresql
        image: postgres:16.2
        lifecycle:
          preStop:
            exec:
              # Give PostgreSQL time to flush WAL and close connections
              command:
              - /bin/sh
              - -c
              - pg_ctl -D /var/lib/postgresql/data stop -m fast
        readinessProbe:
          exec:
            command:
            - pg_isready
            - -U
            - postgres
          initialDelaySeconds: 5
          periodSeconds: 5
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: premium-ssd
      resources:
        requests:
          storage: 100Gi
---
# PDB allowing one pod unavailable at a time
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: postgresql-pdb
  namespace: database
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: postgresql
```

For a 3-node PostgreSQL cluster drained one node at a time:

1. Drain `node01`: PostgreSQL replica 0 terminates gracefully (preStop hook runs), pod is evicted, rescheduled on `node02` or `node03` (if anti-affinity allows a free node). PDB blocks second eviction until the pod is Ready.
2. Drain `node02`: Same process for replica 1.
3. Drain `node03`: Replica 2 moves to a newly uncordoned node.

If all three PostgreSQL pods are on different nodes and the cluster has only three worker nodes, draining the third node leaves no eligible node for rescheduling. Ensure the cluster has at least `StatefulSet replicas + 1` schedulable nodes before beginning maintenance.

## Grace Periods and Graceful Termination

### Understanding Termination Grace Period

When a pod is evicted, Kubernetes sends `SIGTERM` to the container and waits `terminationGracePeriodSeconds` before sending `SIGKILL`. The default is 30 seconds. Applications must handle `SIGTERM` and complete in-flight requests within this window.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-service
  namespace: production
spec:
  template:
    spec:
      # Allow 60 seconds for graceful shutdown
      terminationGracePeriodSeconds: 60
      containers:
      - name: api
        image: internal.registry.example.com/api-service:2.8.0
        lifecycle:
          preStop:
            exec:
              # Give the load balancer time to remove this pod from rotation
              # before the application starts rejecting connections
              command:
              - /bin/sh
              - -c
              - sleep 5
        readinessProbe:
          httpGet:
            path: /healthz/ready
            port: 8080
          periodSeconds: 2
          failureThreshold: 3
```

The `preStop` sleep is important: Kubernetes removes the pod from Service endpoints when the pod begins terminating, but there is a propagation delay between endpoint removal and load balancer update. Without the sleep, requests may continue arriving at the pod for several seconds after it starts shutting down.

### Drain Grace Period Override

The `--grace-period` flag overrides the pod's configured grace period for all pods evicted during the drain:

```bash
# Override grace period to 30 seconds regardless of pod configuration
kubectl drain node01 \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --grace-period=30 \
  --timeout=300s
```

Use this only when the configured grace periods are too long for the maintenance window. Cutting grace periods short risks in-flight request failures.

## Automated Node Maintenance Scripts

### Single Node Maintenance Script

```bash
#!/bin/bash
# Perform maintenance on a single node with PDB-aware draining
# Usage: ./node-maintenance.sh <node-name> [timeout-seconds]

set -euo pipefail

NODE="${1:?node name required}"
TIMEOUT="${2:-600}"
DRAIN_TIMEOUT="${3:-300}"

log() {
  echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] $*"
}

wait_for_pods_ready() {
  local namespace="$1"
  local selector="$2"
  local timeout="$3"
  local start_time=$SECONDS

  while (( SECONDS - start_time < timeout )); do
    local total
    local ready
    total=$(kubectl get pods -n "$namespace" -l "$selector" \
      --no-headers 2>/dev/null | wc -l || echo 0)
    ready=$(kubectl get pods -n "$namespace" -l "$selector" \
      --field-selector=status.phase=Running --no-headers 2>/dev/null | \
      grep -c "1/1\|2/2\|3/3" || echo 0)
    if (( ready >= total && total > 0 )); then
      return 0
    fi
    sleep 10
  done
  return 1
}

# Step 1: Verify node exists and is Ready
log "Checking node ${NODE} status..."
NODE_STATUS=$(kubectl get node "${NODE}" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')
if [[ "${NODE_STATUS}" != "True" ]]; then
  log "ERROR: Node ${NODE} is not Ready (status: ${NODE_STATUS}). Aborting."
  exit 1
fi
log "Node ${NODE} is Ready"

# Step 2: Check current pod count on the node
POD_COUNT=$(kubectl get pods --all-namespaces \
  --field-selector "spec.nodeName=${NODE}" \
  --no-headers 2>/dev/null | grep -v "DaemonSet\|kube-system" | wc -l || echo 0)
log "Node ${NODE} is running approximately ${POD_COUNT} non-DaemonSet pods"

# Step 3: Cordon the node (stop new scheduling)
log "Cordoning node ${NODE}..."
kubectl cordon "${NODE}"
log "Node ${NODE} cordoned"

# Step 4: Check PDB status before draining
log "Checking PodDisruptionBudget status..."
PDB_BLOCKED=$(kubectl get pdb --all-namespaces \
  -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}: allowed={.status.disruptionsAllowed}{"\n"}{end}' | \
  grep "allowed=0" || true)
if [[ -n "${PDB_BLOCKED}" ]]; then
  log "WARNING: The following PDBs have 0 disruptions allowed:"
  echo "${PDB_BLOCKED}"
  log "Drain may block until pods become available. Proceeding..."
fi

# Step 5: Drain the node
log "Draining node ${NODE} (timeout: ${DRAIN_TIMEOUT}s)..."
if kubectl drain "${NODE}" \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --grace-period=60 \
  --timeout="${DRAIN_TIMEOUT}s"; then
  log "Node ${NODE} drained successfully"
else
  log "ERROR: Drain failed or timed out. Node ${NODE} may have remaining pods."
  log "Check: kubectl get pods --all-namespaces --field-selector spec.nodeName=${NODE}"
  exit 1
fi

# Step 6: Verify the node is empty
REMAINING=$(kubectl get pods --all-namespaces \
  --field-selector "spec.nodeName=${NODE}" \
  --no-headers 2>/dev/null | \
  grep -v "DaemonSet\|kube-system" | wc -l || echo 0)
log "Remaining non-DaemonSet pods on ${NODE}: ${REMAINING}"

# Step 7: Perform the actual maintenance
log "=== Node ${NODE} is ready for maintenance ==="
log "Perform maintenance now. Press Enter when complete to uncordon."
read -r

# Step 8: Verify node is back online
log "Waiting for node ${NODE} to become Ready..."
kubectl wait --for=condition=Ready "node/${NODE}" --timeout="${TIMEOUT}s"
log "Node ${NODE} is Ready"

# Step 9: Uncordon the node
log "Uncordoning node ${NODE}..."
kubectl uncordon "${NODE}"
log "Node ${NODE} uncordoned and available for scheduling"

log "Maintenance complete for node ${NODE}"
```

### Rolling Node Maintenance Script

For maintaining all nodes in a node pool sequentially:

```bash
#!/bin/bash
# Rolling node maintenance across a labeled set of nodes
# Usage: ./rolling-maintenance.sh <node-label-selector> [pause-between-nodes-seconds]

set -euo pipefail

SELECTOR="${1:?node label selector required (e.g., node-pool=worker)}"
PAUSE="${2:-120}"
DRAIN_TIMEOUT="${3:-300}"

log() {
  echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] $*"
}

# Get all nodes matching the selector
NODES=$(kubectl get nodes -l "${SELECTOR}" \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')
NODE_COUNT=$(echo "${NODES}" | wc -l)
log "Found ${NODE_COUNT} nodes matching selector '${SELECTOR}'"
log "Nodes: $(echo "${NODES}" | tr '\n' ' ')"

CURRENT=0
for NODE in ${NODES}; do
  CURRENT=$((CURRENT + 1))
  log ""
  log "=== Processing node ${CURRENT}/${NODE_COUNT}: ${NODE} ==="

  # Verify all PDBs allow at least 1 disruption before proceeding
  PDB_BLOCKED=$(kubectl get pdb --all-namespaces \
    -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}: allowed={.status.disruptionsAllowed}{"\n"}{end}' | \
    grep "allowed=0" || true)

  if [[ -n "${PDB_BLOCKED}" ]]; then
    log "WARNING: Waiting for PDBs to allow disruption..."
    echo "${PDB_BLOCKED}"
    # Wait up to 10 minutes for PDB to clear
    for attempt in $(seq 1 60); do
      sleep 10
      PDB_BLOCKED=$(kubectl get pdb --all-namespaces \
        -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}: allowed={.status.disruptionsAllowed}{"\n"}{end}' | \
        grep "allowed=0" || true)
      if [[ -z "${PDB_BLOCKED}" ]]; then
        log "All PDBs now allow disruption. Proceeding with drain."
        break
      fi
    done
  fi

  # Cordon
  log "Cordoning ${NODE}..."
  kubectl cordon "${NODE}"

  # Drain
  log "Draining ${NODE}..."
  kubectl drain "${NODE}" \
    --ignore-daemonsets \
    --delete-emptydir-data \
    --grace-period=60 \
    --timeout="${DRAIN_TIMEOUT}s" || {
    log "ERROR: Drain of ${NODE} failed. Uncordoning and stopping."
    kubectl uncordon "${NODE}"
    exit 1
  }

  log "Node ${NODE} drained. Trigger maintenance task here."
  # Place your maintenance command here, for example:
  # ssh "node-admin@${NODE}" 'sudo apt-get update && sudo apt-get upgrade -y && sudo reboot'

  # Wait for the node to come back
  log "Waiting for node ${NODE} to become Ready (up to 10 minutes)..."
  kubectl wait --for=condition=Ready "node/${NODE}" --timeout=600s || {
    log "WARNING: Node ${NODE} did not become Ready within 10 minutes"
    log "Manual intervention may be required"
    exit 1
  }

  # Uncordon
  log "Uncordoning ${NODE}..."
  kubectl uncordon "${NODE}"
  log "Node ${NODE} back in service"

  if [[ "${CURRENT}" -lt "${NODE_COUNT}" ]]; then
    log "Pausing ${PAUSE} seconds before next node..."
    sleep "${PAUSE}"
  fi
done

log ""
log "Rolling maintenance complete. All ${NODE_COUNT} nodes processed."
```

### Cloud Provider Node Recycling

For AWS EKS with managed node groups, node recycling uses the instance refresh API instead of manual drain:

```bash
#!/bin/bash
# AWS EKS managed node group instance refresh
# Requires: aws CLI, kubectl, jq

CLUSTER_NAME="${1:?cluster name required}"
NODEGROUP_NAME="${2:?nodegroup name required}"
REGION="${3:-us-east-1}"

log() {
  echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] $*"
}

# Get the Auto Scaling Group name for this node group
ASG_NAME=$(aws eks describe-nodegroup \
  --cluster-name "${CLUSTER_NAME}" \
  --nodegroup-name "${NODEGROUP_NAME}" \
  --region "${REGION}" \
  --query 'nodegroup.resources.autoScalingGroups[0].name' \
  --output text)

log "ASG for nodegroup ${NODEGROUP_NAME}: ${ASG_NAME}"

# Start an instance refresh
REFRESH_ID=$(aws autoscaling start-instance-refresh \
  --auto-scaling-group-name "${ASG_NAME}" \
  --strategy Rolling \
  --preferences '{
    "MinHealthyPercentage": 90,
    "InstanceWarmup": 300,
    "CheckpointPercentages": [50, 100],
    "CheckpointDelay": 60,
    "SkipMatching": false
  }' \
  --region "${REGION}" \
  --query 'InstanceRefreshId' \
  --output text)

log "Started instance refresh: ${REFRESH_ID}"
log "Monitoring refresh progress..."

while true; do
  STATUS=$(aws autoscaling describe-instance-refreshes \
    --auto-scaling-group-name "${ASG_NAME}" \
    --instance-refresh-ids "${REFRESH_ID}" \
    --region "${REGION}" \
    --query 'InstanceRefreshes[0]' \
    --output json)

  STATE=$(echo "${STATUS}" | jq -r '.Status')
  PERCENTAGE=$(echo "${STATUS}" | jq -r '.PercentageComplete // 0')

  log "State: ${STATE}, Completed: ${PERCENTAGE}%"

  case "${STATE}" in
    Successful)
      log "Instance refresh completed successfully"
      break
      ;;
    Failed|Cancelled)
      log "ERROR: Instance refresh failed"
      echo "${STATUS}" | jq -r '.StatusReason'
      exit 1
      ;;
    *)
      sleep 30
      ;;
  esac
done
```

## Node Maintenance Annotations and Labels

Annotating nodes during maintenance provides visibility to other operators and automated systems:

```bash
# Mark a node as under maintenance
kubectl annotate node node01 \
  "ops.example.com/maintenance-started=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "ops.example.com/maintenance-reason=kernel-upgrade" \
  "ops.example.com/maintenance-operator=ops-team"

# Remove annotations after maintenance
kubectl annotate node node01 \
  "ops.example.com/maintenance-started-" \
  "ops.example.com/maintenance-reason-" \
  "ops.example.com/maintenance-operator-"

# Add a maintenance label that admission webhooks can detect
kubectl label node node01 "ops.example.com/maintenance=true"
kubectl label node node01 "ops.example.com/maintenance-"
```

## Force Drain Edge Cases

### Pods with Local Storage (emptyDir)

Pods using `emptyDir` volumes are not evicted by default because the data is lost when the pod moves to a new node. The `--delete-emptydir-data` flag overrides this protection.

```bash
# Preview which pods have emptyDir volumes
kubectl get pods --all-namespaces \
  --field-selector "spec.nodeName=node01" \
  -o json | \
  python3 -c "
import sys, json
data = json.load(sys.stdin)
for item in data['items']:
  ns = item['metadata']['namespace']
  name = item['metadata']['name']
  vols = item['spec'].get('volumes', [])
  has_emptydir = any(v.get('emptyDir') is not None for v in vols)
  if has_emptydir:
    print(f'{ns}/{name} has emptyDir volumes')
"
```

### Orphaned Pods (No Controller)

Pods created directly (not via Deployment, StatefulSet, or Job) have no controller to reschedule them. Drain blocks on these by default. The `--force` flag evicts them without rescheduling.

```bash
# Find orphaned pods on a node
kubectl get pods --all-namespaces \
  --field-selector "spec.nodeName=node01" \
  -o json | \
  python3 -c "
import sys, json
data = json.load(sys.stdin)
for item in data['items']:
  owners = item['metadata'].get('ownerReferences', [])
  if not owners:
    ns = item['metadata']['namespace']
    name = item['metadata']['name']
    print(f'Orphaned: {ns}/{name}')
"
```

### Stuck Terminating Pods

Occasionally pods get stuck in `Terminating` state during drain because their finalizers are never cleared:

```bash
# Find stuck terminating pods on the draining node
kubectl get pods --all-namespaces \
  --field-selector "spec.nodeName=node01" | \
  grep Terminating

# Remove the finalizer to allow deletion to proceed
# WARNING: Only do this if the finalizer cleanup is safe to skip
POD_NS=production
POD_NAME=stuck-pod-abc123
kubectl patch pod "${POD_NAME}" -n "${POD_NS}" \
  --type merge \
  -p '{"metadata":{"finalizers":null}}'

# As a last resort, force delete (may leave resources in an inconsistent state)
kubectl delete pod "${POD_NAME}" -n "${POD_NS}" \
  --grace-period=0 \
  --force
```

## Node Taint-Based Maintenance

Taints provide an alternative mechanism for keeping workloads off maintenance nodes without using cordon. This is useful when specific workload classes should still run during maintenance:

```bash
# Add a maintenance taint that evicts all pods without tolerations
kubectl taint node node01 ops.example.com/maintenance=true:NoExecute

# Verify pods are evicted
watch -n 5 'kubectl get pods --all-namespaces --field-selector spec.nodeName=node01'

# Remove the taint to restore normal scheduling
kubectl taint node node01 ops.example.com/maintenance-
```

Add a toleration to DaemonSets or critical infrastructure pods that must continue running even on maintenance nodes:

```yaml
# Monitoring DaemonSet that must survive maintenance taints
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-exporter
  namespace: monitoring
spec:
  template:
    spec:
      tolerations:
      - key: ops.example.com/maintenance
        operator: Exists
        effect: NoExecute
      - key: node.kubernetes.io/unschedulable
        operator: Exists
        effect: NoSchedule
      - operator: Exists
        effect: NoExecute
        tolerationSeconds: 300
```

## Maintenance Observability

### Prometheus Alerts for Node Maintenance

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: node-maintenance-alerts
  namespace: monitoring
spec:
  groups:
  - name: node-maintenance
    interval: 60s
    rules:
    # Alert when a node has been cordoned for an extended period
    - alert: NodeCordonedTooLong
      expr: |
        kube_node_spec_unschedulable == 1
      for: 2h
      labels:
        severity: warning
      annotations:
        summary: "Node {{ $labels.node }} has been cordoned for 2+ hours"
        description: "Check if maintenance is still in progress or if the node should be uncordoned"

    # Alert when too many nodes are cordoned simultaneously
    - alert: TooManyNodesCordoned
      expr: |
        count(kube_node_spec_unschedulable == 1) /
        count(kube_node_info) > 0.3
      for: 10m
      labels:
        severity: critical
      annotations:
        summary: "More than 30% of nodes are cordoned"
        description: "{{ $value | humanizePercentage }} of nodes are currently unschedulable"

    # Alert when a node is not Ready for extended period
    - alert: NodeNotReady
      expr: |
        kube_node_status_condition{condition="Ready",status="true"} == 0
      for: 15m
      labels:
        severity: critical
      annotations:
        summary: "Node {{ $labels.node }} has been NotReady for 15+ minutes"
```

### Drain Event Logging

```bash
# Monitor drain events in real-time
kubectl get events --all-namespaces \
  --field-selector reason=Evicting,reason=Evicted \
  --watch

# Get a drain history from the past hour
kubectl get events --all-namespaces \
  --field-selector reason=Evicted \
  -o json | \
  python3 -c "
import sys, json
from datetime import datetime, timezone
data = json.load(sys.stdin)
cutoff = datetime.now(timezone.utc).timestamp() - 3600
for item in data['items']:
  last_time = item.get('lastTimestamp', '')
  ns = item['metadata']['namespace']
  msg = item.get('message', '')
  involved = item.get('involvedObject', {}).get('name', '')
  print(f'{last_time}  {ns}/{involved}: {msg}')
" | sort
```

## Conclusion

Safe node maintenance requires treating the drain operation as a production event, not an administrative task. The operational discipline — checking PDB status before draining, respecting termination grace periods, handling StatefulSet quorum requirements, annotating nodes with maintenance context, and monitoring for extended cordons — prevents the majority of maintenance-related incidents. Automation scripts reduce the risk of human error in multi-node rolling maintenance scenarios, and Prometheus alerts on cordoned nodes and node readiness catch issues before they escalate to SLA violations.
