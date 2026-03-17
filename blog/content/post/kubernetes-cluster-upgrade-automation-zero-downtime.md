---
title: "Kubernetes Cluster Upgrade Automation: Zero-Downtime Control Plane and Node Rolling"
date: 2030-12-10T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Upgrades", "Automation", "Zero-Downtime", "kubeadm", "PodDisruptionBudget", "Operations"]
categories:
- Kubernetes
- DevOps
- Operations
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Kubernetes cluster upgrade automation covering pre-upgrade validation checklists, control plane upgrade sequencing, node drain and cordon automation, PodDisruptionBudget enforcement, rollback procedures, and post-upgrade smoke tests for zero-downtime production upgrades."
more_link: "yes"
url: "/kubernetes-cluster-upgrade-automation-zero-downtime/"
---

Kubernetes cluster upgrades are among the highest-risk operational procedures in a production environment. A control plane misconfiguration can make the cluster API inaccessible; draining nodes without respecting PodDisruptionBudgets can cause service outages; upgrading minor versions without testing addon compatibility can break monitoring, DNS, or networking. Yet delaying upgrades creates security exposure and accumulates technical debt.

This guide provides a complete, automation-ready cluster upgrade procedure: pre-upgrade validation that catches common failure modes before they occur, control plane sequencing for HA clusters, automated node drain/cordon with PDB-aware pacing, rollback procedures for each failure scenario, and a post-upgrade smoke test suite that verifies cluster health before marking an upgrade complete.

<!--more-->

# Kubernetes Cluster Upgrade Automation: Zero-Downtime Control Plane and Node Rolling

## Pre-Upgrade Validation Checklist

### Version Compatibility Matrix

Before starting any upgrade, verify version compatibility across all components:

```bash
#!/bin/bash
# pre-upgrade-check.sh
# Run this before any cluster upgrade

set -euo pipefail

TARGET_VERSION=${1:-"1.31.0"}
CLUSTER_CONTEXT=${2:-$(kubectl config current-context)}

echo "Pre-upgrade validation for cluster: $CLUSTER_CONTEXT"
echo "Target version: $TARGET_VERSION"
echo "---"

# Check current cluster version
CURRENT_VERSION=$(kubectl version --output=json | jq -r '.serverVersion.gitVersion' | tr -d 'v')
echo "Current cluster version: $CURRENT_VERSION"

# Kubernetes skew policy: can only upgrade one minor version at a time
CURRENT_MINOR=$(echo $CURRENT_VERSION | cut -d. -f2)
TARGET_MINOR=$(echo $TARGET_VERSION | cut -d. -f2)
VERSION_DIFF=$((TARGET_MINOR - CURRENT_MINOR))

if [ $VERSION_DIFF -gt 1 ]; then
    echo "ERROR: Cannot skip minor versions (current: 1.${CURRENT_MINOR}, target: 1.${TARGET_MINOR})"
    echo "You must upgrade through each minor version: 1.${CURRENT_MINOR} -> 1.$((CURRENT_MINOR+1)) -> ... -> 1.${TARGET_MINOR}"
    exit 1
fi
echo "Version skew check: PASS (diff: $VERSION_DIFF minor versions)"
```

### Checking Addon Compatibility

```bash
# Check addon versions against the target Kubernetes version

check_addon_compatibility() {
    echo ""
    echo "=== Addon Compatibility Check ==="

    # Check CoreDNS version
    COREDNS_VERSION=$(kubectl get deployment -n kube-system coredns \
        -o jsonpath='{.spec.template.spec.containers[0].image}' | \
        grep -oP '[\d.]+$')
    echo "CoreDNS version: $COREDNS_VERSION"

    # Check kube-proxy version
    PROXY_VERSION=$(kubectl get daemonset -n kube-system kube-proxy \
        -o jsonpath='{.spec.template.spec.containers[0].image}' | \
        grep -oP 'v[\d.]+$' | tr -d 'v')
    echo "kube-proxy version: $PROXY_VERSION"

    # Check CNI plugin version
    # For Calico:
    if kubectl get daemonset -n calico-system calico-node &>/dev/null; then
        CALICO_VERSION=$(kubectl get daemonset -n calico-system calico-node \
            -o jsonpath='{.spec.template.spec.initContainers[0].image}' | \
            grep -oP 'v[\d.]+$' | tr -d 'v')
        echo "Calico version: $CALICO_VERSION"
        # Check Calico compatibility matrix
        # https://docs.tigera.io/calico/latest/getting-started/kubernetes/requirements
    fi

    # Check cert-manager version
    if kubectl get deployment -n cert-manager cert-manager &>/dev/null; then
        CERTMGR_VERSION=$(kubectl get deployment -n cert-manager cert-manager \
            -o jsonpath='{.spec.template.spec.containers[0].image}' | \
            grep -oP 'v[\d.]+$' | tr -d 'v')
        echo "cert-manager version: $CERTMGR_VERSION"
    fi

    # Check metrics-server version
    if kubectl get deployment -n kube-system metrics-server &>/dev/null; then
        METRICS_VERSION=$(kubectl get deployment -n kube-system metrics-server \
            -o jsonpath='{.spec.template.spec.containers[0].image}' | \
            grep -oP 'v[\d.]+$' | tr -d 'v')
        echo "metrics-server version: $METRICS_VERSION"
    fi
}

check_addon_compatibility
```

### Deprecated API Check

One of the most common upgrade failures is workloads using deprecated or removed API versions:

```bash
check_deprecated_apis() {
    echo ""
    echo "=== Deprecated API Check ==="

    # Install pluto for API deprecation checking
    if ! command -v pluto &>/dev/null; then
        echo "Installing pluto..."
        curl -sL https://github.com/FairwindsOps/pluto/releases/latest/download/pluto_linux_amd64.tar.gz | \
            tar -xz -C /usr/local/bin
    fi

    # Check all deployed resources against the target version
    pluto detect-all-in-cluster \
        --target-versions k8s=v${TARGET_VERSION} \
        --output wide 2>&1

    DEPRECATED_COUNT=$(pluto detect-all-in-cluster \
        --target-versions k8s=v${TARGET_VERSION} \
        --output json 2>/dev/null | \
        jq '[.[] | select(.deprecated==true or .removed==true)] | length')

    if [ "$DEPRECATED_COUNT" -gt 0 ]; then
        echo "WARNING: Found $DEPRECATED_COUNT resources using deprecated/removed APIs"
        echo "These must be updated before upgrading to v$TARGET_VERSION"
    else
        echo "Deprecated API check: PASS (no deprecated APIs found)"
    fi
}

check_deprecated_apis
```

### PodDisruptionBudget Validation

```bash
check_pdbs() {
    echo ""
    echo "=== PodDisruptionBudget Validation ==="

    # Find PDBs that would block node draining
    # A PDB with maxUnavailable=0 and minAvailable equal to current replicas is blocking
    kubectl get pdb -A -o json | jq -r '
    .items[] |
    . as $pdb |
    {
        namespace: .metadata.namespace,
        name: .metadata.name,
        minAvailable: .spec.minAvailable,
        maxUnavailable: .spec.maxUnavailable,
        disruptionsAllowed: .status.disruptionsAllowed,
        currentHealthy: .status.currentHealthy,
        expectedPods: .status.expectedPods
    } |
    select(.disruptionsAllowed == 0) |
    "BLOCKING PDB: \(.namespace)/\(.name) - disruptionsAllowed=0 (healthy=\(.currentHealthy)/\(.expectedPods))"
    '

    BLOCKING_PDBS=$(kubectl get pdb -A -o json | \
        jq '[.items[] | select(.status.disruptionsAllowed == 0)] | length')

    if [ "$BLOCKING_PDBS" -gt 0 ]; then
        echo "WARNING: $BLOCKING_PDBS PDBs are currently blocking (disruptionsAllowed=0)"
        echo "Node draining will fail if any of these protect pods on the node being drained"
    else
        echo "PDB check: PASS (all PDBs allow at least 1 disruption)"
    fi
}

check_pdbs
```

### Node Health Check

```bash
check_node_health() {
    echo ""
    echo "=== Node Health Check ==="

    # Check for NotReady nodes
    NOT_READY=$(kubectl get nodes --no-headers | \
        grep -v " Ready " | grep -v "^$" | wc -l)
    if [ "$NOT_READY" -gt 0 ]; then
        echo "ERROR: $NOT_READY nodes are not Ready:"
        kubectl get nodes --no-headers | grep -v " Ready "
        return 1
    fi
    echo "Node readiness: PASS (all nodes Ready)"

    # Check for nodes with disk pressure, memory pressure, or PID pressure
    PRESSURE=$(kubectl get nodes -o json | jq -r '
    .items[] |
    . as $node |
    $node.status.conditions[] |
    select(.type == "DiskPressure" or .type == "MemoryPressure" or .type == "PIDPressure") |
    select(.status == "True") |
    "\($node.metadata.name): \(.type)"
    ')
    if [ -n "$PRESSURE" ]; then
        echo "WARNING: Nodes under pressure:"
        echo "$PRESSURE"
    else
        echo "Node pressure check: PASS"
    fi
}

check_node_health
```

### etcd Health Check

```bash
check_etcd_health() {
    echo ""
    echo "=== etcd Health Check ==="

    # Check etcd cluster health
    # Run from a control plane node
    ETCDCTL_API=3 etcdctl \
        --endpoints=https://127.0.0.1:2379 \
        --cacert=/etc/kubernetes/pki/etcd/ca.crt \
        --cert=/etc/kubernetes/pki/etcd/server.crt \
        --key=/etc/kubernetes/pki/etcd/server.key \
        endpoint health --cluster

    # Check etcd member list
    ETCDCTL_API=3 etcdctl \
        --endpoints=https://127.0.0.1:2379 \
        --cacert=/etc/kubernetes/pki/etcd/ca.crt \
        --cert=/etc/kubernetes/pki/etcd/server.crt \
        --key=/etc/kubernetes/pki/etcd/server.key \
        member list -w table

    # Check etcd data size — large databases slow down upgrades
    ETCDCTL_API=3 etcdctl \
        --endpoints=https://127.0.0.1:2379 \
        --cacert=/etc/kubernetes/pki/etcd/ca.crt \
        --cert=/etc/kubernetes/pki/etcd/server.crt \
        --key=/etc/kubernetes/pki/etcd/server.key \
        endpoint status --cluster -w table
}

check_etcd_health
```

## Pre-Upgrade: etcd Backup

Never upgrade without a recent etcd backup:

```bash
#!/bin/bash
# backup-etcd.sh

BACKUP_DIR=/var/lib/etcd-backups
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/etcd-snapshot-${TIMESTAMP}.db"

mkdir -p $BACKUP_DIR

ETCDCTL_API=3 etcdctl \
    --endpoints=https://127.0.0.1:2379 \
    --cacert=/etc/kubernetes/pki/etcd/ca.crt \
    --cert=/etc/kubernetes/pki/etcd/server.crt \
    --key=/etc/kubernetes/pki/etcd/server.key \
    snapshot save $BACKUP_FILE

# Verify the backup
ETCDCTL_API=3 etcdctl snapshot status $BACKUP_FILE -w table

# Retain last 5 backups
ls -t ${BACKUP_DIR}/etcd-snapshot-*.db | tail -n +6 | xargs -r rm

echo "etcd backup saved: $BACKUP_FILE"
echo "Backup size: $(du -sh $BACKUP_FILE | cut -f1)"
```

## Control Plane Upgrade Sequencing

For HA clusters with multiple control plane nodes, upgrade one control plane node at a time to maintain API availability.

### Upgrading the First Control Plane Node

```bash
#!/bin/bash
# upgrade-control-plane.sh
# Run on the first control plane node

TARGET_VERSION=${1:-"1.31.0"}

echo "Upgrading first control plane node to $TARGET_VERSION"

# Step 1: Upgrade kubeadm
apt-mark unhold kubeadm
apt-get update
apt-get install -y kubeadm=${TARGET_VERSION}-1.1
apt-mark hold kubeadm

# Verify the upgrade plan
kubeadm upgrade plan v${TARGET_VERSION}

# Step 2: Apply the upgrade (modifies kube-apiserver, kube-controller-manager, kube-scheduler manifests)
kubeadm upgrade apply v${TARGET_VERSION} --yes

# Step 3: Drain this control plane node (carefully — don't disrupt other workloads)
# Control plane nodes may have the NoSchedule taint; drain respects PDBs
kubectl drain $(hostname) \
    --ignore-daemonsets \
    --delete-emptydir-data \
    --timeout=300s \
    --grace-period=60

# Step 4: Upgrade kubelet and kubectl
apt-mark unhold kubelet kubectl
apt-get install -y kubelet=${TARGET_VERSION}-1.1 kubectl=${TARGET_VERSION}-1.1
apt-mark hold kubelet kubectl

# Restart kubelet
systemctl daemon-reload
systemctl restart kubelet

# Step 5: Uncordon the node
kubectl uncordon $(hostname)

# Verify the node is ready with the new version
kubectl get node $(hostname)
```

### Upgrading Additional Control Plane Nodes

```bash
#!/bin/bash
# upgrade-additional-control-plane.sh
# Run on each additional control plane node

TARGET_VERSION=${1:-"1.31.0"}
NODE_NAME=$(hostname)

echo "Upgrading additional control plane node: $NODE_NAME"

# For additional control plane nodes, use 'upgrade node' (not 'upgrade apply')
apt-mark unhold kubeadm
apt-get install -y kubeadm=${TARGET_VERSION}-1.1
apt-mark hold kubeadm

# Upgrade the local node configuration
kubeadm upgrade node

# Drain this node
kubectl drain $NODE_NAME \
    --ignore-daemonsets \
    --delete-emptydir-data \
    --timeout=300s \
    --grace-period=60

# Upgrade kubelet and kubectl
apt-mark unhold kubelet kubectl
apt-get install -y kubelet=${TARGET_VERSION}-1.1 kubectl=${TARGET_VERSION}-1.1
apt-mark hold kubelet kubectl

systemctl daemon-reload
systemctl restart kubelet

kubectl uncordon $NODE_NAME

echo "Control plane node $NODE_NAME upgraded to $TARGET_VERSION"
kubectl get node $NODE_NAME
```

### Verifying Control Plane Health After Upgrade

```bash
verify_control_plane() {
    echo "Verifying control plane health..."

    # Wait for all control plane components to be healthy
    TIMEOUT=300
    ELAPSED=0
    while true; do
        # Check API server health
        if kubectl get --raw /healthz &>/dev/null; then
            echo "API server: HEALTHY"
            break
        fi
        if [ $ELAPSED -ge $TIMEOUT ]; then
            echo "ERROR: API server health check timed out after ${TIMEOUT}s"
            exit 1
        fi
        echo "Waiting for API server... (${ELAPSED}s)"
        sleep 10
        ELAPSED=$((ELAPSED + 10))
    done

    # Check controller manager and scheduler via component status
    # Note: componentstatuses was deprecated but is still functional
    kubectl get componentstatuses 2>/dev/null || echo "componentstatuses not available (expected in newer Kubernetes)"

    # Alternative: check control plane pods directly
    kubectl get pods -n kube-system -l tier=control-plane
    kubectl get pods -n kube-system | grep -E "kube-apiserver|kube-controller|kube-scheduler|etcd"

    # Verify all nodes see the new API server version
    kubectl version --short
}
```

## Automated Node Upgrade with PDB Respect

### Node Drain Controller

The `kubectl drain` command respects PDBs but blocks indefinitely by default. Production automation needs timeout handling and parallel drain management:

```bash
#!/bin/bash
# node-drain-with-pdb.sh
# Drain a single node with PDB-aware pacing

NODE_NAME=$1
DRAIN_TIMEOUT=${2:-600}  # 10 minutes default
FORCE_AFTER_TIMEOUT=${3:-false}

echo "Draining node: $NODE_NAME"

# Record which pods are on this node before drain
PRE_DRAIN_PODS=$(kubectl get pods --all-namespaces \
    --field-selector spec.nodeName=${NODE_NAME} \
    -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{"\n"}{end}')

# Check PDB status for pods on this node before draining
echo "Checking PDB status for pods on $NODE_NAME..."
for POD_INFO in $PRE_DRAIN_PODS; do
    NS=$(echo $POD_INFO | cut -d/ -f1)
    POD=$(echo $POD_INFO | cut -d/ -f2)

    # Find any PDB that selects this pod
    kubectl get pdb -n $NS -o json | jq -r --arg pod "$POD" '
    .items[] |
    . as $pdb |
    if (.status.disruptionsAllowed == 0) then
        "BLOCKING PDB in \(.metadata.namespace)/\(.metadata.name) for pod \($pod)"
    else empty
    end
    '
done

# Perform the drain
if timeout $DRAIN_TIMEOUT kubectl drain $NODE_NAME \
    --ignore-daemonsets \
    --delete-emptydir-data \
    --grace-period=30 \
    --pod-selector='!batch.kubernetes.io/job-name' 2>&1; then
    echo "Node $NODE_NAME drained successfully"
else
    DRAIN_EXIT=$?
    if [ "$FORCE_AFTER_TIMEOUT" = "true" ]; then
        echo "WARNING: Drain timed out. Forcing drain (some pods may be disrupted)..."
        kubectl drain $NODE_NAME \
            --ignore-daemonsets \
            --delete-emptydir-data \
            --force \
            --grace-period=10 \
            --pod-selector='!batch.kubernetes.io/job-name'
    else
        echo "ERROR: Drain failed (exit code: $DRAIN_EXIT). Not forcing."
        kubectl uncordon $NODE_NAME
        exit 1
    fi
fi
```

### Parallel Node Upgrade Orchestrator

For large clusters, upgrade nodes in configurable batches to reduce total upgrade time:

```bash
#!/bin/bash
# upgrade-worker-nodes.sh
# Upgrade all worker nodes in rolling batches

TARGET_VERSION=${1:-"1.31.0"}
BATCH_SIZE=${2:-3}         # Upgrade N nodes at a time
DRAIN_TIMEOUT=${3:-600}    # Seconds to wait for each drain
POST_DRAIN_WAIT=${4:-30}   # Seconds to wait after upgrading a batch

# Get all worker nodes (not control plane nodes)
WORKER_NODES=$(kubectl get nodes \
    -l '!node-role.kubernetes.io/control-plane' \
    -l '!node-role.kubernetes.io/master' \
    --no-headers | awk '{print $1}')

NODE_COUNT=$(echo "$WORKER_NODES" | wc -l)
echo "Upgrading $NODE_COUNT worker nodes in batches of $BATCH_SIZE"
echo "Target version: $TARGET_VERSION"

# Split nodes into batches
BATCH=()
BATCH_NUM=1

for NODE in $WORKER_NODES; do
    BATCH+=($NODE)

    if [ ${#BATCH[@]} -eq $BATCH_SIZE ]; then
        echo ""
        echo "=== Upgrading batch $BATCH_NUM: ${BATCH[*]} ==="

        # Upgrade each node in the batch in parallel
        PIDS=()
        for NODE_TO_UPGRADE in "${BATCH[@]}"; do
            upgrade_single_node $NODE_TO_UPGRADE $TARGET_VERSION $DRAIN_TIMEOUT &
            PIDS+=($!)
        done

        # Wait for all nodes in this batch
        BATCH_FAILED=false
        for PID in "${PIDS[@]}"; do
            if ! wait $PID; then
                BATCH_FAILED=true
                echo "ERROR: A node upgrade in batch $BATCH_NUM failed"
            fi
        done

        if $BATCH_FAILED; then
            echo "ERROR: Batch $BATCH_NUM failed. Halting upgrade."
            exit 1
        fi

        echo "Batch $BATCH_NUM complete. Waiting ${POST_DRAIN_WAIT}s before next batch..."
        sleep $POST_DRAIN_WAIT

        # Verify cluster health after each batch
        if ! verify_cluster_health; then
            echo "ERROR: Cluster health check failed after batch $BATCH_NUM"
            exit 1
        fi

        BATCH=()
        BATCH_NUM=$((BATCH_NUM + 1))
    fi
done

# Handle the final partial batch
if [ ${#BATCH[@]} -gt 0 ]; then
    echo ""
    echo "=== Upgrading final batch $BATCH_NUM: ${BATCH[*]} ==="
    PIDS=()
    for NODE_TO_UPGRADE in "${BATCH[@]}"; do
        upgrade_single_node $NODE_TO_UPGRADE $TARGET_VERSION $DRAIN_TIMEOUT &
        PIDS+=($!)
    done
    for PID in "${PIDS[@]}"; do
        wait $PID
    done
fi

echo ""
echo "All worker nodes upgraded to $TARGET_VERSION"
kubectl get nodes -o wide

upgrade_single_node() {
    local NODE=$1
    local VERSION=$2
    local TIMEOUT=$3

    echo "Upgrading node: $NODE"

    # Drain the node
    kubectl drain $NODE \
        --ignore-daemonsets \
        --delete-emptydir-data \
        --grace-period=30 \
        --timeout=${TIMEOUT}s || {
        echo "ERROR: Failed to drain $NODE"
        kubectl uncordon $NODE
        return 1
    }

    # SSH to the node and run the kubelet upgrade
    # This assumes you have SSH access to node IPs via node annotations
    NODE_IP=$(kubectl get node $NODE -o jsonpath='{.status.addresses[?(@.type=="InternalIP")].address}')

    ssh -o StrictHostKeyChecking=no $NODE_IP bash <<EOF
set -e
apt-mark unhold kubelet kubeadm kubectl
apt-get update -qq
apt-get install -y kubelet=${VERSION}-1.1 kubeadm=${VERSION}-1.1 kubectl=${VERSION}-1.1
apt-mark hold kubelet kubeadm kubectl
kubeadm upgrade node
systemctl daemon-reload
systemctl restart kubelet
EOF

    # Uncordon the node
    kubectl uncordon $NODE

    # Wait for the node to be Ready
    kubectl wait --for=condition=Ready node/$NODE --timeout=120s

    echo "Node $NODE upgraded successfully"
}
```

## Post-Upgrade Smoke Tests

After upgrading, run a comprehensive smoke test to verify cluster functionality:

```bash
#!/bin/bash
# post-upgrade-smoke-test.sh

EXPECTED_VERSION=${1:-"1.31.0"}
TEST_NAMESPACE="upgrade-test-$(date +%s)"

PASS=0
FAIL=0

pass() { echo "PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

cleanup() {
    kubectl delete namespace $TEST_NAMESPACE --ignore-not-found --grace-period=0 &>/dev/null
}
trap cleanup EXIT

echo "=== Kubernetes Post-Upgrade Smoke Tests ==="
echo "Expected version: $EXPECTED_VERSION"
echo ""

# Test 1: All nodes at expected version
echo "--- Test 1: Node Versions ---"
NOT_UPGRADED=$(kubectl get nodes -o json | \
    jq -r ".items[] | select(.status.nodeInfo.kubeletVersion | ltrimstr(\"v\") | startswith(\"$EXPECTED_VERSION\") | not) | .metadata.name")
if [ -z "$NOT_UPGRADED" ]; then
    pass "All nodes are at version $EXPECTED_VERSION"
else
    fail "Nodes not at $EXPECTED_VERSION: $NOT_UPGRADED"
fi

# Test 2: All nodes are Ready
echo ""
echo "--- Test 2: Node Readiness ---"
NOT_READY=$(kubectl get nodes --no-headers | grep -v " Ready " | wc -l)
if [ "$NOT_READY" -eq 0 ]; then
    pass "All nodes are Ready"
else
    fail "$NOT_READY nodes are not Ready"
    kubectl get nodes --no-headers | grep -v " Ready "
fi

# Test 3: System pods are running
echo ""
echo "--- Test 3: System Pods ---"
FAILING_SYSTEM_PODS=$(kubectl get pods -n kube-system --no-headers | \
    grep -v "Running\|Completed" | grep -v "^$" | wc -l)
if [ "$FAILING_SYSTEM_PODS" -eq 0 ]; then
    pass "All kube-system pods are Running"
else
    fail "$FAILING_SYSTEM_PODS kube-system pods are not Running"
    kubectl get pods -n kube-system --no-headers | grep -v "Running\|Completed"
fi

# Test 4: Create and delete a namespace
echo ""
echo "--- Test 4: Namespace CRUD ---"
if kubectl create namespace $TEST_NAMESPACE &>/dev/null; then
    kubectl delete namespace $TEST_NAMESPACE &>/dev/null
    pass "Namespace create/delete"
else
    fail "Namespace create/delete"
fi

# Test 5: Create a test Deployment
echo ""
echo "--- Test 5: Deployment Lifecycle ---"
kubectl create namespace $TEST_NAMESPACE &>/dev/null
cat <<EOF | kubectl apply -f - &>/dev/null
apiVersion: apps/v1
kind: Deployment
metadata:
  name: smoke-test
  namespace: $TEST_NAMESPACE
spec:
  replicas: 3
  selector:
    matchLabels:
      app: smoke-test
  template:
    metadata:
      labels:
        app: smoke-test
    spec:
      containers:
        - name: nginx
          image: nginx:stable-alpine
          ports:
            - containerPort: 80
          readinessProbe:
            httpGet:
              path: /
              port: 80
            initialDelaySeconds: 5
            periodSeconds: 5
EOF

# Wait for deployment to be ready
if kubectl rollout status deployment/smoke-test -n $TEST_NAMESPACE --timeout=120s &>/dev/null; then
    pass "Deployment created and rolled out successfully"
else
    fail "Deployment rollout did not complete within 120s"
    kubectl get pods -n $TEST_NAMESPACE
fi

# Test 6: Service creation and DNS
echo ""
echo "--- Test 6: Service and DNS ---"
cat <<EOF | kubectl apply -f - &>/dev/null
apiVersion: v1
kind: Service
metadata:
  name: smoke-test
  namespace: $TEST_NAMESPACE
spec:
  selector:
    app: smoke-test
  ports:
    - port: 80
EOF

# Test DNS resolution from within the cluster
DNS_RESULT=$(kubectl run dns-test -n $TEST_NAMESPACE \
    --image=busybox:1.36 \
    --restart=Never \
    --rm \
    -it \
    --quiet \
    -- nslookup smoke-test.${TEST_NAMESPACE}.svc.cluster.local 2>/dev/null | \
    grep -c "Address" || true)
if [ "$DNS_RESULT" -gt 0 ]; then
    pass "Service DNS resolution works"
else
    fail "Service DNS resolution failed"
fi

# Test 7: ConfigMap and Secret
echo ""
echo "--- Test 7: ConfigMap and Secret ---"
if kubectl create configmap smoke-test-cm \
    --from-literal=key=value \
    -n $TEST_NAMESPACE &>/dev/null; then
    pass "ConfigMap creation"
else
    fail "ConfigMap creation"
fi

if kubectl create secret generic smoke-test-secret \
    --from-literal=password=testpass \
    -n $TEST_NAMESPACE &>/dev/null; then
    pass "Secret creation"
else
    fail "Secret creation"
fi

# Test 8: Horizontal Pod Autoscaler
echo ""
echo "--- Test 8: HPA ---"
cat <<EOF | kubectl apply -f - &>/dev/null
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: smoke-test-hpa
  namespace: $TEST_NAMESPACE
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: smoke-test
  minReplicas: 2
  maxReplicas: 5
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 50
EOF
sleep 5  # Give HPA time to sync
HPA_STATUS=$(kubectl get hpa smoke-test-hpa -n $TEST_NAMESPACE --no-headers | awk '{print $5}')
if [[ "$HPA_STATUS" != "<unknown>" ]]; then
    pass "HPA created and synced with metrics"
else
    fail "HPA did not sync (metrics-server may have an issue)"
fi

# Test 9: PersistentVolumeClaim (if storage class exists)
echo ""
echo "--- Test 9: PVC Provisioning ---"
DEFAULT_SC=$(kubectl get storageclass -o json | \
    jq -r '.items[] | select(.metadata.annotations."storageclass.kubernetes.io/is-default-class"=="true") | .metadata.name' | \
    head -1)
if [ -n "$DEFAULT_SC" ]; then
    cat <<EOF | kubectl apply -f - &>/dev/null
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: smoke-test-pvc
  namespace: $TEST_NAMESPACE
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Gi
  storageClassName: $DEFAULT_SC
EOF
    # Wait briefly for PVC
    sleep 10
    PVC_STATUS=$(kubectl get pvc smoke-test-pvc -n $TEST_NAMESPACE -o jsonpath='{.status.phase}')
    if [ "$PVC_STATUS" = "Bound" ]; then
        pass "PVC provisioned successfully (StorageClass: $DEFAULT_SC)"
    else
        fail "PVC not bound (status: $PVC_STATUS)"
    fi
else
    echo "SKIP: Test 9 (no default StorageClass found)"
fi

# Test 10: Webhook admission (if cert-manager exists)
echo ""
echo "--- Test 10: Admission Webhooks ---"
WEBHOOK_COUNT=$(kubectl get validatingwebhookconfigurations -o json | \
    jq '[.items[] | select(.metadata.name | contains("cert-manager"))] | length')
if [ "$WEBHOOK_COUNT" -gt 0 ]; then
    # Try creating a cert-manager resource to test webhooks
    cat <<EOF | kubectl apply -f - &>/dev/null
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: smoke-test-cert
  namespace: $TEST_NAMESPACE
spec:
  secretName: smoke-test-cert-tls
  issuerRef:
    name: nonexistent-issuer
    kind: Issuer
  dnsNames: [smoke.test.example.com]
EOF
    if kubectl get certificate smoke-test-cert -n $TEST_NAMESPACE &>/dev/null; then
        pass "cert-manager webhook is functional"
    else
        fail "cert-manager webhook is not responding"
    fi
else
    echo "SKIP: Test 10 (cert-manager not found)"
fi

# Summary
echo ""
echo "=== Smoke Test Summary ==="
echo "PASSED: $PASS"
echo "FAILED: $FAIL"
echo ""

if [ $FAIL -gt 0 ]; then
    echo "RESULT: FAILED — $FAIL tests failed. Investigate before considering upgrade complete."
    exit 1
else
    echo "RESULT: PASSED — All smoke tests passed. Upgrade complete."
    exit 0
fi
```

## Rollback Procedures

### Rolling Back kubelet (Node Level)

If a node has an issue after upgrade:

```bash
#!/bin/bash
# rollback-node.sh
NODE_NAME=$1
PREVIOUS_VERSION=${2:-"1.30.0"}

echo "Rolling back node $NODE_NAME to kubelet $PREVIOUS_VERSION"

# Drain the node first
kubectl drain $NODE_NAME \
    --ignore-daemonsets \
    --delete-emptydir-data \
    --grace-period=30 \
    --timeout=300s

NODE_IP=$(kubectl get node $NODE_NAME -o jsonpath='{.status.addresses[?(@.type=="InternalIP")].address}')
ssh $NODE_IP bash <<EOF
apt-mark unhold kubelet kubeadm kubectl
apt-get install -y \
    kubelet=${PREVIOUS_VERSION}-1.1 \
    kubeadm=${PREVIOUS_VERSION}-1.1 \
    kubectl=${PREVIOUS_VERSION}-1.1
apt-mark hold kubelet kubeadm kubectl
systemctl daemon-reload
systemctl restart kubelet
EOF

kubectl uncordon $NODE_NAME
kubectl wait --for=condition=Ready node/$NODE_NAME --timeout=120s
echo "Node $NODE_NAME rolled back to $PREVIOUS_VERSION"
```

### Rolling Back the Control Plane via etcd Restore

For severe control plane failures, restore from the etcd snapshot:

```bash
#!/bin/bash
# rollback-control-plane-etcd.sh
# WARNING: This restores the entire cluster state to the backup point
# All changes made after the backup will be lost

BACKUP_FILE=${1?USAGE: rollback-control-plane-etcd.sh <backup-file>}

echo "WARNING: This will restore the cluster to the state at backup time"
echo "Backup file: $BACKUP_FILE"
read -p "Type 'RESTORE' to confirm: " CONFIRM
if [ "$CONFIRM" != "RESTORE" ]; then
    echo "Aborted"
    exit 1
fi

# Stop the API server (prevents new writes during restore)
mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/
mv /etc/kubernetes/manifests/kube-controller-manager.yaml /tmp/
mv /etc/kubernetes/manifests/kube-scheduler.yaml /tmp/

# Wait for control plane pods to stop
sleep 30

# Back up current etcd data
mv /var/lib/etcd /var/lib/etcd.bak.$(date +%Y%m%d-%H%M%S)

# Restore from snapshot
ETCDCTL_API=3 etcdctl snapshot restore $BACKUP_FILE \
    --data-dir=/var/lib/etcd \
    --name=$(hostname) \
    --initial-cluster="$(hostname)=https://127.0.0.1:2380" \
    --initial-cluster-token=etcd-cluster \
    --initial-advertise-peer-urls=https://127.0.0.1:2380

# Restore API server manifests
mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/
mv /tmp/kube-controller-manager.yaml /etc/kubernetes/manifests/
mv /tmp/kube-scheduler.yaml /etc/kubernetes/manifests/

echo "etcd restored. Waiting for API server to start..."
sleep 30
kubectl get nodes
```

## Upgrade Automation Pipeline

Integrate the upgrade process into a CI/CD pipeline for full automation:

```yaml
# .github/workflows/cluster-upgrade.yaml
name: Kubernetes Cluster Upgrade

on:
  workflow_dispatch:
    inputs:
      target_version:
        description: 'Target Kubernetes version (e.g., 1.31.0)'
        required: true
      cluster:
        description: 'Cluster to upgrade (dev|staging|production)'
        required: true
      dry_run:
        description: 'Dry run (true/false)'
        default: 'true'

jobs:
  pre-upgrade-checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Configure kubectl
        uses: azure/k8s-set-context@v3
        with:
          kubeconfig: ${{ secrets[format('KUBECONFIG_{0}', github.event.inputs.cluster)] }}

      - name: Run pre-upgrade checks
        run: |
          chmod +x scripts/pre-upgrade-check.sh
          scripts/pre-upgrade-check.sh ${{ github.event.inputs.target_version }}

      - name: Backup etcd
        run: |
          # Trigger etcd backup job in the cluster
          kubectl create job etcd-backup-$(date +%s) \
            --from=cronjob/etcd-backup \
            -n kube-system
          kubectl wait --for=condition=Complete job/etcd-backup-$(date +%s) \
            -n kube-system \
            --timeout=300s

  upgrade-cluster:
    needs: pre-upgrade-checks
    runs-on: ubuntu-latest
    if: github.event.inputs.dry_run == 'false'
    steps:
      - name: Upgrade control plane
        run: |
          # Trigger upgrade automation via cluster API or SSH
          echo "Upgrading control plane..."

      - name: Upgrade worker nodes
        run: |
          echo "Upgrading worker nodes in batches..."

      - name: Run smoke tests
        run: |
          chmod +x scripts/post-upgrade-smoke-test.sh
          scripts/post-upgrade-smoke-test.sh ${{ github.event.inputs.target_version }}

      - name: Notify success
        if: success()
        run: |
          echo "Cluster ${{ github.event.inputs.cluster }} upgraded to ${{ github.event.inputs.target_version }}"
```

## Summary

Zero-downtime Kubernetes cluster upgrades require a systematic approach: comprehensive pre-upgrade validation catches deprecated APIs, blocking PDBs, and unhealthy components before they cause failures during the upgrade; sequential control plane upgrades maintain API availability throughout the process; PDB-respecting node drain automation prevents service outages; and automated smoke tests provide confidence that the upgraded cluster functions correctly. The combination of pre-upgrade checks, etcd snapshots, and tested rollback procedures transforms a high-risk maintenance window into a routine operational procedure that can be safely automated.
