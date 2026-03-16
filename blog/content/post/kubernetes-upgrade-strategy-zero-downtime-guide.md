---
title: "Kubernetes Cluster Upgrade Strategy: Zero-Downtime Procedures for Control Plane and Nodes"
date: 2027-05-23T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Upgrade", "kubeadm", "Node Management", "High Availability", "SRE"]
categories: ["Kubernetes", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes cluster upgrade procedures covering version skew policy, kubeadm upgrade workflows, etcd backup pre-upgrade, worker node drain and upgrade sequences, PodDisruptionBudgets, managed Kubernetes upgrades for EKS, GKE, and AKS, in-place vs blue/green node pool strategies, and post-upgrade validation runbooks."
more_link: "yes"
url: "/kubernetes-upgrade-strategy-zero-downtime-guide/"
---

Kubernetes cluster upgrades are among the highest-risk operations in the Kubernetes lifecycle. A single missequenced step—upgrading a worker node before the control plane, skipping a minor version, or draining nodes without PodDisruptionBudgets—can result in extended downtime, workload disruption, or an unrecoverable cluster state. Production teams need a repeatable, documented upgrade procedure that accounts for version skew constraints, etcd consistency, application availability guarantees, and rollback paths. This guide covers the full upgrade lifecycle from planning through validation, with procedures for self-managed kubeadm clusters and managed Kubernetes services (EKS, GKE, AKS).

<!--more-->

## Kubernetes Version Skew Policy

Kubernetes defines strict version skew constraints between components. Violating these constraints leads to incompatible API behavior and potential cluster instability:

### kube-apiserver Skew Rules

- **kube-apiserver** must be newer than or equal to other control plane components
- **kubelet** can be at most 2 minor versions behind kube-apiserver (e.g., apiserver 1.29, kubelet 1.27 is supported)
- **kube-controller-manager** and **kube-scheduler** must not be newer than kube-apiserver
- **kubectl** can be one minor version above or below the apiserver

```
Supported skew for kube-apiserver 1.29:
  kube-controller-manager: 1.28 or 1.29
  kube-scheduler:          1.28 or 1.29
  kubelet:                 1.27, 1.28, or 1.29
  kubectl:                 1.28, 1.29, or 1.30
```

### Version Upgrade Sequence Constraints

- Upgrades must be sequential minor version by minor version (1.27 -> 1.28 -> 1.29). Skipping minor versions is not supported.
- Control plane components must be upgraded before worker nodes
- Among control plane nodes, the apiserver is upgraded first, then controller-manager and scheduler

```
Upgrade sequence for a cluster from 1.27 to 1.29:

Step 1: Upgrade to 1.28
  1. Back up etcd
  2. Upgrade control plane node 1 (apiserver, controller-manager, scheduler, etcd)
  3. Upgrade control plane node 2
  4. Upgrade control plane node 3
  5. Upgrade worker nodes (drain → upgrade kubelet/kubeadm → uncordon)

Step 2: Upgrade to 1.29 (same procedure)
```

## Pre-Upgrade Preparation

### Environment Assessment

```bash
# Current cluster version
kubectl version --short

# All node versions
kubectl get nodes -o wide

# API server version
kubectl get nodes -o jsonpath='{.items[0].status.nodeInfo.kubeletVersion}'

# Deprecated API usage (use pluto)
curl -LO https://github.com/FairwindsOps/pluto/releases/latest/download/pluto_linux_amd64.tar.gz
tar -xzf pluto_linux_amd64.tar.gz
./pluto detect-all-in-cluster

# Check for any API deprecations in your manifests
./pluto detect-files -d ./kubernetes/

# Check addon compatibility
# cert-manager, ingress-nginx, prometheus-operator, etc. have version-specific K8s requirements
```

### Workload Readiness Assessment

```bash
# Check for single-replica deployments (zero-downtime risk)
kubectl get deployment --all-namespaces \
  -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,REPLICAS:.spec.replicas' \
  | awk '$3 == 1'

# Check for missing PodDisruptionBudgets
# List deployments with no matching PDB
for ns in $(kubectl get namespaces -o jsonpath='{.items[*].metadata.name}'); do
  for deploy in $(kubectl get deployment -n $ns -o jsonpath='{.items[*].metadata.name}'); do
    pdb=$(kubectl get pdb -n $ns --field-selector='metadata.name'=$deploy 2>/dev/null | wc -l)
    if [ "$pdb" -eq "0" ]; then
      echo "Missing PDB: $ns/$deploy"
    fi
  done
done

# Check node taints that may prevent rescheduling
kubectl get nodes -o custom-columns='NAME:.metadata.name,TAINTS:.spec.taints'

# Verify cluster-critical PDBs are in place
kubectl get pdb --all-namespaces
```

### etcd Backup Before Upgrade

etcd backup is non-negotiable before any control plane upgrade. A failed upgrade mid-way requires restoring from backup:

```bash
# On a control plane node, identify etcd pod and credentials
kubectl -n kube-system get pod -l component=etcd -o wide

# Get etcd certificates location
ETCD_CERT_DIR=/etc/kubernetes/pki/etcd
ETCDCTL_API=3
ETCDCTL_ENDPOINTS=https://127.0.0.1:2379
ETCDCTL_CACERT=${ETCD_CERT_DIR}/ca.crt
ETCDCTL_CERT=${ETCD_CERT_DIR}/server.crt
ETCDCTL_KEY=${ETCD_CERT_DIR}/server.key

# Verify etcd cluster health
etcdctl \
  --endpoints=${ETCDCTL_ENDPOINTS} \
  --cacert=${ETCDCTL_CACERT} \
  --cert=${ETCDCTL_CERT} \
  --key=${ETCDCTL_KEY} \
  endpoint health

etcdctl \
  --endpoints=${ETCDCTL_ENDPOINTS} \
  --cacert=${ETCDCTL_CACERT} \
  --cert=${ETCDCTL_CERT} \
  --key=${ETCDCTL_KEY} \
  endpoint status -w table

# Create snapshot backup
BACKUP_DIR=/var/lib/etcd-backups
BACKUP_FILE="${BACKUP_DIR}/etcd-snapshot-$(date +%Y%m%d-%H%M%S).db"
mkdir -p ${BACKUP_DIR}

etcdctl \
  --endpoints=${ETCDCTL_ENDPOINTS} \
  --cacert=${ETCDCTL_CACERT} \
  --cert=${ETCDCTL_CERT} \
  --key=${ETCDCTL_KEY} \
  snapshot save ${BACKUP_FILE}

# Verify backup integrity
etcdctl snapshot status ${BACKUP_FILE} -w table

# Copy backup off-node
scp ${BACKUP_FILE} backup-storage:/etcd-backups/
# Or upload to S3
aws s3 cp ${BACKUP_FILE} s3://my-cluster-backups/etcd/

echo "etcd backup complete: ${BACKUP_FILE}"
```

### Automated Pre-Upgrade etcd Backup (CronJob)

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: etcd-backup
  namespace: kube-system
spec:
  schedule: "0 2 * * *"  # Daily at 2 AM
  successfulJobsHistoryLimit: 7
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          hostNetwork: true
          tolerations:
          - key: node-role.kubernetes.io/control-plane
            operator: Exists
            effect: NoSchedule
          nodeSelector:
            node-role.kubernetes.io/control-plane: ""
          containers:
          - name: etcd-backup
            image: bitnami/etcd:3.5.11
            command:
            - /bin/sh
            - -c
            - |
              BACKUP_FILE="/backup/etcd-$(date +%Y%m%d-%H%M%S).db"
              etcdctl \
                --endpoints=https://127.0.0.1:2379 \
                --cacert=/etc/kubernetes/pki/etcd/ca.crt \
                --cert=/etc/kubernetes/pki/etcd/server.crt \
                --key=/etc/kubernetes/pki/etcd/server.key \
                snapshot save ${BACKUP_FILE}
              etcdctl snapshot status ${BACKUP_FILE}
              aws s3 cp ${BACKUP_FILE} s3://my-cluster-backups/etcd/
              # Remove backups older than 30 days
              find /backup -name "*.db" -mtime +30 -delete
            volumeMounts:
            - name: etcd-certs
              mountPath: /etc/kubernetes/pki/etcd
              readOnly: true
            - name: backup-dir
              mountPath: /backup
            env:
            - name: ETCDCTL_API
              value: "3"
            - name: AWS_REGION
              value: us-east-1
          volumes:
          - name: etcd-certs
            hostPath:
              path: /etc/kubernetes/pki/etcd
          - name: backup-dir
            hostPath:
              path: /var/lib/etcd-backups
          restartPolicy: OnFailure
```

## kubeadm Upgrade Procedure

### Step 1: Upgrade kubeadm on First Control Plane Node

```bash
# On the first control plane node
# Check available versions
apt-cache madison kubeadm | head -20
# Or for RPM-based:
# yum list --showduplicates kubeadm | head -20

# Upgrade kubeadm (Ubuntu/Debian example for 1.28 -> 1.29)
apt-mark unhold kubeadm
apt-get update && apt-get install -y kubeadm=1.29.0-1.1
apt-mark hold kubeadm

# Verify kubeadm version
kubeadm version

# Check upgrade plan
kubeadm upgrade plan

# Expected output:
# COMPONENT                 CURRENT   TARGET
# kube-apiserver            v1.28.5   v1.29.0
# kube-controller-manager   v1.28.5   v1.29.0
# kube-scheduler            v1.28.5   v1.29.0
# kube-proxy                v1.28.5   v1.29.0
# CoreDNS                   v1.10.1   v1.11.1
# etcd                      3.5.9     3.5.10
```

### Step 2: Apply Upgrade to First Control Plane Node

```bash
# Apply the upgrade (substitute the target version)
kubeadm upgrade apply v1.29.0

# The upgrade will:
# 1. Verify upgrade prerequisites
# 2. Download the required container images
# 3. Upgrade the control plane components
# 4. Update the cluster's kubeadm config
# 5. Apply any required RBAC rules and ServiceAccounts
# 6. Update kube-proxy DaemonSet
# 7. Update CoreDNS

# Monitor the output carefully - look for:
# [upgrade/successful] SUCCESS! Your cluster was upgraded to "v1.29.0"
```

### Step 3: Upgrade kubelet and kubectl on First Control Plane Node

```bash
# Drain the node before upgrading kubelet
kubectl drain control-plane-1 \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --grace-period=60 \
  --timeout=5m

# Upgrade kubelet and kubectl
apt-mark unhold kubelet kubectl
apt-get update && apt-get install -y kubelet=1.29.0-1.1 kubectl=1.29.0-1.1
apt-mark hold kubelet kubectl

# Restart kubelet
systemctl daemon-reload
systemctl restart kubelet

# Verify kubelet version
systemctl status kubelet
kubectl get node control-plane-1

# Uncordon the node
kubectl uncordon control-plane-1

# Verify node is Ready
kubectl get node control-plane-1
# NAME               STATUS   ROLES           AGE    VERSION
# control-plane-1    Ready    control-plane   365d   v1.29.0
```

### Step 4: Upgrade Additional Control Plane Nodes

For multi-node control planes, upgrade remaining control plane nodes one at a time. Use `upgrade node` instead of `upgrade apply`:

```bash
# On control-plane-2 and control-plane-3

# Upgrade kubeadm
apt-mark unhold kubeadm
apt-get update && apt-get install -y kubeadm=1.29.0-1.1
apt-mark hold kubeadm

# Upgrade this node's control plane components
kubeadm upgrade node

# Drain the node
kubectl drain control-plane-2 \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --grace-period=60

# Upgrade kubelet and kubectl
apt-mark unhold kubelet kubectl
apt-get update && apt-get install -y kubelet=1.29.0-1.1 kubectl=1.29.0-1.1
apt-mark hold kubelet kubectl

systemctl daemon-reload
systemctl restart kubelet

# Uncordon
kubectl uncordon control-plane-2

# Verify before proceeding to control-plane-3
kubectl get nodes
```

### Step 5: Upgrade Worker Nodes

Worker node upgrades follow a drain → upgrade → uncordon pattern. Process one or a few nodes at a time depending on cluster capacity and PDB constraints:

```bash
#!/bin/bash
# worker-upgrade.sh - Upgrade a single worker node

set -euo pipefail

NODE=$1
TARGET_VERSION=${2:-"1.29.0-1.1"}

echo "=== Starting upgrade for node: ${NODE} ==="

# Step 1: Cordon the node (prevent new pod scheduling)
echo "Cordoning ${NODE}..."
kubectl cordon ${NODE}

# Step 2: Drain the node
echo "Draining ${NODE}..."
kubectl drain ${NODE} \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --grace-period=120 \
  --timeout=10m \
  --force=false  # Do not force if pods have no controller

# Step 3: Upgrade kubeadm on the worker
echo "Upgrading kubeadm on ${NODE}..."
ssh ${NODE} "apt-mark unhold kubeadm && \
  apt-get update && \
  apt-get install -y kubeadm=${TARGET_VERSION} && \
  apt-mark hold kubeadm"

# Step 4: Apply node upgrade configuration
echo "Applying node upgrade on ${NODE}..."
ssh ${NODE} "kubeadm upgrade node"

# Step 5: Upgrade kubelet and kubectl
echo "Upgrading kubelet on ${NODE}..."
ssh ${NODE} "apt-mark unhold kubelet kubectl && \
  apt-get update && \
  apt-get install -y kubelet=${TARGET_VERSION} kubectl=${TARGET_VERSION} && \
  apt-mark hold kubelet kubectl && \
  systemctl daemon-reload && \
  systemctl restart kubelet"

# Step 6: Wait for node to be Ready
echo "Waiting for ${NODE} to be Ready..."
kubectl wait node ${NODE} \
  --for=condition=Ready \
  --timeout=5m

# Step 7: Uncordon the node
echo "Uncordoning ${NODE}..."
kubectl uncordon ${NODE}

# Step 8: Verify node version
NODE_VERSION=$(kubectl get node ${NODE} -o jsonpath='{.status.nodeInfo.kubeletVersion}')
echo "=== Upgrade complete for ${NODE}: ${NODE_VERSION} ==="
```

```bash
# Run upgrade for all worker nodes sequentially
WORKER_NODES=$(kubectl get nodes --selector='!node-role.kubernetes.io/control-plane' \
  -o jsonpath='{.items[*].metadata.name}')

for NODE in ${WORKER_NODES}; do
  ./worker-upgrade.sh ${NODE} "1.29.0-1.1"
  echo "Sleeping 30s before next node..."
  sleep 30
done
```

## PodDisruptionBudgets During Upgrades

PodDisruptionBudgets prevent drain operations from evicting too many pods simultaneously:

```yaml
# Ensure critical services have PDBs before upgrading
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-server-pdb
  namespace: production
spec:
  selector:
    matchLabels:
      app: api-server
  maxUnavailable: 1  # Allow 1 pod to be unavailable during drain

---
# For stateful services, be more conservative
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: database-pdb
  namespace: production
spec:
  selector:
    matchLabels:
      app: database
  minAvailable: 2  # Require at least 2 pods to remain available

---
# Percentage-based PDB for large deployments
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: worker-pdb
  namespace: production
spec:
  selector:
    matchLabels:
      app: worker
  minAvailable: "80%"  # Keep 80% available during disruptions
```

### Handling Drain Blocked by PDB

```bash
# If drain is blocked by a PDB, check which PDB is blocking
kubectl get events -n production --field-selector reason=Evicting

# Check which PDB is preventing eviction
kubectl get pdb -n production

# If the PDB is too restrictive for the upgrade, you can temporarily patch it
# (only do this in planned maintenance windows)
kubectl patch pdb api-server-pdb -n production \
  --type merge \
  -p '{"spec":{"maxUnavailable":2}}'

# Proceed with drain
kubectl drain worker-node-1 --ignore-daemonsets --delete-emptydir-data

# Restore PDB after drain completes
kubectl patch pdb api-server-pdb -n production \
  --type merge \
  -p '{"spec":{"maxUnavailable":1}}'
```

## Managed Kubernetes Upgrade Procedures

### EKS (Amazon Elastic Kubernetes Service)

EKS provides a managed control plane. Control plane upgrades are triggered via the EKS console or CLI and are performed by AWS:

```bash
# Check current EKS cluster version
aws eks describe-cluster --name my-cluster \
  --query 'cluster.version' --output text

# Check available upgrade versions
aws eks describe-addon-versions \
  --kubernetes-version 1.29 \
  --query 'addons[0].addonVersions[0].compatibilities'

# Upgrade the control plane
aws eks update-cluster-version \
  --name my-cluster \
  --kubernetes-version 1.29

# Monitor upgrade status
aws eks describe-update \
  --name my-cluster \
  --update-id <update-id>

# Wait for upgrade to complete (can take 20-30 minutes)
aws eks wait cluster-active --name my-cluster
```

```bash
# Upgrade EKS managed node groups
# Method 1: Rolling update (default)
aws eks update-nodegroup-version \
  --cluster-name my-cluster \
  --nodegroup-name application-nodes \
  --kubernetes-version 1.29 \
  --update-config '{"maxUnavailable": 1}'

# Method 2: Force update (ignores PDB constraints - use only in emergencies)
aws eks update-nodegroup-version \
  --cluster-name my-cluster \
  --nodegroup-name application-nodes \
  --kubernetes-version 1.29 \
  --force

# Monitor node group upgrade
aws eks describe-nodegroup \
  --cluster-name my-cluster \
  --nodegroup-name application-nodes \
  --query 'nodegroup.status'
```

```bash
# Upgrade EKS add-ons after control plane upgrade
# List current add-on versions
aws eks list-addons --cluster-name my-cluster

# Get recommended add-on version for new K8s version
aws eks describe-addon-versions \
  --addon-name vpc-cni \
  --kubernetes-version 1.29 \
  --query 'addons[0].addonVersions[0].addonVersion'

# Upgrade each add-on
for ADDON in vpc-cni kube-proxy coredns aws-ebs-csi-driver; do
  LATEST_VERSION=$(aws eks describe-addon-versions \
    --addon-name ${ADDON} \
    --kubernetes-version 1.29 \
    --query 'addons[0].addonVersions[0].addonVersion' \
    --output text)

  aws eks update-addon \
    --cluster-name my-cluster \
    --addon-name ${ADDON} \
    --addon-version ${LATEST_VERSION} \
    --resolve-conflicts OVERWRITE
done
```

### GKE (Google Kubernetes Engine)

```bash
# Check available upgrade channels
gcloud container get-server-config \
  --zone us-central1-a \
  --format="yaml(channels)"

# Upgrade GKE control plane
gcloud container clusters upgrade my-cluster \
  --master \
  --cluster-version 1.29.0-gke.1000 \
  --zone us-central1-a

# Upgrade a specific node pool
gcloud container clusters upgrade my-cluster \
  --node-pool application-pool \
  --cluster-version 1.29.0-gke.1000 \
  --zone us-central1-a \
  --max-surge-upgrade 1 \
  --max-unavailable-upgrade 0

# Monitor upgrade progress
gcloud container operations list \
  --filter="operationType=UPGRADE_CLUSTER" \
  --sort-by="~startTime"
```

### AKS (Azure Kubernetes Service)

```bash
# Check available upgrade versions
az aks get-upgrades \
  --resource-group my-rg \
  --name my-cluster \
  --output table

# Upgrade the control plane
az aks upgrade \
  --resource-group my-rg \
  --name my-cluster \
  --kubernetes-version 1.29.0 \
  --no-wait

# Monitor upgrade
az aks show \
  --resource-group my-rg \
  --name my-cluster \
  --query provisioningState

# Upgrade a specific node pool
az aks nodepool upgrade \
  --resource-group my-rg \
  --cluster-name my-cluster \
  --name agentpool \
  --kubernetes-version 1.29.0 \
  --max-surge 1
```

## In-Place vs Blue/Green Node Pool Strategy

### In-Place Node Upgrade

Upgrade existing nodes by draining and reimaging them. Simpler but has a brief period where cluster capacity is reduced.

**Pros**: Simpler, no IP address changes, preserves node labels and taints.
**Cons**: Temporary capacity reduction, rollback requires re-upgrading (complex).

```bash
# In-place upgrade script for a node pool
drain_and_upgrade_pool() {
  POOL_NODES=$(kubectl get nodes -l nodepool=application \
    -o jsonpath='{.items[*].metadata.name}')

  for NODE in ${POOL_NODES}; do
    echo "Processing ${NODE}"
    kubectl drain ${NODE} \
      --ignore-daemonsets \
      --delete-emptydir-data \
      --grace-period=120 \
      --timeout=10m

    # Upgrade (cloud-specific - example for AWS)
    aws ec2 replace-launch-template-version \
      --launch-template-id lt-12345 \
      --source-version 1 \
      --launch-template-data '{"ImageId":"ami-new-eks-1-29"}'

    # Terminate and let ASG replace with new AMI
    INSTANCE_ID=$(aws ec2 describe-instances \
      --filters "Name=private-dns-name,Values=${NODE}" \
      --query 'Reservations[0].Instances[0].InstanceId' --output text)
    aws ec2 terminate-instances --instance-ids ${INSTANCE_ID}

    # Wait for new node to join
    sleep 120
    kubectl uncordon ${NODE}  # If ASG brings back same name
  done
}
```

### Blue/Green Node Pool Strategy

Create a new node pool with the target Kubernetes version, migrate workloads, then delete the old pool. This is the preferred approach for production clusters as it allows instant rollback.

```bash
#!/bin/bash
# blue-green-node-pool-upgrade.sh

set -euo pipefail

CLUSTER_NAME="my-cluster"
OLD_POOL="application-v1-28"
NEW_POOL="application-v1-29"
NEW_K8S_VERSION="1.29.0"
NODE_TYPE="m5.2xlarge"
DESIRED_SIZE=5
MIN_SIZE=3
MAX_SIZE=20

echo "=== Phase 1: Create new node pool with target version ==="

# AWS EKS example
aws eks create-nodegroup \
  --cluster-name ${CLUSTER_NAME} \
  --nodegroup-name ${NEW_POOL} \
  --kubernetes-version ${NEW_K8S_VERSION} \
  --node-role arn:aws:iam::123456789012:role/eks-node-role \
  --subnets subnet-aaa subnet-bbb subnet-ccc \
  --instance-types ${NODE_TYPE} \
  --scaling-config minSize=${MIN_SIZE},maxSize=${MAX_SIZE},desiredSize=${DESIRED_SIZE} \
  --labels "nodepool=${NEW_POOL},version=v1-29" \
  --update-config maxUnavailable=1

echo "Waiting for new node pool to be Active..."
aws eks wait nodegroup-active \
  --cluster-name ${CLUSTER_NAME} \
  --nodegroup-name ${NEW_POOL}

echo "=== Phase 2: Validate new nodes are healthy ==="
kubectl get nodes -l "nodepool=${NEW_POOL}"
kubectl wait node \
  --selector="nodepool=${NEW_POOL}" \
  --for=condition=Ready \
  --timeout=10m

echo "=== Phase 3: Taint old nodes to prevent new scheduling ==="
OLD_NODES=$(kubectl get nodes -l "nodepool=${OLD_POOL}" \
  -o jsonpath='{.items[*].metadata.name}')
for NODE in ${OLD_NODES}; do
  kubectl taint node ${NODE} \
    "deprecation=drain-in-progress:NoSchedule" \
    --overwrite
done

echo "=== Phase 4: Drain old nodes one by one ==="
for NODE in ${OLD_NODES}; do
  echo "Draining ${NODE}..."
  kubectl drain ${NODE} \
    --ignore-daemonsets \
    --delete-emptydir-data \
    --grace-period=120 \
    --timeout=15m

  echo "Waiting 60s before draining next node..."
  sleep 60
done

echo "=== Phase 5: Verify all workloads running on new nodes ==="
kubectl get pods --all-namespaces \
  -o wide \
  --field-selector spec.nodeName!="" \
  | grep "${OLD_POOL}" && echo "WARNING: Some pods still on old nodes" || echo "All pods migrated to new nodes"

echo "=== Phase 6: Delete old node pool (after validation) ==="
echo "Review the above output. Press ENTER to delete old pool or Ctrl-C to abort."
read

aws eks delete-nodegroup \
  --cluster-name ${CLUSTER_NAME} \
  --nodegroup-name ${OLD_POOL}

echo "=== Blue/green node pool upgrade complete ==="
```

### Rollback Procedure for Blue/Green

```bash
# If issues are found after migrating to new pool:
# 1. Remove taint from old nodes
OLD_NODES=$(kubectl get nodes -l "nodepool=${OLD_POOL}" \
  -o jsonpath='{.items[*].metadata.name}')
for NODE in ${OLD_NODES}; do
  kubectl taint node ${NODE} "deprecation:NoSchedule-" || true
  kubectl uncordon ${NODE}
done

# 2. Taint new nodes
NEW_NODES=$(kubectl get nodes -l "nodepool=${NEW_POOL}" \
  -o jsonpath='{.items[*].metadata.name}')
for NODE in ${NEW_NODES}; do
  kubectl taint node ${NODE} "rollback=in-progress:NoSchedule"
  kubectl drain ${NODE} \
    --ignore-daemonsets \
    --delete-emptydir-data \
    --grace-period=120
done

# 3. Delete new (failed) node pool
aws eks delete-nodegroup \
  --cluster-name my-cluster \
  --nodegroup-name ${NEW_POOL}

echo "Rollback complete - workloads restored to old node pool"
```

## Node Surge Upgrade Strategy

Node surge creates additional nodes before draining old ones, ensuring cluster capacity never decreases during the upgrade. This eliminates the temporary capacity reduction of in-place upgrades:

```bash
# EKS managed node group with surge configuration
aws eks update-nodegroup-version \
  --cluster-name my-cluster \
  --nodegroup-name application-nodes \
  --kubernetes-version 1.29 \
  --update-config '{
    "maxUnavailable": 0,
    "maxUnavailablePercentage": null
  }'

# This creates 1 new node per unavailable node, default behavior
# For faster upgrades, specify maxUnavailable > 0 but this risks capacity reduction

# GKE surge upgrade
gcloud container clusters upgrade my-cluster \
  --node-pool application-pool \
  --cluster-version 1.29.0-gke.1000 \
  --max-surge-upgrade 2 \
  --max-unavailable-upgrade 0 \
  --zone us-central1-a
```

## Post-Upgrade Validation

### Automated Post-Upgrade Checks

```bash
#!/bin/bash
# post-upgrade-validation.sh

set -euo pipefail

TARGET_VERSION=${1:-"v1.29.0"}
FAILURES=0

echo "=== Post-Upgrade Validation ==="

# Check 1: All nodes at target version
echo "Checking node versions..."
NON_TARGET=$(kubectl get nodes \
  -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.nodeInfo.kubeletVersion}{"\n"}{end}' \
  | grep -v "${TARGET_VERSION}" | wc -l)
if [ "${NON_TARGET}" -gt "0" ]; then
  echo "FAIL: ${NON_TARGET} nodes not at target version ${TARGET_VERSION}"
  kubectl get nodes -o wide
  FAILURES=$((FAILURES + 1))
else
  echo "PASS: All nodes at version ${TARGET_VERSION}"
fi

# Check 2: All nodes Ready
echo "Checking node readiness..."
NOT_READY=$(kubectl get nodes \
  --field-selector='status.conditions[?(@.type=="Ready")].status!=True' \
  -o name | wc -l)
if [ "${NOT_READY}" -gt "0" ]; then
  echo "FAIL: ${NOT_READY} nodes not Ready"
  FAILURES=$((FAILURES + 1))
else
  echo "PASS: All nodes Ready"
fi

# Check 3: System pods healthy
echo "Checking system pod health..."
SYSTEM_NOT_RUNNING=$(kubectl get pods -n kube-system \
  --field-selector='status.phase!=Running,status.phase!=Succeeded' \
  -o name | wc -l)
if [ "${SYSTEM_NOT_RUNNING}" -gt "0" ]; then
  echo "FAIL: ${SYSTEM_NOT_RUNNING} system pods not Running"
  kubectl get pods -n kube-system | grep -v Running | grep -v Completed
  FAILURES=$((FAILURES + 1))
else
  echo "PASS: All system pods Running"
fi

# Check 4: API server responding
echo "Checking API server health..."
kubectl cluster-info > /dev/null 2>&1 || {
  echo "FAIL: API server not responding"
  FAILURES=$((FAILURES + 1))
}
echo "PASS: API server responding"

# Check 5: Core DNS working
echo "Checking CoreDNS..."
kubectl run dns-test \
  --image=busybox:latest \
  --restart=Never \
  --rm \
  -it \
  --timeout=30s \
  -- nslookup kubernetes.default.svc.cluster.local > /dev/null 2>&1 || {
  echo "FAIL: DNS resolution not working"
  FAILURES=$((FAILURES + 1))
}
echo "PASS: DNS resolution working"

# Check 6: No crashlooping pods
echo "Checking for CrashLoopBackOff pods..."
CRASH_PODS=$(kubectl get pods --all-namespaces \
  -o jsonpath='{range .items[*]}{.metadata.namespace}{" "}{.metadata.name}{" "}{range .status.containerStatuses[*]}{.state.waiting.reason}{"\n"}{end}{end}' \
  | grep "CrashLoopBackOff" | wc -l)
if [ "${CRASH_PODS}" -gt "0" ]; then
  echo "WARN: ${CRASH_PODS} pods in CrashLoopBackOff"
  kubectl get pods --all-namespaces | grep CrashLoopBackOff
  FAILURES=$((FAILURES + 1))
else
  echo "PASS: No pods in CrashLoopBackOff"
fi

# Check 7: Pending pods
echo "Checking for Pending pods..."
PENDING=$(kubectl get pods --all-namespaces \
  --field-selector=status.phase=Pending \
  -o name | wc -l)
if [ "${PENDING}" -gt "0" ]; then
  echo "WARN: ${PENDING} pods pending"
  kubectl get pods --all-namespaces --field-selector=status.phase=Pending
fi

# Check 8: Storage (PVCs bound)
echo "Checking PersistentVolumeClaims..."
UNBOUND_PVC=$(kubectl get pvc --all-namespaces \
  --field-selector=status.phase!=Bound \
  -o name | wc -l)
if [ "${UNBOUND_PVC}" -gt "0" ]; then
  echo "WARN: ${UNBOUND_PVC} PVCs not Bound"
  kubectl get pvc --all-namespaces | grep -v Bound
fi

# Check 9: Verify key deployments are available
echo "Checking deployment availability..."
UNAVAILABLE=$(kubectl get deployments --all-namespaces \
  -o jsonpath='{range .items[*]}{.metadata.namespace}{" "}{.metadata.name}{" "}{.status.unavailableReplicas}{"\n"}{end}' \
  | awk '$3 > 0')
if [ -n "${UNAVAILABLE}" ]; then
  echo "WARN: Some deployments have unavailable replicas:"
  echo "${UNAVAILABLE}"
fi

# Check 10: etcd health
echo "Checking etcd cluster health..."
kubectl -n kube-system exec \
  $(kubectl -n kube-system get pods -l component=etcd -o jsonpath='{.items[0].metadata.name}') \
  -- etcdctl \
    --endpoints=https://127.0.0.1:2379 \
    --cacert=/etc/kubernetes/pki/etcd/ca.crt \
    --cert=/etc/kubernetes/pki/etcd/server.crt \
    --key=/etc/kubernetes/pki/etcd/server.key \
    endpoint health 2>&1 || {
  echo "FAIL: etcd health check failed"
  FAILURES=$((FAILURES + 1))
}

echo ""
echo "=== Validation Summary ==="
if [ "${FAILURES}" -eq "0" ]; then
  echo "PASS: All checks passed"
  exit 0
else
  echo "FAIL: ${FAILURES} checks failed - review output above"
  exit 1
fi
```

### API Deprecation Validation Post-Upgrade

```bash
# Re-run pluto after upgrade to catch any missed deprecated API usage
./pluto detect-all-in-cluster \
  --target-versions k8s=v1.29.0

# Check kube-apiserver audit logs for deprecated API calls
kubectl logs -n kube-system kube-apiserver-control-plane-1 \
  | grep '"k8s.io/deprecated"' \
  | jq '.user.username, .requestURI' \
  | head -50
```

## Upgrade Rollback Procedures

### kubeadm Rollback (Control Plane)

kubeadm does not provide a direct rollback command. Control plane rollback requires etcd restoration:

```bash
# Stop kubeapi server
systemctl stop kubelet

# Move current etcd data directory
mv /var/lib/etcd /var/lib/etcd.failed

# Restore etcd from pre-upgrade backup
etcdctl snapshot restore ${BACKUP_FILE} \
  --data-dir /var/lib/etcd \
  --initial-cluster "control-plane-1=https://10.0.0.10:2380" \
  --initial-advertise-peer-urls https://10.0.0.10:2380 \
  --name control-plane-1

# Downgrade kubeadm, kubelet, kubectl
apt-get install -y \
  kubeadm=1.28.0-1.1 \
  kubelet=1.28.0-1.1 \
  kubectl=1.28.0-1.1

# Restore kubernetes static pod manifests from backup
# (back these up before upgrading)
cp /backup/kubernetes/manifests/*.yaml /etc/kubernetes/manifests/

# Start kubelet
systemctl start kubelet

# Verify control plane is healthy
kubectl get nodes
kubectl cluster-info
```

## Upgrade Communication Plan

Stakeholder communication during cluster upgrades follows a structured template:

```
Pre-Upgrade Notice (sent 5 business days before):
- Cluster: production-us-east-1
- Current Version: 1.28.5
- Target Version: 1.29.0
- Maintenance Window: Saturday, [Date], 22:00-02:00 UTC
- Expected Impact: Brief pod restarts during node drain/uncordon cycles
- Action Required: Ensure PodDisruptionBudgets are configured for critical services

During Upgrade (posted to #platform-ops channel):
- [22:00] Starting control plane upgrade
- [22:30] Control plane upgrade complete, starting worker node upgrades
- [23:30] Worker node upgrades 50% complete
- [00:15] Worker node upgrades 100% complete, running validation
- [00:30] Upgrade complete, all validation checks passed

Post-Upgrade Summary:
- Start Time: 22:00 UTC
- Completion Time: 00:30 UTC
- Cluster Version: 1.29.0
- Nodes Upgraded: 3 control plane, 15 worker
- Issues Encountered: None
- Validation Status: All checks passed
```
