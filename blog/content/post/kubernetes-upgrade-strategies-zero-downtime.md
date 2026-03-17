---
title: "Kubernetes Cluster Upgrades: Zero-Downtime Strategies for Production"
date: 2027-11-30T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Upgrades", "Zero Downtime", "kubeadm", "EKS"]
categories:
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to zero-downtime Kubernetes cluster upgrades, covering pre-upgrade validation, control plane sequencing, node drain strategies, API deprecation handling, rollback procedures, and managed service upgrade automation."
more_link: "yes"
url: "/kubernetes-upgrade-strategies-zero-downtime/"
---

Kubernetes cluster upgrades are among the highest-risk operations in a production environment. A failed control plane upgrade can prevent workload scheduling and API operations. A poorly executed node upgrade can cause cascading failures if PodDisruptionBudgets are not respected. This guide provides a systematic approach to upgrades that minimizes downtime and provides clear rollback paths.

<!--more-->

# Kubernetes Cluster Upgrades: Zero-Downtime Strategies for Production

## Upgrade Philosophy

Kubernetes follows a strict versioning policy:
- Minor version releases occur approximately every 4 months
- Each release is supported for approximately 14 months
- You should be running no more than 2 minor versions behind the latest
- Upgrade one minor version at a time (never skip versions)
- The kubelet version on worker nodes can be at most one minor version behind the control plane

The Kubernetes API server supports N-2 client compatibility, meaning clients (kubectl, operators, custom controllers) that are two minor versions behind will still work against a newer API server. This window allows for rolling upgrades.

## Section 1: Pre-Upgrade Validation Checklist

### Cluster Health Verification

```bash
#!/bin/bash
# pre-upgrade-check.sh - Comprehensive pre-upgrade validation

CURRENT_VERSION=$(kubectl version --output=json | jq -r '.serverVersion.gitVersion')
TARGET_VERSION="${1:?Usage: $0 <target-version> (e.g., v1.29.0)}"

echo "=== Kubernetes Cluster Upgrade Pre-flight Check ==="
echo "Current version: $CURRENT_VERSION"
echo "Target version: $TARGET_VERSION"
echo ""

PASS=0
WARN=0
FAIL=0

check_pass() { echo "[PASS] $1"; PASS=$((PASS + 1)); }
check_warn() { echo "[WARN] $1"; WARN=$((WARN + 1)); }
check_fail() { echo "[FAIL] $1"; FAIL=$((FAIL + 1)); }

# Node health
echo "=== Node Health ==="
NOT_READY=$(kubectl get nodes --no-headers | grep -v " Ready " | wc -l)
if [ "$NOT_READY" -eq 0 ]; then
  check_pass "All nodes are Ready"
else
  check_fail "$NOT_READY nodes are not Ready - fix before upgrading"
  kubectl get nodes | grep -v Ready
fi

# Control plane component health
echo ""
echo "=== Control Plane Health ==="
UNHEALTHY=$(kubectl get componentstatuses --no-headers 2>/dev/null | grep -v Healthy | wc -l)
if [ "$UNHEALTHY" -eq 0 ]; then
  check_pass "All control plane components are healthy"
else
  check_warn "Component status check not available (normal for newer clusters)"
fi

# Check API server availability
kubectl cluster-info > /dev/null 2>&1 && \
  check_pass "API server is responding" || \
  check_fail "API server is not responding"

# etcd health
echo ""
echo "=== etcd Health ==="
ETCD_POD=$(kubectl get pod -n kube-system -l component=etcd -o name | head -1)
if [ -n "$ETCD_POD" ]; then
  ETCD_HEALTH=$(kubectl exec -n kube-system "$ETCD_POD" -- \
    etcdctl endpoint health \
    --endpoints=https://127.0.0.1:2379 \
    --cacert=/etc/kubernetes/pki/etcd/ca.crt \
    --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
    --key=/etc/kubernetes/pki/etcd/healthcheck-client.key \
    2>&1)
  if echo "$ETCD_HEALTH" | grep -q "is healthy"; then
    check_pass "etcd cluster is healthy"
  else
    check_fail "etcd cluster is unhealthy: $ETCD_HEALTH"
  fi
else
  check_warn "etcd pod not found (managed control plane?)"
fi

# PodDisruptionBudgets
echo ""
echo "=== PodDisruptionBudget Analysis ==="
PDBS=$(kubectl get pdb --all-namespaces --no-headers 2>/dev/null)
if [ -z "$PDBS" ]; then
  check_warn "No PodDisruptionBudgets found - workloads may be disrupted during node drains"
else
  BLOCKING_PDBS=$(kubectl get pdb --all-namespaces -o json | \
    jq '.items[] | select(.status.disruptionsAllowed == 0) | .metadata.name' | wc -l)
  if [ "$BLOCKING_PDBS" -gt 0 ]; then
    check_warn "$BLOCKING_PDBS PDBs currently blocking disruptions"
    kubectl get pdb --all-namespaces | grep '0         0'
  else
    check_pass "All PDBs allow at least one disruption"
  fi
fi

# API deprecations
echo ""
echo "=== API Deprecation Check ==="
# Use kubectl-convert or pluto for API version checking
if command -v pluto &> /dev/null; then
  DEPRECATED=$(pluto detect-all-in-cluster --target-versions "k8s=$TARGET_VERSION" 2>/dev/null | \
    grep -v "No deprecated" | grep -v "^NAME" | wc -l)
  if [ "$DEPRECATED" -gt 0 ]; then
    check_fail "$DEPRECATED deprecated API resources found for $TARGET_VERSION"
    pluto detect-all-in-cluster --target-versions "k8s=$TARGET_VERSION" 2>/dev/null
  else
    check_pass "No deprecated API resources found"
  fi
else
  check_warn "pluto not installed - install it to check API deprecations"
fi

# Storage
echo ""
echo "=== Storage Health ==="
PENDING_PVCS=$(kubectl get pvc --all-namespaces --no-headers | grep -v Bound | wc -l)
if [ "$PENDING_PVCS" -eq 0 ]; then
  check_pass "All PVCs are bound"
else
  check_warn "$PENDING_PVCS PVCs are not in Bound state"
  kubectl get pvc --all-namespaces | grep -v Bound
fi

# Certificates
echo ""
echo "=== Certificate Expiry ==="
for cert in /etc/kubernetes/pki/*.crt; do
  EXPIRY=$(openssl x509 -in "$cert" -noout -enddate 2>/dev/null | cut -d= -f2)
  EXPIRY_EPOCH=$(date -d "$EXPIRY" +%s 2>/dev/null || date -j -f "%b %d %T %Y %Z" "$EXPIRY" +%s)
  DAYS_LEFT=$(( (EXPIRY_EPOCH - $(date +%s)) / 86400 ))
  
  if [ "$DAYS_LEFT" -lt 30 ]; then
    check_fail "Certificate $cert expires in $DAYS_LEFT days"
  elif [ "$DAYS_LEFT" -lt 90 ]; then
    check_warn "Certificate $cert expires in $DAYS_LEFT days"
  fi
done 2>/dev/null

echo ""
echo "=== Pre-flight Results ==="
echo "Passed: $PASS | Warnings: $WARN | Failed: $FAIL"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "ABORT: $FAIL critical checks failed. Resolve before proceeding."
  exit 1
elif [ "$WARN" -gt 0 ]; then
  echo "CAUTION: $WARN warnings found. Review before proceeding."
  exit 0
else
  echo "All checks passed. Ready to proceed with upgrade."
fi
```

### API Deprecation Checking with Pluto

```bash
# Install pluto
curl -sSL https://github.com/FairwindsOps/pluto/releases/latest/download/pluto_linux_amd64.tar.gz | tar xz
sudo mv pluto /usr/local/bin/

# Check all cluster resources for deprecated APIs
pluto detect-all-in-cluster \
  --target-versions "k8s=v1.29.0" \
  --output wide \
  --ignore-deprecations \
  --only-show-removed

# Check Helm releases for deprecated APIs
pluto detect-helm --target-versions "k8s=v1.29.0" --output wide

# Check manifests in a directory
pluto detect-files -d ./manifests \
  --target-versions "k8s=v1.29.0"
```

### etcd Backup Before Upgrade

```bash
#!/bin/bash
# etcd-backup.sh - Create point-in-time etcd backup

BACKUP_DIR="/var/backups/etcd"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="$BACKUP_DIR/etcd-snapshot-$TIMESTAMP.db"

mkdir -p "$BACKUP_DIR"

echo "Creating etcd snapshot: $BACKUP_FILE"

ETCDCTL_API=3 etcdctl snapshot save "$BACKUP_FILE" \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
  --key=/etc/kubernetes/pki/etcd/healthcheck-client.key

# Verify the snapshot
ETCDCTL_API=3 etcdctl snapshot status "$BACKUP_FILE" --write-out=table

# Upload to S3 for durability
aws s3 cp "$BACKUP_FILE" \
  "s3://acme-cluster-backups/etcd/$(hostname)/$TIMESTAMP/" \
  --sse aws:kms \
  --sse-kms-key-id "arn:aws:kms:us-east-1:123456789012:key/mrk-abc123"

echo "etcd backup complete: $BACKUP_FILE"
echo "Snapshot size: $(du -h "$BACKUP_FILE" | cut -f1)"
```

## Section 2: Control Plane Upgrade Sequence

### kubeadm Upgrade Process

For self-managed clusters using kubeadm:

```bash
#!/bin/bash
# upgrade-control-plane.sh
# Run on the FIRST control plane node

TARGET_VERSION="${1:?Usage: $0 <target-version>}"
# Remove the 'v' prefix for apt/yum
PACKAGE_VERSION="${TARGET_VERSION#v}"

echo "=== Upgrading control plane to $TARGET_VERSION ==="

# Step 1: Update kubeadm on the first control plane node
apt-mark unhold kubeadm
apt-get update
apt-get install -y kubeadm="${PACKAGE_VERSION}-*"
apt-mark hold kubeadm

# Verify
kubeadm version

# Step 2: Verify the upgrade plan
kubeadm upgrade plan "$TARGET_VERSION"

# Step 3: Apply the upgrade (interactive review recommended)
echo "Review the above plan. Proceeding with upgrade in 30 seconds..."
sleep 30

kubeadm upgrade apply "$TARGET_VERSION" \
  --certificate-renewal=true \
  --yes

# Step 4: Verify control plane upgraded
kubectl get nodes
kubectl version --short

echo "Control plane node upgrade complete. Now upgrade kubelet and kubectl."
```

```bash
#!/bin/bash
# upgrade-kubelet.sh - Upgrade kubelet on the current node
# Run on each control plane and worker node

TARGET_VERSION="${1:?Usage: $0 <target-version>}"
PACKAGE_VERSION="${TARGET_VERSION#v}"
NODE_NAME=$(hostname)

echo "=== Upgrading kubelet on $NODE_NAME to $TARGET_VERSION ==="

# Drain the node (only needed for worker nodes)
# For control plane: kubectl drain with --ignore-daemonsets is fine
kubectl drain "$NODE_NAME" \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --timeout=300s

# Upgrade kubelet and kubectl
apt-mark unhold kubelet kubectl
apt-get update
apt-get install -y "kubelet=${PACKAGE_VERSION}-*" "kubectl=${PACKAGE_VERSION}-*"
apt-mark hold kubelet kubectl

# Reload and restart kubelet
systemctl daemon-reload
systemctl restart kubelet

# Verify kubelet is running
sleep 5
systemctl status kubelet

# Uncordon the node
kubectl uncordon "$NODE_NAME"

echo "Node $NODE_NAME upgrade complete"
kubectl get node "$NODE_NAME"
```

### Additional Control Plane Nodes

```bash
#!/bin/bash
# upgrade-additional-control-plane.sh
# Run on each additional control plane node AFTER the first

TARGET_VERSION="${1:?Usage: $0 <target-version>}"
PACKAGE_VERSION="${TARGET_VERSION#v}"

# Update kubeadm
apt-mark unhold kubeadm
apt-get update
apt-get install -y "kubeadm=${PACKAGE_VERSION}-*"
apt-mark hold kubeadm

# Use 'upgrade node' for additional control plane nodes (not 'upgrade apply')
kubeadm upgrade node

# Then upgrade kubelet using the same script as workers
./upgrade-kubelet.sh "$TARGET_VERSION"
```

## Section 3: Node Drain Strategies

### Safe Node Drain with PDB Awareness

```bash
#!/bin/bash
# safe-drain.sh - Drain a node with PDB awareness and monitoring

NODE_NAME="${1:?Usage: $0 <node-name>}"
DRAIN_TIMEOUT="${2:-300}"
CHECK_INTERVAL=10

echo "=== Safe drain of node: $NODE_NAME ==="

# Pre-drain checks
echo "Pods currently on this node:"
kubectl get pods --all-namespaces \
  --field-selector "spec.nodeName=$NODE_NAME" \
  --no-headers | grep -v Completed | sort -k1

# Check for PDBs that might block the drain
echo ""
echo "PDB status (checking for blocking policies):"
kubectl get pdb --all-namespaces \
  -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}: allowed={.status.disruptionsAllowed}/{.spec.minAvailable}{"\n"}{end}'

# Cordon the node first (prevents new scheduling while we check)
kubectl cordon "$NODE_NAME"
echo "Node cordoned. Waiting 30s for any in-flight requests to complete..."
sleep 30

# Start drain with generous timeout
echo "Starting drain..."
kubectl drain "$NODE_NAME" \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --grace-period=60 \
  --timeout="${DRAIN_TIMEOUT}s" \
  --pod-selector='!job-name' &

DRAIN_PID=$!

# Monitor drain progress
elapsed=0
while kill -0 $DRAIN_PID 2>/dev/null; do
  REMAINING=$(kubectl get pods --all-namespaces \
    --field-selector "spec.nodeName=$NODE_NAME" \
    --no-headers | grep -v Completed | grep -v DaemonSet | wc -l)
  echo "[${elapsed}s] Pods remaining: $REMAINING"
  
  # Check for stuck evictions
  STUCK_PODS=$(kubectl get pods --all-namespaces \
    --field-selector "spec.nodeName=$NODE_NAME" \
    --no-headers | grep -v Completed | grep Terminating)
  if [ -n "$STUCK_PODS" ]; then
    echo "Pods in Terminating state:"
    echo "$STUCK_PODS"
  fi
  
  sleep $CHECK_INTERVAL
  elapsed=$((elapsed + CHECK_INTERVAL))
  
  if [ "$elapsed" -gt "$DRAIN_TIMEOUT" ]; then
    echo "Drain timeout exceeded"
    kill $DRAIN_PID
    break
  fi
done

wait $DRAIN_PID
DRAIN_EXIT=$?

if [ "$DRAIN_EXIT" -eq 0 ]; then
  echo "Node drained successfully after ${elapsed} seconds"
else
  echo "Drain completed with exit code: $DRAIN_EXIT"
  echo "Remaining pods:"
  kubectl get pods --all-namespaces \
    --field-selector "spec.nodeName=$NODE_NAME" \
    --no-headers | grep -v Completed
fi
```

### Parallel Worker Node Upgrade

```bash
#!/bin/bash
# parallel-worker-upgrade.sh - Upgrade worker nodes in batches

TARGET_VERSION="${1:?Usage: $0 <target-version>}"
BATCH_SIZE="${2:-2}"
WORKERS_FILE="${3:-worker-nodes.txt}"

echo "=== Parallel Worker Node Upgrade ==="
echo "Target version: $TARGET_VERSION"
echo "Batch size: $BATCH_SIZE"

# Get all worker nodes (not control plane)
kubectl get nodes \
  --selector='!node-role.kubernetes.io/control-plane' \
  -o jsonpath='{.items[*].metadata.name}' | tr ' ' '\n' > "$WORKERS_FILE"

TOTAL_WORKERS=$(wc -l < "$WORKERS_FILE")
echo "Total workers to upgrade: $TOTAL_WORKERS"

# Process in batches
batch=1
while read -r NODE; do
  BATCH_NODES+=("$NODE")
  
  if [ "${#BATCH_NODES[@]}" -eq "$BATCH_SIZE" ] || [ "$(wc -w <<< "${BATCH_NODES[*]}")" -eq "$TOTAL_WORKERS" ]; then
    echo ""
    echo "=== Processing batch $batch: ${BATCH_NODES[*]} ==="
    
    # Drain all nodes in batch in parallel
    for node in "${BATCH_NODES[@]}"; do
      (
        echo "Draining $node..."
        kubectl drain "$node" \
          --ignore-daemonsets \
          --delete-emptydir-data \
          --timeout=300s 2>&1 | sed "s/^/[$node] /"
      ) &
    done
    
    # Wait for all drains in this batch
    wait
    echo "Batch $batch drained"
    
    # Upgrade kubelet in parallel
    for node in "${BATCH_NODES[@]}"; do
      (
        echo "Upgrading $node..."
        ssh "$node" "bash /tmp/upgrade-kubelet.sh $TARGET_VERSION" 2>&1 | \
          sed "s/^/[$node] /"
      ) &
    done
    
    wait
    echo "Batch $batch upgraded"
    
    # Verify nodes came back healthy
    for node in "${BATCH_NODES[@]}"; do
      kubectl wait node "$node" --for=condition=Ready --timeout=300s
      kubectl uncordon "$node"
    done
    
    # Wait for workloads to stabilize
    echo "Waiting 60s for workloads to stabilize..."
    sleep 60
    
    # Verify cluster health before proceeding
    UNHEALTHY=$(kubectl get pods --all-namespaces \
      --field-selector status.phase!=Running \
      --no-headers | grep -v Completed | wc -l)
    
    if [ "$UNHEALTHY" -gt 0 ]; then
      echo "WARNING: $UNHEALTHY pods are not running after batch $batch:"
      kubectl get pods --all-namespaces \
        --field-selector status.phase!=Running | grep -v Completed
      read -r -p "Continue with next batch? (y/N): " CONTINUE
      if [ "$CONTINUE" != "y" ]; then
        echo "Aborting upgrade after batch $batch"
        exit 1
      fi
    fi
    
    BATCH_NODES=()
    batch=$((batch + 1))
  fi
done < "$WORKERS_FILE"

echo ""
echo "All worker nodes upgraded to $TARGET_VERSION"
kubectl get nodes
```

## Section 4: PodDisruptionBudgets During Upgrades

### PDB Configuration for Upgrade Safety

```yaml
# PDB for stateless services - allow one disruption at a time
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payments-api-pdb
  namespace: production
spec:
  selector:
    matchLabels:
      app: payments-api
  # At least 2 replicas must remain (protects against draining during low capacity)
  minAvailable: 2
  # Alternative: maxUnavailable: 1 (relative to current replicas)
---
# PDB for databases - stricter, no more than 1 down at a time
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: postgresql-pdb
  namespace: production
spec:
  selector:
    matchLabels:
      app: postgresql
  maxUnavailable: 1
---
# PDB for single-replica critical services
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: key-service-pdb
  namespace: production
spec:
  selector:
    matchLabels:
      app: critical-service
  # This prevents eviction entirely - only scale up before upgrading this node
  minAvailable: 1
```

### Handling Stuck PDBs During Upgrades

```bash
# Check which PDBs are blocking drains
kubectl get pdb --all-namespaces \
  -o jsonpath='{range .items[*]}{"\nName: "}{.metadata.namespace}/{.metadata.name}{"\n  DisruptionsAllowed: "}{.status.disruptionsAllowed}{"\n  CurrentHealthy: "}{.status.currentHealthy}{"\n  MinAvailable: "}{.spec.minAvailable}{"\n"}{end}'

# If a PDB is blocking due to unhealthy pods:
# 1. Find the unhealthy pods
kubectl get pods --all-namespaces -l app=critical-service

# 2. Check why they're unhealthy
kubectl describe pod <pod-name> -n <namespace>

# 3. If the pod is truly stuck (not a real failure), you can temporarily delete it
# WARNING: Only do this after confirming it is safe
kubectl delete pod <stuck-pod-name> -n <namespace>

# 4. For maintenance windows where you need to drain despite PDB:
# Temporarily patch the PDB (record the original value first)
ORIGINAL=$(kubectl get pdb payments-api-pdb -n production -o jsonpath='{.spec.minAvailable}')
echo "Original minAvailable: $ORIGINAL"

kubectl patch pdb payments-api-pdb -n production \
  --type='merge' \
  -p '{"spec":{"minAvailable":1}}'

# Perform the drain
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data

# Restore the PDB
kubectl patch pdb payments-api-pdb -n production \
  --type='merge' \
  -p "{\"spec\":{\"minAvailable\":$ORIGINAL}}"
```

## Section 5: Handling API Deprecations

### API Version Migration

```bash
# Find resources using deprecated API versions
kubectl api-resources --verbs=list -o name | xargs -n 1 \
  kubectl get --show-kind --ignore-not-found -A 2>/dev/null | \
  grep -E 'autoscaling/v1|batch/v1beta1|networking.k8s.io/v1beta1'

# Convert deprecated manifests using kubectl convert
kubectl convert -f old-manifest.yaml --output-version apps/v1 > new-manifest.yaml

# Bulk convert a directory
find ./manifests -name '*.yaml' -exec kubectl convert -f {} --output-version apps/v1 \; 2>/dev/null

# Check Helm releases for deprecated API versions
helm list --all-namespaces -o json | jq '.[].name' | \
  xargs -I{} pluto detect-helm --output wide -n {}
```

### Common API Version Changes by Kubernetes Version

```bash
# Kubernetes 1.25 removed:
# - PodSecurityPolicy (policy/v1beta1) -> Pod Security Standards
# - RuntimeClass (node.k8s.io/v1beta1) -> node.k8s.io/v1
# - CronJob (batch/v1beta1) -> batch/v1
# - EndpointSlice (discovery.k8s.io/v1beta1) -> discovery.k8s.io/v1
# - Event (events.k8s.io/v1beta1) -> events.k8s.io/v1
# - HorizontalPodAutoscaler (autoscaling/v2beta1) -> autoscaling/v2

# Kubernetes 1.26 removed:
# - HorizontalPodAutoscaler (autoscaling/v2beta2) -> autoscaling/v2
# - FlowSchema/PriorityLevelConfiguration (flowcontrol.apiserver.k8s.io/v1beta1) -> v1beta3

# Kubernetes 1.29:
# - FlowSchema/PriorityLevelConfiguration (flowcontrol.apiserver.k8s.io/v1beta2) -> v1

# Check current cluster for each deprecated kind
check_deprecated() {
  local kind="$1"
  local old_api="$2"
  local new_api="$3"
  
  COUNT=$(kubectl get "$kind.${old_api%%/*}" --all-namespaces --no-headers 2>/dev/null | wc -l)
  if [ "$COUNT" -gt 0 ]; then
    echo "DEPRECATED: Found $COUNT $kind resources using $old_api (migrate to $new_api)"
    kubectl get "$kind.${old_api%%/*}" --all-namespaces --no-headers 2>/dev/null
  fi
}

check_deprecated "cronjob" "batch/v1beta1" "batch/v1"
check_deprecated "horizontalpodautoscaler" "autoscaling/v2beta2" "autoscaling/v2"
```

## Section 6: Managed Service Upgrades

### AWS EKS Upgrade

```bash
#!/bin/bash
# eks-upgrade.sh - EKS cluster upgrade script

CLUSTER_NAME="${1:?Usage: $0 <cluster-name> <target-version>}"
TARGET_VERSION="${2:?}"
REGION="${3:-us-east-1}"

echo "=== EKS Cluster Upgrade: $CLUSTER_NAME to $TARGET_VERSION ==="

# Step 1: Update eksctl or AWS CLI
aws eks describe-cluster \
  --name "$CLUSTER_NAME" \
  --region "$REGION" \
  --query 'cluster.{name:name,version:version,status:status}' \
  --output table

# Step 2: Check add-on compatibility
echo "Checking add-on versions..."
aws eks describe-addon-versions \
  --kubernetes-version "$TARGET_VERSION" \
  --region "$REGION" \
  --output json | \
  jq '.addons[] | {name: .addonName, versions: [.addonVersions[0].addonVersion]}'

# Step 3: Update the control plane
echo "Updating EKS control plane..."
aws eks update-cluster-version \
  --name "$CLUSTER_NAME" \
  --kubernetes-version "$TARGET_VERSION" \
  --region "$REGION"

# Wait for the control plane update to complete
echo "Waiting for control plane update..."
aws eks wait cluster-active \
  --name "$CLUSTER_NAME" \
  --region "$REGION"

# Verify
aws eks describe-cluster \
  --name "$CLUSTER_NAME" \
  --region "$REGION" \
  --query 'cluster.version'

# Step 4: Update core add-ons
echo "Updating core add-ons..."
for addon in vpc-cni coredns kube-proxy; do
  LATEST_VERSION=$(aws eks describe-addon-versions \
    --kubernetes-version "$TARGET_VERSION" \
    --addon-name "$addon" \
    --region "$REGION" \
    --query 'addons[0].addonVersions[0].addonVersion' \
    --output text)
  
  echo "Updating $addon to $LATEST_VERSION..."
  aws eks update-addon \
    --cluster-name "$CLUSTER_NAME" \
    --addon-name "$addon" \
    --addon-version "$LATEST_VERSION" \
    --resolve-conflicts OVERWRITE \
    --region "$REGION"
done

# Step 5: Update managed node groups
echo "Getting managed node groups..."
NODE_GROUPS=$(aws eks list-nodegroups \
  --cluster-name "$CLUSTER_NAME" \
  --region "$REGION" \
  --query 'nodegroups[]' \
  --output text)

for nodegroup in $NODE_GROUPS; do
  echo "Updating node group: $nodegroup"
  aws eks update-nodegroup-version \
    --cluster-name "$CLUSTER_NAME" \
    --nodegroup-name "$nodegroup" \
    --kubernetes-version "$TARGET_VERSION" \
    --region "$REGION"
  
  # Wait for this node group to complete before starting the next
  echo "Waiting for $nodegroup to update..."
  aws eks wait nodegroup-active \
    --cluster-name "$CLUSTER_NAME" \
    --nodegroup-name "$nodegroup" \
    --region "$REGION"
  
  echo "Node group $nodegroup updated"
done

echo "EKS upgrade complete"
```

### GKE Upgrade

```bash
#!/bin/bash
# gke-upgrade.sh - GKE cluster upgrade

PROJECT="${1:?Usage: $0 <project> <cluster> <zone> <target-version>}"
CLUSTER="${2:?}"
ZONE="${3:?}"
TARGET_VERSION="${4:?}"

echo "=== GKE Cluster Upgrade ==="

# Get current version
gcloud container clusters describe "$CLUSTER" \
  --zone "$ZONE" \
  --project "$PROJECT" \
  --format='value(currentMasterVersion,currentNodeVersion)'

# Check available versions
gcloud container get-server-config \
  --zone "$ZONE" \
  --project "$PROJECT" \
  --format='value(validMasterVersions)'

# Upgrade master (control plane)
echo "Upgrading GKE master to $TARGET_VERSION..."
gcloud container clusters upgrade "$CLUSTER" \
  --master \
  --cluster-version "$TARGET_VERSION" \
  --zone "$ZONE" \
  --project "$PROJECT" \
  --quiet

# Get all node pools
NODE_POOLS=$(gcloud container node-pools list \
  --cluster "$CLUSTER" \
  --zone "$ZONE" \
  --project "$PROJECT" \
  --format='value(name)')

# Upgrade each node pool
for pool in $NODE_POOLS; do
  echo "Upgrading node pool: $pool"
  gcloud container clusters upgrade "$CLUSTER" \
    --node-pool "$pool" \
    --cluster-version "$TARGET_VERSION" \
    --zone "$ZONE" \
    --project "$PROJECT" \
    --quiet
done

echo "GKE upgrade complete"
gcloud container clusters describe "$CLUSTER" \
  --zone "$ZONE" \
  --project "$PROJECT" \
  --format='value(currentMasterVersion,currentNodeVersion)'
```

## Section 7: Rollback Procedures

### Control Plane Rollback

```bash
#!/bin/bash
# rollback-control-plane.sh - Restore control plane from etcd backup

ETCD_BACKUP="${1:?Usage: $0 <etcd-backup-file>}"

echo "=== Control Plane Rollback ==="
echo "WARNING: This will restore the cluster to the state at backup time"
echo "All changes since the backup will be lost"
echo ""
read -r -p "Type 'ROLLBACK' to confirm: " CONFIRM

if [ "$CONFIRM" != "ROLLBACK" ]; then
  echo "Rollback cancelled"
  exit 0
fi

# Stop all control plane components
echo "Stopping control plane components..."
mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/
mv /etc/kubernetes/manifests/kube-controller-manager.yaml /tmp/
mv /etc/kubernetes/manifests/kube-scheduler.yaml /tmp/
mv /etc/kubernetes/manifests/etcd.yaml /tmp/

# Wait for containers to stop
sleep 30

# Backup current etcd data
echo "Backing up current etcd data..."
mv /var/lib/etcd /var/lib/etcd.failed

# Restore from backup
echo "Restoring etcd from backup: $ETCD_BACKUP"
ETCDCTL_API=3 etcdctl snapshot restore "$ETCD_BACKUP" \
  --data-dir /var/lib/etcd \
  --name "$(hostname)" \
  --initial-cluster "$(hostname)=https://$(hostname -I | awk '{print $1}'):2380" \
  --initial-cluster-token etcd-cluster-1 \
  --initial-advertise-peer-urls "https://$(hostname -I | awk '{print $1}'):2380"

# Downgrade kubeadm and kubelet to previous version
echo "Downgrading Kubernetes components..."
# Specify the previous version
PREVIOUS_VERSION="1.27.8"  # Replace with your previous version
apt-get install -y \
  "kubeadm=${PREVIOUS_VERSION}-*" \
  "kubelet=${PREVIOUS_VERSION}-*" \
  "kubectl=${PREVIOUS_VERSION}-*"

# Restore control plane manifests (from backup copy)
echo "Restoring control plane manifests..."
cp /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/
cp /tmp/kube-controller-manager.yaml /etc/kubernetes/manifests/
cp /tmp/kube-scheduler.yaml /etc/kubernetes/manifests/
cp /tmp/etcd.yaml /etc/kubernetes/manifests/

# Wait for API server to come up
echo "Waiting for API server..."
until kubectl cluster-info 2>/dev/null; do
  echo "Waiting..."
  sleep 5
done

echo "Rollback complete. Verify cluster state:"
kubectl get nodes
kubectl get pods --all-namespaces | head -30
```

## Section 8: Upgrade Automation with Kured

Kured (Kubernetes Reboot Daemon) automates node reboots in response to system package updates:

```yaml
# Install kured for automated node management
helm repo add kubereboot https://kubereboot.github.io/charts/
helm repo update

helm install kured kubereboot/kured \
  --namespace kube-system \
  --set configuration.rebootSentinel=/var/run/reboot-required \
  --set configuration.period=1h \
  --set configuration.rebootSentinelCommand="" \
  --set configuration.notifyUrl="https://hooks.slack.com/services/T.../B.../..." \
  --set configuration.slackHookUrl="https://hooks.slack.com/services/T.../B.../..." \
  --set configuration.slackUsername="kured" \
  --set configuration.slackChannel="#ops-alerts"
```

```yaml
# Kured DaemonSet configuration
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: kured
  namespace: kube-system
spec:
  selector:
    matchLabels:
      name: kured
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
  template:
    metadata:
      labels:
        name: kured
    spec:
      serviceAccountName: kured
      tolerations:
      - key: node-role.kubernetes.io/control-plane
        effect: NoSchedule
      hostPID: true
      restartPolicy: Always
      containers:
      - name: kured
        image: ghcr.io/kubereboot/kured:1.15.0
        imagePullPolicy: IfNotPresent
        securityContext:
          privileged: true
        env:
        - name: KURED_NODE_ID
          valueFrom:
            fieldRef:
              fieldPath: spec.nodeName
        command:
        - /usr/bin/kured
        - --reboot-sentinel=/var/run/reboot-required
        - --blocking-pod-selector=do-not-disrupt=true
        - --reboot-days=mon,tue,wed,thu,fri
        - --start-time=22:00
        - --end-time=06:00
        - --time-zone=America/New_York
        - --period=1h
        - --notify-url=slack://T.../B.../...
        ports:
        - containerPort: 8080
          name: metrics
        volumeMounts:
        - mountPath: /var/run
          name: run
        - mountPath: /run/systemd/private
          name: systemd
          readOnly: true
      volumes:
      - name: run
        hostPath:
          path: /var/run
      - name: systemd
        hostPath:
          path: /run/systemd
```

## Section 9: Post-Upgrade Validation

```bash
#!/bin/bash
# post-upgrade-validation.sh

TARGET_VERSION="${1:?Usage: $0 <target-version>}"

echo "=== Post-Upgrade Validation ==="

PASS=0
FAIL=0

check_pass() { echo "[PASS] $1"; PASS=$((PASS + 1)); }
check_fail() { echo "[FAIL] $1"; FAIL=$((FAIL + 1)); }

# Version check
ACTUAL_VERSION=$(kubectl version --output=json | jq -r '.serverVersion.gitVersion')
if [ "$ACTUAL_VERSION" = "$TARGET_VERSION" ]; then
  check_pass "API server version is $TARGET_VERSION"
else
  check_fail "API server version is $ACTUAL_VERSION (expected $TARGET_VERSION)"
fi

# All nodes at target version
OUTDATED_NODES=$(kubectl get nodes --no-headers | grep -v "$TARGET_VERSION" | wc -l)
if [ "$OUTDATED_NODES" -eq 0 ]; then
  check_pass "All nodes are running $TARGET_VERSION"
else
  check_fail "$OUTDATED_NODES nodes are still on old version"
  kubectl get nodes | grep -v "$TARGET_VERSION"
fi

# All system pods healthy
SYSTEM_UNHEALTHY=$(kubectl get pods -n kube-system --no-headers | \
  grep -v Running | grep -v Completed | wc -l)
if [ "$SYSTEM_UNHEALTHY" -eq 0 ]; then
  check_pass "All kube-system pods are running"
else
  check_fail "$SYSTEM_UNHEALTHY kube-system pods are not running"
  kubectl get pods -n kube-system | grep -v Running | grep -v Completed
fi

# CoreDNS is healthy and resolving names
DNS_RESULT=$(kubectl run dns-check --image=nicolaka/netshoot --rm --restart=Never \
  -- dig +short kubernetes.default.svc.cluster.local 2>/dev/null | grep -v pod | head -1)
if [ -n "$DNS_RESULT" ]; then
  check_pass "CoreDNS is resolving internal names"
else
  check_fail "CoreDNS is not resolving internal names"
fi

# kube-proxy health
PROXY_UNHEALTHY=$(kubectl get pods -n kube-system -l k8s-app=kube-proxy --no-headers | \
  grep -v Running | wc -l)
if [ "$PROXY_UNHEALTHY" -eq 0 ]; then
  check_pass "kube-proxy is running on all nodes"
else
  check_fail "$PROXY_UNHEALTHY kube-proxy pods are not running"
fi

# Application pods health
APP_UNHEALTHY=$(kubectl get pods --all-namespaces \
  --field-selector status.phase!=Running,status.phase!=Succeeded \
  --no-headers | wc -l)
if [ "$APP_UNHEALTHY" -eq 0 ]; then
  check_pass "All application pods are running"
else
  check_fail "$APP_UNHEALTHY application pods are not running"
  kubectl get pods --all-namespaces \
    --field-selector status.phase!=Running,status.phase!=Succeeded
fi

# Persistent volume bindings
UNBOUND_PVCS=$(kubectl get pvc --all-namespaces --no-headers | grep -v Bound | wc -l)
if [ "$UNBOUND_PVCS" -eq 0 ]; then
  check_pass "All PVCs are bound"
else
  check_fail "$UNBOUND_PVCS PVCs are not bound"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
  echo "Post-upgrade validation FAILED. Investigate immediately."
  exit 1
fi

echo "Post-upgrade validation passed. Cluster is healthy."
```

## Summary

Successful zero-downtime Kubernetes upgrades require:

1. Comprehensive pre-flight checks covering node health, etcd integrity, API deprecations, and PDB status
2. etcd backup immediately before any control plane change
3. Sequential control plane upgrade (first node with `kubeadm upgrade apply`, additional nodes with `kubeadm upgrade node`)
4. Batch node drains that respect PodDisruptionBudgets and include pause-and-verify steps
5. API version migration completed before the upgrade, not after
6. Clear rollback procedures with tested etcd restore playbooks
7. Post-upgrade validation that verifies every component, not just node versions
8. For managed services (EKS, GKE, AKS), use cloud-provider tooling but still validate PDB compliance and add-on versions

The risk of a Kubernetes upgrade is directly proportional to how much time has passed since the last upgrade. Clusters that are upgraded quarterly have well-practiced procedures and smaller version gaps to cross. Clusters that are upgraded annually accumulate API deprecations, operator compatibility issues, and runbook staleness that significantly increase upgrade risk.
