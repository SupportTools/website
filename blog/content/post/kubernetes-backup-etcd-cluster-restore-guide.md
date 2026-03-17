---
title: "Kubernetes Cluster Backup and Full Restore: etcd, Velero, and Disaster Recovery"
date: 2028-11-27T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Backup", "etcd", "Velero", "Disaster Recovery"]
categories:
- Kubernetes
- Disaster Recovery
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete Kubernetes disaster recovery guide: automating etcd snapshots, restoring clusters from etcd backups, using Velero for namespace-level recovery, defining RTO/RPO objectives, and validating DR with exercises."
more_link: "yes"
url: "/kubernetes-backup-etcd-cluster-restore-guide/"
---

Kubernetes cluster recovery after catastrophic failure requires two distinct backup strategies: etcd snapshots for cluster state recovery, and application-level backups (Velero) for persistent volume data and namespaced resources. Neither alone is sufficient. A restored etcd snapshot without PVC data leaves applications with empty databases. Velero backups without etcd restoration leave you rebuilding cluster infrastructure manually before you can restore application state.

This guide covers the complete DR strategy: etcd snapshot automation, S3 backup storage with encryption, step-by-step restore procedures, Velero for namespace-level recovery, RTO/RPO objectives, and tabletop exercise templates.

<!--more-->

# Kubernetes Cluster Backup and Full Restore: A Complete Disaster Recovery Guide

## The DR Architecture

A complete Kubernetes DR strategy requires three backup layers:

```
Layer 1: etcd snapshot
  - Contains: All Kubernetes objects (Deployments, Services, ConfigMaps, Secrets, CRDs, etc.)
  - Does NOT contain: PVC data (actual files/databases stored in volumes)
  - Recovery use: Rebuild cluster from scratch, restore to known-good state
  - Frequency: Every 15-60 minutes for production

Layer 2: Velero backup
  - Contains: Kubernetes resources (namespace-scoped), PVC snapshots via CSI
  - Does NOT contain: Cluster-scoped resources not in backup scope
  - Recovery use: Restore individual namespaces, applications, or specific resources
  - Frequency: Daily full + continuous for critical namespaces

Layer 3: Database-level backups
  - Contains: Logical database exports (pg_dump, mysqldump, mongodump)
  - Does NOT contain: Non-database PVC content
  - Recovery use: Point-in-time database recovery, cross-cluster migration
  - Frequency: Continuous (WAL archiving) or hourly logical
```

## etcd Snapshot Automation

### Understanding etcd Snapshot Content

An etcd snapshot is a point-in-time copy of the entire etcd key-value store. This includes:
- All Kubernetes API objects (your entire cluster configuration)
- Custom Resource Definitions and their instances
- Kubernetes Secrets (etcd-encrypted if encryption at rest is enabled)
- Lease objects (ephemeral, but included)

The snapshot does **not** include:
- Container images (in registry)
- Persistent volume data (on storage backend)
- Node-level state (kubelet, container runtime)

### Manual etcd Snapshot

```bash
# On a control plane node (or using kubectl exec for kubeadm clusters)
ETCDCTL_API=3 etcdctl snapshot save /backup/etcd-snapshot-$(date +%Y%m%d-%H%M%S).db \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key

# Verify the snapshot
ETCDCTL_API=3 etcdctl snapshot status /backup/etcd-snapshot-*.db \
  --write-out=table

# Expected output:
# +----------+----------+------------+------------+
# |   HASH   | REVISION | TOTAL KEYS | TOTAL SIZE |
# +----------+----------+------------+------------+
# | abc12345 |   234567 |       8432 |     42 MB  |
# +----------+----------+------------+------------+
```

### Automated Snapshot CronJob

```yaml
# etcd-backup-cronjob.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: etcd-backup
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: etcd-backup
  namespace: etcd-backup
---
# ConfigMap with backup script
apiVersion: v1
kind: ConfigMap
metadata:
  name: etcd-backup-script
  namespace: etcd-backup
data:
  backup.sh: |
    #!/bin/bash
    set -euo pipefail

    TIMESTAMP=$(date +%Y%m%d-%H%M%S)
    SNAPSHOT_FILE="/tmp/etcd-snapshot-${TIMESTAMP}.db"
    S3_BUCKET="${S3_BUCKET:-s3://my-cluster-backups}"
    S3_PREFIX="${S3_PREFIX:-etcd/production}"
    RETENTION_DAYS="${RETENTION_DAYS:-30}"

    echo "Starting etcd backup at ${TIMESTAMP}"

    # Take snapshot
    ETCDCTL_API=3 etcdctl snapshot save "${SNAPSHOT_FILE}" \
      --endpoints="${ETCD_ENDPOINTS:-https://127.0.0.1:2379}" \
      --cacert="${ETCD_CA_CERT:-/etc/kubernetes/pki/etcd/ca.crt}" \
      --cert="${ETCD_CERT:-/etc/kubernetes/pki/etcd/server.crt}" \
      --key="${ETCD_KEY:-/etc/kubernetes/pki/etcd/server.key}"

    # Verify snapshot integrity
    ETCDCTL_API=3 etcdctl snapshot status "${SNAPSHOT_FILE}" --write-out=json
    SNAPSHOT_SIZE=$(stat -c%s "${SNAPSHOT_FILE}")
    echo "Snapshot size: ${SNAPSHOT_SIZE} bytes"

    if [ "${SNAPSHOT_SIZE}" -lt 1048576 ]; then
      echo "ERROR: Snapshot suspiciously small (< 1MB). Aborting."
      exit 1
    fi

    # Encrypt and upload to S3
    ENCRYPTED_FILE="${SNAPSHOT_FILE}.enc"
    openssl enc -aes-256-cbc -pbkdf2 \
      -in "${SNAPSHOT_FILE}" \
      -out "${ENCRYPTED_FILE}" \
      -pass "env:ENCRYPTION_PASSWORD"

    aws s3 cp "${ENCRYPTED_FILE}" \
      "${S3_BUCKET}/${S3_PREFIX}/etcd-snapshot-${TIMESTAMP}.db.enc" \
      --storage-class STANDARD_IA \
      --metadata "cluster=${CLUSTER_NAME:-unknown},timestamp=${TIMESTAMP}"

    # Also save cluster version info alongside snapshot
    kubectl version -o json > /tmp/cluster-version.json
    aws s3 cp /tmp/cluster-version.json \
      "${S3_BUCKET}/${S3_PREFIX}/cluster-version-${TIMESTAMP}.json"

    # Clean up local files
    rm -f "${SNAPSHOT_FILE}" "${ENCRYPTED_FILE}" /tmp/cluster-version.json

    # Remove old S3 backups (older than RETENTION_DAYS)
    CUTOFF_DATE=$(date -d "-${RETENTION_DAYS} days" +%Y-%m-%d)
    aws s3 ls "${S3_BUCKET}/${S3_PREFIX}/" | \
      awk '{print $4}' | \
      while read -r key; do
        KEY_DATE=$(echo "${key}" | grep -oP '\d{8}' | head -1)
        if [ -n "${KEY_DATE}" ] && [ "${KEY_DATE}" \< "${CUTOFF_DATE//\-/}" ]; then
          echo "Removing old backup: ${key}"
          aws s3 rm "${S3_BUCKET}/${S3_PREFIX}/${key}"
        fi
      done

    echo "etcd backup completed successfully: ${TIMESTAMP}"
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: etcd-backup
  namespace: etcd-backup
spec:
  schedule: "*/30 * * * *"     # Every 30 minutes
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 5
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: etcd-backup
          hostNetwork: true          # Access etcd via localhost
          tolerations:
          - key: node-role.kubernetes.io/control-plane
            effect: NoSchedule
          nodeSelector:
            node-role.kubernetes.io/control-plane: ""
          containers:
          - name: etcd-backup
            image: bitnami/etcd:3.5.0
            command: ["/scripts/backup.sh"]
            env:
            - name: ETCD_ENDPOINTS
              value: "https://127.0.0.1:2379"
            - name: S3_BUCKET
              value: "s3://my-cluster-etcd-backups"
            - name: CLUSTER_NAME
              value: "production-cluster"
            - name: ENCRYPTION_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: etcd-backup-encryption
                  key: password
            volumeMounts:
            - name: etcd-certs
              mountPath: /etc/kubernetes/pki/etcd
              readOnly: true
            - name: scripts
              mountPath: /scripts
          volumes:
          - name: etcd-certs
            hostPath:
              path: /etc/kubernetes/pki/etcd
          - name: scripts
            configMap:
              name: etcd-backup-script
              defaultMode: 0755
          restartPolicy: OnFailure
```

## Full Cluster Restore from etcd Snapshot

This procedure restores a Kubernetes cluster from an etcd snapshot. It requires downtime.

### Pre-Restore Checklist

```bash
# Before starting restore:
# 1. Document current cluster state
kubectl get nodes -o wide > /tmp/pre-restore-nodes.txt
kubectl get pods --all-namespaces > /tmp/pre-restore-pods.txt

# 2. Download the target snapshot from S3
aws s3 cp \
  s3://my-cluster-etcd-backups/etcd/production/etcd-snapshot-20281127-100000.db.enc \
  /tmp/etcd-snapshot.db.enc

# 3. Decrypt the snapshot
openssl enc -d -aes-256-cbc -pbkdf2 \
  -in /tmp/etcd-snapshot.db.enc \
  -out /tmp/etcd-snapshot.db \
  -pass "env:ENCRYPTION_PASSWORD"

# 4. Verify snapshot integrity
ETCDCTL_API=3 etcdctl snapshot status /tmp/etcd-snapshot.db --write-out=table
```

### Step-by-Step etcd Restore

Perform this on **all** control plane nodes. Start with the first, then join the others.

```bash
# === On control-plane-1 ===

# Step 1: Stop Kubernetes components
# For kubeadm clusters (static pods in /etc/kubernetes/manifests)
mkdir -p /tmp/manifests-backup
mv /etc/kubernetes/manifests/*.yaml /tmp/manifests-backup/

# Wait for API server, controller manager, scheduler to stop
while kubectl cluster-info 2>/dev/null; do
  echo "Waiting for API server to stop..."
  sleep 2
done
echo "API server stopped"

# Step 2: Stop etcd
# Move etcd manifest to stop the static pod
mv /tmp/manifests-backup/etcd.yaml /tmp/etcd-manifest-backup.yaml

# Wait for etcd to stop
while pgrep etcd > /dev/null; do
  echo "Waiting for etcd to stop..."
  sleep 2
done
echo "etcd stopped"

# Step 3: Backup current etcd data directory
ETCD_DATA_DIR="/var/lib/etcd"
mv "${ETCD_DATA_DIR}" "${ETCD_DATA_DIR}.bak.$(date +%Y%m%d-%H%M%S)"

# Step 4: Restore snapshot
ETCDCTL_API=3 etcdctl snapshot restore /tmp/etcd-snapshot.db \
  --name="control-plane-1" \
  --initial-cluster="control-plane-1=https://192.168.1.10:2380" \
  --initial-advertise-peer-urls="https://192.168.1.10:2380" \
  --data-dir="${ETCD_DATA_DIR}" \
  --skip-hash-check

# Verify restore succeeded
ls -la "${ETCD_DATA_DIR}"

# Step 5: Restore etcd manifest
cp /tmp/etcd-manifest-backup.yaml /etc/kubernetes/manifests/etcd.yaml

# Wait for etcd to start
sleep 5
while ! ETCDCTL_API=3 etcdctl endpoint health \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key 2>/dev/null; do
  echo "Waiting for etcd to be healthy..."
  sleep 3
done
echo "etcd healthy"

# Step 6: Restore other Kubernetes manifests
cp /tmp/manifests-backup/*.yaml /etc/kubernetes/manifests/

# Wait for API server to become available
while ! kubectl cluster-info 2>/dev/null; do
  echo "Waiting for API server..."
  sleep 3
done
echo "API server ready"

# Step 7: Verify cluster state
kubectl get nodes
kubectl get pods --all-namespaces | head -30
```

### Multi-Node etcd Cluster Restore

For HA clusters with 3+ etcd members, restore on each control plane node:

```bash
# On each control plane node, use different --name and peer URL
# control-plane-1:
etcdctl snapshot restore /tmp/etcd-snapshot.db \
  --name="control-plane-1" \
  --initial-cluster="control-plane-1=https://192.168.1.10:2380,control-plane-2=https://192.168.1.11:2380,control-plane-3=https://192.168.1.12:2380" \
  --initial-advertise-peer-urls="https://192.168.1.10:2380" \
  --data-dir=/var/lib/etcd

# control-plane-2 (adjust --name and --initial-advertise-peer-urls):
etcdctl snapshot restore /tmp/etcd-snapshot.db \
  --name="control-plane-2" \
  --initial-cluster="control-plane-1=https://192.168.1.10:2380,control-plane-2=https://192.168.1.11:2380,control-plane-3=https://192.168.1.12:2380" \
  --initial-advertise-peer-urls="https://192.168.1.11:2380" \
  --data-dir=/var/lib/etcd
```

## Velero for Namespace-Level Recovery

Velero provides application-level backup and restore for Kubernetes namespaced resources and PVCs. It is the right tool for:
- Restoring a deleted namespace
- Migrating workloads between clusters
- Recovering PVC data after accidental deletion
- Rolling back application configuration

### Velero Installation

```bash
# Install Velero with AWS S3 backend
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.8.0 \
  --bucket my-cluster-velero-backups \
  --secret-file ./credentials-velero \
  --backup-location-config region=us-east-1 \
  --snapshot-location-config region=us-east-1 \
  --use-volume-snapshots=true \
  --use-node-agent \
  --default-volumes-to-fs-backup

# Verify installation
velero status
kubectl get pods -n velero
```

### Creating Backup Schedules

```bash
# Daily backup of all namespaces (cluster-wide application state)
velero schedule create daily-backup \
  --schedule="0 2 * * *" \
  --ttl 720h \
  --include-cluster-resources=true \
  --storage-location default

# Hourly backup of critical namespaces
velero schedule create hourly-payments \
  --schedule="0 * * * *" \
  --include-namespaces payments,orders \
  --ttl 168h \
  --storage-location default

# Verify schedules
velero schedule get
velero backup get
```

### Manual Backup Before Changes

```bash
# Always take a backup before major changes
velero backup create pre-upgrade-backup-$(date +%Y%m%d-%H%M%S) \
  --include-cluster-resources=true \
  --wait

# Verify backup completed
velero backup describe pre-upgrade-backup-20281127-120000 --details
```

### Restoring from Velero Backup

```bash
# List available backups
velero backup get

# Restore a specific namespace
velero restore create \
  --from-backup daily-backup-20281127-020000 \
  --include-namespaces payments \
  --wait

# Restore everything
velero restore create \
  --from-backup daily-backup-20281127-020000 \
  --include-cluster-resources=true \
  --wait

# Check restore status
velero restore describe <restore-name>
velero restore logs <restore-name>

# Verify pods are running after restore
kubectl get pods -n payments
```

### Restoring to a New Cluster

```bash
# 1. Install Velero on new cluster pointing to same S3 bucket
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.8.0 \
  --bucket my-cluster-velero-backups \
  --secret-file ./credentials-velero \
  --backup-location-config region=us-east-1 \
  --use-node-agent

# 2. Wait for Velero to sync backups from S3
sleep 30
velero backup get  # Should show backups from source cluster

# 3. Restore to new cluster
velero restore create cluster-migration \
  --from-backup daily-backup-20281127-020000 \
  --include-cluster-resources=true \
  --namespace-mappings "payments:payments-restored" \  # Optional: rename namespace
  --wait
```

## RTO/RPO Objectives by Cluster Tier

Define and document RTO/RPO based on cluster criticality:

```yaml
# dr-policy.yaml - document as Kubernetes ConfigMap for visibility
apiVersion: v1
kind: ConfigMap
metadata:
  name: dr-policy
  namespace: kube-system
  labels:
    app.kubernetes.io/component: disaster-recovery
data:
  policy: |
    Production Cluster (prd):
      RPO (Recovery Point Objective): 15 minutes
        - etcd backup every 15 minutes to S3
        - Velero PVC snapshots every 30 minutes for stateful workloads
      RTO (Recovery Time Objective): 2 hours
        - etcd restore: ~45 minutes
        - Velero restore: ~30 minutes
        - Application validation: ~45 minutes
      Backup Retention: 30 days

    Staging Cluster (stg):
      RPO: 4 hours
        - etcd backup every 4 hours
        - Velero daily backup
      RTO: 4 hours
      Backup Retention: 14 days

    Development Cluster (dev):
      RPO: 24 hours
        - Velero daily backup only
      RTO: 8 hours (rebuild from scratch if needed)
      Backup Retention: 7 days
```

## DR Validation and Tabletop Exercises

### Monthly Restore Test

```bash
#!/bin/bash
# dr-test.sh - run monthly to verify restore procedures work
# Usage: ./dr-test.sh <backup-name> <target-namespace>

BACKUP_NAME=${1:-"daily-backup-$(date -d 'yesterday' +%Y%m%d)-020000"}
TARGET_NS=${2:-"payments-dr-test"}

echo "=== DR Test: $(date) ==="
echo "Backup: ${BACKUP_NAME}"
echo "Target namespace: ${TARGET_NS}"

# Restore to isolated namespace
velero restore create "dr-test-$(date +%Y%m%d-%H%M%S)" \
  --from-backup "${BACKUP_NAME}" \
  --include-namespaces payments \
  --namespace-mappings "payments:${TARGET_NS}" \
  --wait

# Validate restore
echo "=== Checking restore status ==="
kubectl get pods -n "${TARGET_NS}"
kubectl get pvc -n "${TARGET_NS}"

# Run smoke tests against restored namespace
echo "=== Running smoke tests ==="
kubectl run smoke-test \
  --image=curlimages/curl \
  --restart=Never \
  --namespace="${TARGET_NS}" \
  --rm -it \
  -- curl -s http://payment-api.${TARGET_NS}.svc.cluster.local:8080/health

# Clean up
echo "=== Cleaning up ==="
kubectl delete namespace "${TARGET_NS}"
echo "=== DR Test Complete ==="
```

### Quarterly Tabletop Exercise Template

```markdown
# DR Tabletop Exercise - Q4 2028

## Scenario: Full Production Cluster Loss
Assume: Production cluster is completely unavailable. All nodes destroyed.
Data available: Latest etcd snapshot (15 min old) + Velero backup (30 min old)

## Participants
- On-call engineer: [name]
- Cluster admin: [name]
- Application owner: [name]
- Management: [name]

## Exercise Steps

1. Alert Detection (T+0)
   - Who detects the outage?
   - What monitoring alerts fire?
   - Expected MTTR to notification: < 5 min

2. Decision Point (T+5)
   - Determine scope: Is it recoverable or full rebuild?
   - Who has authority to declare DR and begin restore?

3. Communication (T+10)
   - Notify stakeholders with initial assessment
   - Set up war room (Slack channel: #incident-YYYYMMDD)
   - Establish update cadence

4. Restore Execution (T+15 to T+120)
   - Who runs the etcd restore procedure?
   - Who runs Velero restore?
   - Who validates application state?
   - Document actual time for each step

5. Validation (T+120)
   - Run smoke tests
   - Verify databases have expected data
   - Check dependent services

6. Resolution (T+135)
   - Announce recovery
   - Calculate actual RTO
   - Schedule post-mortem

## Questions to Answer During Exercise
- Where is the current backup list? (S3 console URL: ___)
- Where is the etcd restore runbook? (Confluence: ___)
- Who holds the encryption key for etcd backups?
- What is the current etcd snapshot age? (Monitoring URL: ___)
- Which Velero backup should we use?
- Are there any databases that need special restore procedures?
```

## Monitoring Backup Health

```yaml
# PrometheusRule for backup monitoring
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: etcd-backup-alerts
  namespace: monitoring
spec:
  groups:
  - name: etcd-backup
    rules:
    - alert: EtcdBackupJobFailed
      expr: kube_job_status_failed{job="etcd-backup", namespace="etcd-backup"} > 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "etcd backup job failed"
        description: "The etcd backup CronJob has a failed job. Last successful backup may be stale."

    - alert: EtcdBackupStale
      expr: |
        (time() - kube_cronjob_status_last_successful_time{cronjob="etcd-backup"}) > 3600
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "etcd backup is stale (>1 hour since last success)"

    - alert: VeleroBackupFailed
      expr: velero_backup_failure_total > 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Velero backup failed"
```

## Summary

A complete Kubernetes DR program requires both etcd snapshots (for cluster state) and Velero (for PVC data), encrypted and stored in S3. The critical operational practices:

1. Automate etcd snapshots every 15-30 minutes for production clusters
2. Encrypt backups before uploading to S3 using AES-256
3. Store encryption keys separately from backup storage (use Secrets Manager, not the same S3 bucket)
4. Verify snapshot integrity with `etcdctl snapshot status` after each backup
5. Test the full restore procedure quarterly - DR runbooks that have never been tested are not DR plans
6. Document RTO/RPO objectives and measure against them in tabletop exercises
7. Monitor backup job success/failure with Prometheus alerts; a silently failing backup job provides false confidence
8. Keep backup retention policy aligned with RPO and compliance requirements
