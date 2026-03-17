---
title: "Kubernetes Cluster Upgrades: Zero-Downtime Strategies"
date: 2029-04-12T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cluster Upgrade", "Zero Downtime", "etcd", "PodDisruptionBudget", "Node Drain"]
categories:
- Kubernetes
- Operations
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to zero-downtime Kubernetes cluster upgrades covering version skew policy, control plane upgrade order, node drain and cordon procedures, PodDisruptionBudgets, rollback strategies, and etcd upgrades."
more_link: "yes"
url: "/kubernetes-cluster-upgrades-zero-downtime-strategies-enterprise-guide/"
---

Upgrading a production Kubernetes cluster is one of the highest-risk routine operations for a platform team. A poorly planned upgrade can cause workload disruptions, API incompatibilities, and networking outages that affect hundreds of services. A well-planned upgrade using Kubernetes' built-in machinery — version skew policies, PodDisruptionBudgets, rolling drain procedures — can complete with zero application downtime.

This guide covers the complete upgrade lifecycle from pre-upgrade validation through post-upgrade verification, with production-proven procedures for both managed (EKS, GKE, AKS) and self-managed clusters.

<!--more-->

# Kubernetes Cluster Upgrades: Zero-Downtime Strategies

## Section 1: Version Skew Policy

### Understanding Version Skew

Kubernetes enforces strict version compatibility rules between components. Violating these rules can cause API failures, authentication breakdowns, or silent data corruption.

**kube-apiserver to kubelet skew**: The kubelet must not be more than two minor versions older than the kube-apiserver. The kubelet can never be newer than the kube-apiserver.

```
kube-apiserver: 1.29
kubelet: 1.27 (allowed, 2 minor versions behind)
kubelet: 1.26 (NOT allowed, 3 minor versions behind)
kubelet: 1.30 (NOT allowed, newer than apiserver)
```

**kube-controller-manager and kube-scheduler**: Must be the same minor version as kube-apiserver or one minor version older.

**kubectl**: Can be one minor version newer or older than kube-apiserver.

**kube-proxy**: Must match the kubelet version on the same node.

### Required Upgrade Order

For a cluster running 1.28 being upgraded to 1.29:

1. etcd (upgrade independently or as part of control plane)
2. kube-apiserver (all control plane nodes)
3. kube-controller-manager
4. kube-scheduler
5. cloud-controller-manager (if applicable)
6. kube-proxy (on each node)
7. kubelet (on each node)
8. kubectl (workstations and CI/CD systems)

For multi-control-plane clusters, upgrade control plane nodes one at a time. The cluster remains functional while individual control plane nodes are upgraded because the others continue serving requests.

### Pre-Upgrade Version Check

```bash
# Check current versions
kubectl version --short
# Client Version: v1.28.5
# Kube-Proxy Version: v1.28.5
# Server Version: v1.28.5

# Check node versions
kubectl get nodes -o custom-columns='NODE:.metadata.name,VERSION:.status.nodeInfo.kubeletVersion'
# NODE              VERSION
# control-plane-1   v1.28.5
# control-plane-2   v1.28.5
# control-plane-3   v1.28.5
# worker-1          v1.28.5
# worker-2          v1.28.5

# Check etcd version
kubectl -n kube-system exec -it etcd-control-plane-1 -- \
  etcd --version 2>/dev/null | head -1
# etcd Version: 3.5.9

# Verify all components healthy before upgrade
kubectl get componentstatuses
# NAME                 STATUS    MESSAGE              ERROR
# controller-manager   Healthy   ok
# scheduler            Healthy   ok
# etcd-0               Healthy   {"health":"true","reason":""}
```

## Section 2: Pre-Upgrade Checklist and Preparation

### API Deprecation Check

Each Kubernetes version removes deprecated APIs. Check your workloads before upgrading:

```bash
# Install pluto — deprecation checker
wget https://github.com/FairwindsOps/pluto/releases/latest/download/pluto_linux_amd64.tar.gz
tar xzf pluto_linux_amd64.tar.gz

# Check live cluster resources
./pluto detect-all-in-cluster --target-versions k8s=v1.29.0

# Example output:
# NAME                         NAMESPACE   KIND                      VERSION          REPLACEMENT   REMOVED   DEPRECATED
# my-ingress                   production  Ingress                   networking.k8s.io/v1beta1  networking.k8s.io/v1  true      true

# Check Helm releases
./pluto detect-helm --target-versions k8s=v1.29.0

# Check local manifest files
./pluto detect-files -d ./kubernetes/ --target-versions k8s=v1.29.0
```

### Backup etcd Before Upgrading

```bash
# Backup etcd (run on control plane node)
ETCD_DATA_DIR=/var/lib/etcd
BACKUP_DIR=/backup/etcd-$(date +%Y%m%d-%H%M%S)

mkdir -p $BACKUP_DIR

# For etcd running as a static pod
ETCDCTL_API=3 etcdctl snapshot save $BACKUP_DIR/snapshot.db \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key

# Verify the backup
ETCDCTL_API=3 etcdctl snapshot status $BACKUP_DIR/snapshot.db --write-out=table
# +----------+----------+------------+------------+
# |   HASH   | REVISION | TOTAL KEYS | TOTAL SIZE |
# +----------+----------+------------+------------+
# | a1b2c3d4 |   123456 |       1234 |     5.2 MB |
# +----------+----------+------------+------------+

# Copy backup off-cluster
scp -r $BACKUP_DIR backup-server:/etcd-backups/
```

### Verify PodDisruptionBudgets

PodDisruptionBudgets (PDBs) protect workloads during node drains. Verify they are configured correctly before upgrading:

```bash
# List all PDBs
kubectl get pdb -A

# Check PDBs that might block drain operations
kubectl get pdb -A -o json | jq -r '.items[] |
  select(.status.disruptionsAllowed == 0) |
  "\(.metadata.namespace)/\(.metadata.name): disruptionsAllowed=0"'

# Check for misconfigured PDBs (maxUnavailable=0 with single replica)
kubectl get pdb -A -o json | jq -r '.items[] |
  select(.spec.maxUnavailable == 0 or .spec.maxUnavailable == "0") |
  "\(.metadata.namespace)/\(.metadata.name): maxUnavailable=0 — will block drain"'
```

### Test Drain Procedure

Test the drain procedure on a non-critical node before the actual upgrade:

```bash
# Simulate drain without actually evicting pods
kubectl drain worker-test-1 \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --dry-run=client

# Check for pods that will be disrupted
kubectl get pods -A --field-selector spec.nodeName=worker-test-1 \
  -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,CONTROLLED:.metadata.ownerReferences[0].kind'
```

## Section 3: Control Plane Upgrade

### kubeadm-Based Control Plane Upgrade

For clusters managed with kubeadm:

```bash
# On the first control plane node:

# Step 1: Update kubeadm
apt-mark unhold kubeadm
apt-get update
apt-get install -y kubeadm=1.29.5-00
apt-mark hold kubeadm

# Verify the new version
kubeadm version
# kubeadm version: &version.Info{Major:"1", Minor:"29", GitVersion:"v1.29.5"}

# Step 2: Plan the upgrade (shows what will be upgraded)
kubeadm upgrade plan
# COMPONENT                 CURRENT   TARGET
# kube-apiserver            v1.28.5   v1.29.5
# kube-controller-manager   v1.28.5   v1.29.5
# kube-scheduler            v1.28.5   v1.29.5
# kube-proxy                v1.28.5   v1.29.5
# CoreDNS                   v1.10.1   v1.11.1
# etcd                      3.5.9     3.5.12

# Step 3: Apply the upgrade (control plane only)
kubeadm upgrade apply v1.29.5 --yes

# Step 4: Upgrade kubelet and kubectl on this node
apt-mark unhold kubelet kubectl
apt-get install -y kubelet=1.29.5-00 kubectl=1.29.5-00
apt-mark hold kubelet kubectl

systemctl daemon-reload
systemctl restart kubelet

# Verify first control plane node upgraded
kubectl get node control-plane-1
# NAME              STATUS   ROLES           AGE   VERSION
# control-plane-1   Ready    control-plane   60d   v1.29.5
```

### Upgrading Additional Control Plane Nodes

```bash
# For each additional control plane node (run on that node):

# Step 1: Drain the node (from another node)
kubectl cordon control-plane-2
kubectl drain control-plane-2 \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --timeout=300s

# Step 2: Upgrade kubeadm
apt-mark unhold kubeadm
apt-get install -y kubeadm=1.29.5-00
apt-mark hold kubeadm

# Step 3: Upgrade the node (not apply — only for first node)
kubeadm upgrade node

# Step 4: Upgrade kubelet and kubectl
apt-mark unhold kubelet kubectl
apt-get install -y kubelet=1.29.5-00 kubectl=1.29.5-00
apt-mark hold kubelet kubectl

systemctl daemon-reload
systemctl restart kubelet

# Step 5: Uncordon the node
kubectl uncordon control-plane-2

# Verify the node is Ready and schedulable
kubectl get node control-plane-2
# NAME              STATUS   ROLES           AGE   VERSION
# control-plane-2   Ready    control-plane   60d   v1.29.5

# Wait for API server on this node to become healthy before proceeding
kubectl -n kube-system wait pod \
  -l component=kube-apiserver \
  --for=condition=Ready \
  --timeout=120s
```

### Monitoring Control Plane During Upgrade

```bash
# Watch control plane component health in real-time
watch -n2 'kubectl get pods -n kube-system -l tier=control-plane -o wide'

# Check API server availability from each node
for node in control-plane-1 control-plane-2 control-plane-3; do
  echo -n "$node: "
  kubectl -n kube-system exec -it $(kubectl -n kube-system get pod \
    -l component=kube-apiserver \
    --field-selector spec.nodeName=$node \
    -o name | head -1) \
    -- wget -qO- http://localhost:8080/healthz 2>/dev/null || echo "unhealthy"
done

# Monitor etcd cluster health
ETCDCTL_API=3 etcdctl endpoint health \
  --endpoints=https://control-plane-1:2379,https://control-plane-2:2379,https://control-plane-3:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/peer.crt \
  --key=/etc/kubernetes/pki/etcd/peer.key
```

## Section 4: Worker Node Upgrade

### Rolling Node Upgrade Strategy

Worker nodes must be upgraded one at a time (or in small batches) to maintain application availability. The target is draining a node, upgrading it, verifying it, then moving to the next.

```bash
#!/bin/bash
# rolling-node-upgrade.sh

set -euo pipefail

NODES=$(kubectl get nodes -l node-role.kubernetes.io/control-plane!="" \
  -o name | grep -v control-plane)
DRAIN_TIMEOUT=300
READY_TIMEOUT=300
NEW_VERSION="1.29.5-00"

for node in $NODES; do
    NODE_NAME=$(echo "$node" | cut -d/ -f2)
    echo "=== Upgrading node: $NODE_NAME ==="

    # Step 1: Cordon the node
    echo "Cordoning $NODE_NAME..."
    kubectl cordon "$NODE_NAME"

    # Step 2: Drain the node
    echo "Draining $NODE_NAME..."
    kubectl drain "$NODE_NAME" \
        --ignore-daemonsets \
        --delete-emptydir-data \
        --timeout="${DRAIN_TIMEOUT}s" \
        --force=false  # never force — respect PDBs

    # Step 3: SSH to node and upgrade
    echo "Upgrading kubelet on $NODE_NAME..."
    ssh "$NODE_NAME" "
        set -e
        apt-mark unhold kubeadm kubelet kubectl
        apt-get update -qq
        apt-get install -y kubeadm=${NEW_VERSION} kubelet=${NEW_VERSION} kubectl=${NEW_VERSION}
        apt-mark hold kubeadm kubelet kubectl
        kubeadm upgrade node
        systemctl daemon-reload
        systemctl restart kubelet
    "

    # Step 4: Uncordon
    echo "Uncordoning $NODE_NAME..."
    kubectl uncordon "$NODE_NAME"

    # Step 5: Wait for node to become Ready
    echo "Waiting for $NODE_NAME to be Ready..."
    kubectl wait node "$NODE_NAME" \
        --for=condition=Ready \
        --timeout="${READY_TIMEOUT}s"

    # Step 6: Verify node version
    ACTUAL_VERSION=$(kubectl get node "$NODE_NAME" \
        -o jsonpath='{.status.nodeInfo.kubeletVersion}')
    echo "Node $NODE_NAME upgraded to: $ACTUAL_VERSION"

    # Step 7: Brief stabilization pause before next node
    echo "Waiting 30s before next node..."
    sleep 30

    echo "=== $NODE_NAME upgrade complete ==="
    echo ""
done

echo "All worker nodes upgraded successfully"
```

### Node Drain with PodDisruptionBudget Awareness

```bash
# Drain with PDB awareness — will wait up to 5 minutes for PDB to allow eviction
kubectl drain worker-1 \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --timeout=300s \
  --disable-eviction=false  # default: respects PDBs via eviction API

# If a PDB is blocking drain, check which pods are affected
kubectl get pdb -A -o json | jq -r '.items[] |
  select(.status.disruptionsAllowed == 0) |
  "\(.metadata.namespace)/\(.metadata.name)"'

# Temporarily increase maxUnavailable if PDB is too restrictive
# (coordinate with application team first)
kubectl patch pdb my-app-pdb -n production \
  -p '{"spec":{"maxUnavailable":1}}'

# After upgrade, restore original PDB
kubectl patch pdb my-app-pdb -n production \
  -p '{"spec":{"maxUnavailable":0}}'
```

### Handling Stateful Workloads During Drain

StatefulSets with PDBs require special care:

```yaml
# Ensure StatefulSets have PDBs allowing at least 1 disruption
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: kafka-pdb
  namespace: production
spec:
  selector:
    matchLabels:
      app: kafka
  # Allow 1 of 3 pods to be disrupted at a time
  maxUnavailable: 1
  # This allows drain to proceed while maintaining quorum
```

```bash
# For Kafka: ensure partition reassignment completes before drain
kubectl exec -n production kafka-0 -- \
  kafka-topics.sh --bootstrap-server kafka:9092 \
  --describe --under-replicated-partitions

# Only proceed with drain when output is empty (no under-replicated partitions)
```

## Section 5: PodDisruptionBudgets During Upgrades

### Designing PDBs for Upgrade Safety

A well-designed PDB protects applications during upgrades without blocking the upgrade process:

```yaml
# For a stateless deployment with 5 replicas:
# Allow up to 20% disruption (1 pod at a time)
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-server-pdb
  namespace: production
spec:
  selector:
    matchLabels:
      app: api-server
  maxUnavailable: 1  # or "20%"

# For a critical database with 3 replicas:
# Maintain minimum 2 replicas at all times (quorum)
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: database-pdb
  namespace: production
spec:
  selector:
    matchLabels:
      app: postgres
  minAvailable: 2
```

### Common PDB Mistakes That Block Upgrades

**Mistake 1: maxUnavailable=0 with minAvailable=total replicas**

```yaml
# This blocks ALL drains regardless of replica count
spec:
  minAvailable: 3
  # And Deployment has replicas: 3
  # Result: drain hangs forever
```

**Mistake 2: PDB selector matches more pods than exist**

```bash
# Check for PDBs blocking upgrades
kubectl get pdb -A -o json | jq -r '
  .items[] |
  select(.status.expectedPods > 0 and .status.disruptionsAllowed == 0) |
  "\(.metadata.namespace)/\(.metadata.name): " +
  "expected=\(.status.expectedPods) " +
  "healthy=\(.status.currentHealthy) " +
  "allowed=\(.status.disruptionsAllowed)"
'
```

**Mistake 3: PDB on single-replica deployments**

```bash
# Find single-replica deployments with PDBs that disallow any disruption
kubectl get pdb -A -o json | jq -r '.items[] |
  "\(.metadata.namespace)/\(.metadata.name)" +
  " minAvailable=\(.spec.minAvailable // "nil")" +
  " maxUnavailable=\(.spec.maxUnavailable // "nil")"' | \
  grep "maxUnavailable=0\|minAvailable=1"
```

### PDB Validation Script

```bash
#!/bin/bash
# validate-pdbs.sh — run before cluster upgrade

echo "Checking PodDisruptionBudgets..."

BLOCKING=$(kubectl get pdb -A -o json | jq -r '
  .items[] |
  select(
    (.spec.maxUnavailable == 0 or .spec.maxUnavailable == "0") and
    (.status.expectedPods > 0)
  ) |
  "\(.metadata.namespace)/\(.metadata.name)"
')

if [ -n "$BLOCKING" ]; then
  echo "WARNING: The following PDBs have maxUnavailable=0 and may block node drains:"
  echo "$BLOCKING"
  echo ""
  echo "Consider temporarily setting maxUnavailable=1 for these PDBs during the upgrade."
else
  echo "OK: No blocking PDBs found"
fi

# Check for PDBs where disruptionsAllowed is already 0 (workload is unhealthy)
UNHEALTHY=$(kubectl get pdb -A -o json | jq -r '
  .items[] |
  select(.status.disruptionsAllowed == 0 and .status.expectedPods > 0) |
  "\(.metadata.namespace)/\(.metadata.name): expectedPods=\(.status.expectedPods) currentHealthy=\(.status.currentHealthy)"
')

if [ -n "$UNHEALTHY" ]; then
  echo ""
  echo "WARNING: The following PDBs currently allow 0 disruptions (workload may be unhealthy):"
  echo "$UNHEALTHY"
fi
```

## Section 6: etcd Upgrade Procedures

### etcd Version Compatibility

etcd version compatibility with Kubernetes:

| Kubernetes | etcd Version |
|---|---|
| 1.28 | 3.5.x |
| 1.29 | 3.5.x |
| 1.30 | 3.5.x |
| 1.31 | 3.5.x |

kubeadm upgrades etcd automatically. For external etcd clusters, upgrade manually:

### Upgrading External etcd

```bash
#!/bin/bash
# upgrade-etcd-member.sh — upgrade one etcd member at a time

ETCD_VERSION="3.5.12"
ETCD_MEMBER="etcd-1"
ETCD_DATA_DIR="/var/lib/etcd"

# Step 1: Verify cluster health before upgrade
ETCDCTL_API=3 etcdctl endpoint health \
  --endpoints=https://etcd-1:2379,https://etcd-2:2379,https://etcd-3:2379 \
  --cacert=/etc/etcd/pki/ca.crt \
  --cert=/etc/etcd/pki/peer.crt \
  --key=/etc/etcd/pki/peer.key

# Step 2: Identify the leader
ETCDCTL_API=3 etcdctl endpoint status \
  --endpoints=https://etcd-1:2379,https://etcd-2:2379,https://etcd-3:2379 \
  --cacert=/etc/etcd/pki/ca.crt \
  --cert=/etc/etcd/pki/peer.crt \
  --key=/etc/etcd/pki/peer.key \
  --write-out=table

# Step 3: Backup before upgrade
ETCDCTL_API=3 etcdctl snapshot save /backup/etcd-pre-upgrade-$(date +%Y%m%d).db \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/etcd/pki/ca.crt \
  --cert=/etc/etcd/pki/server.crt \
  --key=/etc/etcd/pki/server.key

# Step 4: Stop etcd on this member
systemctl stop etcd

# Step 5: Download and install new etcd binary
curl -sL "https://github.com/etcd-io/etcd/releases/download/v${ETCD_VERSION}/etcd-v${ETCD_VERSION}-linux-amd64.tar.gz" \
  | tar xz -C /tmp/
cp /tmp/etcd-v${ETCD_VERSION}-linux-amd64/etcd /usr/local/bin/etcd
cp /tmp/etcd-v${ETCD_VERSION}-linux-amd64/etcdctl /usr/local/bin/etcdctl

# Step 6: Start etcd
systemctl start etcd

# Step 7: Verify member rejoined cluster
sleep 10
ETCDCTL_API=3 etcdctl endpoint health \
  --endpoints=https://etcd-1:2379,https://etcd-2:2379,https://etcd-3:2379 \
  --cacert=/etc/etcd/pki/ca.crt \
  --cert=/etc/etcd/pki/peer.crt \
  --key=/etc/etcd/pki/peer.key

echo "etcd member upgraded to v${ETCD_VERSION}"
```

### etcd Defragmentation After Upgrade

```bash
# Defragment etcd after version upgrade to reclaim space
# Run on each member sequentially (never simultaneously)

for endpoint in etcd-1:2379 etcd-2:2379 etcd-3:2379; do
  echo "Defragmenting $endpoint..."
  ETCDCTL_API=3 etcdctl defrag \
    --endpoints=https://$endpoint \
    --cacert=/etc/etcd/pki/ca.crt \
    --cert=/etc/etcd/pki/peer.crt \
    --key=/etc/etcd/pki/peer.key

  echo "Defragmentation of $endpoint complete"
  sleep 5
done

# Check db size after defragmentation
ETCDCTL_API=3 etcdctl endpoint status \
  --endpoints=https://etcd-1:2379,https://etcd-2:2379,https://etcd-3:2379 \
  --cacert=/etc/etcd/pki/ca.crt \
  --cert=/etc/etcd/pki/peer.crt \
  --key=/etc/etcd/pki/peer.key \
  --write-out=table
```

## Section 7: Rollback Procedures

### Rolling Back a Failed Control Plane Upgrade

```bash
# If kubeadm upgrade apply fails partway through:

# Option 1: Fix and retry (preferred when possible)
# kubeadm upgrade apply v1.29.5 --yes

# Option 2: Rollback kubelet and kubectl (kubeadm does not support rollback)
# You must restore from etcd backup if the upgrade corrupted cluster state

# Restore etcd from backup
systemctl stop kube-apiserver kube-controller-manager kube-scheduler

# Restore etcd snapshot
ETCDCTL_API=3 etcdctl snapshot restore \
  /backup/etcd-pre-upgrade-20290412.db \
  --data-dir=/var/lib/etcd-restore \
  --name=control-plane-1 \
  --initial-cluster="control-plane-1=https://192.168.1.1:2380,control-plane-2=https://192.168.1.2:2380,control-plane-3=https://192.168.1.3:2380" \
  --initial-cluster-token=etcd-cluster-1 \
  --initial-advertise-peer-urls=https://192.168.1.1:2380

# Replace data directory
mv /var/lib/etcd /var/lib/etcd-broken
mv /var/lib/etcd-restore /var/lib/etcd

# Downgrade kubelet and kubectl
apt-get install -y kubelet=1.28.5-00 kubectl=1.28.5-00

systemctl daemon-reload
systemctl restart kubelet

# Restart control plane components
systemctl start kube-apiserver kube-controller-manager kube-scheduler
```

### Rolling Back Worker Nodes

```bash
# If a worker node upgrade fails:

# Step 1: Cordon the node (prevents new pods from scheduling)
kubectl cordon worker-failed-1

# Step 2: Downgrade kubelet on the node
ssh worker-failed-1 "
  apt-get install -y kubelet=1.28.5-00
  systemctl daemon-reload
  systemctl restart kubelet
"

# Step 3: Verify node is Ready with old version
kubectl get node worker-failed-1

# Step 4: Uncordon once verified
kubectl uncordon worker-failed-1
```

## Section 8: Managed Cluster Upgrade Procedures

### AWS EKS Zero-Downtime Upgrade

```bash
# Step 1: Update EKS control plane
aws eks update-cluster-version \
  --name production-cluster \
  --kubernetes-version 1.29 \
  --region us-east-1

# Wait for control plane upgrade to complete
aws eks wait cluster-active \
  --name production-cluster \
  --region us-east-1

# Step 2: Update managed node group
aws eks update-nodegroup-version \
  --cluster-name production-cluster \
  --nodegroup-name workers \
  --kubernetes-version 1.29 \
  --region us-east-1

# Monitor node group update
aws eks describe-nodegroup \
  --cluster-name production-cluster \
  --nodegroup-name workers \
  --region us-east-1 \
  --query 'nodegroup.status'

# Step 3: Update add-ons
for addon in kube-proxy vpc-cni coredns; do
  LATEST=$(aws eks describe-addon-versions \
    --kubernetes-version 1.29 \
    --addon-name $addon \
    --region us-east-1 \
    --query 'addons[0].addonVersions[0].addonVersion' \
    --output text)

  aws eks update-addon \
    --cluster-name production-cluster \
    --addon-name $addon \
    --addon-version $LATEST \
    --region us-east-1
done
```

### GKE Upgrade with Surge Upgrades

```bash
# Configure surge upgrades for minimal disruption
gcloud container node-pools update workers \
  --cluster=production-cluster \
  --zone=us-central1-a \
  --max-surge-upgrade=1 \
  --max-unavailable-upgrade=0

# Upgrade the control plane
gcloud container clusters upgrade production-cluster \
  --zone=us-central1-a \
  --master \
  --cluster-version=1.29.5-gke.1000

# Upgrade node pool
gcloud container clusters upgrade production-cluster \
  --zone=us-central1-a \
  --node-pool=workers \
  --cluster-version=1.29.5-gke.1000
```

## Section 9: Post-Upgrade Verification

### Comprehensive Post-Upgrade Checks

```bash
#!/bin/bash
# post-upgrade-verify.sh

echo "=== Post-Upgrade Verification ==="
echo ""

# 1. Verify all nodes are Ready and on new version
echo "1. Node versions:"
kubectl get nodes -o custom-columns='NODE:.metadata.name,VERSION:.status.nodeInfo.kubeletVersion,STATUS:.status.conditions[-1].type'
echo ""

# 2. Verify all system pods are running
echo "2. System pods:"
kubectl get pods -n kube-system -o wide | grep -v Running
echo ""

# 3. Verify API server endpoints
echo "3. API server health:"
kubectl get --raw /healthz
echo ""

# 4. Verify etcd health
echo "4. etcd health:"
kubectl -n kube-system exec -it \
  $(kubectl -n kube-system get pod -l component=etcd -o name | head -1) \
  -- etcdctl endpoint health \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
  --key=/etc/kubernetes/pki/etcd/healthcheck-client.key
echo ""

# 5. Check for evicted or failed pods
echo "5. Failed/evicted pods:"
kubectl get pods -A --field-selector=status.phase=Failed
kubectl get pods -A | grep Evicted
echo ""

# 6. Verify DNS
echo "6. DNS resolution:"
kubectl run dns-test --rm -it \
  --image=busybox:1.35 \
  --restart=Never \
  -- nslookup kubernetes.default 2>/dev/null
echo ""

# 7. Check PVs and PVCs
echo "7. Storage status:"
kubectl get pv -o custom-columns='NAME:.metadata.name,STATUS:.status.phase,CLAIM:.spec.claimRef.name'
kubectl get pvc -A | grep -v Bound
echo ""

# 8. Verify workload health
echo "8. Deployment rollout status:"
kubectl get deployments -A -o json | jq -r '
  .items[] |
  select(.status.unavailableReplicas > 0) |
  "\(.metadata.namespace)/\(.metadata.name): unavailable=\(.status.unavailableReplicas)"
'

echo "=== Verification Complete ==="
```

## Summary

Zero-downtime Kubernetes upgrades require systematic preparation and disciplined execution:

- Follow version skew policy strictly: upgrade control plane before workers, never skip minor versions
- Back up etcd immediately before any control plane upgrade — this is your recovery path
- Run deprecation checks with pluto before upgrading to find API removals early
- Validate PodDisruptionBudgets allow at least one disruption per workload, or drain will hang
- Upgrade control plane nodes one at a time, verifying health between each
- Use the rolling drain script to upgrade worker nodes with automatic verification
- For managed clusters (EKS, GKE, AKS), use surge upgrades to ensure zero-downtime node replacement
- Execute the post-upgrade verification script to confirm cluster health before declaring success
