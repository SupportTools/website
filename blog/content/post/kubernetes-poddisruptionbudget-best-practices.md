---
title: "Kubernetes PodDisruptionBudget Best Practices: High Availability During Maintenance"
date: 2029-01-22T00:00:00-05:00
draft: false
tags: ["Kubernetes", "PodDisruptionBudget", "High Availability", "Maintenance", "Operations", "SRE"]
categories:
- Kubernetes
- Operations
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes PodDisruptionBudgets covering configuration patterns, common pitfalls, interaction with cluster autoscaler, and enterprise operational practices for zero-downtime maintenance."
more_link: "yes"
url: "/kubernetes-poddisruptionbudget-best-practices/"
---

PodDisruptionBudgets (PDBs) are the Kubernetes mechanism that empowers platform teams to define the minimum acceptable availability for an application during voluntary disruptions—node drains, cluster upgrades, and pod evictions triggered by autoscalers or manual operations. Without PDBs, a `kubectl drain` on a node can evict all pods of a critical service simultaneously, causing an outage even on a properly sized deployment.

This post covers the PDB specification in depth, the distinction between `minAvailable` and `maxUnavailable`, interaction with the Cluster Autoscaler, unhealthy pod accounting, common misconfigurations that make PDBs ineffective, and the full operational playbook for safe cluster maintenance.

<!--more-->

## PDB Fundamentals

A PodDisruptionBudget is a namespaced resource that instructs the Kubernetes eviction API to reject eviction requests that would violate the defined availability constraints. It applies to voluntary disruptions—operations that go through the eviction API—and has no effect on involuntary disruptions (node failures, OOM kills, kernel panics).

```yaml
# Minimal PDB — protects at least 2 replicas of the payment-service
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-service-pdb
  namespace: production
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: payment-service
```

The eviction API checks PDBs before allowing any pod eviction. If evicting a pod would bring the number of available pods below `minAvailable` (or above `maxUnavailable`), the eviction request returns HTTP 429 Too Many Requests, and the draining node must wait before proceeding.

### minAvailable vs maxUnavailable

Both parameters can be specified as absolute integers or as percentages, but only one can be set per PDB.

```yaml
# Integer examples
spec:
  minAvailable: 3      # At least 3 pods must be available
  # or
  maxUnavailable: 1    # At most 1 pod may be unavailable

# Percentage examples
spec:
  minAvailable: "60%"  # At least 60% of desired replicas must be available
  # or
  maxUnavailable: "25%" # At most 25% of desired replicas may be unavailable
```

**Critical distinction**: `minAvailable` counts against the total number of pods matched by the selector, not against the deployment's desired replica count. If a deployment has 5 desired replicas but only 3 are running (due to pending pods), `minAvailable: 3` means no evictions are permitted because evicting any pod would leave fewer than 3 available.

### The Unhealthy Pod Problem

A common misconfiguration that causes maintenance to stall indefinitely:

```yaml
# PROBLEMATIC: This PDB can deadlock a drain
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-server-pdb
  namespace: production
spec:
  minAvailable: 3
  selector:
    matchLabels:
      app: api-server
```

If the deployment has exactly 3 replicas, `minAvailable: 3` means no pod can ever be evicted—the drain will hang forever waiting for a pod to become available that will never appear. The correct approach:

```yaml
# CORRECT: Allow one eviction for a 3-replica deployment
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-server-pdb
  namespace: production
spec:
  # For a 3-replica deployment, this allows at most 1 unavailable
  maxUnavailable: 1
  selector:
    matchLabels:
      app: api-server
```

For deployments that scale, percentages are safer because they adapt:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-server-pdb
  namespace: production
spec:
  # Regardless of replica count, always keep 75% available
  minAvailable: "75%"
  selector:
    matchLabels:
      app: api-server
```

## Production PDB Patterns by Workload Type

### Stateless API Services

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: checkout-api-pdb
  namespace: production
  labels:
    app: checkout-api
    tier: api
    criticality: high
spec:
  # Allow one pod unavailable at a time for rolling maintenance
  maxUnavailable: 1
  selector:
    matchLabels:
      app: checkout-api
      tier: api
```

### StatefulSets and Databases

Database StatefulSets require careful PDB configuration because pod identities matter and quorum must be maintained:

```yaml
# MongoDB replica set with 3 members — must always have quorum (2 of 3)
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: mongodb-pdb
  namespace: databases
spec:
  # Quorum requires at least 2 of 3 members
  minAvailable: 2
  selector:
    matchLabels:
      app: mongodb
      component: replicaset

---
# etcd cluster (5 members) — quorum requires 3 of 5
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: etcd-pdb
  namespace: kube-system
spec:
  # etcd quorum = floor(n/2) + 1 = 3 for n=5
  minAvailable: 3
  selector:
    matchLabels:
      component: etcd

---
# Kafka broker cluster — allow one broker offline at a time
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: kafka-pdb
  namespace: streaming
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: kafka
      role: broker
```

### Ingress Controllers

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: nginx-ingress-pdb
  namespace: ingress-nginx
spec:
  # Always keep at least 2 ingress pods running
  # This prevents all traffic from being dropped during a node drain
  minAvailable: 2
  selector:
    matchLabels:
      app.kubernetes.io/name: ingress-nginx
      app.kubernetes.io/component: controller
```

### Batch Processing and Jobs

PDBs on Jobs and CronJobs work differently—they apply to pods with the matched labels, not to the Job/CronJob object itself:

```yaml
# For long-running batch jobs that should not be interrupted during partial completion
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: ml-training-pdb
  namespace: batch
spec:
  # Allow the training to be interrupted (maxUnavailable: "100%") but only
  # when explicitly evicted; protects against accidental multiple simultaneous evictions
  maxUnavailable: "50%"
  selector:
    matchLabels:
      app: ml-training
      job-type: distributed
```

## PDB with Horizontal Pod Autoscaler

PDBs and HPAs interact in subtle ways. When the HPA scales down, it chooses pods to terminate and does NOT go through the eviction API—HPA scale-downs bypass PDB protection. PDBs only protect against voluntary disruptions initiated via the eviction API.

However, the Cluster Autoscaler respects PDBs when draining nodes before scale-down:

```yaml
# Deployment with both HPA and PDB
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-frontend
  namespace: production
spec:
  replicas: 5
  selector:
    matchLabels:
      app: web-frontend
  template:
    metadata:
      labels:
        app: web-frontend
    spec:
      containers:
      - name: frontend
        image: registry.example.com/web-frontend:v2.3.1
        resources:
          requests:
            cpu: 250m
            memory: 256Mi
          limits:
            cpu: 1000m
            memory: 512Mi
        readinessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
          failureThreshold: 3

---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: web-frontend-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web-frontend
  minReplicas: 3
  maxReplicas: 20
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
        value: 2
        periodSeconds: 60

---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: web-frontend-pdb
  namespace: production
spec:
  # With minReplicas=3 on HPA, always keep at least 2 running
  # This allows draining one node without service interruption
  minAvailable: 2
  selector:
    matchLabels:
      app: web-frontend
```

## Node Drain Workflow

Understanding the drain process is essential for operating PDBs correctly:

```bash
#!/bin/bash
# safe-node-drain.sh — Production-grade node drain with PDB awareness

NODE_NAME="${1}"
MAX_WAIT_MINUTES="${2:-30}"

if [ -z "${NODE_NAME}" ]; then
    echo "Usage: $0 <node-name> [max-wait-minutes]"
    exit 1
fi

# Verify the node exists
if ! kubectl get node "${NODE_NAME}" &>/dev/null; then
    echo "ERROR: Node ${NODE_NAME} does not exist"
    exit 1
fi

echo "=== Pre-drain PDB validation ==="

# List all PDBs in the cluster and check for potentially blocking ones
kubectl get pdb --all-namespaces -o json | python3 - <<'PYEOF'
import sys, json, subprocess

data = json.loads(subprocess.check_output(["kubectl", "get", "pdb", "--all-namespaces", "-o", "json"]))
for item in data.get("items", []):
    ns = item["metadata"]["namespace"]
    name = item["metadata"]["name"]
    status = item.get("status", {})
    desired = status.get("desiredHealthy", 0)
    current = status.get("currentHealthy", 0)
    disruptions_allowed = status.get("disruptionsAllowed", 0)

    if disruptions_allowed == 0:
        print(f"BLOCKED: {ns}/{name} — desired={desired}, current={current}, disruptions_allowed=0")
    else:
        print(f"OK:      {ns}/{name} — desired={desired}, current={current}, disruptions_allowed={disruptions_allowed}")
PYEOF

echo ""
echo "=== Cordoning node ${NODE_NAME} ==="
kubectl cordon "${NODE_NAME}"

echo ""
echo "=== Starting drain (max-wait: ${MAX_WAIT_MINUTES}m) ==="
timeout $((MAX_WAIT_MINUTES * 60)) kubectl drain "${NODE_NAME}" \
    --ignore-daemonsets \
    --delete-emptydir-data \
    --grace-period=60 \
    --timeout=${MAX_WAIT_MINUTES}m \
    --pod-selector='!job-name' \  # Skip job pods — they'll be rescheduled
    --dry-run=client 2>&1

echo ""
read -r -p "Dry run complete. Proceed with actual drain? [y/N] " confirm
if [ "${confirm}" != "y" ] && [ "${confirm}" != "Y" ]; then
    echo "Drain cancelled. Uncordoning node."
    kubectl uncordon "${NODE_NAME}"
    exit 0
fi

# Actual drain
kubectl drain "${NODE_NAME}" \
    --ignore-daemonsets \
    --delete-emptydir-data \
    --grace-period=60 \
    --timeout=${MAX_WAIT_MINUTES}m

DRAIN_EXIT=$?
if [ "${DRAIN_EXIT}" -ne 0 ]; then
    echo "ERROR: Drain failed or timed out (exit code: ${DRAIN_EXIT})"
    echo "Check for blocking PDBs:"
    kubectl get pdb --all-namespaces -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name,ALLOWED:.status.disruptionsAllowed'
    echo ""
    echo "Node remains cordoned. Manual intervention required."
    exit 1
fi

echo ""
echo "=== Drain complete ==="
kubectl get node "${NODE_NAME}"
```

## Debugging Blocked Drains

When a drain stalls, the PDB is usually responsible. Here is a structured diagnostic approach:

```bash
#!/bin/bash
# debug-pdb-blocks.sh — Identify which PDB is blocking a drain

NODE_NAME="${1:-$(kubectl get nodes --no-headers | head -1 | awk '{print $1}')}"

echo "=== Pods on node ${NODE_NAME} ==="
kubectl get pods --all-namespaces \
    -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name,STATUS:.status.phase,READY:.status.conditions[?(@.type=="Ready")].status' \
    --field-selector "spec.nodeName=${NODE_NAME}" | grep -v DaemonSet

echo ""
echo "=== PDB Status (sorted by disruptionsAllowed) ==="
kubectl get pdb --all-namespaces \
    -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name,MIN-AVAILABLE:.spec.minAvailable,MAX-UNAVAILABLE:.spec.maxUnavailable,EXPECTED:.status.expectedPods,CURRENT:.status.currentHealthy,DISRUPTIONS:.status.disruptionsAllowed' \
    | sort -k7 -n

echo ""
echo "=== PDBs with zero disruptions allowed ==="
kubectl get pdb --all-namespaces -o json | \
    python3 -c "
import sys, json
data = json.load(sys.stdin)
for item in data['items']:
    ns = item['metadata']['namespace']
    name = item['metadata']['name']
    da = item.get('status', {}).get('disruptionsAllowed', -1)
    if da == 0:
        spec = item.get('spec', {})
        min_avail = spec.get('minAvailable', 'N/A')
        max_unavail = spec.get('maxUnavailable', 'N/A')
        status = item.get('status', {})
        print(f'  {ns}/{name}:')
        print(f'    minAvailable={min_avail}, maxUnavailable={max_unavail}')
        print(f'    expectedPods={status.get(\"expectedPods\",\"?\")}')
        print(f'    currentHealthy={status.get(\"currentHealthy\",\"?\")}')
        print(f'    disruptedPods={list(status.get(\"disruptedPods\",{}).keys())}')
        print()
"
```

### Emergency Eviction Override

When a PDB is blocking maintenance due to a misconfiguration (not a genuine availability issue), the PDB can be temporarily deleted and recreated after the drain:

```bash
#!/bin/bash
# emergency-pdb-bypass.sh — Use with extreme caution
# This bypasses PDB protection — only for pre-approved emergency maintenance

NAMESPACE="${1}"
PDB_NAME="${2}"
NODE_NAME="${3}"

echo "WARNING: This will temporarily disable PDB protection for ${NAMESPACE}/${PDB_NAME}"
echo "Node to drain: ${NODE_NAME}"
echo ""
read -r -p "Type 'CONFIRM EMERGENCY BYPASS' to proceed: " confirm

if [ "${confirm}" != "CONFIRM EMERGENCY BYPASS" ]; then
    echo "Aborted."
    exit 1
fi

# Backup the PDB
kubectl get pdb "${PDB_NAME}" -n "${NAMESPACE}" -o yaml > "/tmp/pdb-backup-${PDB_NAME}-$(date +%s).yaml"
echo "PDB backed up to /tmp/pdb-backup-${PDB_NAME}-*.yaml"

# Delete the PDB temporarily
kubectl delete pdb "${PDB_NAME}" -n "${NAMESPACE}"

# Drain the node
kubectl drain "${NODE_NAME}" \
    --ignore-daemonsets \
    --delete-emptydir-data \
    --grace-period=30 \
    --timeout=15m

# Restore the PDB
kubectl apply -f "/tmp/pdb-backup-${PDB_NAME}-"*.yaml
echo "PDB restored: $(kubectl get pdb ${PDB_NAME} -n ${NAMESPACE})"
```

## Cluster Autoscaler Integration

The Cluster Autoscaler (CA) respects PDBs during scale-down operations. Understanding this interaction prevents scenarios where the CA cannot remove underutilized nodes because PDBs block eviction.

```yaml
# Cluster Autoscaler configuration for PDB awareness
apiVersion: v1
kind: ConfigMap
metadata:
  name: cluster-autoscaler-priority-expander
  namespace: kube-system
data:
  priorities: |-
    10:
      - .*spot.*
      - .*preemptible.*
    20:
      - .*on-demand.*
      - .*standard.*
```

```bash
# Check which nodes the Cluster Autoscaler considers unremovable due to PDBs
kubectl get configmap cluster-autoscaler-status -n kube-system -o yaml | \
    grep -A5 "NodeNotRemovable\|notSafeToEvictError\|pdb"

# Identify pods blocking CA scale-down via PDB
kubectl describe configmap cluster-autoscaler-status -n kube-system | \
    grep -B2 -A5 "blocked"
```

## PDB Validation and Testing

### Automated PDB Validation

```bash
#!/bin/bash
# validate-pdbs.sh — Comprehensive PDB validation for a namespace or cluster-wide

NAMESPACE="${1:---all-namespaces}"
NS_FLAG=""
if [ "${NAMESPACE}" != "--all-namespaces" ]; then
    NS_FLAG="-n ${NAMESPACE}"
fi

echo "=== PDB Validation Report ==="
echo "Namespace: ${NAMESPACE}"
echo "Timestamp: $(date -Iseconds)"
echo ""

ISSUES=0

# Check 1: PDB selector matches at least one pod
echo "--- Check 1: PDB selectors match pods ---"
kubectl get pdb ${NS_FLAG} -o json | python3 -c "
import sys, json, subprocess

data = json.load(sys.stdin)
for item in data['items']:
    ns = item['metadata']['namespace']
    name = item['metadata']['name']
    expected = item.get('status', {}).get('expectedPods', 0)
    if expected == 0:
        print(f'WARN: {ns}/{name} matches 0 pods (selector may be wrong)')
    else:
        print(f'OK:   {ns}/{name} matches {expected} pods')
"

echo ""
echo "--- Check 2: minAvailable less than replica count ---"
kubectl get pdb ${NS_FLAG} -o json | python3 -c "
import sys, json

data = json.load(sys.stdin)
for item in data['items']:
    ns = item['metadata']['namespace']
    name = item['metadata']['name']
    spec = item.get('spec', {})
    status = item.get('status', {})
    min_avail = spec.get('minAvailable')
    expected = status.get('expectedPods', 0)

    if min_avail is not None and not isinstance(min_avail, str):
        if min_avail >= expected and expected > 0:
            print(f'ERROR: {ns}/{name}: minAvailable={min_avail} >= expectedPods={expected} — DRAIN WILL BLOCK FOREVER')
        elif min_avail == expected - 1:
            print(f'OK:   {ns}/{name}: minAvailable={min_avail}, expectedPods={expected} (allows 1 eviction)')
        else:
            print(f'OK:   {ns}/{name}: minAvailable={min_avail}, expectedPods={expected}')
"

echo ""
echo "--- Check 3: PDBs currently blocking disruptions ---"
kubectl get pdb ${NS_FLAG} \
    -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name,DISRUPTIONS-ALLOWED:.status.disruptionsAllowed' \
    --sort-by='.status.disruptionsAllowed' | \
    awk 'NR==1 || $3=="0" {print}'
```

### Chaos Testing PDB Enforcement

```bash
#!/bin/bash
# test-pdb-enforcement.sh — Verify PDB is actually enforced

NAMESPACE="${1:-default}"
DEPLOY_NAME="${2:-test-pdb-app}"
PDB_NAME="${3:-test-pdb}"

echo "=== Creating test deployment and PDB ==="
kubectl create deployment "${DEPLOY_NAME}" \
    --image=nginx:1.27-alpine \
    --replicas=3 \
    -n "${NAMESPACE}"

kubectl wait deployment "${DEPLOY_NAME}" \
    --for=condition=Available \
    --timeout=60s \
    -n "${NAMESPACE}"

cat <<EOF | kubectl apply -f -
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: ${PDB_NAME}
  namespace: ${NAMESPACE}
spec:
  minAvailable: 3
  selector:
    matchLabels:
      app: ${DEPLOY_NAME}
EOF

echo ""
echo "=== Attempting to evict a pod (should fail with 429) ==="
POD_NAME=$(kubectl get pods -n "${NAMESPACE}" -l "app=${DEPLOY_NAME}" \
    -o jsonpath='{.items[0].metadata.name}')

# Construct the eviction request
cat <<EOF | kubectl create -f - 2>&1
apiVersion: policy/v1
kind: Eviction
metadata:
  name: ${POD_NAME}
  namespace: ${NAMESPACE}
EOF

echo ""
echo "=== Cleanup ==="
kubectl delete pdb "${PDB_NAME}" -n "${NAMESPACE}" --ignore-not-found
kubectl delete deployment "${DEPLOY_NAME}" -n "${NAMESPACE}" --ignore-not-found
echo "Test complete"
```

## PDB and Karpenter

Karpenter, the next-generation Kubernetes node lifecycle controller, has its own disruption controls that interact with PDBs:

```yaml
# Karpenter NodePool with disruption budgets
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: general-purpose
spec:
  disruption:
    consolidationPolicy: WhenUnderutilized
    consolidateAfter: 30s
    # Karpenter respects PDBs during voluntary node disruption
    # These are Karpenter-level disruption budgets (complement PDBs)
    budgets:
    - nodes: "10%"
      schedule: "0 9 * * 1-5"  # Weekdays 9am
      duration: 8h
    - nodes: "0"               # No disruptions on weekends
      schedule: "0 0 * * 0,6"
      duration: 48h
  template:
    metadata:
      labels:
        karpenter.sh/nodepool: general-purpose
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: default
      requirements:
      - key: karpenter.sh/capacity-type
        operator: In
        values: ["on-demand"]
      - key: kubernetes.io/arch
        operator: In
        values: ["amd64"]
```

## Summary and Recommendations

PodDisruptionBudgets are a critical safety mechanism that prevents voluntary disruptions from causing outages. The key operational principles:

1. **Define PDBs for every critical workload** before the cluster sees production traffic. Retrofitting PDBs after incidents is reactive and error-prone.

2. **Use `maxUnavailable` rather than `minAvailable`** for deployments with a fixed replica count, because `minAvailable` equal to the replica count creates an undrainable deadlock.

3. **Use percentages for autoscaled workloads** so the PDB adapts as the HPA scales the deployment up and down.

4. **Always ensure `disruptionsAllowed >= 1`** for PDBs to be useful. A PDB that allows zero disruptions because its `minAvailable` equals the current pod count provides no value and blocks all maintenance.

5. **Run PDB validation scripts in CI** to catch misconfigured budgets before they block a production maintenance window at 2am.

6. **Coordinate PDBs with the Cluster Autoscaler** by ensuring the CA can drain at least one node without violating all PDBs simultaneously—otherwise scale-down will be permanently blocked.

7. **Test PDB enforcement in staging** before relying on it in production. Use the eviction API test script above to verify the PDB actually blocks eviction as intended.
