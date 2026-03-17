---
title: "Kubernetes Cluster Upgrade Strategies: Zero-Downtime Upgrades for Production Clusters"
date: 2027-08-17T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Upgrades", "Operations"]
categories:
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Production Kubernetes cluster upgrade strategies covering in-place upgrades, blue-green cluster migration, canary node upgrades, pre-upgrade checklist, API deprecation handling, and post-upgrade validation for enterprise clusters."
more_link: "yes"
url: "/kubernetes-cluster-upgrade-strategies-guide/"
---

Kubernetes releases a new minor version approximately every four months, and each version is supported for about fourteen months. For production clusters, this means upgrades are not occasional events but a continuous operational discipline. A poorly executed upgrade can cause workload disruptions, API compatibility breaks, and hours of recovery work. A well-planned upgrade, by contrast, is transparent to end users. This guide covers the strategies, tooling, and step-by-step procedures used in enterprise production environments to upgrade Kubernetes clusters with zero workload downtime.

<!--more-->

## Upgrade Strategy Overview

Three primary strategies exist for production Kubernetes upgrades:

| Strategy | Risk | Complexity | Downtime Risk | Best For |
|----------|------|-----------|---------------|---------|
| In-place (rolling) | Medium | Low | None if done correctly | kubeadm, on-prem clusters |
| Blue-green cluster | Low | High | None | Cloud, GitOps-driven environments |
| Canary node pools | Low | Medium | None | Cloud-managed clusters (EKS, GKE, AKS) |

## Pre-Upgrade Checklist

Never begin a Kubernetes upgrade without completing this checklist. Skipping steps is the primary cause of upgrade incidents.

### 1. Version Skew Policy Verification

Kubernetes enforces specific version skew rules:

```
kube-apiserver:     N
kubelet:            N-2 (maximum skew)
kubectl:            N±1
kube-controller-manager: N or N-1
kube-scheduler:     N or N-1
etcd:               must match supported versions for that kube-apiserver
```

```bash
# Check current versions
kubectl version
kubectl get nodes -o custom-columns=NAME:.metadata.name,VERSION:.status.nodeInfo.kubeletVersion

# Check etcd version
kubectl -n kube-system exec -it etcd-control-plane-01 -- \
    etcdctl version --endpoints=https://127.0.0.1:2379 \
    --cacert=/etc/kubernetes/pki/etcd/ca.crt \
    --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
    --key=/etc/kubernetes/pki/etcd/healthcheck-client.key
```

### 2. API Deprecation Audit

```bash
# Install kubent (kube-no-trouble)
curl -sSL https://git.io/install-kubent | bash

# Scan for deprecated APIs
kubent --target-version 1.33

# Output example:
# ____________________________ 
# >>> Deprecated APIs:         
# ____________________________
# KIND            NAMESPACE   NAME          API_VERSION         REPLACE_WITH
# CronJob         production  backup-job    batch/v1beta1       batch/v1
# Ingress         staging     frontend      networking.k8s.io/v1beta1  networking.k8s.io/v1
```

Also use Pluto for CI/CD integration:

```bash
# Scan all cluster resources
pluto detect-all-in-cluster --target-versions k8s=v1.33.0

# Scan Helm releases
pluto detect-helm --target-versions k8s=v1.33.0
```

### 3. etcd Backup

```bash
#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="/var/backups/etcd"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/etcd-backup-${TIMESTAMP}.db"

mkdir -p "${BACKUP_DIR}"

ETCDCTL_API=3 etcdctl snapshot save "${BACKUP_FILE}" \
    --endpoints=https://127.0.0.1:2379 \
    --cacert=/etc/kubernetes/pki/etcd/ca.crt \
    --cert=/etc/kubernetes/pki/etcd/server.crt \
    --key=/etc/kubernetes/pki/etcd/server.key

# Verify the backup
ETCDCTL_API=3 etcdctl snapshot status "${BACKUP_FILE}" \
    --write-out=table

echo "Backup saved to ${BACKUP_FILE}"
echo "Size: $(du -sh ${BACKUP_FILE} | cut -f1)"

# Upload to S3 (replace bucket name with actual value)
aws s3 cp "${BACKUP_FILE}" "s3://YOUR_ETCD_BACKUP_BUCKET_REPLACE_ME/$(hostname)/$(basename ${BACKUP_FILE})"
```

### 4. Add-on Compatibility Check

```bash
# Check key add-on versions against target Kubernetes version
# CoreDNS compatibility matrix: https://github.com/coredns/coredns/blob/master/README.md

# Check Cluster Autoscaler (must match major.minor)
kubectl -n kube-system get deployment cluster-autoscaler -o jsonpath='{.spec.template.spec.containers[0].image}'

# Check cert-manager
kubectl -n cert-manager get deployment cert-manager -o jsonpath='{.spec.template.spec.containers[0].image}'

# Check ingress-nginx
kubectl -n ingress-nginx get deployment ingress-nginx-controller -o jsonpath='{.spec.template.spec.containers[0].image}'

# Check all Helm releases for chart compatibility
helm list --all-namespaces
```

### 5. Workload Health Assessment

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "=== Pre-Upgrade Workload Health Check ==="

# Check for any non-running pods
echo "--- Non-running pods ---"
kubectl get pods --all-namespaces \
    --field-selector 'status.phase!=Running,status.phase!=Succeeded' \
    --no-headers | grep -v "Completed" || echo "None found"

# Check PodDisruptionBudgets at minimum
echo "--- PDBs allowing zero disruptions ---"
kubectl get pdb --all-namespaces -o json | jq -r '
    .items[] |
    select(.status.disruptionsAllowed == 0) |
    "\(.metadata.namespace)/\(.metadata.name): disruptionsAllowed=0"
' || echo "None found"

# Check for pending PVCs
echo "--- Pending PVCs ---"
kubectl get pvc --all-namespaces \
    --field-selector status.phase=Pending \
    --no-headers || echo "None found"

# Check node status
echo "--- Node status ---"
kubectl get nodes -o custom-columns=\
NAME:.metadata.name,STATUS:.status.conditions[-1].type,READY:.status.conditions[-1].status,VERSION:.status.nodeInfo.kubeletVersion

echo "=== Health check complete ==="
```

## In-Place Rolling Upgrade (kubeadm)

### Control Plane Upgrade

```bash
#!/usr/bin/env bash
set -euo pipefail

TARGET_VERSION="${1:?Usage: $0 <target-version>}"
# Example: ./upgrade-control-plane.sh 1.33.0

echo "Upgrading control plane to Kubernetes ${TARGET_VERSION}"

# Step 1: Upgrade kubeadm
apt-mark unhold kubeadm
apt-get update
apt-get install -y "kubeadm=${TARGET_VERSION}-00"
apt-mark hold kubeadm

kubeadm version

# Step 2: Review the upgrade plan
kubeadm upgrade plan "v${TARGET_VERSION}"

# Step 3: Apply the upgrade (updates kube-apiserver, kube-controller-manager,
# kube-scheduler, and CoreDNS/kube-proxy)
kubeadm upgrade apply "v${TARGET_VERSION}" --yes

# Step 4: Upgrade CNI plugin if required (consult CNI vendor docs)
# Example for Cilium:
# helm upgrade cilium cilium/cilium --namespace kube-system --reuse-values

# Step 5: Upgrade kubelet and kubectl
apt-mark unhold kubelet kubectl
apt-get install -y "kubelet=${TARGET_VERSION}-00" "kubectl=${TARGET_VERSION}-00"
apt-mark hold kubelet kubectl

systemctl daemon-reload
systemctl restart kubelet

# Step 6: Verify control plane
kubectl get nodes
kubectl version

echo "Control plane upgrade complete"
```

### Worker Node Upgrade

```bash
#!/usr/bin/env bash
set -euo pipefail

NODE="${1:?Usage: $0 <node-name> <target-version>}"
TARGET_VERSION="${2:?Usage: $0 <node-name> <target-version>}"
DRAIN_TIMEOUT="${3:-300s}"

echo "Upgrading worker node ${NODE} to ${TARGET_VERSION}"

# Step 1: Cordon the node
kubectl cordon "${NODE}"

# Step 2: Drain the node
kubectl drain "${NODE}" \
    --ignore-daemonsets \
    --delete-emissary-data \
    --timeout="${DRAIN_TIMEOUT}"

echo "Node ${NODE} drained. Proceeding with upgrade on the node..."
echo "Run the following on node ${NODE}:"
cat <<REMOTE_SCRIPT
apt-mark unhold kubeadm kubelet kubectl
apt-get update
apt-get install -y kubeadm=${TARGET_VERSION}-00 kubelet=${TARGET_VERSION}-00 kubectl=${TARGET_VERSION}-00
apt-mark hold kubeadm kubelet kubectl
kubeadm upgrade node
systemctl daemon-reload
systemctl restart kubelet
REMOTE_SCRIPT

# Wait for operator to complete the node upgrade
read -r -p "Press Enter after the node upgrade is complete on ${NODE}..."

# Verify node is Ready with new version
kubectl wait node "${NODE}" --for=condition=Ready --timeout=120s
NODE_VERSION=$(kubectl get node "${NODE}" -o jsonpath='{.status.nodeInfo.kubeletVersion}')
echo "Node ${NODE} is now running kubelet ${NODE_VERSION}"

# Step 3: Uncordon
kubectl uncordon "${NODE}"
echo "Node ${NODE} uncordoned and ready for workloads"
```

### Automating Multi-Node Worker Upgrade

```bash
#!/usr/bin/env bash
set -euo pipefail

TARGET_VERSION="${1:?Usage: $0 <target-version>}"
WAIT_BETWEEN_NODES="${2:-60}"

WORKERS=$(kubectl get nodes \
    --selector='!node-role.kubernetes.io/control-plane' \
    -o jsonpath='{.items[*].metadata.name}')

for NODE in ${WORKERS}; do
    echo "============================================"
    echo "Upgrading node: ${NODE}"
    echo "============================================"
    
    # Cordon
    kubectl cordon "${NODE}"
    
    # Drain with PDB respect
    if ! kubectl drain "${NODE}" \
        --ignore-daemonsets \
        --delete-emissary-data \
        --timeout=300s; then
        echo "ERROR: Failed to drain ${NODE}. Stopping upgrade."
        kubectl uncordon "${NODE}"
        exit 1
    fi
    
    # Perform upgrade via SSH
    ssh -o StrictHostKeyChecking=no "ubuntu@${NODE}" \
        "sudo apt-get update && \
         sudo apt-mark unhold kubeadm kubelet kubectl && \
         sudo apt-get install -y kubeadm=${TARGET_VERSION}-00 kubelet=${TARGET_VERSION}-00 kubectl=${TARGET_VERSION}-00 && \
         sudo apt-mark hold kubeadm kubelet kubectl && \
         sudo kubeadm upgrade node && \
         sudo systemctl daemon-reload && \
         sudo systemctl restart kubelet"
    
    # Wait for Ready
    kubectl wait node "${NODE}" --for=condition=Ready --timeout=180s
    
    # Verify version
    NODE_VERSION=$(kubectl get node "${NODE}" -o jsonpath='{.status.nodeInfo.kubeletVersion}')
    echo "Node ${NODE} upgraded to ${NODE_VERSION}"
    
    # Uncordon
    kubectl uncordon "${NODE}"
    
    # Wait before proceeding to next node
    echo "Waiting ${WAIT_BETWEEN_NODES}s before upgrading next node..."
    sleep "${WAIT_BETWEEN_NODES}"
done

echo "All worker nodes upgraded to ${TARGET_VERSION}"
```

## Blue-Green Cluster Upgrade

Blue-green cluster upgrades create a new cluster at the target version and migrate workloads from the old cluster to the new one. This strategy eliminates upgrade risk entirely — the old cluster remains fully operational until the migration is complete and validated.

### Migration Process Overview

```
Phase 1: Build green cluster
  - Provision new cluster at target version
  - Install all add-ons at compatible versions
  - Configure networking, DNS, and storage

Phase 2: Migrate stateless workloads
  - Apply all GitOps manifests to green cluster
  - Verify all Deployments are running
  - Run smoke tests

Phase 3: Migrate stateful workloads
  - Take snapshots of all PVCs
  - Restore snapshots in green cluster
  - Verify data integrity

Phase 4: Traffic migration
  - Shift a percentage of traffic to green cluster
  - Monitor error rates and latency
  - Shift 100% of traffic to green cluster

Phase 5: Decommission blue cluster
  - Wait 24-48 hours for confidence
  - Delete blue cluster
```

### DNS-Based Traffic Cutover

```bash
# Update Route53 (or equivalent) to point to green cluster load balancer
# Start with weighted routing: 10% green, 90% blue

aws route53 change-resource-record-sets \
    --hosted-zone-id ZONE_ID_REPLACE_ME \
    --change-batch '{
        "Changes": [{
            "Action": "UPSERT",
            "ResourceRecordSet": {
                "Name": "api.example.com",
                "Type": "A",
                "SetIdentifier": "green",
                "Weight": 10,
                "AliasTarget": {
                    "HostedZoneId": "GREEN_LB_HOSTED_ZONE_REPLACE_ME",
                    "DNSName": "green-cluster-lb.us-east-1.elb.amazonaws.com",
                    "EvaluateTargetHealth": true
                }
            }
        }]
    }'
```

## Canary Node Pool Upgrade (Cloud Managed)

For EKS, GKE, or AKS, the cleanest upgrade strategy is to create a new node pool at the target version and migrate workloads by draining the old node pool.

### EKS Managed Node Group Upgrade

```bash
# Create a new node group at the target version
aws eks create-nodegroup \
    --cluster-name production-cluster \
    --nodegroup-name workers-v133 \
    --ami-type AL2_x86_64 \
    --instance-types m5.2xlarge \
    --scaling-config minSize=3,maxSize=20,desiredSize=10 \
    --node-role "arn:aws:iam::ACCOUNT_ID_REPLACE_ME:role/EKSNodeRole" \
    --release-version 1.33.x-eksbuild.1 \
    --labels k8s.io/cluster-autoscaler/node-template/label/node-version=v133 \
    --subnets subnet-REPLACE_ME subnet-REPLACE_ME2

# Wait for new nodes to be Ready
kubectl wait nodes \
    --selector=eks.amazonaws.com/nodegroup=workers-v133 \
    --for=condition=Ready \
    --timeout=600s

# Cordon all old nodes
kubectl cordon -l eks.amazonaws.com/nodegroup=workers-v131

# Drain old nodes
for NODE in $(kubectl get nodes -l eks.amazonaws.com/nodegroup=workers-v131 -o name); do
    kubectl drain "${NODE}" \
        --ignore-daemonsets \
        --delete-emissary-data \
        --timeout=300s
    echo "Drained ${NODE}"
    sleep 30
done

# Delete old node group
aws eks delete-nodegroup \
    --cluster-name production-cluster \
    --nodegroup-name workers-v131
```

## API Deprecation Remediation

When kubent or Pluto identifies deprecated APIs, manifests must be updated before upgrading:

### Batch Remediation Script

```bash
#!/usr/bin/env bash
set -euo pipefail

# Replace deprecated batch/v1beta1 CronJob with batch/v1
grep -rl "apiVersion: batch/v1beta1" ./kubernetes/ | while read -r FILE; do
    echo "Updating: ${FILE}"
    sed -i 's|apiVersion: batch/v1beta1|apiVersion: batch/v1|g' "${FILE}"
done

# Replace deprecated networking.k8s.io/v1beta1 Ingress with networking.k8s.io/v1
grep -rl "apiVersion: networking.k8s.io/v1beta1" ./kubernetes/ | while read -r FILE; do
    echo "Updating: ${FILE}"
    sed -i 's|apiVersion: networking.k8s.io/v1beta1|apiVersion: networking.k8s.io/v1|g' "${FILE}"
done

# Replace deprecated autoscaling/v2beta2 HPA with autoscaling/v2
grep -rl "apiVersion: autoscaling/v2beta2" ./kubernetes/ | while read -r FILE; do
    echo "Updating: ${FILE}"
    sed -i 's|apiVersion: autoscaling/v2beta2|apiVersion: autoscaling/v2|g' "${FILE}"
done

echo "API version updates complete. Review changes before committing."
git diff --stat
```

## Post-Upgrade Validation

### Automated Validation Script

```bash
#!/usr/bin/env bash
set -euo pipefail

EXPECTED_VERSION="${1:?Usage: $0 <expected-version>}"

echo "=== Post-Upgrade Validation ==="

# 1. Verify all control plane components
echo "--- Control plane component versions ---"
kubectl get componentstatuses 2>/dev/null || true
kubectl -n kube-system get pods \
    -l tier=control-plane \
    -o custom-columns=NAME:.metadata.name,IMAGE:.spec.containers[0].image

# 2. Verify all nodes are at expected version
echo "--- Node versions ---"
OUTDATED=$(kubectl get nodes \
    -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.nodeInfo.kubeletVersion}{"\n"}{end}' \
    | grep -v "v${EXPECTED_VERSION}" || true)

if [[ -n "${OUTDATED}" ]]; then
    echo "WARNING: The following nodes are not at v${EXPECTED_VERSION}:"
    echo "${OUTDATED}"
else
    echo "All nodes are at v${EXPECTED_VERSION}"
fi

# 3. Check all system pods are running
echo "--- System pod health ---"
UNHEALTHY=$(kubectl get pods -n kube-system \
    --field-selector 'status.phase!=Running,status.phase!=Succeeded' \
    --no-headers 2>/dev/null | grep -v Completed || true)

if [[ -n "${UNHEALTHY}" ]]; then
    echo "WARNING: Unhealthy system pods:"
    echo "${UNHEALTHY}"
else
    echo "All system pods are healthy"
fi

# 4. Verify CoreDNS is resolving
echo "--- DNS resolution check ---"
kubectl run dns-test --image=busybox:1.36 --restart=Never --rm -it \
    --command -- nslookup kubernetes.default.svc.cluster.local 2>/dev/null \
    && echo "DNS resolution OK" \
    || echo "WARNING: DNS resolution failed"

# 5. Check for any failed pods across the cluster
echo "--- Cluster-wide pod health ---"
FAILED_PODS=$(kubectl get pods --all-namespaces \
    --field-selector 'status.phase=Failed' \
    --no-headers 2>/dev/null | head -20 || true)

if [[ -n "${FAILED_PODS}" ]]; then
    echo "WARNING: Failed pods found:"
    echo "${FAILED_PODS}"
else
    echo "No failed pods found"
fi

# 6. Run a test deployment
echo "--- Deployment smoke test ---"
kubectl create deployment upgrade-smoke-test \
    --image=nginx:1.27 \
    --replicas=2 \
    -n default 2>/dev/null || true

kubectl rollout status deployment/upgrade-smoke-test -n default --timeout=60s \
    && echo "Smoke test deployment OK" \
    || echo "WARNING: Smoke test deployment failed"

kubectl delete deployment upgrade-smoke-test -n default 2>/dev/null || true

echo "=== Post-upgrade validation complete ==="
```

## Upgrade Rollback Procedures

### etcd Restore (Full Rollback)

In the event of a catastrophic upgrade failure, restore from the pre-upgrade etcd backup:

```bash
#!/usr/bin/env bash
set -euo pipefail

BACKUP_FILE="${1:?Usage: $0 <etcd-backup-file>}"
RESTORE_DIR="/var/lib/etcd-restore"

# Stop kube-apiserver by moving the static pod manifest
mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/
mv /etc/kubernetes/manifests/kube-controller-manager.yaml /tmp/
mv /etc/kubernetes/manifests/kube-scheduler.yaml /tmp/
mv /etc/kubernetes/manifests/etcd.yaml /tmp/

# Wait for static pods to stop
sleep 10

# Restore etcd data
ETCDCTL_API=3 etcdctl snapshot restore "${BACKUP_FILE}" \
    --data-dir="${RESTORE_DIR}" \
    --name "$(hostname)" \
    --initial-cluster "$(hostname)=https://127.0.0.1:2380" \
    --initial-advertise-peer-urls "https://127.0.0.1:2380"

# Swap the data directory
mv /var/lib/etcd /var/lib/etcd-broken-$(date +%Y%m%d)
mv "${RESTORE_DIR}" /var/lib/etcd

# Restore kubeadm-generated version of etcd.yaml pointing to old image
# (modify etcd.yaml to use previous version image before moving back)
mv /tmp/etcd.yaml /etc/kubernetes/manifests/
sleep 15

mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/
mv /tmp/kube-controller-manager.yaml /etc/kubernetes/manifests/
mv /tmp/kube-scheduler.yaml /etc/kubernetes/manifests/

# Wait for API server to become ready
until kubectl get nodes &>/dev/null; do
    echo "Waiting for API server..."
    sleep 5
done

echo "etcd restore complete. Verify cluster state."
```

## Summary

Production Kubernetes upgrades require a structured approach: complete the pre-upgrade checklist, remediate API deprecations before the upgrade, take an etcd backup, and choose the upgrade strategy that matches the cluster type and organizational risk tolerance. In-place rolling upgrades with kubeadm are reliable when worker nodes are upgraded one at a time with appropriate waiting periods. Blue-green cluster migration eliminates upgrade risk entirely but requires operational maturity in GitOps and stateful data migration. Canary node pools provide a middle ground that is well-suited to cloud-managed clusters. Post-upgrade validation scripts provide systematic confirmation that the upgrade was successful before the maintenance window is closed.
