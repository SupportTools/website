---
title: "Kubernetes Disaster Recovery: Runbooks, etcd Restoration, and Cluster Rebuild Procedures"
date: 2027-05-24T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Disaster Recovery", "etcd", "Backup", "Velero", "SRE"]
categories: ["Kubernetes", "SRE"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes disaster recovery covering RPO and RTO planning, etcd snapshot automation, etcd restore procedures for single and multi-member clusters, control plane recovery, Velero backup and restore for workloads, namespace-level recovery, PersistentVolume data recovery, GitOps-driven cluster recreation, runbook templates for common failure scenarios, and multi-region failover strategies."
more_link: "yes"
url: "/kubernetes-disaster-recovery-runbook-guide/"
---

Kubernetes clusters fail in ways that range from a single pod crashing (trivially recovered by the controller) to complete etcd data corruption (requiring a full cluster rebuild). Between these extremes lies a spectrum of failure modes: control plane node loss, split-brain scenarios in multi-node etcd clusters, accidental namespace deletion, persistent volume data loss, and certificate expiration cascades. Each failure mode demands a different recovery procedure, pre-existing backups, and tested runbooks. This guide provides production-grade procedures for the full range of Kubernetes disaster scenarios, from automated etcd backup pipelines to multi-region failover playbooks.

<!--more-->

## RPO and RTO Planning for Kubernetes

Recovery Point Objective (RPO) defines the maximum acceptable data loss expressed in time. Recovery Time Objective (RTO) defines the maximum acceptable time to restore service. For Kubernetes clusters, RPO and RTO must be defined separately for:

- **Cluster control plane state** (etcd): Kubernetes object definitions, secrets, configmaps
- **Application workload state**: Database contents, file system data on PersistentVolumes
- **Cluster configuration**: Add-ons, RBAC, network policies, storage classes

### RPO/RTO Target Matrix

| Component | Typical RPO | Typical RTO | Primary Recovery Method |
|-----------|------------|------------|------------------------|
| etcd cluster state | 1 hour | 30-60 minutes | etcd snapshot restore |
| Kubernetes manifests | 0 (GitOps) | 15-30 minutes | GitOps re-apply |
| Application databases | 5-60 minutes | 1-4 hours | Velero + database backup |
| PersistentVolumes | 1-24 hours | 30-120 minutes | Velero with restic/Kopia |
| Full cluster rebuild | N/A | 2-8 hours | GitOps + etcd restore |
| Stateless workloads | 0 (stateless) | 5-15 minutes | Deployment re-create |

### DR Tier Classification

```yaml
# Example tier definitions for prioritizing recovery
Tier 1 - Critical (RTO: 30 minutes):
  - Payment processing service
  - User authentication service
  - Core API gateway

Tier 2 - High (RTO: 2 hours):
  - Order management
  - Inventory service
  - Notification service

Tier 3 - Medium (RTO: 8 hours):
  - Analytics pipeline
  - Reporting service
  - Admin interfaces

Tier 4 - Low (RTO: 24 hours):
  - Batch processing
  - Development environments
  - Non-customer-facing tools
```

## etcd Backup Automation

### Snapshot-Based Backup Architecture

etcd snapshots capture the complete cluster state at a point in time. A reliable backup pipeline requires:
1. Regular automated snapshots (every 15-60 minutes for critical clusters)
2. Off-cluster storage (S3, GCS, Azure Blob)
3. Snapshot integrity verification
4. Retention management
5. Alerting on backup failure

```bash
#!/bin/bash
# etcd-backup.sh - Production etcd snapshot backup script

set -euo pipefail

CLUSTER_NAME="${CLUSTER_NAME:-my-cluster}"
BACKUP_BUCKET="${BACKUP_BUCKET:-s3://my-cluster-etcd-backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
ALERT_WEBHOOK="${ALERT_WEBHOOK:-}"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="/tmp/etcd-backup-${TIMESTAMP}"
SNAPSHOT_FILE="${BACKUP_DIR}/etcd-snapshot.db"
METADATA_FILE="${BACKUP_DIR}/metadata.json"

ETCD_ENDPOINTS="https://127.0.0.1:2379"
ETCD_CACERT="/etc/kubernetes/pki/etcd/ca.crt"
ETCD_CERT="/etc/kubernetes/pki/etcd/server.crt"
ETCD_KEY="/etc/kubernetes/pki/etcd/server.key"

log() {
  echo "[$(date -Iseconds)] $*"
}

alert() {
  local severity=$1
  local message=$2
  log "${severity}: ${message}"
  if [ -n "${ALERT_WEBHOOK}" ]; then
    curl -s -X POST "${ALERT_WEBHOOK}" \
      -H 'Content-Type: application/json' \
      -d "{\"severity\":\"${severity}\",\"message\":\"${message}\",\"cluster\":\"${CLUSTER_NAME}\"}" \
      || true
  fi
}

cleanup() {
  rm -rf "${BACKUP_DIR}"
}
trap cleanup EXIT

log "Starting etcd backup for cluster ${CLUSTER_NAME}"
mkdir -p "${BACKUP_DIR}"

# Step 1: Verify etcd cluster health
log "Verifying etcd cluster health..."
if ! etcdctl \
  --endpoints="${ETCD_ENDPOINTS}" \
  --cacert="${ETCD_CACERT}" \
  --cert="${ETCD_CERT}" \
  --key="${ETCD_KEY}" \
  endpoint health > /dev/null 2>&1; then
  alert "CRITICAL" "etcd health check failed - backup aborted"
  exit 1
fi

# Step 2: Get etcd cluster status
ETCD_STATUS=$(etcdctl \
  --endpoints="${ETCD_ENDPOINTS}" \
  --cacert="${ETCD_CACERT}" \
  --cert="${ETCD_CERT}" \
  --key="${ETCD_KEY}" \
  endpoint status -w json 2>/dev/null)

MEMBER_ID=$(echo "${ETCD_STATUS}" | jq -r '.[0].Status.header.member_id // "unknown"')
REVISION=$(echo "${ETCD_STATUS}" | jq -r '.[0].Status.header.revision // 0')
DB_SIZE=$(echo "${ETCD_STATUS}" | jq -r '.[0].Status.dbSizeInUse // 0')

# Step 3: Take snapshot
log "Taking etcd snapshot (revision: ${REVISION})..."
if ! etcdctl \
  --endpoints="${ETCD_ENDPOINTS}" \
  --cacert="${ETCD_CACERT}" \
  --cert="${ETCD_CERT}" \
  --key="${ETCD_KEY}" \
  snapshot save "${SNAPSHOT_FILE}"; then
  alert "CRITICAL" "etcd snapshot failed"
  exit 1
fi

# Step 4: Verify snapshot integrity
log "Verifying snapshot integrity..."
SNAPSHOT_STATUS=$(etcdctl snapshot status "${SNAPSHOT_FILE}" -w json)
SNAPSHOT_REVISION=$(echo "${SNAPSHOT_STATUS}" | jq -r '.revision')
SNAPSHOT_HASH=$(echo "${SNAPSHOT_STATUS}" | jq -r '.hash')

log "Snapshot verified: revision=${SNAPSHOT_REVISION}, hash=${SNAPSHOT_HASH}"

# Step 5: Create metadata file
cat > "${METADATA_FILE}" << EOF
{
  "cluster": "${CLUSTER_NAME}",
  "timestamp": "${TIMESTAMP}",
  "etcd_revision": ${REVISION},
  "snapshot_revision": ${SNAPSHOT_REVISION},
  "snapshot_hash": "${SNAPSHOT_HASH}",
  "db_size_bytes": ${DB_SIZE},
  "member_id": "${MEMBER_ID}",
  "kubernetes_version": "$(kubectl version --short 2>/dev/null | grep Server | awk '{print $3}' || echo 'unknown')"
}
EOF

# Step 6: Upload to object storage
REMOTE_PATH="${CLUSTER_NAME}/${TIMESTAMP}"
log "Uploading snapshot to ${BACKUP_BUCKET}/${REMOTE_PATH}..."

aws s3 cp "${SNAPSHOT_FILE}" "${BACKUP_BUCKET}/${REMOTE_PATH}/etcd-snapshot.db" \
  --sse aws:kms \
  --storage-class STANDARD_IA

aws s3 cp "${METADATA_FILE}" "${BACKUP_BUCKET}/${REMOTE_PATH}/metadata.json"

# Step 7: Update "latest" symlink
echo "${REMOTE_PATH}" | aws s3 cp - "${BACKUP_BUCKET}/${CLUSTER_NAME}/latest"

# Step 8: Clean up old backups
log "Cleaning up backups older than ${RETENTION_DAYS} days..."
CUTOFF_DATE=$(date -d "${RETENTION_DAYS} days ago" +%Y%m%d 2>/dev/null || \
  date -v-${RETENTION_DAYS}d +%Y%m%d)  # macOS compatibility

aws s3 ls "${BACKUP_BUCKET}/${CLUSTER_NAME}/" | while read -r line; do
  BACKUP_DATE=$(echo "$line" | awk '{print $2}' | cut -c1-8 | tr -d -)
  if [[ "${BACKUP_DATE}" < "${CUTOFF_DATE}" ]] && [[ "${BACKUP_DATE}" =~ ^[0-9]{8}$ ]]; then
    BACKUP_PATH=$(echo "$line" | awk '{print $2}')
    log "Deleting old backup: ${BACKUP_PATH}"
    aws s3 rm --recursive "${BACKUP_BUCKET}/${CLUSTER_NAME}/${BACKUP_PATH}"
  fi
done

log "etcd backup complete: ${BACKUP_BUCKET}/${REMOTE_PATH}"
alert "INFO" "etcd backup successful: revision ${SNAPSHOT_REVISION}, size $(echo "${DB_SIZE}" | awk '{printf "%.1fMB", $1/1024/1024}')"
```

### Kubernetes CronJob for etcd Backup

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: etcd-backup
  namespace: kube-system

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: etcd-backup
rules:
- apiGroups: [""]
  resources: ["nodes"]
  verbs: ["get", "list"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: etcd-backup
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: etcd-backup
subjects:
- kind: ServiceAccount
  name: etcd-backup
  namespace: kube-system

---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: etcd-backup
  namespace: kube-system
spec:
  schedule: "0 * * * *"  # Every hour
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 24
  failedJobsHistoryLimit: 5
  jobTemplate:
    spec:
      activeDeadlineSeconds: 600
      template:
        spec:
          serviceAccountName: etcd-backup
          hostNetwork: true
          priorityClassName: system-cluster-critical
          tolerations:
          - key: node-role.kubernetes.io/control-plane
            operator: Exists
            effect: NoSchedule
          nodeSelector:
            node-role.kubernetes.io/control-plane: ""
          containers:
          - name: etcd-backup
            image: amazon/aws-cli:latest
            command: ["/scripts/etcd-backup.sh"]
            env:
            - name: ETCDCTL_API
              value: "3"
            - name: CLUSTER_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
            - name: BACKUP_BUCKET
              value: s3://my-cluster-etcd-backups
            - name: RETENTION_DAYS
              value: "30"
            - name: AWS_REGION
              value: us-east-1
            volumeMounts:
            - name: etcd-certs
              mountPath: /etc/kubernetes/pki/etcd
              readOnly: true
            - name: scripts
              mountPath: /scripts
            resources:
              requests:
                cpu: 100m
                memory: 128Mi
              limits:
                cpu: 500m
                memory: 512Mi
          volumes:
          - name: etcd-certs
            hostPath:
              path: /etc/kubernetes/pki/etcd
              type: Directory
          - name: scripts
            configMap:
              name: etcd-backup-scripts
              defaultMode: 0755
          restartPolicy: OnFailure
```

## etcd Restore Procedures

### Single-Node etcd Restore

For a single-node etcd cluster (development/test environments):

```bash
#!/bin/bash
# etcd-restore-single.sh

SNAPSHOT_FILE=$1
ETCD_DATA_DIR="/var/lib/etcd"
ETCD_INITIAL_CLUSTER="control-plane=https://10.0.0.10:2380"
ETCD_INITIAL_ADVERTISE_PEER_URLS="https://10.0.0.10:2380"
ETCD_NAME="control-plane"

# Step 1: Stop the API server by moving the static pod manifest
echo "Stopping API server..."
mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/kube-apiserver.yaml.bak
mv /etc/kubernetes/manifests/kube-controller-manager.yaml /tmp/kube-controller-manager.yaml.bak
mv /etc/kubernetes/manifests/kube-scheduler.yaml /tmp/kube-scheduler.yaml.bak
mv /etc/kubernetes/manifests/etcd.yaml /tmp/etcd.yaml.bak

# Wait for containers to stop
sleep 10
echo "Waiting for API server containers to terminate..."
until ! crictl ps | grep -q kube-apiserver; do sleep 2; done
until ! crictl ps | grep -q etcd; do sleep 2; done
echo "All control plane containers stopped"

# Step 2: Back up existing etcd data directory
echo "Backing up existing etcd data..."
mv "${ETCD_DATA_DIR}" "${ETCD_DATA_DIR}.backup.$(date +%Y%m%d-%H%M%S)"

# Step 3: Restore from snapshot
echo "Restoring from snapshot: ${SNAPSHOT_FILE}..."
ETCDCTL_API=3 etcdctl snapshot restore "${SNAPSHOT_FILE}" \
  --data-dir="${ETCD_DATA_DIR}" \
  --initial-cluster="${ETCD_INITIAL_CLUSTER}" \
  --initial-advertise-peer-urls="${ETCD_INITIAL_ADVERTISE_PEER_URLS}" \
  --name="${ETCD_NAME}" \
  --skip-hash-check=false

# Fix ownership
chown -R etcd:etcd "${ETCD_DATA_DIR}" 2>/dev/null || true

# Step 4: Restore static pod manifests
echo "Restoring static pod manifests..."
mv /tmp/etcd.yaml.bak /etc/kubernetes/manifests/etcd.yaml
sleep 15  # Wait for etcd to start

# Step 5: Verify etcd is running
echo "Waiting for etcd to become healthy..."
for i in $(seq 1 30); do
  if etcdctl \
    --endpoints=https://127.0.0.1:2379 \
    --cacert=/etc/kubernetes/pki/etcd/ca.crt \
    --cert=/etc/kubernetes/pki/etcd/server.crt \
    --key=/etc/kubernetes/pki/etcd/server.key \
    endpoint health 2>/dev/null; then
    echo "etcd is healthy"
    break
  fi
  echo "Waiting for etcd... (${i}/30)"
  sleep 5
done

# Step 6: Restore API server and other control plane components
echo "Restoring control plane components..."
mv /tmp/kube-apiserver.yaml.bak /etc/kubernetes/manifests/kube-apiserver.yaml
mv /tmp/kube-controller-manager.yaml.bak /etc/kubernetes/manifests/kube-controller-manager.yaml
mv /tmp/kube-scheduler.yaml.bak /etc/kubernetes/manifests/kube-scheduler.yaml

# Step 7: Wait for API server to become available
echo "Waiting for API server..."
for i in $(seq 1 60); do
  if kubectl cluster-info 2>/dev/null; then
    echo "API server is available"
    break
  fi
  echo "Waiting for API server... (${i}/60)"
  sleep 5
done

echo "etcd restore complete"
kubectl get nodes
```

### Multi-Member etcd Cluster Restore

Restoring a multi-member etcd cluster requires stopping all members, restoring each with matching initial cluster configuration, then restarting:

```bash
#!/bin/bash
# etcd-restore-multi.sh
# Must be run on all control plane nodes simultaneously or sequentially

set -euo pipefail

SNAPSHOT_FILE=$1
# These values must match the cluster's etcd configuration
ETCD_NAME=$(hostname)
ETCD_DATA_DIR="/var/lib/etcd"

# Cluster member configuration - must match ALL members
ETCD_INITIAL_CLUSTER="control-plane-1=https://10.0.0.10:2380,control-plane-2=https://10.0.0.11:2380,control-plane-3=https://10.0.0.12:2380"

# Per-node advertise URL
case ${ETCD_NAME} in
  control-plane-1)
    ADVERTISE_PEER_URL="https://10.0.0.10:2380"
    ;;
  control-plane-2)
    ADVERTISE_PEER_URL="https://10.0.0.11:2380"
    ;;
  control-plane-3)
    ADVERTISE_PEER_URL="https://10.0.0.12:2380"
    ;;
  *)
    echo "Unknown node: ${ETCD_NAME}"
    exit 1
    ;;
esac

echo "Restoring etcd on ${ETCD_NAME}..."

# Stop static pods
echo "Stopping control plane static pods..."
mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/kube-apiserver.yaml.bak 2>/dev/null || true
mv /etc/kubernetes/manifests/kube-controller-manager.yaml /tmp/ 2>/dev/null || true
mv /etc/kubernetes/manifests/kube-scheduler.yaml /tmp/ 2>/dev/null || true
mv /etc/kubernetes/manifests/etcd.yaml /tmp/etcd.yaml.bak

# Wait for containers to stop
sleep 15

# Remove old etcd data
mv "${ETCD_DATA_DIR}" "${ETCD_DATA_DIR}.old.$(date +%Y%m%d-%H%M%S)"

# Restore from snapshot - MUST use same snapshot file on ALL members
ETCDCTL_API=3 etcdctl snapshot restore "${SNAPSHOT_FILE}" \
  --data-dir="${ETCD_DATA_DIR}" \
  --name="${ETCD_NAME}" \
  --initial-cluster="${ETCD_INITIAL_CLUSTER}" \
  --initial-cluster-token="etcd-cluster-1" \
  --initial-advertise-peer-urls="${ADVERTISE_PEER_URL}"

echo "Snapshot restored on ${ETCD_NAME}"
echo "IMPORTANT: Wait until ALL control plane nodes have completed restore before starting etcd"
echo "Press ENTER when all nodes are ready to start..."
read

# Restore etcd static pod (all nodes start simultaneously)
mv /tmp/etcd.yaml.bak /etc/kubernetes/manifests/etcd.yaml

# Wait for etcd to form quorum
for i in $(seq 1 60); do
  if ETCDCTL_API=3 etcdctl \
    --endpoints="https://127.0.0.1:2379" \
    --cacert=/etc/kubernetes/pki/etcd/ca.crt \
    --cert=/etc/kubernetes/pki/etcd/server.crt \
    --key=/etc/kubernetes/pki/etcd/server.key \
    member list 2>/dev/null | grep "started"; then
    echo "etcd cluster healthy on ${ETCD_NAME}"
    break
  fi
  echo "Waiting for etcd quorum... (${i}/60)"
  sleep 5
done

# Restore control plane static pods
mv /tmp/kube-apiserver.yaml.bak /etc/kubernetes/manifests/kube-apiserver.yaml
mv /tmp/kube-controller-manager.yaml /etc/kubernetes/manifests/ 2>/dev/null || true
mv /tmp/kube-scheduler.yaml /etc/kubernetes/manifests/ 2>/dev/null || true

echo "Control plane restore initiated on ${ETCD_NAME}"
```

### Recovering a Failed etcd Member

When one etcd member fails without full cluster data loss:

```bash
#!/bin/bash
# etcd-recover-member.sh - Recover a single failed etcd member

FAILED_MEMBER_NAME="control-plane-2"
FAILED_MEMBER_ID=""  # Will be found below

# From a healthy control plane node:
# Step 1: Identify the failed member
ETCDCTL_API=3 etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  member list -w table

# Step 2: Remove the failed member
FAILED_MEMBER_ID=$(ETCDCTL_API=3 etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  member list -w json \
  | jq -r ".members[] | select(.name==\"${FAILED_MEMBER_NAME}\") | .ID")

echo "Removing failed member: ${FAILED_MEMBER_ID}"
ETCDCTL_API=3 etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  member remove "${FAILED_MEMBER_ID}"

# On the failed node:
# Step 3: Clean old etcd data on the failed node
ssh ${FAILED_MEMBER_NAME} "mv /var/lib/etcd /var/lib/etcd.failed.$(date +%Y%m%d) && \
  rm /etc/kubernetes/manifests/etcd.yaml"

# Step 4: Re-add the member to the cluster (from a healthy node)
ETCDCTL_API=3 etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  member add "${FAILED_MEMBER_NAME}" \
  --peer-urls="https://10.0.0.11:2380"

# Step 5: Update etcd manifest on failed node with --initial-cluster-state=existing
# Modify /etc/kubernetes/manifests/etcd.yaml on the failed node to add:
# --initial-cluster-state=existing
# Then restore the manifest to trigger etcd startup

ssh ${FAILED_MEMBER_NAME} "cat /tmp/etcd.yaml.bak \
  | sed 's/--initial-cluster-state=new/--initial-cluster-state=existing/' \
  > /etc/kubernetes/manifests/etcd.yaml"

echo "Member recovery initiated. Monitor etcd logs on ${FAILED_MEMBER_NAME}"
```

## Velero Backup and Restore for Workloads

Velero provides Kubernetes-native backup and restore for cluster resources and persistent volumes. It integrates with cloud storage (S3, GCS, Azure Blob) and volume snapshot APIs.

### Installing Velero

```bash
# Install Velero CLI
curl -LO https://github.com/vmware-tanzu/velero/releases/download/v1.13.0/velero-v1.13.0-linux-amd64.tar.gz
tar -xzf velero-v1.13.0-linux-amd64.tar.gz
mv velero-v1.13.0-linux-amd64/velero /usr/local/bin/

# Install Velero server with AWS plugin
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.9.0 \
  --bucket my-velero-backups \
  --backup-location-config region=us-east-1 \
  --snapshot-location-config region=us-east-1 \
  --secret-file ./credentials-velero \
  --use-node-agent \
  --default-volumes-to-fs-backup \
  --wait
```

### Velero Credentials File

```ini
# credentials-velero
[default]
aws_access_key_id=EXAMPLE_AWS_ACCESS_KEY_REPLACE_ME
aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
```

### Scheduled Backup Configuration

```yaml
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: daily-cluster-backup
  namespace: velero
spec:
  schedule: "0 1 * * *"  # Daily at 1 AM UTC
  useOwnerReferencesInBackup: false
  template:
    includedNamespaces:
    - "*"
    excludedNamespaces:
    - kube-system
    - velero
    includedResources:
    - "*"
    excludedResources:
    - events
    - events.events.k8s.io
    labelSelector:
      matchExpressions:
      - key: velero.io/exclude-from-backup
        operator: DoesNotExist
    storageLocation: default
    volumeSnapshotLocations:
    - default
    ttl: 720h  # 30 days
    snapshotVolumes: true
    defaultVolumesToFsBackup: false  # Use volume snapshots, not file-level backup
    hooks:
      resources:
      - name: database-hooks
        includedNamespaces:
        - production
        labelSelector:
          matchLabels:
            backup-hook: pre-post
        pre:
        - exec:
            container: postgres
            command: ["/bin/bash", "-c", "psql -U postgres -c 'CHECKPOINT;'"]
            onError: Fail
            timeout: 30s

---
# Critical namespace backup - more frequent
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: hourly-critical-backup
  namespace: velero
spec:
  schedule: "0 * * * *"  # Hourly
  template:
    includedNamespaces:
    - production
    - critical-services
    storageLocation: default
    volumeSnapshotLocations:
    - default
    ttl: 168h  # 7 days
    snapshotVolumes: true
```

### Velero Backup Annotations

```yaml
# Opt specific pods into or out of backups
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
  namespace: production
spec:
  template:
    metadata:
      annotations:
        backup.velero.io/backup-volumes: data  # Include volume 'data' in backup
        # Or to use file-level backup for this specific volume:
        backup.velero.io/backup-volumes-excludes: cache
    spec:
      containers:
      - name: postgres
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
        - name: cache
          mountPath: /tmp/cache
```

### Namespace-Level Restore

```bash
# List available backups
velero backup get

# Describe a specific backup
velero backup describe daily-cluster-backup-20270524 --details

# Restore a specific namespace from backup
velero restore create \
  --from-backup daily-cluster-backup-20270524 \
  --include-namespaces production \
  --namespace-mappings production:production-restored \
  --wait

# Monitor restore progress
velero restore describe <restore-name> --details

# Check restore logs
velero restore logs <restore-name>

# Restore with PV recovery
velero restore create \
  --from-backup daily-cluster-backup-20270524 \
  --include-namespaces production \
  --restore-volumes=true \
  --wait
```

### Selective Resource Restore

```bash
# Restore only ConfigMaps and Secrets from a backup
velero restore create \
  --from-backup daily-cluster-backup-20270524 \
  --include-resources configmaps,secrets \
  --include-namespaces production

# Restore a specific Deployment
velero restore create \
  --from-backup daily-cluster-backup-20270524 \
  --include-resources deployments \
  --include-namespaces production \
  --selector app=api-server

# Restore with label filter
velero restore create \
  --from-backup daily-cluster-backup-20270524 \
  --include-namespaces production \
  --label-selector "tier=critical"
```

### PersistentVolume Data Recovery

```bash
# When PV data is lost but K8s objects exist:
# Step 1: Check current PV status
kubectl get pv,pvc -n production

# Step 2: Find the backup containing the PV
velero backup describe daily-cluster-backup-20270524 --details \
  | grep PersistentVolume

# Step 3: Restore only the PV and PVC
velero restore create \
  --from-backup daily-cluster-backup-20270524 \
  --include-resources persistentvolumes,persistentvolumeclaims \
  --include-namespaces production \
  --restore-volumes=true

# Step 4: If using file-level (Restic/Kopia) backup:
# The restore will copy files from the backup location to a new PV
# Monitor with:
velero restore describe <restore-name> --details | grep -A5 "Restic Restores"
```

## GitOps-Driven Cluster Recreation

When a cluster is completely lost and etcd cannot be recovered, GitOps enables full cluster recreation from the repository. This requires that all cluster state—manifests, Helm values, Kustomize overlays—is stored in Git.

### Cluster Bootstrap Sequence

```bash
#!/bin/bash
# cluster-bootstrap.sh - Recreate cluster from GitOps state

set -euo pipefail

CLUSTER_NAME="${1:-my-cluster}"
ENVIRONMENT="${2:-production}"
GIT_REPO="https://github.com/myorg/infrastructure"
GIT_BRANCH="${3:-main}"

echo "=== Bootstrapping cluster: ${CLUSTER_NAME} (${ENVIRONMENT}) ==="

# Phase 1: Infrastructure
echo "Phase 1: Creating infrastructure..."
# Trigger Terraform/Pulumi to recreate the cluster
cd infrastructure/terraform/clusters/${CLUSTER_NAME}
terraform init
terraform plan -var="environment=${ENVIRONMENT}" -out=tfplan
terraform apply tfplan

# Phase 2: Get kubeconfig
echo "Phase 2: Configuring kubectl..."
aws eks update-kubeconfig \
  --name ${CLUSTER_NAME} \
  --region us-east-1

kubectl cluster-info

# Phase 3: Bootstrap ArgoCD
echo "Phase 3: Bootstrapping ArgoCD..."
kubectl create namespace argocd
kubectl apply -n argocd \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# Wait for ArgoCD to be ready
kubectl wait pod \
  -n argocd \
  -l app.kubernetes.io/component=server \
  --for=condition=Ready \
  --timeout=5m

# Phase 4: Configure ArgoCD to sync from Git
echo "Phase 4: Connecting ArgoCD to Git repository..."
argocd login argocd-server.argocd.svc.cluster.local \
  --username admin \
  --password $(kubectl -n argocd get secret argocd-initial-admin-secret \
    -o jsonpath='{.data.password}' | base64 -d) \
  --insecure

argocd repo add ${GIT_REPO} \
  --type git \
  --username git \
  --password "$(cat ~/.git-credentials)"

# Phase 5: Create root Application
echo "Phase 5: Creating root Application (App of Apps)..."
argocd app create root \
  --repo ${GIT_REPO} \
  --path "clusters/${CLUSTER_NAME}/argocd" \
  --dest-server https://kubernetes.default.svc \
  --dest-namespace argocd \
  --revision ${GIT_BRANCH} \
  --sync-policy automated \
  --auto-prune \
  --self-heal

# Sync and wait
argocd app sync root --timeout 300
argocd app wait root --timeout 600

echo "Phase 5: Root application synced"

# Phase 6: Monitor full sync
echo "Phase 6: Monitoring full cluster sync..."
for i in $(seq 1 60); do
  SYNC_STATUS=$(argocd app list -o json | jq -r '.[].status.sync.status' | sort | uniq -c)
  echo "Sync status at ${i} minutes: ${SYNC_STATUS}"

  SYNCED=$(argocd app list -o json | jq '[.[] | select(.status.sync.status=="Synced")] | length')
  TOTAL=$(argocd app list -o json | jq '. | length')

  if [ "${SYNCED}" -eq "${TOTAL}" ] && [ "${TOTAL}" -gt "0" ]; then
    echo "All ${TOTAL} applications synced"
    break
  fi
  sleep 60
done

echo "=== Cluster bootstrap complete ==="
kubectl get nodes
kubectl get pods --all-namespaces | grep -v Running | grep -v Completed || true
```

### GitOps Repository Structure for DR

```
infrastructure/
  clusters/
    my-cluster/
      argocd/
        root-app.yaml          # App of Apps
        namespaces.yaml
      cert-manager/
        chart.yaml
        values-prod.yaml
      ingress-nginx/
        chart.yaml
        values-prod.yaml
      monitoring/
        chart.yaml
        values-prod.yaml
      velero/
        chart.yaml
        values-prod.yaml
  terraform/
    clusters/
      my-cluster/
        main.tf
        variables.tf
        outputs.tf
        backend.tf            # Remote state in S3

applications/
  production/
    api-server/
      deployment.yaml
      service.yaml
      ingress.yaml
      hpa.yaml
      pdb.yaml
    postgres/
      statefulset.yaml
      service.yaml
      pvc.yaml
```

## Runbook Templates for Common Failure Scenarios

### Runbook: Complete etcd Failure

```markdown
# Runbook: Complete etcd Cluster Failure

## Severity: P0 - Critical
## RTO: 60 minutes
## RPO: 1 hour (last hourly snapshot)

## Symptoms
- API server returning 503 errors
- kubectl commands failing with "connection refused" or timeout
- All pods showing as Unknown

## Triage Steps

1. Verify etcd is actually failed (not just apiserver):
   ssh control-plane-1
   systemctl status etcd || crictl ps | grep etcd

2. Check etcd logs:
   journalctl -u etcd -n 200
   # Or for static pod:
   crictl logs $(crictl ps --name etcd -q)

3. Identify failure type:
   - All members failed → full restore required
   - One member failed → member recovery (see etcd-recover-member.sh)
   - Data corruption → snapshot restore required

## Recovery Steps

### Full Restore

1. Download latest snapshot from backup:
   aws s3 cp s3://my-cluster-etcd-backups/my-cluster/latest /tmp/latest-path
   LATEST=$(cat /tmp/latest-path)
   aws s3 cp s3://my-cluster-etcd-backups/my-cluster/${LATEST}/etcd-snapshot.db /tmp/

2. Verify snapshot:
   etcdctl snapshot status /tmp/etcd-snapshot.db

3. Run restore on ALL control plane nodes simultaneously:
   ./etcd-restore-multi.sh /tmp/etcd-snapshot.db

4. Validate recovery:
   kubectl get nodes
   kubectl get pods --all-namespaces | head -30

5. Trigger GitOps sync for any state created after last snapshot:
   argocd app sync --all

## Communication
- Notify: #incident-channel, #platform-ops, on-call PagerDuty
- Status page: Update to "Investigating"
- Customer impact: All operations blocked during etcd recovery
```

### Runbook: Accidental Namespace Deletion

```bash
#!/bin/bash
# recover-deleted-namespace.sh

NAMESPACE=$1
BACKUP_NAME=$2  # velero backup name, or "latest"

if [ -z "${BACKUP_NAME}" ] || [ "${BACKUP_NAME}" = "latest" ]; then
  # Find most recent backup containing the namespace
  BACKUP_NAME=$(velero backup get -o json \
    | jq -r ".items[] | select(.status.phase==\"Completed\") | .metadata.name" \
    | head -1)
  echo "Using most recent backup: ${BACKUP_NAME}"
fi

echo "Recovering namespace ${NAMESPACE} from backup ${BACKUP_NAME}..."

# Check the backup contains the namespace
velero backup describe ${BACKUP_NAME} \
  | grep -A10 "Namespaces:"

# Restore the namespace
velero restore create \
  --from-backup ${BACKUP_NAME} \
  --include-namespaces ${NAMESPACE} \
  --restore-volumes=true \
  --wait

RESTORE_NAME=$(velero restore get \
  --output json \
  | jq -r ".items[-1].metadata.name")

echo "Restore status:"
velero restore describe ${RESTORE_NAME} --details

echo "Recovery complete for namespace: ${NAMESPACE}"
kubectl get all -n ${NAMESPACE}
```

### Runbook: Control Plane Node Loss

```markdown
# Runbook: Single Control Plane Node Failure (HA Cluster)

## Severity: P1 - High
## RTO: 30 minutes
## Impact: Cluster continues operating; control plane capacity reduced by 33%

## Symptoms
- One control plane node is NotReady
- kubectl works (quorum maintained with 2/3 members)
- etcd shows one member as unreachable

## Verification
```bash
kubectl get nodes
ETCDCTL_API=3 etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  member list -w table
```

## Recovery Options

### Option A: Repair the failed node
1. SSH to the failed control plane node
2. Check kubelet and etcd status:
   systemctl status kubelet
   systemctl status etcd
3. Restart failed services:
   systemctl restart kubelet
   systemctl restart etcd
4. Verify node recovers:
   kubectl get node control-plane-2

### Option B: Replace the failed node (for hardware failure)
1. Remove failed etcd member from cluster
2. Provision new control plane node
3. Re-join using kubeadm join with control-plane flag:
   kubeadm join control-plane.example.com:6443 \
     --token <token> \
     --discovery-token-ca-cert-hash sha256:<hash> \
     --control-plane \
     --certificate-key <cert-key>
4. Verify cluster health
```

## DR Testing Cadence

Regular DR testing is the only way to ensure runbooks work when a real incident occurs. Testing also reveals gaps in backup coverage and procedure documentation.

```yaml
# DR Testing Schedule
Quarterly Tests:
  - etcd snapshot restore in isolated environment
  - Single node failure recovery
  - Velero namespace restore test

Semi-Annual Tests:
  - Full cluster recreate from GitOps (in separate region/account)
  - Multi-member etcd failure recovery
  - Control plane complete failure recovery

Annual Tests:
  - Full DR failover to secondary region
  - RTO validation against SLA targets
  - Full runbook review and update
```

```bash
#!/bin/bash
# dr-test-etcd-restore.sh - Test etcd restore in isolated environment

CLUSTER_NAME="dr-test-$(date +%Y%m)"
SNAPSHOT_SOURCE="s3://my-cluster-etcd-backups/production/$(aws s3 ls s3://my-cluster-etcd-backups/production/ | tail -1 | awk '{print $2}')"

echo "=== Starting DR Test: etcd Restore ==="
echo "Test cluster: ${CLUSTER_NAME}"
echo "Snapshot source: ${SNAPSHOT_SOURCE}"

START_TIME=$(date +%s)

# 1. Provision isolated test cluster (same specs as production)
echo "Step 1: Provisioning test cluster..."
eksctl create cluster \
  --name ${CLUSTER_NAME} \
  --version 1.29 \
  --region us-east-1 \
  --nodegroup-name workers \
  --node-type m5.xlarge \
  --nodes 3

# 2. Download snapshot
echo "Step 2: Downloading etcd snapshot..."
aws s3 cp ${SNAPSHOT_SOURCE}etcd-snapshot.db /tmp/test-snapshot.db

# 3. Perform restore
echo "Step 3: Performing etcd restore..."
./etcd-restore-single.sh /tmp/test-snapshot.db

# 4. Validate
echo "Step 4: Validating restore..."
./post-upgrade-validation.sh "v1.29.0"

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

echo "=== DR Test Complete ==="
echo "Total time: ${ELAPSED} seconds ($((ELAPSED/60)) minutes)"
echo "RTO achieved: $((ELAPSED/60)) minutes"
echo "Target RTO: 60 minutes"

if [ $((ELAPSED/60)) -le 60 ]; then
  echo "PASS: RTO target met"
else
  echo "FAIL: RTO target exceeded"
fi

# 5. Clean up test cluster
echo "Cleaning up test cluster..."
eksctl delete cluster --name ${CLUSTER_NAME}
```

## Multi-Region Failover

### Architecture for Multi-Region K8s DR

```yaml
Primary Region (us-east-1):
  - Active production cluster
  - Active database cluster
  - Hourly etcd snapshots to S3 (cross-region replication enabled)
  - Velero backups to S3
  - GitOps repository (GitHub/GitLab)

Secondary Region (us-west-2):
  - Warm standby cluster (minimal node count)
  - Read replica databases
  - S3 bucket for receiving replicated backups
  - DNS failover via Route 53 health checks
```

```bash
#!/bin/bash
# multi-region-failover.sh

set -euo pipefail

PRIMARY_REGION="us-east-1"
SECONDARY_REGION="us-west-2"
CLUSTER_NAME="my-cluster"
DOMAIN="api.example.com"
HOSTED_ZONE_ID="Z1234567890ABCDEFGHIJ"

echo "=== Initiating failover from ${PRIMARY_REGION} to ${SECONDARY_REGION} ==="

# Step 1: Verify primary is actually down
echo "Step 1: Verifying primary region status..."
if aws eks describe-cluster \
  --name ${CLUSTER_NAME} \
  --region ${PRIMARY_REGION} \
  --query 'cluster.status' 2>/dev/null | grep -q "ACTIVE"; then
  echo "WARNING: Primary cluster appears healthy. Are you sure you want to failover?"
  echo "Type 'FAILOVER' to confirm:"
  read CONFIRM
  [ "${CONFIRM}" != "FAILOVER" ] && exit 1
fi

# Step 2: Scale up secondary cluster
echo "Step 2: Scaling up secondary cluster..."
aws eks update-nodegroup-config \
  --cluster-name ${CLUSTER_NAME} \
  --nodegroup-name workers \
  --region ${SECONDARY_REGION} \
  --scaling-config minSize=5,maxSize=20,desiredSize=10

# Step 3: Restore latest etcd snapshot to secondary (if not using GitOps)
echo "Step 3: Syncing cluster state to secondary..."
# If using GitOps, just trigger sync:
KUBECONFIG=/tmp/secondary-kubeconfig
aws eks update-kubeconfig \
  --name ${CLUSTER_NAME} \
  --region ${SECONDARY_REGION} \
  --kubeconfig ${KUBECONFIG}

KUBECONFIG=${KUBECONFIG} argocd app sync --all --timeout 300

# Step 4: Verify workloads are running in secondary
echo "Step 4: Verifying workloads in secondary region..."
KUBECONFIG=${KUBECONFIG} kubectl get pods --all-namespaces \
  | grep -v Running | grep -v Completed

# Step 5: Update DNS to secondary region
echo "Step 5: Updating DNS to secondary region..."
SECONDARY_LB=$(KUBECONFIG=${KUBECONFIG} kubectl get svc \
  -n ingress-nginx ingress-nginx-controller \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')

aws route53 change-resource-record-sets \
  --hosted-zone-id ${HOSTED_ZONE_ID} \
  --change-batch "{
    \"Changes\": [{
      \"Action\": \"UPSERT\",
      \"ResourceRecordSet\": {
        \"Name\": \"${DOMAIN}\",
        \"Type\": \"CNAME\",
        \"TTL\": 60,
        \"ResourceRecords\": [{\"Value\": \"${SECONDARY_LB}\"}]
      }
    }]
  }"

echo "Step 5: DNS updated to secondary load balancer: ${SECONDARY_LB}"

# Step 6: Validate end-to-end
echo "Step 6: Validating end-to-end connectivity..."
for i in $(seq 1 12); do
  if curl -sf "https://${DOMAIN}/health" > /dev/null 2>&1; then
    echo "Health check passed"
    break
  fi
  echo "Waiting for DNS propagation... (${i}/12)"
  sleep 15
done

echo "=== Failover complete ==="
echo "Traffic is now served from ${SECONDARY_REGION}"
echo "Document this incident and initiate root cause analysis for primary failure"
```

## Monitoring DR Readiness

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: dr-readiness-alerts
  namespace: monitoring
spec:
  groups:
  - name: dr-readiness
    rules:
    - alert: EtcdBackupMissing
      expr: |
        time() - max(kube_job_status_completion_time{
          namespace="kube-system",
          job_name=~"etcd-backup.*"
        }) > 7200  # No successful backup in 2 hours
      for: 5m
      labels:
        severity: critical
        team: platform
      annotations:
        summary: "etcd backup has not run in 2 hours"
        description: "The last successful etcd backup was more than 2 hours ago. DR capability may be compromised."

    - alert: VeleroBackupFailed
      expr: |
        velero_backup_failure_total > 0
      for: 1m
      labels:
        severity: warning
        team: platform
      annotations:
        summary: "Velero backup failure detected"
        description: "Velero reported {{ $value }} backup failure(s). Application DR may be incomplete."

    - alert: VeleroBackupNotRun
      expr: |
        time() - max(velero_backup_last_successful_timestamp) > 86400
      for: 1h
      labels:
        severity: critical
        team: platform
      annotations:
        summary: "No successful Velero backup in 24 hours"
        description: "Velero has not completed a successful backup in 24 hours. DR capability is degraded."
```
