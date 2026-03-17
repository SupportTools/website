---
title: "Kubernetes Cluster Upgrade Strategies: Zero-Downtime Node Drain, Version Skew, and RKE2/EKS Upgrade Procedures"
date: 2028-06-25T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Upgrades", "RKE2", "EKS", "Zero-Downtime", "Production"]
categories:
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete production guide to Kubernetes cluster upgrades including version skew policy, safe node drain procedures, RKE2 upgrade automation, and EKS managed node group rolling upgrades with zero downtime."
more_link: "yes"
url: "/kubernetes-cluster-upgrade-zero-downtime-guide/"
---

Kubernetes cluster upgrades are the maintenance task that most production teams dread. They combine version compatibility constraints, application disruption risk, and a narrow rollback window into a single high-stakes operation. After managing upgrades across hundreds of production clusters, the pattern is consistent: teams that struggle have no pre-upgrade validation, skip the version skew rules, and drain nodes without understanding PodDisruptionBudgets. Teams that succeed treat upgrades as a rehearsed runbook.

This guide covers everything you need to upgrade production Kubernetes clusters without service disruption: version skew policy, pre-upgrade validation, safe drain procedures, and the specific procedures for RKE2 and EKS.

<!--more-->

# Kubernetes Cluster Upgrade Strategies: Zero-Downtime Node Drain, Version Skew, and RKE2/EKS Upgrade Procedures

## Section 1: Version Skew Policy

Understanding version skew is not optional. Violating it produces subtle bugs that are nearly impossible to diagnose.

### Kubernetes Version Skew Rules

The official policy from the Kubernetes documentation:

- **kube-apiserver**: Must be at most one minor version ahead of any component it communicates with
- **kubelet**: May be up to three minor versions behind kube-apiserver (since Kubernetes 1.28)
- **kube-controller-manager, kube-scheduler, cloud-controller-manager**: Must not be newer than kube-apiserver; may be up to one minor version behind
- **kubectl**: May be one minor version ahead or behind kube-apiserver

### Upgrade Order for Control Plane

Always upgrade control plane components before worker nodes:

```
1. kube-apiserver
2. kube-controller-manager
3. kube-scheduler
4. cloud-controller-manager (if applicable)
5. kubelet and kube-proxy on control plane nodes
6. kubelet and kube-proxy on worker nodes
```

For multi-control-plane clusters, upgrade one control plane node at a time to maintain quorum.

### Checking Current Version Skew

```bash
# Check all component versions
kubectl version --output=yaml

# Check node versions (shows kubelet version)
kubectl get nodes -o wide

# Check kube-proxy version on each node
kubectl get pods -n kube-system -l k8s-app=kube-proxy \
  -o custom-columns='NODE:.spec.nodeName,VERSION:.spec.containers[0].image'

# Full component version check
kubectl get componentstatus  # Deprecated but still useful
kubectl get --raw '/livez/ping'
kubectl get --raw '/readyz'

# Check for version skew across nodes
kubectl get nodes -o json | jq -r '
  .items[] |
  {node: .metadata.name, kubelet: .status.nodeInfo.kubeletVersion, os: .status.nodeInfo.osImage} |
  "\(.node): kubelet=\(.kubelet) os=\(.os)"
'
```

### Supported Version Ranges per Release

```bash
# Check which API versions will be removed in next Kubernetes release
kubectl api-resources --verbs=list --namespaced=false | head -20

# Use pluto to detect deprecated API usage
kubectl krew install pluto
kubectl pluto detect-all-in-cluster --target-versions k8s=v1.29

# Example output of deprecated APIs in use:
# NAME                           NAMESPACE    KIND                    VERSION    REPLACEMENT   REMOVED   DEPRECATED
# my-ingress                     production   Ingress                 v1beta1    networking.k8s.io/v1/Ingress   true   true
```

## Section 2: Pre-Upgrade Validation

### Pre-Upgrade Checklist Script

```bash
#!/bin/bash
# pre-upgrade-check.sh
# Run before any Kubernetes upgrade

set -euo pipefail

CURRENT_VERSION=$(kubectl version --short 2>/dev/null | grep Server | awk '{print $3}')
echo "=== Kubernetes Pre-Upgrade Validation ==="
echo "Current server version: ${CURRENT_VERSION}"
echo ""

ERRORS=0
WARNINGS=0

check() {
    local name="$1"
    local result="$2"
    local expected="$3"
    if [ "${result}" = "${expected}" ]; then
        echo "[PASS] ${name}"
    else
        echo "[FAIL] ${name}: expected '${expected}', got '${result}'"
        ERRORS=$((ERRORS + 1))
    fi
}

warn() {
    local name="$1"
    local message="$2"
    echo "[WARN] ${name}: ${message}"
    WARNINGS=$((WARNINGS + 1))
}

# Check etcd health
echo "--- etcd Health ---"
ETCD_PODS=$(kubectl get pods -n kube-system -l component=etcd --no-headers | awk '{print $1}')
for pod in ${ETCD_PODS}; do
    STATUS=$(kubectl exec -n kube-system ${pod} -- etcdctl \
        --cert /etc/kubernetes/pki/etcd/peer.crt \
        --key /etc/kubernetes/pki/etcd/peer.key \
        --cacert /etc/kubernetes/pki/etcd/ca.crt \
        endpoint health 2>&1 | grep -c "is healthy" || echo "0")
    if [ "${STATUS}" -ge 1 ]; then
        echo "[PASS] etcd pod ${pod} is healthy"
    else
        echo "[FAIL] etcd pod ${pod} is not healthy"
        ERRORS=$((ERRORS + 1))
    fi
done

# Check all nodes are Ready
echo ""
echo "--- Node Health ---"
NOT_READY=$(kubectl get nodes --no-headers | grep -v " Ready" | wc -l)
if [ "${NOT_READY}" -eq 0 ]; then
    echo "[PASS] All nodes are Ready"
else
    echo "[FAIL] ${NOT_READY} nodes are not Ready"
    kubectl get nodes --no-headers | grep -v " Ready"
    ERRORS=$((ERRORS + 1))
fi

# Check for pods not running
echo ""
echo "--- Pod Health ---"
FAILING_PODS=$(kubectl get pods -A --no-headers | grep -vE "Running|Completed|Succeeded" | wc -l)
if [ "${FAILING_PODS}" -eq 0 ]; then
    echo "[PASS] No failing pods"
else
    warn "Failing pods" "${FAILING_PODS} pods are not running"
    kubectl get pods -A --no-headers | grep -vE "Running|Completed|Succeeded" | head -20
fi

# Check PodDisruptionBudgets
echo ""
echo "--- PodDisruptionBudgets ---"
kubectl get pdb -A -o json | jq -r '
  .items[] |
  select(.status.disruptionsAllowed == 0) |
  "WARN: PDB \(.metadata.namespace)/\(.metadata.name) allows 0 disruptions (current: \(.status.currentHealthy), desired: \(.status.desiredHealthy))"
' | while read line; do
    warn "PDB" "${line}"
done

# Check deprecated API usage
echo ""
echo "--- Deprecated API Usage ---"
if command -v pluto &>/dev/null; then
    DEPRECATED=$(kubectl pluto detect-all-in-cluster 2>/dev/null | grep -c "true" || echo "0")
    if [ "${DEPRECATED}" -eq 0 ]; then
        echo "[PASS] No deprecated APIs detected"
    else
        warn "Deprecated APIs" "${DEPRECATED} resources using deprecated APIs"
    fi
else
    warn "pluto not installed" "Cannot check deprecated API usage"
fi

# Check certificate expiry
echo ""
echo "--- Certificate Expiry ---"
if command -v kubeadm &>/dev/null; then
    kubeadm certs check-expiration 2>/dev/null | grep -E "CERTIFICATE|MISSING" | while read line; do
        if echo "${line}" | grep -q "MISSING\|invalid"; then
            echo "[FAIL] ${line}"
            ERRORS=$((ERRORS + 1))
        else
            echo "[PASS] ${line}"
        fi
    done
fi

# Check storage
echo ""
echo "--- Persistent Volume Health ---"
FAILED_PV=$(kubectl get pv --no-headers | grep -vE "Bound|Available|Released" | wc -l)
if [ "${FAILED_PV}" -eq 0 ]; then
    echo "[PASS] All PersistentVolumes are in healthy state"
else
    warn "PersistentVolumes" "${FAILED_PV} PVs in non-healthy state"
fi

echo ""
echo "=== Summary ==="
echo "Errors: ${ERRORS}"
echo "Warnings: ${WARNINGS}"

if [ "${ERRORS}" -gt 0 ]; then
    echo "UPGRADE BLOCKED: Fix errors before proceeding"
    exit 1
else
    echo "Pre-upgrade checks passed. Review warnings before proceeding."
    exit 0
fi
```

### etcd Backup Before Upgrade

```bash
#!/bin/bash
# Always backup etcd before upgrading

ETCD_SNAPSHOT_PATH="/backup/etcd/snapshot-$(date +%Y%m%d-%H%M%S).db"
mkdir -p /backup/etcd

# For kubeadm clusters
ETCD_POD=$(kubectl get pods -n kube-system -l component=etcd -o jsonpath='{.items[0].metadata.name}')

kubectl exec -n kube-system ${ETCD_POD} -- \
    etcdctl \
    --cert /etc/kubernetes/pki/etcd/peer.crt \
    --key /etc/kubernetes/pki/etcd/peer.key \
    --cacert /etc/kubernetes/pki/etcd/ca.crt \
    snapshot save /tmp/etcd-snapshot.db

kubectl cp kube-system/${ETCD_POD}:/tmp/etcd-snapshot.db ${ETCD_SNAPSHOT_PATH}

echo "etcd snapshot saved to: ${ETCD_SNAPSHOT_PATH}"
ls -lh ${ETCD_SNAPSHOT_PATH}

# Verify snapshot
etcdutl snapshot status ${ETCD_SNAPSHOT_PATH} --write-out=table
```

## Section 3: Safe Node Drain Procedure

### Understanding PodDisruptionBudgets

Before draining, you must understand what disruptions are allowed:

```bash
# Check all PDBs and their current status
kubectl get pdb -A -o custom-columns=\
'NAMESPACE:.metadata.namespace,NAME:.metadata.name,MIN-AVAILABLE:.spec.minAvailable,MAX-UNAVAILABLE:.spec.maxUnavailable,ALLOWED:.status.disruptionsAllowed,CURRENT:.status.currentHealthy,DESIRED:.status.desiredHealthy'

# Identify PDBs that will block drain
kubectl get pdb -A -o json | jq '.items[] | select(.status.disruptionsAllowed == 0) | {namespace: .metadata.namespace, name: .metadata.name}'
```

### Safe Drain Script

```bash
#!/bin/bash
# safe-node-drain.sh
# Safely drain a node with PDB awareness

set -euo pipefail

NODE_NAME="${1:?Usage: $0 <node-name>}"
DRAIN_TIMEOUT="${2:-300}"  # seconds
DRY_RUN="${DRY_RUN:-false}"

echo "=== Safe Node Drain: ${NODE_NAME} ==="

# Step 1: Check node exists
kubectl get node ${NODE_NAME} >/dev/null 2>&1 || {
    echo "ERROR: Node ${NODE_NAME} not found"
    exit 1
}

# Step 2: Check for PDBs that might block drain
echo "Checking PodDisruptionBudgets..."
BLOCKING_PDBS=$(kubectl get pdb -A -o json | jq -r '
  .items[] |
  select(.status.disruptionsAllowed == 0) |
  "\(.metadata.namespace)/\(.metadata.name)"
')

if [ -n "${BLOCKING_PDBS}" ]; then
    echo "WARNING: The following PDBs currently allow 0 disruptions:"
    echo "${BLOCKING_PDBS}"
    echo ""
    echo "Draining may hang or fail. Verify these are expected before proceeding."
    read -p "Continue? (yes/no): " confirm
    [ "${confirm}" = "yes" ] || exit 1
fi

# Step 3: Check pods on node
echo ""
echo "Pods currently on ${NODE_NAME}:"
kubectl get pods -A --field-selector=spec.nodeName=${NODE_NAME} \
  --no-headers | grep -v "Completed\|Succeeded" | wc -l
echo " non-completed pods on node"

# Step 4: Check for pods without replication
echo ""
echo "Checking for singleton pods (no controller)..."
kubectl get pods -A --field-selector=spec.nodeName=${NODE_NAME} \
  -o json | jq -r '
  .items[] |
  select(.metadata.ownerReferences == null or (.metadata.ownerReferences | length) == 0) |
  "\(.metadata.namespace)/\(.metadata.name)"
'

# Step 5: Cordon the node
if [ "${DRY_RUN}" = "false" ]; then
    echo ""
    echo "Cordoning node ${NODE_NAME}..."
    kubectl cordon ${NODE_NAME}
fi

# Step 6: Drain the node
echo ""
echo "Draining node ${NODE_NAME}..."

DRAIN_CMD="kubectl drain ${NODE_NAME} \
    --ignore-daemonsets \
    --delete-emptydir-data \
    --timeout=${DRAIN_TIMEOUT}s \
    --grace-period=60"

if [ "${DRY_RUN}" = "true" ]; then
    echo "DRY RUN - would execute:"
    echo "${DRAIN_CMD}"
else
    ${DRAIN_CMD} || {
        EXIT_CODE=$?
        echo ""
        echo "ERROR: Drain failed with exit code ${EXIT_CODE}"
        echo ""
        echo "Checking for remaining pods..."
        kubectl get pods -A --field-selector=spec.nodeName=${NODE_NAME} \
          --no-headers | grep -v "Completed\|Succeeded\|DaemonSet"
        echo ""
        echo "Node is still cordoned. Investigate the failure before proceeding."
        echo "To uncordon: kubectl uncordon ${NODE_NAME}"
        exit 1
    }
fi

echo ""
echo "Node ${NODE_NAME} successfully drained"
echo "Verify pods have rescheduled on other nodes before proceeding with upgrade"
```

### Handling Drain Failures

```bash
# Common drain failure: Eviction blocked by PDB
# Check which pods are blocking eviction
kubectl describe node ${NODE_NAME} | grep -A 20 "Conditions\|Events"

# Force pod eviction if PDB is misconfigured (use with extreme caution)
kubectl drain ${NODE_NAME} \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --disable-eviction  # Bypasses PDB checks - DANGEROUS

# Better approach: temporarily patch the PDB
kubectl patch pdb <pdb-name> -n <namespace> \
  -p '{"spec": {"minAvailable": 0}}'
# Then drain, then restore PDB
kubectl patch pdb <pdb-name> -n <namespace> \
  -p '{"spec": {"minAvailable": 1}}'

# Handle local storage (emptyDir) pods
kubectl drain ${NODE_NAME} \
  --ignore-daemonsets \
  --delete-emptydir-data  # Required if pods use emptyDir volumes
```

## Section 4: RKE2 Upgrade Procedure

RKE2 upgrades can be performed using the automated system-upgrade-controller or manually. The automated approach is safer for production.

### Method 1: System Upgrade Controller (Recommended)

```bash
# Install system-upgrade-controller
kubectl apply -f https://github.com/rancher/system-upgrade-controller/releases/latest/download/system-upgrade-controller.yaml

# Create upgrade plans
cat <<'EOF' > rke2-upgrade-plans.yaml
---
# Upgrade server (control plane) nodes first
apiVersion: upgrade.cattle.io/v1
kind: Plan
metadata:
  name: rke2-server
  namespace: system-upgrade
  labels:
    rke2-upgrade: server
spec:
  concurrency: 1  # Always upgrade one control plane node at a time
  nodeSelector:
    matchExpressions:
    - key: node-role.kubernetes.io/control-plane
      operator: In
      values: ["true"]
  serviceAccountName: system-upgrade
  tolerations:
  - key: CriticalAddonsOnly
    operator: Exists
  - effect: NoSchedule
    key: node-role.kubernetes.io/control-plane
    operator: Exists
  - effect: NoSchedule
    key: node-role.kubernetes.io/etcd
    operator: Exists
  upgrade:
    image: rancher/rke2-upgrade
  version: v1.28.4+rke2r1  # Target version

---
# Upgrade agent (worker) nodes after control plane is done
apiVersion: upgrade.cattle.io/v1
kind: Plan
metadata:
  name: rke2-agent
  namespace: system-upgrade
  labels:
    rke2-upgrade: agent
spec:
  concurrency: 2  # Upgrade 2 worker nodes simultaneously
  nodeSelector:
    matchExpressions:
    - key: node-role.kubernetes.io/control-plane
      operator: DoesNotExist
  serviceAccountName: system-upgrade
  prepare:
    args:
    - prepare
    - rke2-server  # Wait for server plan to complete
    image: rancher/rke2-upgrade
  upgrade:
    image: rancher/rke2-upgrade
  version: v1.28.4+rke2r1
  drain:
    force: false
    skipWaitForDeleteTimeout: 60
    ignoreDaemonSets: true
    deleteLocalData: true
    timeout: 300
EOF

kubectl apply -f rke2-upgrade-plans.yaml
```

Monitor the upgrade progress:

```bash
# Watch upgrade controller logs
kubectl logs -n system-upgrade -l app=system-upgrade-controller -f

# Watch plan jobs being created
kubectl get jobs -n system-upgrade -w

# Watch nodes being upgraded
kubectl get nodes -w

# Check plan status
kubectl get plan -n system-upgrade -o wide
```

### Method 2: Manual RKE2 Upgrade

```bash
#!/bin/bash
# manual-rke2-upgrade.sh
# Run on each node in sequence

set -euo pipefail

TARGET_VERSION="${1:?Usage: $0 <version>  e.g. v1.28.4+rke2r1}"
NODE_TYPE="${2:-server}"  # server or agent

echo "=== RKE2 Upgrade: ${TARGET_VERSION} (${NODE_TYPE}) ==="

# Download the new version
curl -sfL https://get.rke2.io | \
    INSTALL_RKE2_VERSION=${TARGET_VERSION} \
    INSTALL_RKE2_TYPE=${NODE_TYPE} \
    sh -

# For server nodes
if [ "${NODE_TYPE}" = "server" ]; then
    echo "Restarting RKE2 server..."
    systemctl restart rke2-server

    # Wait for API server to be ready
    echo "Waiting for API server..."
    TIMEOUT=120
    ELAPSED=0
    until kubectl get nodes &>/dev/null; do
        sleep 5
        ELAPSED=$((ELAPSED + 5))
        if [ ${ELAPSED} -ge ${TIMEOUT} ]; then
            echo "ERROR: API server did not become ready within ${TIMEOUT}s"
            exit 1
        fi
    done
    echo "API server is ready"
fi

# For agent nodes
if [ "${NODE_TYPE}" = "agent" ]; then
    echo "Restarting RKE2 agent..."
    systemctl restart rke2-agent
fi

# Verify version
echo ""
echo "New kubelet version:"
/var/lib/rancher/rke2/bin/kubectl version --short 2>/dev/null || true
```

### RKE2 Upgrade with Node Cordon/Drain

```bash
#!/bin/bash
# Full RKE2 node upgrade with coordinated drain

set -euo pipefail

NODE_NAME=$(hostname)
TARGET_VERSION="${1:?Usage: $0 <version>}"
KUBECONFIG=/etc/rancher/rke2/rke2.yaml

export KUBECONFIG

echo "=== RKE2 Node Upgrade: ${NODE_NAME} to ${TARGET_VERSION} ==="

# Step 1: Cordon the node (from control plane)
echo "Cordoning ${NODE_NAME}..."
kubectl cordon ${NODE_NAME}

# Step 2: Drain (let workloads gracefully terminate)
echo "Draining ${NODE_NAME}..."
kubectl drain ${NODE_NAME} \
    --ignore-daemonsets \
    --delete-emptydir-data \
    --timeout=300s \
    --grace-period=60

# Step 3: Upgrade RKE2
echo "Upgrading RKE2 to ${TARGET_VERSION}..."
NODE_ROLE=$(kubectl get node ${NODE_NAME} -o jsonpath='{.metadata.labels.node-role\.kubernetes\.io/control-plane}')
if [ "${NODE_ROLE}" = "true" ]; then
    INSTALL_TYPE="server"
else
    INSTALL_TYPE="agent"
fi

curl -sfL https://get.rke2.io | \
    INSTALL_RKE2_VERSION=${TARGET_VERSION} \
    INSTALL_RKE2_TYPE=${INSTALL_TYPE} \
    sh -

systemctl restart rke2-${INSTALL_TYPE}

# Step 4: Wait for node to be Ready
echo "Waiting for node to become Ready..."
TIMEOUT=300
ELAPSED=0
while true; do
    STATUS=$(kubectl get node ${NODE_NAME} -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')
    if [ "${STATUS}" = "True" ]; then
        echo "Node ${NODE_NAME} is Ready"
        break
    fi
    sleep 10
    ELAPSED=$((ELAPSED + 10))
    if [ ${ELAPSED} -ge ${TIMEOUT} ]; then
        echo "ERROR: Node did not become Ready within ${TIMEOUT}s"
        exit 1
    fi
done

# Step 5: Uncordon the node
echo "Uncordoning ${NODE_NAME}..."
kubectl uncordon ${NODE_NAME}

echo "=== Upgrade complete for ${NODE_NAME} ==="
kubectl get node ${NODE_NAME}
```

## Section 5: EKS Upgrade Procedure

EKS upgrades have additional considerations: managed node groups, add-ons, and the EKS control plane upgrade process.

### EKS Upgrade Order

```
1. Upgrade EKS control plane (one minor version at a time)
2. Upgrade EKS-managed add-ons (VPC CNI, kube-proxy, CoreDNS)
3. Upgrade managed node groups
4. Upgrade self-managed node groups
```

### Step 1: Upgrade EKS Control Plane

```bash
# Check current version and available updates
aws eks describe-cluster --name my-cluster \
  --query "cluster.{version: version, status: status, name: name}" \
  --output table

# Upgrade control plane
aws eks update-cluster-version \
  --name my-cluster \
  --kubernetes-version 1.28

# Wait for upgrade to complete
aws eks wait cluster-active --name my-cluster

# Monitor upgrade status
while true; do
    STATUS=$(aws eks describe-cluster --name my-cluster \
        --query "cluster.status" --output text)
    VERSION=$(aws eks describe-cluster --name my-cluster \
        --query "cluster.version" --output text)
    echo "Status: ${STATUS}, Version: ${VERSION}"
    [ "${STATUS}" = "ACTIVE" ] && break
    sleep 30
done
```

### Step 2: Upgrade EKS Add-ons

```bash
#!/bin/bash
# upgrade-eks-addons.sh

CLUSTER_NAME="my-cluster"
TARGET_K8S_VERSION="1.28"

# Get list of installed add-ons and their versions
aws eks list-addons --cluster-name ${CLUSTER_NAME} --output json | \
  jq -r '.addons[]'

# Function to get latest addon version for a Kubernetes version
get_latest_addon_version() {
    local addon_name="$1"
    aws eks describe-addon-versions \
        --addon-name ${addon_name} \
        --kubernetes-version ${TARGET_K8S_VERSION} \
        --query "addons[0].addonVersions[0].addonVersion" \
        --output text
}

# Upgrade VPC CNI
VPC_CNI_VERSION=$(get_latest_addon_version "vpc-cni")
echo "Upgrading vpc-cni to ${VPC_CNI_VERSION}"
aws eks update-addon \
    --cluster-name ${CLUSTER_NAME} \
    --addon-name vpc-cni \
    --addon-version ${VPC_CNI_VERSION} \
    --resolve-conflicts OVERWRITE

# Upgrade kube-proxy
KUBE_PROXY_VERSION=$(get_latest_addon_version "kube-proxy")
echo "Upgrading kube-proxy to ${KUBE_PROXY_VERSION}"
aws eks update-addon \
    --cluster-name ${CLUSTER_NAME} \
    --addon-name kube-proxy \
    --addon-version ${KUBE_PROXY_VERSION} \
    --resolve-conflicts OVERWRITE

# Upgrade CoreDNS
COREDNS_VERSION=$(get_latest_addon_version "coredns")
echo "Upgrading coredns to ${COREDNS_VERSION}"
aws eks update-addon \
    --cluster-name ${CLUSTER_NAME} \
    --addon-name coredns \
    --addon-version ${COREDNS_VERSION} \
    --resolve-conflicts OVERWRITE

# Wait for add-ons to be active
for addon in vpc-cni kube-proxy coredns; do
    echo "Waiting for ${addon}..."
    aws eks wait addon-active \
        --cluster-name ${CLUSTER_NAME} \
        --addon-name ${addon}
    echo "${addon} is active"
done
```

### Step 3: Upgrade Managed Node Groups

```bash
# Check if node group needs upgrade
aws eks describe-nodegroup \
    --cluster-name my-cluster \
    --nodegroup-name production-workers \
    --query "nodegroup.{version: version, releaseVersion: releaseVersion, status: status}" \
    --output table

# Upgrade managed node group
aws eks update-nodegroup-version \
    --cluster-name my-cluster \
    --nodegroup-name production-workers \
    --kubernetes-version 1.28 \
    --force  # Forces update even if disruptive

# Monitor the rolling update
while true; do
    STATUS=$(aws eks describe-nodegroup \
        --cluster-name my-cluster \
        --nodegroup-name production-workers \
        --query "nodegroup.status" --output text)

    HEALTH=$(aws eks describe-nodegroup \
        --cluster-name my-cluster \
        --nodegroup-name production-workers \
        --query "nodegroup.health" --output json)

    echo "Status: ${STATUS}"
    echo "Health: ${HEALTH}"

    [ "${STATUS}" = "ACTIVE" ] && break
    sleep 30
done
```

### EKS Upgrade with Terraform

For infrastructure-as-code managed clusters:

```hcl
# main.tf - EKS cluster upgrade

resource "aws_eks_cluster" "main" {
  name     = "production"
  version  = "1.28"  # Bump this to trigger upgrade
  role_arn = aws_iam_role.cluster.arn

  vpc_config {
    subnet_ids = var.subnet_ids
  }

  # Control plane logging
  enabled_cluster_log_types = ["api", "audit", "authenticator"]

  lifecycle {
    ignore_changes = [version]  # Remove this during planned upgrade window
  }
}

resource "aws_eks_node_group" "workers" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "production-workers"
  node_role_arn   = aws_iam_role.worker.arn
  subnet_ids      = var.private_subnet_ids
  version         = aws_eks_cluster.main.version  # Stays in sync with cluster

  ami_type       = "AL2_x86_64"
  instance_types = ["m5.xlarge"]

  scaling_config {
    desired_size = 10
    min_size     = 8
    max_size     = 20
  }

  update_config {
    max_unavailable = 2  # Max nodes unavailable during rolling update
  }

  lifecycle {
    create_before_destroy = true
    ignore_changes        = [scaling_config[0].desired_size]
  }
}

# Upgrade add-ons
resource "aws_eks_addon" "vpc_cni" {
  cluster_name             = aws_eks_cluster.main.name
  addon_name               = "vpc-cni"
  addon_version            = "v1.15.4-eksbuild.1"
  resolve_conflicts_on_update = "OVERWRITE"
}

resource "aws_eks_addon" "kube_proxy" {
  cluster_name             = aws_eks_cluster.main.name
  addon_name               = "kube-proxy"
  addon_version            = "v1.28.2-eksbuild.2"
  resolve_conflicts_on_update = "OVERWRITE"
}
```

## Section 6: Post-Upgrade Validation

### Post-Upgrade Checklist

```bash
#!/bin/bash
# post-upgrade-validation.sh

set -euo pipefail

echo "=== Post-Upgrade Validation ==="
TARGET_VERSION="${1:?provide target version}"

# 1. Verify all nodes are on new version
echo "--- Node Versions ---"
kubectl get nodes -o custom-columns=\
'NAME:.metadata.name,VERSION:.status.nodeInfo.kubeletVersion,STATUS:.status.conditions[-1].type,REASON:.status.conditions[-1].reason'

OLD_VERSION_NODES=$(kubectl get nodes -o jsonpath='{.items[*].status.nodeInfo.kubeletVersion}' | \
  tr ' ' '\n' | grep -v "${TARGET_VERSION}" | wc -l)

if [ "${OLD_VERSION_NODES}" -eq 0 ]; then
    echo "[PASS] All nodes are running ${TARGET_VERSION}"
else
    echo "[FAIL] ${OLD_VERSION_NODES} nodes are still on old version"
fi

# 2. Check all system pods are running
echo ""
echo "--- System Pod Health ---"
FAILING_SYSTEM_PODS=$(kubectl get pods -n kube-system --no-headers | \
  grep -vE "Running|Completed" | wc -l)
if [ "${FAILING_SYSTEM_PODS}" -eq 0 ]; then
    echo "[PASS] All kube-system pods are running"
else
    echo "[FAIL] ${FAILING_SYSTEM_PODS} kube-system pods are not running:"
    kubectl get pods -n kube-system --no-headers | grep -vE "Running|Completed"
fi

# 3. Check cluster DNS
echo ""
echo "--- CoreDNS Validation ---"
kubectl run dns-test --image=busybox:1.35 --rm -it --restart=Never \
  -- nslookup kubernetes.default.svc.cluster.local || \
  echo "[FAIL] DNS resolution failed"

# 4. Check networking
echo ""
echo "--- Network Connectivity ---"
kubectl run net-test --image=nicolaka/netshoot --rm -it --restart=Never \
  -- curl -s --max-time 5 https://kubernetes.default.svc.cluster.local/healthz \
  --cacert /var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
  --header "Authorization: Bearer $(cat /var/run/secrets/kubernetes.io/serviceaccount/token)" || \
  echo "[FAIL] Internal API connectivity failed"

# 5. Check application pods
echo ""
echo "--- Application Pod Health ---"
FAILING_APP_PODS=$(kubectl get pods -A --no-headers | \
  grep -v "kube-system\|kube-public\|kube-node-lease" | \
  grep -vE "Running|Completed|Succeeded" | wc -l)
if [ "${FAILING_APP_PODS}" -eq 0 ]; then
    echo "[PASS] All application pods are running"
else
    echo "[WARN] ${FAILING_APP_PODS} application pods are not running"
fi

# 6. Run cluster conformance smoke test (optional)
echo ""
echo "--- API Server Validation ---"
kubectl auth can-i "*" "*" --all-namespaces >/dev/null && \
  echo "[PASS] API server is accepting requests" || \
  echo "[FAIL] API server authorization check failed"

echo ""
echo "=== Validation Complete ==="
```

### Rollback Procedure

Kubernetes doesn't support direct downgrade of the control plane. Recovery options:

```bash
# Option 1: Restore from etcd backup (most reliable)
# This requires stopping the cluster and restoring etcd state

# Stop kube-apiserver (remove manifest from staticPodPath)
mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/

# Restore etcd from backup
ETCDCTL_API=3 etcdctl snapshot restore /backup/etcd/snapshot-before-upgrade.db \
    --data-dir=/var/lib/etcd-restored \
    --name=master-1 \
    --initial-cluster=master-1=https://10.0.0.10:2380 \
    --initial-cluster-token=etcd-cluster-1 \
    --initial-advertise-peer-urls=https://10.0.0.10:2380

# Replace etcd data directory
mv /var/lib/etcd /var/lib/etcd-backup
mv /var/lib/etcd-restored /var/lib/etcd

# Restore kube-apiserver manifest
mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/

# Option 2: For EKS - rollback is done by re-creating the cluster
# This is why blue-green cluster upgrades are popular for EKS

# Option 3: For worker nodes - uncordon and keep old nodes
# If you provisioned new nodes for upgrade, simply delete the new nodes
# and uncordon the old ones
kubectl uncordon <old-node>
kubectl delete node <new-node>
```

## Section 7: Upgrade Windows and Change Management

### Calculating Upgrade Windows

```bash
# Estimate upgrade duration
TOTAL_NODES=$(kubectl get nodes --no-headers | wc -l)
CONTROL_PLANE=$(kubectl get nodes -l node-role.kubernetes.io/control-plane --no-headers | wc -l)
WORKERS=$((TOTAL_NODES - CONTROL_PLANE))
CONCURRENCY=2  # Worker nodes upgraded simultaneously

# Estimate: 15 min per control plane node, 8 min per worker node batch
CP_TIME=$((CONTROL_PLANE * 15))
WORKER_TIME=$(( (WORKERS / CONCURRENCY + 1) * 8 ))
TOTAL_MINUTES=$((CP_TIME + WORKER_TIME + 30))  # +30 for pre/post checks

echo "Estimated upgrade duration: ${TOTAL_MINUTES} minutes"
echo "Recommended maintenance window: $((TOTAL_MINUTES * 2)) minutes"
```

### Upgrade Notification Template

```markdown
# Kubernetes Cluster Upgrade Notice

**Cluster**: production-us-east-1
**Current Version**: 1.27.x
**Target Version**: 1.28.x
**Scheduled Window**: Saturday 2024-02-10, 2:00 AM - 6:00 AM EST

## Expected Impact
- Control plane upgrade: 0-5 minutes API server instability (short-lived)
- Worker node rolling upgrade: workloads with single replicas will experience brief restarts
- Estimated total duration: 90 minutes

## Validation Steps
1. Pre-upgrade checks run at T-24 hours
2. etcd backup taken at start of window
3. Control plane upgraded first
4. 30-minute observation period before worker node drain
5. Post-upgrade validation tests run after completion

## Rollback Criteria
Automatic rollback if any of the following occur:
- Control plane upgrade exceeds 30 minutes
- More than 10% of pods fail to reschedule within 15 minutes
- Core system pods (CoreDNS, CNI, metrics-server) remain unhealthy

## Contact
On-call engineer: @platform-team-oncall
Slack channel: #kubernetes-upgrades
```

## Section 8: Key Takeaways

- Always follow the version skew policy: control plane must be upgraded before worker nodes, and skipping minor versions is not supported
- Create etcd backups immediately before every upgrade
- Run pre-upgrade validation scripts to catch deprecated APIs, unhealthy pods, and blocking PDBs before the maintenance window starts
- For RKE2, use the system-upgrade-controller for automated, coordinated node upgrades
- For EKS, upgrade in order: control plane, then managed add-ons, then node groups
- Keep concurrency at 1 for control plane nodes and 2-3 for worker nodes to maintain application availability
- Post-upgrade validation should include DNS tests, API connectivity tests, and pod health checks
- Document your rollback procedure and test it annually - not on the night of an incident
