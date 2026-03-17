---
title: "Kubernetes Cluster Upgrade Strategies: Zero-Downtime Procedures"
date: 2028-03-13T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cluster Upgrade", "kubeadm", "EKS", "GKE", "AKS", "Zero Downtime"]
categories: ["Kubernetes", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes cluster upgrade strategies covering version skew policy, control plane upgrade sequence, node upgrade procedures, PodDisruptionBudget verification, kubeadm workflow, and managed cluster upgrade procedures for EKS, GKE, and AKS."
more_link: "yes"
url: "/kubernetes-cluster-upgrade-strategies-guide-advanced/"
---

Kubernetes cluster upgrades are among the highest-risk operational tasks for platform teams. A poorly sequenced upgrade can cause API compatibility breaks, drain-induced outages, and etcd data loss. A well-planned upgrade, supported by automation and pre-upgrade validation, completes invisibly to application teams. This guide covers the full upgrade lifecycle from pre-upgrade assessment through rollback planning for both kubeadm-managed and managed cloud Kubernetes services.

<!--more-->

## Version Skew Policy

Kubernetes enforces a strict version skew policy between components:

| Component Pair | Maximum Skew | Notes |
|---|---|---|
| kube-apiserver vs kube-controller-manager | ±1 minor | Must upgrade apiserver first |
| kube-apiserver vs kube-scheduler | ±1 minor | Must upgrade apiserver first |
| kube-apiserver vs kubelet | -2 minor | Kubelet can be 2 minors behind apiserver |
| kube-apiserver vs kube-proxy | -2 minor | kube-proxy can be 2 minors behind |
| kubectl vs kube-apiserver | ±1 minor | kubectl should stay current |

**Critical implication**: You can only upgrade one minor version at a time (1.28 → 1.29, not 1.28 → 1.30) unless skipping versions is explicitly tested. Plan multi-step upgrades for clusters more than one minor version behind.

### Version Matrix Verification

Before upgrading, verify current versions of all components:

```bash
#!/bin/bash
# pre-upgrade-version-check.sh

echo "=== Kubernetes Component Versions ==="
kubectl version --output=json | jq '{
  clientVersion: .clientVersion.gitVersion,
  serverVersion: .serverVersion.gitVersion
}'

echo ""
echo "=== Node Versions ==="
kubectl get nodes -o custom-columns=\
  NAME:.metadata.name,\
  VERSION:.status.nodeInfo.kubeletVersion,\
  CONTAINER-RUNTIME:.status.nodeInfo.containerRuntimeVersion,\
  OS:.status.nodeInfo.osImage | sort

echo ""
echo "=== Control Plane Component Versions ==="
kubectl get pods -n kube-system -o json | \
  jq -r '
    .items[] |
    select(.metadata.name | test("etcd|apiserver|controller-manager|scheduler")) |
    "\(.metadata.name): \(.spec.containers[0].image)"
  '

echo ""
echo "=== Add-on Versions ==="
kubectl get deployment coredns -n kube-system \
  -o jsonpath='{.spec.template.spec.containers[0].image}'
echo ""
kubectl get daemonset kube-proxy -n kube-system \
  -o jsonpath='{.spec.template.spec.containers[0].image}'
echo ""
```

## Pre-Upgrade Checklist

### API Deprecation Scan

Check for deprecated or removed API usage before upgrading:

```bash
# Install Pluto (API deprecation scanner)
helm repo add fairwinds-stable https://charts.fairwinds.com/stable
helm install pluto fairwinds-stable/pluto \
  --namespace pluto \
  --create-namespace

# Scan the cluster for deprecated APIs
pluto detect-all-in-cluster --target-versions k8s=v1.29.0

# Scan Helm releases for deprecated APIs
pluto detect-helm --target-versions k8s=v1.29.0

# Scan local manifests
pluto detect-files -d ./k8s/ --target-versions k8s=v1.29.0
```

Example output requiring remediation:

```
NAME                          NAMESPACE       KIND                          VERSION     REPLACEMENT                        DEPRECATED   REMOVED
ingress-nginx/ingress-nginx   ingress-nginx   PodSecurityPolicy             policy/v1b  N/A                               true         true
cert-manager                  cert-manager    MutatingWebhookConfiguration  v1beta1     admissionregistration.k8s.io/v1   true         false
```

### PodDisruptionBudget Verification

Verify all stateful workloads have PDBs before any drain operation:

```bash
#!/bin/bash
# verify-pdbs.sh
# Reports Deployments/StatefulSets with replicas > 1 but no PDB

NAMESPACE=${1:---all-namespaces}

echo "Checking for workloads missing PodDisruptionBudgets..."
echo ""

# Get all PDB target selectors
PDBS=$(kubectl get pdb ${NAMESPACE} -o json | \
  jq -r '
    .items[] |
    .metadata.namespace + "/" + (
      .spec.selector.matchLabels |
      to_entries |
      map("\(.key)=\(.value)") |
      join(",")
    )
  ')

# Check Deployments with 2+ replicas
kubectl get deployments ${NAMESPACE} -o json | \
  jq -r '
    .items[] |
    select(.spec.replicas >= 2) |
    .metadata.namespace + "/" + .metadata.name + " (replicas: " + (.spec.replicas | tostring) + ")"
  ' | while read -r workload; do
  NS=$(echo "${workload}" | cut -d/ -f1)
  NAME=$(echo "${workload}" | cut -d/ -f2 | cut -d' ' -f1)

  # Check if any PDB covers pods from this deployment
  LABELS=$(kubectl get deployment "${NAME}" -n "${NS}" \
    -o jsonpath='{.spec.selector.matchLabels}' | \
    jq -r 'to_entries | map("\(.key)=\(.value)") | join(",")')

  PDB_COUNT=$(kubectl get pdb -n "${NS}" \
    --selector="${LABELS}" \
    --no-headers 2>/dev/null | wc -l)

  if [ "${PDB_COUNT}" -eq 0 ]; then
    echo "WARNING: No PDB for ${NS}/${NAME}"
  fi
done

echo ""
echo "PDB verification complete."
```

### Workload Health Check

```bash
#!/bin/bash
# pre-upgrade-health-check.sh

echo "=== Pod Status Summary ==="
kubectl get pods --all-namespaces | \
  grep -v "Running\|Completed\|Succeeded" | \
  grep -v "NAME"

echo ""
echo "=== Nodes Not Ready ==="
kubectl get nodes | grep -v "Ready"

echo ""
echo "=== PVC Pending ==="
kubectl get pvc --all-namespaces | grep -v "Bound"

echo ""
echo "=== ReplicaSets with Unavailable Replicas ==="
kubectl get replicasets --all-namespaces -o json | \
  jq -r '
    .items[] |
    select(.status.availableReplicas < .spec.replicas) |
    "\(.metadata.namespace)/\(.metadata.name): available=\(.status.availableReplicas) desired=\(.spec.replicas)"
  '
```

## Control Plane Upgrade Sequence

The correct upgrade order for control plane components:

1. etcd (if upgrading separately)
2. kube-apiserver
3. kube-controller-manager
4. kube-scheduler
5. cloud-controller-manager (if applicable)
6. CoreDNS
7. kube-proxy

**Each step must complete and be verified healthy before proceeding to the next.**

### kubeadm Upgrade Plan

```bash
# On the first control plane node

# Step 1: Upgrade kubeadm itself
sudo apt-get update
sudo apt-get install -y kubeadm=1.29.3-1.1

# Step 2: Review the upgrade plan
sudo kubeadm upgrade plan v1.29.3

# Example output:
# Components that must be upgraded manually after you have upgraded the control plane with 'kubeadm upgrade apply':
# COMPONENT   CURRENT    TARGET
# kubelet     1.28.8     1.29.3
#
# Upgrade to the latest stable version:
# COMPONENT                 CURRENT    TARGET
# kube-apiserver            v1.28.8    v1.29.3
# kube-controller-manager   v1.28.8    v1.29.3
# kube-scheduler            v1.28.8    v1.29.3
# kube-proxy                v1.28.8    v1.29.3
# CoreDNS                   v1.10.1    v1.11.1
# etcd                      3.5.9      3.5.12

# Step 3: Apply the upgrade (first control plane node only)
sudo kubeadm upgrade apply v1.29.3 --yes

# Step 4: Verify control plane is healthy after upgrade
kubectl get componentstatuses 2>/dev/null || \
  kubectl get pods -n kube-system | grep -E "apiserver|controller|scheduler|etcd"

# Step 5: Upgrade kubelet and kubectl on the control plane node
sudo apt-get install -y kubelet=1.29.3-1.1 kubectl=1.29.3-1.1
sudo systemctl daemon-reload
sudo systemctl restart kubelet

# Verify kubelet version
kubectl get node $(hostname) -o jsonpath='{.status.nodeInfo.kubeletVersion}'
```

### Additional Control Plane Nodes

For HA control planes (3+ control plane nodes), upgrade them sequentially:

```bash
# On each additional control plane node (NOT the first one)
sudo apt-get install -y kubeadm=1.29.3-1.1
sudo kubeadm upgrade node  # NOT 'upgrade apply' — that's only for the first node

sudo apt-get install -y kubelet=1.29.3-1.1 kubectl=1.29.3-1.1
sudo systemctl daemon-reload
sudo systemctl restart kubelet
```

### etcd Upgrade (If Separate from kubeadm)

```bash
# Backup etcd BEFORE any upgrade
ETCDCTL_API=3 etcdctl snapshot save \
  /backup/etcd-snapshot-$(date +%Y%m%d%H%M%S).db \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key

# Verify snapshot integrity
ETCDCTL_API=3 etcdctl snapshot status \
  /backup/etcd-snapshot-*.db \
  --write-out=table
```

## Node Upgrade Strategy: Cordon, Drain, Upgrade, Uncordon

### Standard Node Upgrade Procedure

```bash
#!/bin/bash
# upgrade-node.sh
# Usage: ./upgrade-node.sh <node-name> <new-kubelet-version>

NODE_NAME=${1}
NEW_VERSION=${2:-1.29.3-1.1}
DRAIN_TIMEOUT=${3:-300s}

set -euo pipefail

echo "Starting upgrade of node: ${NODE_NAME}"

# Step 1: Cordon the node
echo "Cordoning ${NODE_NAME}..."
kubectl cordon "${NODE_NAME}"

# Step 2: Wait for existing pods to stabilize
sleep 5

# Step 3: Drain the node
echo "Draining ${NODE_NAME}..."
kubectl drain "${NODE_NAME}" \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --grace-period=60 \
  --timeout="${DRAIN_TIMEOUT}" \
  --force=false  # Do not force-delete pods without a controller

# Step 4: Upgrade kubelet on the node (via SSH or node provisioning tool)
echo "Upgrading kubelet on ${NODE_NAME}..."
ssh "ubuntu@${NODE_NAME}" <<EOF
  set -euo pipefail
  sudo kubeadm upgrade node
  sudo apt-get update
  sudo apt-get install -y kubelet=${NEW_VERSION} kubectl=${NEW_VERSION}
  sudo systemctl daemon-reload
  sudo systemctl restart kubelet
  sudo systemctl status kubelet --no-pager
EOF

# Step 5: Wait for node to become Ready
echo "Waiting for ${NODE_NAME} to become Ready..."
kubectl wait node "${NODE_NAME}" \
  --for=condition=Ready \
  --timeout=300s

# Step 6: Verify kubelet version
ACTUAL_VERSION=$(kubectl get node "${NODE_NAME}" \
  -o jsonpath='{.status.nodeInfo.kubeletVersion}')
echo "Kubelet version on ${NODE_NAME}: ${ACTUAL_VERSION}"

# Step 7: Uncordon
echo "Uncordoning ${NODE_NAME}..."
kubectl uncordon "${NODE_NAME}"

echo "Node ${NODE_NAME} upgrade complete."
```

### Batch Node Upgrade with Rate Control

```bash
#!/bin/bash
# batch-upgrade-nodes.sh
# Upgrades worker nodes in batches, verifying cluster health between batches

NEW_VERSION=${1:-1.29.3-1.1}
BATCH_SIZE=${2:-2}  # Number of nodes to upgrade concurrently
BATCH_PAUSE=${3:-120}  # Seconds to pause between batches

# Get all worker nodes (exclude control plane)
WORKER_NODES=$(kubectl get nodes \
  --selector='!node-role.kubernetes.io/control-plane' \
  -o jsonpath='{.items[*].metadata.name}')

read -ra NODE_ARRAY <<< "${WORKER_NODES}"
TOTAL=${#NODE_ARRAY[@]}
BATCHES=$(( (TOTAL + BATCH_SIZE - 1) / BATCH_SIZE ))

echo "Upgrading ${TOTAL} nodes in ${BATCHES} batches of ${BATCH_SIZE}"

for ((batch=0; batch<BATCHES; batch++)); do
  START=$((batch * BATCH_SIZE))
  END=$(( START + BATCH_SIZE ))
  BATCH_NODES=("${NODE_ARRAY[@]:${START}:${BATCH_SIZE}}")

  echo ""
  echo "=== Batch $((batch + 1))/${BATCHES}: ${BATCH_NODES[*]} ==="

  # Upgrade nodes in this batch sequentially (parallel is riskier)
  for node in "${BATCH_NODES[@]}"; do
    ./upgrade-node.sh "${node}" "${NEW_VERSION}" &
    BATCH_PIDS+=($!)
  done

  # Wait for all nodes in batch to complete
  for pid in "${BATCH_PIDS[@]:-}"; do
    wait "${pid}" || {
      echo "ERROR: Node upgrade failed (pid ${pid})"
      exit 1
    }
  done
  unset BATCH_PIDS

  # Cluster health check between batches
  echo "Verifying cluster health after batch $((batch + 1))..."

  UNHEALTHY=$(kubectl get nodes --no-headers | \
    grep -cv "Ready\s")
  if [ "${UNHEALTHY}" -gt 0 ]; then
    echo "ERROR: ${UNHEALTHY} nodes are not Ready after batch upgrade"
    kubectl get nodes
    exit 1
  fi

  PENDING_PODS=$(kubectl get pods --all-namespaces \
    --field-selector=status.phase=Pending \
    --no-headers | wc -l)
  if [ "${PENDING_PODS}" -gt 10 ]; then
    echo "WARNING: ${PENDING_PODS} pods are Pending — investigating before continuing"
    kubectl get pods --all-namespaces --field-selector=status.phase=Pending
    read -p "Continue anyway? (yes/no): " CONFIRM
    [ "${CONFIRM}" = "yes" ] || exit 1
  fi

  if [ $((batch + 1)) -lt "${BATCHES}" ]; then
    echo "Pausing ${BATCH_PAUSE}s before next batch..."
    sleep "${BATCH_PAUSE}"
  fi
done

echo ""
echo "All nodes upgraded successfully."
kubectl get nodes
```

## Managed Cluster Upgrade Procedures

### AWS EKS

```bash
# Step 1: Check available upgrade paths
aws eks describe-addon-versions \
  --kubernetes-version 1.29 \
  --query 'addons[].addonName' \
  --output text

# Step 2: Update managed node group (pre-flight check)
aws eks describe-nodegroup \
  --cluster-name prod-cluster \
  --nodegroup-name workers | \
  jq '.nodegroup.releaseVersion'

# Step 3: Update the control plane
aws eks update-cluster-version \
  --name prod-cluster \
  --kubernetes-version 1.29

# Monitor upgrade progress
aws eks describe-update \
  --name prod-cluster \
  --update-id $(aws eks list-updates \
    --name prod-cluster \
    --query 'updateIds[0]' \
    --output text)

# Wait for completion
aws eks wait cluster-active --name prod-cluster

# Step 4: Update managed add-ons
for ADDON in vpc-cni coredns kube-proxy aws-ebs-csi-driver; do
  LATEST=$(aws eks describe-addon-versions \
    --kubernetes-version 1.29 \
    --addon-name "${ADDON}" \
    --query 'addons[0].addonVersions[0].addonVersion' \
    --output text)

  echo "Updating ${ADDON} to ${LATEST}..."
  aws eks update-addon \
    --cluster-name prod-cluster \
    --addon-name "${ADDON}" \
    --addon-version "${LATEST}" \
    --resolve-conflicts OVERWRITE

  aws eks wait addon-active \
    --cluster-name prod-cluster \
    --addon-name "${ADDON}"
done

# Step 5: Update node group AMI
aws eks update-nodegroup-version \
  --cluster-name prod-cluster \
  --nodegroup-name workers \
  --kubernetes-version 1.29 \
  --update-config '{"maxUnavailable":2}'
```

### Google GKE

```bash
# Step 1: Check current version and available upgrades
gcloud container clusters describe prod-cluster \
  --zone us-central1-a \
  --format='yaml(currentMasterVersion,currentNodeVersion,locations)'

# List available versions
gcloud container get-server-config --zone us-central1-a \
  --format='yaml(validMasterVersions[:5])'

# Step 2: Upgrade control plane (GKE manages the sequence internally)
gcloud container clusters upgrade prod-cluster \
  --master \
  --cluster-version 1.29.3-gke.1000 \
  --zone us-central1-a

# Monitor (upgrade is asynchronous)
gcloud container operations list \
  --filter="status=RUNNING" \
  --zone us-central1-a

# Step 3: Upgrade node pools
# GKE recommends surge upgrades for zero-downtime
gcloud container node-pools update workers \
  --cluster prod-cluster \
  --zone us-central1-a \
  --max-surge-upgrade 1 \
  --max-unavailable-upgrade 0

gcloud container clusters upgrade prod-cluster \
  --node-pool workers \
  --cluster-version 1.29.3-gke.1000 \
  --zone us-central1-a
```

### Azure AKS

```bash
# Step 1: Check available upgrades
az aks get-upgrades \
  --resource-group prod-rg \
  --name prod-cluster \
  --output table

# Step 2: Upgrade control plane
az aks upgrade \
  --resource-group prod-rg \
  --name prod-cluster \
  --kubernetes-version 1.29.3 \
  --control-plane-only \
  --yes

# Monitor upgrade
az aks show \
  --resource-group prod-rg \
  --name prod-cluster \
  --query "provisioningState"

# Step 3: Upgrade node pools
az aks nodepool upgrade \
  --resource-group prod-rg \
  --cluster-name prod-cluster \
  --name nodepool1 \
  --kubernetes-version 1.29.3 \
  --max-surge 1 \
  --no-wait

# Watch node pool upgrade progress
watch -n 30 'az aks nodepool show \
  --resource-group prod-rg \
  --cluster-name prod-cluster \
  --name nodepool1 \
  --query "{state: provisioningState, version: orchestratorVersion}" \
  --output table'
```

## Post-Upgrade Validation

```bash
#!/bin/bash
# post-upgrade-validation.sh

TARGET_VERSION=${1}

echo "=== Post-Upgrade Validation ==="

# 1. Verify all nodes are on target version
echo "Node versions:"
kubectl get nodes -o custom-columns=NAME:.metadata.name,VERSION:.status.nodeInfo.kubeletVersion

MISMATCHED=$(kubectl get nodes \
  -o jsonpath='{.items[*].status.nodeInfo.kubeletVersion}' | \
  tr ' ' '\n' | grep -v "v${TARGET_VERSION}" | wc -l)
if [ "${MISMATCHED}" -gt 0 ]; then
  echo "WARNING: ${MISMATCHED} nodes not on target version ${TARGET_VERSION}"
fi

# 2. Verify all system pods are running
echo ""
echo "System pod status:"
kubectl get pods -n kube-system | grep -v "Running\|Completed"

# 3. Verify API server health
echo ""
echo "API server health:"
kubectl get --raw /healthz
kubectl get --raw /readyz

# 4. Verify etcd cluster health
echo ""
echo "etcd health:"
kubectl exec -n kube-system etcd-$(hostname) -- \
  etcdctl endpoint health \
  --cluster \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  2>/dev/null || echo "etcd check skipped (managed cluster)"

# 5. Verify admission webhooks are functioning
echo ""
echo "Testing admission webhooks:"
kubectl auth can-i create pods --namespace=production --as=system:serviceaccount:production:default

# 6. Spot check application pods
echo ""
echo "Application pod health sample:"
kubectl get pods --all-namespaces | \
  grep -v "kube-system\|monitoring\|Running\|Completed\|NAME" | \
  head -20

echo ""
echo "Validation complete."
```

## Rollback Planning

### Pre-Upgrade etcd Snapshot

```bash
#!/bin/bash
# pre-upgrade-backup.sh

BACKUP_DIR="/backup/pre-upgrade-$(date +%Y%m%d%H%M%S)"
mkdir -p "${BACKUP_DIR}"

# etcd snapshot
ETCDCTL_API=3 etcdctl snapshot save "${BACKUP_DIR}/etcd-snapshot.db" \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key

# Verify snapshot
ETCDCTL_API=3 etcdctl snapshot status "${BACKUP_DIR}/etcd-snapshot.db" \
  --write-out=table

# Backup kubeadm config
kubectl -n kube-system get configmap kubeadm-config \
  -o jsonpath='{.data.ClusterConfiguration}' > "${BACKUP_DIR}/kubeadm-config.yaml"

# Export all cluster resources (belt-and-suspenders)
kubectl get all --all-namespaces -o yaml > "${BACKUP_DIR}/all-resources.yaml"
kubectl get pv --all-namespaces -o yaml > "${BACKUP_DIR}/persistent-volumes.yaml"
kubectl get configmap --all-namespaces -o yaml > "${BACKUP_DIR}/configmaps.yaml"

echo "Pre-upgrade backup stored in ${BACKUP_DIR}"
ls -lh "${BACKUP_DIR}/"
```

### Downgrade Procedure (kubeadm)

Kubernetes does not support official downgrade, but emergency rollback is possible:

```bash
# EMERGENCY ONLY — downgrade is unsupported and risky

# Step 1: Restore etcd from pre-upgrade snapshot
# (This must be done on ALL etcd nodes simultaneously)
ETCDCTL_API=3 etcdctl snapshot restore \
  /backup/pre-upgrade-20260315/etcd-snapshot.db \
  --data-dir=/var/lib/etcd-restore \
  --name=etcd-node-1 \
  --initial-cluster="etcd-node-1=https://10.0.0.1:2380" \
  --initial-cluster-token=etcd-cluster-1 \
  --initial-advertise-peer-urls=https://10.0.0.1:2380

# Step 2: Update etcd data directory
sudo systemctl stop etcd
sudo mv /var/lib/etcd /var/lib/etcd-upgraded
sudo mv /var/lib/etcd-restore /var/lib/etcd
sudo systemctl start etcd

# Step 3: Downgrade kube-apiserver, controller-manager, scheduler
sudo apt-get install -y \
  kubeadm=1.28.8-1.1 \
  kubelet=1.28.8-1.1 \
  kubectl=1.28.8-1.1

# Update kubeadm static pod manifests
sudo kubeadm upgrade apply v1.28.8 --force

sudo systemctl restart kubelet
```

## Upgrade Timeline and Communication

### Sample Upgrade Timeline

```
T-7 days:
  - API deprecation scan
  - PDB verification
  - Announce maintenance window to application teams

T-3 days:
  - Test upgrade in dev cluster
  - Verify add-on compatibility
  - Pre-upgrade backup procedure dry run

T-1 day:
  - Freeze deployments to production
  - Verify monitoring and alerting are operational
  - Confirm rollback procedure

T-0 (Upgrade Day):
  08:00 - Take pre-upgrade etcd snapshot
  08:15 - Begin control plane upgrade
  09:00 - Verify control plane healthy
  09:15 - Begin worker node rolling upgrade (batch 1)
  10:30 - Verify batch 1 healthy, begin batch 2
  12:00 - All nodes upgraded
  12:15 - Run post-upgrade validation
  12:30 - Announce upgrade complete

T+1 day:
  - Monitor error rates and latency
  - Address any pod evictions or scheduling issues
  - Unfreeze deployments
```

### Upgrade Announcement Template

```bash
# Generate upgrade summary for stakeholders
cat <<EOF
Kubernetes Upgrade Summary
==========================
Date: $(date)
Cluster: prod-cluster
Previous Version: v$(kubectl version --short 2>/dev/null | grep Server | awk '{print $3}')
Target Version: v${TARGET_VERSION}

Nodes Upgraded:
$(kubectl get nodes -o custom-columns=NAME:.metadata.name,VERSION:.status.nodeInfo.kubeletVersion)

Outcome: SUCCESS / PARTIAL / FAILED

Incidents During Upgrade:
- None / [List any incidents]

Post-Upgrade Validation: PASSED / FAILED

Next Scheduled Upgrade: $(date -d "+90 days" "+%Y-%m-%d") (v${NEXT_VERSION})
EOF
```

## Summary

Zero-downtime Kubernetes cluster upgrades depend on four foundations: pre-upgrade validation (API deprecation scanning, PDB verification, health checks), correct component sequencing (etcd first, then apiserver, then other control plane components, then workers), controlled node rolling (cordon, drain, upgrade, uncordon with batch rate limiting), and pre-materialized rollback options (etcd snapshots, Velero backups). Managed clusters (EKS, GKE, AKS) abstract much of the control plane sequencing but still require careful node pool upgrade planning and add-on version management. The automation scripts in this guide provide a starting framework — adapt them to the specific cluster topology, application SLOs, and maintenance window constraints in each environment.
