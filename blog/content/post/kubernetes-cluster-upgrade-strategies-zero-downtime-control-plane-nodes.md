---
title: "Kubernetes Cluster Upgrade Strategies: Zero-Downtime Control Plane and Node Upgrades"
date: 2029-12-21T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cluster Upgrade", "kubeadm", "EKS", "GKE", "AKS", "PodDisruptionBudget", "Node Drain", "Zero Downtime"]
categories:
- Kubernetes
- Operations
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide covering kubeadm upgrade procedures, node drain strategies, PodDisruptionBudget preparation, cloud provider managed upgrade paths for EKS GKE and AKS, and rollback procedures."
more_link: "yes"
url: "/kubernetes-cluster-upgrade-strategies-zero-downtime-control-plane-nodes/"
---

Kubernetes cluster upgrades are one of the highest-risk operational events in a platform engineer's calendar. A minor version skip can expose API deprecations, break admission webhooks, or trigger unexpected node evictions. Done correctly with proper preparation, a Kubernetes upgrade causes zero application downtime: PodDisruptionBudgets prevent mass eviction, rolling node replacement keeps capacity stable, and a validated rollback path exists at every stage. This guide covers the full upgrade lifecycle from pre-flight checks to post-upgrade validation.

<!--more-->

## Upgrade Philosophy and Constraints

Before starting any upgrade, three rules govern every decision:

1. **One minor version at a time**: Kubernetes supports skew of at most one minor version between components. Never jump from 1.28 to 1.30 directly — upgrade to 1.29 first, validate, then upgrade to 1.30.
2. **Control plane before nodes**: The kube-apiserver must always be equal to or newer than kubelet. Upgrade control plane components first, then worker nodes.
3. **Deprecation audit first**: Check `kubectl get apiservices` and run `pluto detect-api-deprecated` to find deprecated API versions in use before the upgrade window.

## Pre-Upgrade Preparation

### Deprecation and API Audit

```bash
# Install pluto for API deprecation scanning
curl -L https://github.com/FairwindsOps/pluto/releases/latest/download/pluto_linux_amd64.tar.gz \
  | tar -xz
sudo mv pluto /usr/local/bin/

# Scan live cluster resources against target version
pluto detect-all-in-cluster --target-versions k8s=v1.29.0

# Scan Helm releases
pluto detect-helm --target-versions k8s=v1.29.0

# Scan manifest directories
pluto detect-files -d ./manifests --target-versions k8s=v1.29.0
```

### PodDisruptionBudget Audit

Identify deployments without PDBs — these are at risk during node drain:

```bash
# Find all deployments without an associated PDB
kubectl get deployments --all-namespaces -o json | \
  jq -r '.items[] | select(.spec.replicas > 1) |
    "\(.metadata.namespace)/\(.metadata.name)"' | \
  while IFS='/' read -r ns name; do
    pdb_count=$(kubectl get pdb -n "$ns" -o json | \
      jq --arg app "$name" \
      '[.items[] | select(.spec.selector.matchLabels | to_entries[] |
        .value == $app)] | length')
    if [ "$pdb_count" -eq "0" ]; then
      echo "NO PDB: $ns/$name"
    fi
  done
```

Create PDBs for critical workloads before the upgrade:

```yaml
# pdb-critical-services.yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-service-pdb
  namespace: payment-service
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app.kubernetes.io/name: payment-service
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-gateway-pdb
  namespace: api-gateway
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: api-gateway
```

### Admission Webhook Compatibility

Webhooks that call deprecated APIs or use `failurePolicy: Fail` can block the upgrade:

```bash
# List all admission webhooks
kubectl get mutatingwebhookconfigurations,validatingwebhookconfigurations \
  -o custom-columns=NAME:.metadata.name,FAILURE:.webhooks[*].failurePolicy

# Check webhook endpoints for availability
kubectl get validatingwebhookconfigurations -o json | \
  jq -r '.items[].webhooks[] | "\(.name): \(.clientConfig.service.name).\(.clientConfig.service.namespace)"'
```

Temporarily change critical webhooks to `failurePolicy: Ignore` during the upgrade window if the backing service itself needs upgrading.

### etcd Backup

Always take a fresh etcd snapshot immediately before starting:

```bash
# On a control plane node (using etcdctl from the etcd container)
ETCDCTL_API=3 etcdctl snapshot save /backup/etcd-pre-upgrade-$(date +%Y%m%d-%H%M%S).db \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key

# Verify the snapshot
ETCDCTL_API=3 etcdctl snapshot status \
  /backup/etcd-pre-upgrade-*.db \
  --write-out=table
```

## kubeadm Cluster Upgrade

### Control Plane Upgrade

```bash
# Step 1: Upgrade kubeadm on the first control plane node
sudo apt-mark unhold kubeadm
sudo apt-get update && sudo apt-get install -y kubeadm=1.29.0-00
sudo apt-mark hold kubeadm

# Verify the new version
kubeadm version

# Step 2: Dry-run the upgrade to check for issues
sudo kubeadm upgrade plan v1.29.0

# Step 3: Apply the upgrade
sudo kubeadm upgrade apply v1.29.0

# Expected output includes:
# [upgrade/successful] SUCCESS! Your cluster was upgraded to "v1.29.0"
# [upgrade/kubelet] Now that your control plane is upgraded, please proceed with upgrading your kubelets...

# Step 4: Drain the control plane node
kubectl drain <control-plane-node> \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --force

# Step 5: Upgrade kubelet and kubectl
sudo apt-mark unhold kubelet kubectl
sudo apt-get install -y kubelet=1.29.0-00 kubectl=1.29.0-00
sudo apt-mark hold kubelet kubectl

# Step 6: Restart kubelet
sudo systemctl daemon-reload
sudo systemctl restart kubelet

# Step 7: Uncordon the node
kubectl uncordon <control-plane-node>

# Step 8: Verify control plane health
kubectl get nodes
kubectl get pods -n kube-system

# Repeat Steps 4-8 for additional control plane nodes
# (use "kubeadm upgrade node" instead of "kubeadm upgrade apply" on secondary nodes)
```

### Secondary Control Plane Nodes

```bash
# On additional control plane nodes (not the first one):
sudo apt-mark unhold kubeadm
sudo apt-get install -y kubeadm=1.29.0-00
sudo apt-mark hold kubeadm

# Note: use "upgrade node" not "upgrade apply" on secondary CPs
sudo kubeadm upgrade node

kubectl drain <secondary-cp-node> \
  --ignore-daemonsets \
  --delete-emptydir-data

sudo apt-mark unhold kubelet kubectl
sudo apt-get install -y kubelet=1.29.0-00 kubectl=1.29.0-00
sudo apt-mark hold kubelet kubectl

sudo systemctl daemon-reload
sudo systemctl restart kubelet

kubectl uncordon <secondary-cp-node>
```

### Worker Node Rolling Upgrade

Upgrade worker nodes one at a time (or in small batches) to maintain workload capacity:

```bash
#!/usr/bin/env bash
# upgrade-workers.sh — rolling worker node upgrade

set -euo pipefail

TARGET_VERSION="1.29.0-00"
DRAIN_TIMEOUT="300s"
WAIT_AFTER_UNCORDON="60s"

upgrade_node() {
    local NODE="$1"
    echo "=== Upgrading node: $NODE ==="

    # Cordon to prevent new scheduling
    kubectl cordon "$NODE"

    # Drain: evict all pods (respects PDBs)
    kubectl drain "$NODE" \
        --ignore-daemonsets \
        --delete-emptydir-data \
        --grace-period=60 \
        --timeout="$DRAIN_TIMEOUT" \
        --force

    # SSH to node and upgrade packages
    ssh "$NODE" "
        sudo apt-mark unhold kubeadm kubelet kubectl
        sudo apt-get update -q
        sudo apt-get install -y \
            kubeadm=${TARGET_VERSION} \
            kubelet=${TARGET_VERSION} \
            kubectl=${TARGET_VERSION}
        sudo apt-mark hold kubeadm kubelet kubectl
        sudo kubeadm upgrade node
        sudo systemctl daemon-reload
        sudo systemctl restart kubelet
    "

    # Wait for node to become Ready
    echo "Waiting for $NODE to become Ready..."
    kubectl wait node "$NODE" \
        --for=condition=Ready \
        --timeout=180s

    kubectl uncordon "$NODE"
    echo "Node $NODE upgraded and uncordoned."

    # Wait for pods to reschedule before draining the next node
    sleep "$WAIT_AFTER_UNCORDON"
}

# Get all worker nodes (exclude control-plane nodes)
WORKERS=$(kubectl get nodes \
    --selector='!node-role.kubernetes.io/control-plane' \
    -o jsonpath='{.items[*].metadata.name}')

for node in $WORKERS; do
    upgrade_node "$node"
done

echo "All worker nodes upgraded to $TARGET_VERSION"
```

## Cloud Provider Managed Upgrade Paths

### Amazon EKS

EKS separates control plane and node group upgrades:

```bash
# Step 1: Update control plane
aws eks update-cluster-version \
  --name my-eks-cluster \
  --kubernetes-version 1.29 \
  --region us-east-1

# Monitor upgrade progress
aws eks describe-update \
  --name my-eks-cluster \
  --update-id <update-id> \
  --region us-east-1

# Wait for completion (takes 15-30 minutes)
aws eks wait cluster-active \
  --name my-eks-cluster \
  --region us-east-1

# Step 2: Update managed node groups
aws eks update-nodegroup-version \
  --cluster-name my-eks-cluster \
  --nodegroup-name workers-general \
  --kubernetes-version 1.29 \
  --region us-east-1

# For launch-template-based node groups, also update the AMI:
aws eks update-nodegroup-version \
  --cluster-name my-eks-cluster \
  --nodegroup-name workers-general \
  --release-version <ami-release-version> \
  --region us-east-1

# Step 3: Update add-ons to compatible versions
aws eks describe-addon-versions \
  --kubernetes-version 1.29 \
  --addon-name vpc-cni \
  --region us-east-1

aws eks update-addon \
  --cluster-name my-eks-cluster \
  --addon-name vpc-cni \
  --addon-version v1.18.1-eksbuild.1 \
  --region us-east-1
```

### Google Kubernetes Engine

```bash
# Enable maintenance window to control when upgrades occur
gcloud container clusters update my-gke-cluster \
  --maintenance-window-start "2029-12-22T02:00:00Z" \
  --maintenance-window-end "2029-12-22T06:00:00Z" \
  --maintenance-window-recurrence "FREQ=WEEKLY;BYDAY=SA,SU" \
  --region us-central1

# Upgrade control plane manually
gcloud container clusters upgrade my-gke-cluster \
  --master \
  --cluster-version 1.29.0-gke.1200 \
  --region us-central1

# Upgrade a specific node pool with surge settings
gcloud container node-pools update workers \
  --cluster my-gke-cluster \
  --max-surge-upgrade 1 \
  --max-unavailable-upgrade 0 \
  --region us-central1

gcloud container clusters upgrade my-gke-cluster \
  --node-pool workers \
  --cluster-version 1.29.0-gke.1200 \
  --region us-central1

# Monitor upgrade
gcloud container operations list \
  --filter="status=RUNNING" \
  --region us-central1
```

### Azure AKS

```bash
# Check available upgrade versions
az aks get-upgrades \
  --name my-aks-cluster \
  --resource-group my-rg \
  --output table

# Upgrade control plane and node pools together
az aks upgrade \
  --name my-aks-cluster \
  --resource-group my-rg \
  --kubernetes-version 1.29.0 \
  --yes

# Upgrade node pools independently for more control
az aks nodepool upgrade \
  --cluster-name my-aks-cluster \
  --resource-group my-rg \
  --name workerpool \
  --kubernetes-version 1.29.0 \
  --max-surge 1

# Monitor upgrade
az aks show \
  --name my-aks-cluster \
  --resource-group my-rg \
  --query "provisioningState"
```

## Post-Upgrade Validation

```bash
#!/usr/bin/env bash
# post-upgrade-validation.sh

set -euo pipefail

echo "=== Post-Upgrade Validation ==="

echo "--- Node versions ---"
kubectl get nodes -o wide

echo "--- Control plane component versions ---"
kubectl version

echo "--- Component statuses ---"
kubectl get componentstatuses 2>/dev/null || true

echo "--- Pod health in kube-system ---"
kubectl get pods -n kube-system

echo "--- Failed pods across all namespaces ---"
kubectl get pods --all-namespaces --field-selector=status.phase=Failed

echo "--- Pending pods ---"
kubectl get pods --all-namespaces --field-selector=status.phase=Pending

echo "--- DaemonSet status ---"
kubectl get daemonsets --all-namespaces

echo "--- PodDisruptionBudget status ---"
kubectl get pdb --all-namespaces

echo "--- API server health ---"
kubectl get --raw /healthz
kubectl get --raw /readyz

echo "--- Core DNS health ---"
kubectl get pods -n kube-system -l k8s-app=kube-dns
kubectl run dns-test \
  --image=busybox:1.35 \
  --rm \
  --restart=Never \
  -it \
  -- nslookup kubernetes.default.svc.cluster.local

echo "--- Check for deprecated API usage after upgrade ---"
pluto detect-all-in-cluster \
  --target-versions "k8s=v$(kubectl version --short 2>/dev/null | grep Server | awk '{print $3}' | tr -d 'v')"

echo "=== Validation complete ==="
```

## Rollback Procedures

### etcd Restore (Last Resort)

```bash
# Stop all kube-apiserver instances on all control plane nodes
# (remove the static pod manifest temporarily)
sudo mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/kube-apiserver.yaml.bak

# Restore etcd snapshot
ETCDCTL_API=3 etcdctl snapshot restore /backup/etcd-pre-upgrade-20291220-020000.db \
  --name=master \
  --initial-cluster=master=https://10.0.0.10:2380 \
  --initial-cluster-token=etcd-cluster-1 \
  --initial-advertise-peer-urls=https://10.0.0.10:2380 \
  --data-dir=/var/lib/etcd-restored

# Update etcd data dir and restart
sudo mv /var/lib/etcd /var/lib/etcd.backup
sudo mv /var/lib/etcd-restored /var/lib/etcd
sudo systemctl restart etcd

# Restore the apiserver manifest
sudo mv /tmp/kube-apiserver.yaml.bak /etc/kubernetes/manifests/kube-apiserver.yaml
```

### Node Rollback (Cloud Provider)

For cloud-managed node groups, rolling back is typically a node group recreation with the previous AMI/image version:

```bash
# EKS: launch a new node group with the previous version
aws eks create-nodegroup \
  --cluster-name my-eks-cluster \
  --nodegroup-name workers-rollback \
  --kubernetes-version 1.28 \
  --scaling-config minSize=3,maxSize=10,desiredSize=5 \
  --ami-type AL2_x86_64 \
  --instance-types m5.xlarge \
  --region us-east-1

# Drain the upgraded node group
kubectl drain -l "eks.amazonaws.com/nodegroup=workers-general" \
  --ignore-daemonsets \
  --delete-emptydir-data

# Delete the upgraded node group after workloads are migrated
aws eks delete-nodegroup \
  --cluster-name my-eks-cluster \
  --nodegroup-name workers-general \
  --region us-east-1
```

## Upgrade Automation with GitHub Actions

```yaml
# .github/workflows/cluster-upgrade.yaml
name: Kubernetes Cluster Upgrade

on:
  workflow_dispatch:
    inputs:
      cluster_name:
        description: "Cluster name"
        required: true
      target_version:
        description: "Target Kubernetes version (e.g., 1.29)"
        required: true
      environment:
        description: "Environment"
        required: true
        type: choice
        options: [dev, staging, production]

jobs:
  preflight:
    name: Pre-flight Checks
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Configure kubectl
        uses: azure/k8s-set-context@v3
        with:
          cluster-name: ${{ inputs.cluster_name }}

      - name: Run deprecation scan
        run: |
          pluto detect-all-in-cluster \
            --target-versions k8s=v${{ inputs.target_version }}.0

      - name: Check PDB coverage
        run: ./scripts/check-pdb-coverage.sh

      - name: Create etcd backup
        run: ./scripts/etcd-backup.sh

  upgrade:
    name: Execute Upgrade
    needs: preflight
    runs-on: ubuntu-latest
    environment: ${{ inputs.environment }}
    steps:
      - name: Upgrade control plane
        run: ./scripts/upgrade-control-plane.sh ${{ inputs.target_version }}

      - name: Upgrade worker nodes
        run: ./scripts/upgrade-workers.sh ${{ inputs.target_version }}

      - name: Post-upgrade validation
        run: ./scripts/post-upgrade-validation.sh
```

## Summary

Zero-downtime Kubernetes upgrades are achievable with disciplined preparation. The sequence is always: audit deprecations, ensure PDB coverage for critical workloads, take an etcd backup, upgrade control plane components one node at a time, then roll worker nodes with the drain/upgrade/uncordon cycle. Cloud providers (EKS, GKE, AKS) automate this workflow but still benefit from pre-flight deprecation scanning and post-upgrade validation. Rollback procedures should be rehearsed in staging before any production upgrade window. Automation via CI/CD pipelines enforces the checklist and provides an audit trail for compliance.
