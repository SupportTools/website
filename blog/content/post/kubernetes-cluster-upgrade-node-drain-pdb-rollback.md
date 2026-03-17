---
title: "Kubernetes Cluster Upgrade Best Practices: Node Drain Strategies, PDB Enforcement, and Rollback Procedures"
date: 2031-09-25T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cluster Upgrade", "Node Drain", "PDB", "Rollback", "Operations"]
categories:
- Kubernetes
- Operations
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes cluster upgrades covering node drain automation, PodDisruptionBudget enforcement, control plane sequencing, etcd backup strategies, and rollback procedures for production environments."
more_link: "yes"
url: "/kubernetes-cluster-upgrade-node-drain-pdb-rollback/"
---

Kubernetes cluster upgrades are among the highest-risk operational activities in a production environment. A misconfigured upgrade can simultaneously drain all pods from a critical namespace, violate PodDisruptionBudgets that were working correctly in isolation, leave the API server unreachable while nodes wait for certificate rotation, or — in the worst case — corrupt the etcd data store and require a full cluster restore. Yet upgrades are necessary: security patches, feature requirements, and end-of-life timelines make staying on outdated versions equally risky.

This post provides a complete, battle-tested upgrade playbook: pre-upgrade validation, control plane sequencing, node drain automation with PDB awareness, rollback procedures, and post-upgrade validation. The procedures apply to kubeadm-managed clusters and provide guidance for EKS, GKE, and AKS managed plane upgrades.

<!--more-->

# Kubernetes Cluster Upgrade Best Practices

## Kubernetes Version Skew Policy

Before upgrading, understand the supported version skew:

- **kube-apiserver**: Can only be upgraded one minor version at a time (1.29 → 1.30, not 1.29 → 1.31).
- **kubelet**: Can be up to 2 minor versions behind the API server (API 1.30, kubelet 1.28 is supported).
- **kube-controller-manager, kube-scheduler**: Must be same or one version below the API server.
- **kubectl**: Must be within one minor version of the API server in either direction.
- **etcd**: Must match the version expected by the specific kube-apiserver version.

This means a cluster at 1.28 upgrading to 1.31 requires three sequential upgrade operations: 1.28→1.29, 1.29→1.30, 1.30→1.31.

## Pre-Upgrade Checklist

```bash
#!/bin/bash
# pre-upgrade-check.sh
# Run this 1-2 weeks before planned upgrade

set -euo pipefail
CURRENT_VERSION=$(kubectl version --short 2>/dev/null | grep "Server Version" | awk '{print $3}')
TARGET_VERSION="${1:-}"

echo "=== PRE-UPGRADE VALIDATION ==="
echo "Current version: $CURRENT_VERSION"
echo "Target version: $TARGET_VERSION"
echo ""

# 1. Check API deprecations
echo "=== Checking for deprecated API usage ==="
kubectl get --all-namespaces \
    ingresses.extensions \
    2>/dev/null | head -20 && echo "WARNING: ingresses.extensions is deprecated"

# Pluto for comprehensive API deprecation checking
if command -v pluto &>/dev/null; then
    pluto detect-all-in-cluster --target-versions k8s=v${TARGET_VERSION#v} 2>/dev/null || true
else
    echo "Install pluto for API deprecation checking: https://github.com/FairwindsOps/pluto"
fi

# 2. Check PodDisruptionBudgets
echo ""
echo "=== PodDisruptionBudgets with minAvailable >= replicas ==="
kubectl get pdb --all-namespaces -o json | \
    jq -r '.items[] |
        select(.spec.minAvailable != null) |
        .metadata.namespace + "/" + .metadata.name + ": minAvailable=" + (.spec.minAvailable | tostring)'

# 3. Check for pods not managed by a controller (naked pods)
echo ""
echo "=== Unmanaged pods (will not be rescheduled after drain) ==="
kubectl get pods --all-namespaces -o json | \
    jq -r '.items[] |
        select(.metadata.ownerReferences == null or .metadata.ownerReferences == []) |
        [.metadata.namespace, .metadata.name, .status.phase] | @tsv'

# 4. Check for DaemonSet pods that block drains
echo ""
echo "=== DaemonSets in non-system namespaces (review before drain) ==="
kubectl get daemonset --all-namespaces \
    --field-selector metadata.namespace!=kube-system \
    -o wide

# 5. Check etcd cluster health
echo ""
echo "=== etcd cluster health ==="
ETCD_PODS=$(kubectl -n kube-system get pods -l component=etcd -o name)
for pod in $ETCD_PODS; do
    kubectl -n kube-system exec "$pod" -- \
        etcdctl endpoint health \
        --endpoints=https://127.0.0.1:2379 \
        --cacert=/etc/kubernetes/pki/etcd/ca.crt \
        --cert=/etc/kubernetes/pki/etcd/server.crt \
        --key=/etc/kubernetes/pki/etcd/server.key \
        2>/dev/null || echo "etcd health check failed on $pod"
done

# 6. Check certificate expiration
echo ""
echo "=== Certificate expiration (within 90 days = warning) ==="
if command -v kubeadm &>/dev/null; then
    kubeadm certs check-expiration 2>/dev/null || true
fi
# Check manually for non-kubeadm clusters
for cert in /etc/kubernetes/pki/*.crt /etc/kubernetes/pki/etcd/*.crt; do
    if [ -f "$cert" ]; then
        EXPIRY=$(openssl x509 -in "$cert" -noout -enddate 2>/dev/null | cut -d= -f2)
        EXPIRY_EPOCH=$(date -d "$EXPIRY" +%s 2>/dev/null || date -j -f "%b %d %T %Y %Z" "$EXPIRY" +%s 2>/dev/null)
        NOW_EPOCH=$(date +%s)
        DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))
        if [ "$DAYS_LEFT" -lt 90 ]; then
            echo "WARNING: $cert expires in $DAYS_LEFT days ($EXPIRY)"
        fi
    fi
done

# 7. Check node resource headroom for drain
echo ""
echo "=== Node resource usage (low headroom may cause drain failures) ==="
kubectl top nodes 2>/dev/null || echo "metrics-server not available"

# 8. Backup reminder
echo ""
echo "=== REQUIRED: Take etcd backup before proceeding ==="
echo "Run: ./backup-etcd.sh"
```

## etcd Backup

**Always backup etcd before any upgrade.**

```bash
#!/bin/bash
# backup-etcd.sh

BACKUP_DIR="/var/backup/etcd/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

ETCD_POD=$(kubectl -n kube-system get pods -l component=etcd \
    -o jsonpath='{.items[0].metadata.name}')

echo "Taking etcd snapshot..."
kubectl -n kube-system exec "$ETCD_POD" -- \
    etcdctl snapshot save /tmp/etcd-backup.db \
    --endpoints=https://127.0.0.1:2379 \
    --cacert=/etc/kubernetes/pki/etcd/ca.crt \
    --cert=/etc/kubernetes/pki/etcd/server.crt \
    --key=/etc/kubernetes/pki/etcd/server.key

kubectl -n kube-system cp \
    "$ETCD_POD:/tmp/etcd-backup.db" \
    "$BACKUP_DIR/etcd-snapshot.db"

# Verify the snapshot
ETCD_VERSION=$(kubectl -n kube-system exec "$ETCD_POD" -- \
    etcdctl version 2>/dev/null | head -1)
kubectl -n kube-system exec "$ETCD_POD" -- \
    etcdctl snapshot status /tmp/etcd-backup.db \
    --write-out=table \
    --endpoints=https://127.0.0.1:2379 \
    --cacert=/etc/kubernetes/pki/etcd/ca.crt \
    --cert=/etc/kubernetes/pki/etcd/server.crt \
    --key=/etc/kubernetes/pki/etcd/server.key

# Save cluster state
kubectl get nodes -o yaml > "$BACKUP_DIR/nodes.yaml"
kubectl get all --all-namespaces -o yaml > "$BACKUP_DIR/all-resources.yaml"
kubectl get pv,pvc --all-namespaces -o yaml > "$BACKUP_DIR/storage.yaml"

echo "Backup complete: $BACKUP_DIR"
echo "etcd snapshot size: $(du -h $BACKUP_DIR/etcd-snapshot.db | cut -f1)"

# Copy to remote storage (recommended)
# rsync -av "$BACKUP_DIR" backup-server:/kubernetes-backups/
```

## Control Plane Upgrade Sequence

For kubeadm-managed clusters with multiple control plane nodes:

```bash
#!/bin/bash
# upgrade-control-plane.sh
set -euo pipefail

TARGET_VERSION="${1:?Usage: $0 <target_version>}"  # e.g., 1.31.0

echo "=== CONTROL PLANE UPGRADE: $TARGET_VERSION ==="

# Step 1: Upgrade kubeadm on first control plane node
echo "Step 1: Upgrading kubeadm..."
apt-mark unhold kubeadm
apt-get update
apt-get install -y "kubeadm=${TARGET_VERSION}-*"
apt-mark hold kubeadm

kubeadm version

# Step 2: Verify upgrade plan
echo ""
echo "Step 2: Upgrade plan..."
kubeadm upgrade plan

# Step 3: Apply upgrade (first control plane only)
echo ""
echo "Step 3: Applying upgrade..."
kubeadm upgrade apply "v${TARGET_VERSION}" \
    --certificate-renewal=true \
    --yes

# Step 4: Drain the first control plane node
echo ""
echo "Step 4: Draining first control plane node..."
NODE_NAME=$(hostname)
kubectl drain "$NODE_NAME" \
    --ignore-daemonsets \
    --delete-emptydir-data \
    --timeout=300s \
    --force=false   # respects PDBs

# Step 5: Upgrade kubelet and kubectl
echo ""
echo "Step 5: Upgrading kubelet and kubectl..."
apt-mark unhold kubelet kubectl
apt-get install -y \
    "kubelet=${TARGET_VERSION}-*" \
    "kubectl=${TARGET_VERSION}-*"
apt-mark hold kubelet kubectl

systemctl daemon-reload
systemctl restart kubelet

# Step 6: Uncordon
echo ""
echo "Step 6: Uncordoning node..."
kubectl uncordon "$NODE_NAME"

echo ""
echo "First control plane node upgrade complete."
echo "Verify health before proceeding to additional control planes:"
echo "  kubectl get nodes"
echo "  kubectl get pods -n kube-system"
```

For additional control plane nodes (repeat after first is healthy):

```bash
# On each additional control plane node:
kubeadm upgrade node   # different command than first node
# Then drain, upgrade kubelet, uncordon (same as above)
```

## Node Drain with PDB Awareness

The standard `kubectl drain` command respects PDBs, but its error handling in large clusters is poor. A production drain script needs better retry logic and observability:

```bash
#!/bin/bash
# drain-node.sh
# Gracefully drain a node with PDB awareness and retry logic

set -euo pipefail

NODE_NAME="${1:?Usage: $0 <node-name>}"
MAX_DRAIN_WAIT="${MAX_DRAIN_WAIT:-600}"   # seconds
RETRY_INTERVAL="${RETRY_INTERVAL:-30}"    # seconds between retries
MAX_RETRIES="${MAX_RETRIES:-10}"

echo "=== DRAINING NODE: $NODE_NAME ==="
echo "Max wait: ${MAX_DRAIN_WAIT}s, retry interval: ${RETRY_INTERVAL}s"

# Pre-drain checks
echo ""
echo "Pre-drain pod count on node:"
kubectl get pods --all-namespaces \
    --field-selector "spec.nodeName=${NODE_NAME}" \
    --no-headers | wc -l

echo ""
echo "PDBs that may block drain:"
kubectl get pdb --all-namespaces -o json | \
    jq -r '.items[] |
        select(.status.disruptionsAllowed == 0) |
        .metadata.namespace + "/" + .metadata.name +
        " (disruptionsAllowed=0)"'

# Cordon first (prevent new scheduling while we prepare)
echo ""
echo "Cordoning node..."
kubectl cordon "$NODE_NAME"

# Attempt drain with retries
attempt=0
while [ $attempt -lt $MAX_RETRIES ]; do
    attempt=$((attempt + 1))
    echo ""
    echo "Drain attempt $attempt/$MAX_RETRIES..."

    if kubectl drain "$NODE_NAME" \
        --ignore-daemonsets \
        --delete-emptydir-data \
        --timeout="${MAX_DRAIN_WAIT}s" \
        --force=false \
        2>&1; then
        echo "Drain successful on attempt $attempt"
        break
    else
        EXIT_CODE=$?
        echo "Drain failed (exit code $EXIT_CODE)"

        if [ $attempt -lt $MAX_RETRIES ]; then
            echo "Checking PDB violations..."
            kubectl get pdb --all-namespaces -o json | \
                jq -r '.items[] |
                    select(.status.disruptionsAllowed == 0) |
                    "  PDB BLOCKING: " + .metadata.namespace +
                    "/" + .metadata.name +
                    " expected=" + (.status.expectedPods | tostring) +
                    " ready=" + (.status.currentHealthy | tostring)'

            echo "Waiting ${RETRY_INTERVAL}s before retry..."
            sleep "$RETRY_INTERVAL"
        else
            echo "ERROR: Drain failed after $MAX_RETRIES attempts"
            echo "Manual intervention required. Checking remaining pods..."
            kubectl get pods --all-namespaces \
                --field-selector "spec.nodeName=${NODE_NAME}" \
                -o wide
            kubectl uncordon "$NODE_NAME"
            exit 1
        fi
    fi
done

# Verify drain completion
REMAINING=$(kubectl get pods --all-namespaces \
    --field-selector "spec.nodeName=${NODE_NAME}" \
    --no-headers 2>/dev/null | \
    grep -v "DaemonSet" | wc -l || echo "0")

echo ""
echo "Remaining non-DaemonSet pods: $REMAINING"

if [ "$REMAINING" -gt 0 ]; then
    echo "WARNING: Non-DaemonSet pods still on node:"
    kubectl get pods --all-namespaces \
        --field-selector "spec.nodeName=${NODE_NAME}" -o wide
fi

echo ""
echo "Node $NODE_NAME is drained and cordoned."
echo "Proceed with upgrade, then run: kubectl uncordon $NODE_NAME"
```

## Worker Node Upgrade Script

```bash
#!/bin/bash
# upgrade-worker-node.sh
# Run on each worker node

set -euo pipefail

TARGET_VERSION="${1:?Usage: $0 <target_version>}"

echo "=== WORKER NODE UPGRADE: $TARGET_VERSION ==="
echo "Node: $(hostname)"

# Step 1: Upgrade kubeadm
apt-mark unhold kubeadm
apt-get update
apt-get install -y "kubeadm=${TARGET_VERSION}-*"
apt-mark hold kubeadm

# Step 2: Apply node-level upgrade
kubeadm upgrade node

# Step 3: Upgrade kubelet and kubectl
apt-mark unhold kubelet kubectl
apt-get install -y \
    "kubelet=${TARGET_VERSION}-*" \
    "kubectl=${TARGET_VERSION}-*"
apt-mark hold kubelet kubectl

systemctl daemon-reload
systemctl restart kubelet

echo "Worker node upgrade complete."
echo "Node will self-report new version within 30 seconds."
```

## Automated Rolling Upgrade for Worker Nodes

For large clusters, automate the rolling upgrade process:

```bash
#!/bin/bash
# rolling-upgrade-workers.sh
# Upgrades all worker nodes in batches

set -euo pipefail

TARGET_VERSION="${1:?Usage: $0 <target_version>}"
BATCH_SIZE="${BATCH_SIZE:-3}"        # nodes per batch
INTER_BATCH_WAIT="${INTER_BATCH_WAIT:-120}"  # seconds between batches

# Get all worker nodes (exclude control plane)
WORKER_NODES=$(kubectl get nodes \
    --selector='!node-role.kubernetes.io/control-plane' \
    -o jsonpath='{.items[*].metadata.name}')

TOTAL=$(echo "$WORKER_NODES" | wc -w)
echo "=== ROLLING WORKER NODE UPGRADE ==="
echo "Target version: $TARGET_VERSION"
echo "Total workers: $TOTAL"
echo "Batch size: $BATCH_SIZE"
echo ""

batch=0
upgraded=0

for node in $WORKER_NODES; do
    batch=$((batch + 1))

    echo "=== Processing node $node ($upgraded/$TOTAL upgraded) ==="

    # 1. Drain the node (from control plane)
    echo "Draining $node..."
    MAX_DRAIN_WAIT=600 ./drain-node.sh "$node"

    # 2. Trigger upgrade on the node
    echo "Upgrading $node..."
    if command -v ansible &>/dev/null; then
        ansible "$node" -m shell -a \
            "/usr/local/bin/upgrade-worker-node.sh $TARGET_VERSION" \
            --become
    else
        # Fallback: SSH directly
        ssh -o StrictHostKeyChecking=no "root@$node" \
            "/usr/local/bin/upgrade-worker-node.sh $TARGET_VERSION"
    fi

    # 3. Wait for node to report new version
    echo "Waiting for $node to report new kubelet version..."
    MAX_WAIT=120
    elapsed=0
    while [ $elapsed -lt $MAX_WAIT ]; do
        REPORTED_VERSION=$(kubectl get node "$node" \
            -o jsonpath='{.status.nodeInfo.kubeletVersion}' 2>/dev/null | tr -d 'v')
        if [[ "$REPORTED_VERSION" == "${TARGET_VERSION}"* ]]; then
            echo "$node is now at $REPORTED_VERSION"
            break
        fi
        sleep 10
        elapsed=$((elapsed + 10))
    done

    # 4. Uncordon
    kubectl uncordon "$node"
    echo "Uncordoned $node"

    upgraded=$((upgraded + 1))

    # 5. Wait for workloads to reschedule
    echo "Waiting 30s for workloads to stabilize..."
    sleep 30

    # 6. Verify cluster health before next batch
    echo "Verifying cluster health..."
    NOT_READY=$(kubectl get nodes --no-headers | grep "NotReady" | wc -l)
    if [ "$NOT_READY" -gt 0 ]; then
        echo "ERROR: $NOT_READY nodes are NotReady. Pausing upgrade."
        kubectl get nodes
        exit 1
    fi

    # 7. Inter-batch pause
    if [ $((batch % BATCH_SIZE)) -eq 0 ] && [ $upgraded -lt $TOTAL ]; then
        echo "Batch complete. Waiting ${INTER_BATCH_WAIT}s before next batch..."
        sleep "$INTER_BATCH_WAIT"
        batch=0
    fi
done

echo ""
echo "=== UPGRADE COMPLETE ==="
echo "Upgraded: $upgraded/$TOTAL nodes"
kubectl get nodes -o wide
```

## PodDisruptionBudget Validation Before Drain

Before draining nodes, verify that PDBs won't block the entire upgrade:

```bash
#!/bin/bash
# validate-pdbs.sh

echo "=== PDB VALIDATION FOR UPGRADE ==="

# Find PDBs with 0 allowed disruptions
kubectl get pdb --all-namespaces -o json | jq -r '
    .items[] |
    {
        namespace: .metadata.namespace,
        name: .metadata.name,
        minAvailable: .spec.minAvailable,
        maxUnavailable: .spec.maxUnavailable,
        expectedPods: .status.expectedPods,
        currentHealthy: .status.currentHealthy,
        disruptionsAllowed: .status.disruptionsAllowed
    } |
    select(.disruptionsAllowed == 0) |
    "BLOCKED: " + .namespace + "/" + .name +
    " (expected=" + (.expectedPods|tostring) +
    " healthy=" + (.currentHealthy|tostring) +
    " disruptionsAllowed=0)"'

echo ""
echo "=== PDBs that allow only 1 disruption (serialize node drains) ==="
kubectl get pdb --all-namespaces -o json | jq -r '
    .items[] |
    select(.status.disruptionsAllowed == 1) |
    .metadata.namespace + "/" + .metadata.name +
    " (disruptionsAllowed=1 - drain one node at a time)"'

echo ""
echo "=== PDBs with minAvailable >= maxReplicas (will always block) ==="
# This requires correlating PDB selectors with deployment replicas
# Simplified version:
kubectl get pdb --all-namespaces -o json | jq -r '
    .items[] |
    select(.spec.minAvailable != null) |
    select((.spec.minAvailable | tonumber) >= (.status.expectedPods | tonumber)) |
    "MISCONFIGURED: " + .metadata.namespace + "/" + .metadata.name +
    " minAvailable=" + (.spec.minAvailable | tostring) +
    " >= expectedPods=" + (.status.expectedPods | tostring)'
```

## Rollback Procedures

### Rolling Back a Worker Node

If a node fails to upgrade or starts exhibiting problems:

```bash
# 1. Drain the problematic node
./drain-node.sh problematic-worker-01

# 2. Downgrade packages (kubeadm, kubelet, kubectl)
apt-get install -y \
    "kubeadm=${PREVIOUS_VERSION}-*" \
    "kubelet=${PREVIOUS_VERSION}-*" \
    "kubectl=${PREVIOUS_VERSION}-*"

# 3. Re-run node-level configuration
kubeadm upgrade node

# 4. Restart kubelet
systemctl daemon-reload
systemctl restart kubelet

# 5. Uncordon
kubectl uncordon problematic-worker-01
```

### Rolling Back the Control Plane

Control plane rollback is significantly more complex. The safest rollback path:

```bash
# CAUTION: Control plane rollback requires careful sequencing

# 1. Backup current state
./backup-etcd.sh

# 2. Downgrade control plane components (kubeadm, kubelet, kubectl)
apt-get install -y \
    "kubeadm=${PREVIOUS_VERSION}-*" \
    "kubelet=${PREVIOUS_VERSION}-*" \
    "kubectl=${PREVIOUS_VERSION}-*"

# 3. Re-configure control plane
# For kubeadm: apply the previous kubeadm configuration
kubeadm init phase control-plane apiserver \
    --config=/etc/kubernetes/kubeadm-previous.yaml

# 4. Restart API server
# On kubeadm: the API server is a static pod
mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/kube-apiserver-new.yaml
cp /tmp/kube-apiserver-previous.yaml /etc/kubernetes/manifests/kube-apiserver.yaml
# kubelet will restart the API server automatically

# 5. Verify API server is running previous version
kubectl version
```

### etcd Restore (Last Resort)

If the upgrade corrupts etcd, restore from backup:

```bash
# WARNING: etcd restore requires stopping the cluster

# 1. Stop API server on all control plane nodes
for node in control-plane-01 control-plane-02 control-plane-03; do
    ssh "root@$node" "mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/"
    ssh "root@$node" "mv /etc/kubernetes/manifests/kube-controller-manager.yaml /tmp/"
    ssh "root@$node" "mv /etc/kubernetes/manifests/kube-scheduler.yaml /tmp/"
done

# 2. Restore etcd snapshot on all nodes
SNAPSHOT="/var/backup/etcd/20310925-030000/etcd-snapshot.db"
for node in control-plane-01 control-plane-02 control-plane-03; do
    ssh "root@$node" "etcdctl snapshot restore ${SNAPSHOT} \
        --name $node \
        --initial-cluster control-plane-01=https://10.0.0.1:2380,control-plane-02=https://10.0.0.2:2380,control-plane-03=https://10.0.0.3:2380 \
        --initial-cluster-token etcd-cluster-token \
        --initial-advertise-peer-urls https://${node_ip}:2380 \
        --data-dir=/var/lib/etcd-restored"
    # Replace data directory
    ssh "root@$node" "mv /var/lib/etcd /var/lib/etcd-failed && mv /var/lib/etcd-restored /var/lib/etcd"
done

# 3. Restart etcd
for node in control-plane-01 control-plane-02 control-plane-03; do
    ssh "root@$node" "systemctl restart etcd || true"
done

# 4. Restore API server
for node in control-plane-01 control-plane-02 control-plane-03; do
    ssh "root@$node" "mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/"
    ssh "root@$node" "mv /tmp/kube-controller-manager.yaml /etc/kubernetes/manifests/"
    ssh "root@$node" "mv /tmp/kube-scheduler.yaml /etc/kubernetes/manifests/"
done
```

## Post-Upgrade Validation

```bash
#!/bin/bash
# post-upgrade-validate.sh

TARGET_VERSION="${1:?Usage: $0 <target_version>}"

echo "=== POST-UPGRADE VALIDATION ==="
echo ""

# 1. Node versions
echo "Node versions:"
kubectl get nodes -o custom-columns=NAME:.metadata.name,VERSION:.status.nodeInfo.kubeletVersion,STATUS:.status.conditions[-1].type

# Verify all nodes are at target version
WRONG_VERSION=$(kubectl get nodes \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.nodeInfo.kubeletVersion}{"\n"}{end}' | \
    grep -v "v${TARGET_VERSION}" | wc -l)
if [ "$WRONG_VERSION" -gt 0 ]; then
    echo "WARNING: $WRONG_VERSION nodes not at target version"
fi

echo ""
echo "kube-system pod versions:"
kubectl get pods -n kube-system -o wide

# 2. Control plane health
echo ""
echo "Control plane component status:"
kubectl get componentstatuses 2>/dev/null || \
    kubectl -n kube-system get pods -l tier=control-plane

# 3. etcd health
echo ""
echo "etcd health:"
ETCD_POD=$(kubectl -n kube-system get pods -l component=etcd \
    -o jsonpath='{.items[0].metadata.name}')
kubectl -n kube-system exec "$ETCD_POD" -- \
    etcdctl endpoint health \
    --endpoints=https://127.0.0.1:2379 \
    --cacert=/etc/kubernetes/pki/etcd/ca.crt \
    --cert=/etc/kubernetes/pki/etcd/server.crt \
    --key=/etc/kubernetes/pki/etcd/server.key \
    2>/dev/null

kubectl -n kube-system exec "$ETCD_POD" -- \
    etcdctl endpoint status \
    --endpoints=https://127.0.0.1:2379 \
    --cacert=/etc/kubernetes/pki/etcd/ca.crt \
    --cert=/etc/kubernetes/pki/etcd/server.crt \
    --key=/etc/kubernetes/pki/etcd/server.key \
    --write-out=table \
    2>/dev/null

# 4. Workload health
echo ""
echo "Deployment rollout status:"
kubectl get deployments --all-namespaces -o json | \
    jq -r '.items[] |
        select(.status.unavailableReplicas > 0) |
        .metadata.namespace + "/" + .metadata.name +
        ": unavailable=" + (.status.unavailableReplicas | tostring)'

echo ""
echo "StatefulSet status:"
kubectl get statefulsets --all-namespaces -o json | \
    jq -r '.items[] |
        select(.status.readyReplicas < .status.replicas) |
        .metadata.namespace + "/" + .metadata.name +
        ": ready=" + (.status.readyReplicas | tostring) +
        "/" + (.status.replicas | tostring)'

# 5. Certificate expiration check
echo ""
echo "Certificate expiration:"
kubeadm certs check-expiration 2>/dev/null || true

# 6. PDB status post-upgrade
echo ""
echo "PDBs with 0 allowed disruptions (should be 0 in steady state):"
kubectl get pdb --all-namespaces -o json | \
    jq -r '.items[] | select(.status.disruptionsAllowed == 0) |
        .metadata.namespace + "/" + .metadata.name'

echo ""
echo "=== UPGRADE VALIDATION COMPLETE ==="
```

## Managed Kubernetes Upgrade Notes

### EKS

```bash
# Check current version
aws eks describe-cluster --name my-cluster \
    --query 'cluster.version' --output text

# Upgrade control plane
aws eks update-cluster-version \
    --name my-cluster \
    --kubernetes-version 1.31

# Monitor upgrade
aws eks describe-update \
    --name my-cluster \
    --update-id <update-id>

# Upgrade node groups
aws eks update-nodegroup-version \
    --cluster-name my-cluster \
    --nodegroup-name standard-workers \
    --kubernetes-version 1.31

# Update add-ons after cluster upgrade
aws eks update-addon \
    --cluster-name my-cluster \
    --addon-name coredns \
    --addon-version v1.11.3-eksbuild.1
```

### GKE

```bash
# Enable maintenance windows to control upgrade timing
gcloud container clusters update my-cluster \
    --maintenance-window-start "2031-09-25T02:00:00Z" \
    --maintenance-window-end "2031-09-25T06:00:00Z" \
    --maintenance-window-recurrence "FREQ=WEEKLY;BYDAY=SA,SU"

# Manual upgrade
gcloud container clusters upgrade my-cluster \
    --master \
    --cluster-version 1.31.0-gke.100

# Upgrade node pools
gcloud container clusters upgrade my-cluster \
    --node-pool standard-pool \
    --cluster-version 1.31.0-gke.100

# Surge upgrade configuration (controls upgrade speed)
gcloud container node-pools update standard-pool \
    --cluster my-cluster \
    --max-surge-upgrade 3 \
    --max-unavailable-upgrade 0  # zero disruption during upgrade
```

## Summary

Kubernetes cluster upgrades require systematic preparation, automated tooling, and clear rollback procedures. The critical success factors are: taking an etcd backup before every upgrade, validating PDB configurations so they don't block drains, using ordered control plane sequencing to maintain API server availability throughout, draining nodes with retry logic that respects PDB-enforced quorums, and automating post-upgrade validation to catch regressions before they affect production traffic. For large clusters, batched rolling upgrades with health checks between batches provide the right balance between upgrade speed and risk management. The time investment in a well-tested upgrade playbook pays for itself the first time an upgrade encounters an unexpected obstacle and the team can respond from a documented procedure rather than improvising under pressure.
