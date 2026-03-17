---
title: "Kubernetes etcd Operations: Backup, Restore, Compaction, and Disaster Recovery"
date: 2027-08-21T00:00:00-05:00
draft: false
tags: ["Kubernetes", "etcd", "Backup", "Disaster Recovery"]
categories:
- Kubernetes
- Operations
author: "Matthew Mattox - mmattox@support.tools"
description: "Production etcd operations guide covering backup strategies with etcdctl, point-in-time restore procedures, compaction and defragmentation, cluster membership changes, TLS certificate rotation, and comprehensive etcd health monitoring."
more_link: "yes"
url: "/kubernetes-etcd-operations-guide/"
---

etcd is the sole persistent store for all Kubernetes cluster state — every Pod, Service, ConfigMap, Secret, and CRD lives in etcd. A corrupted or unavailable etcd cluster means an unavailable Kubernetes control plane. Production operations teams must treat etcd with the same operational rigor as a primary database: scheduled backups, tested restores, proactive compaction, and continuous health monitoring are non-negotiable.

<!--more-->

## etcd Architecture in Kubernetes

### Raft Consensus and Quorum

etcd uses the Raft consensus algorithm, requiring a quorum of `(n/2)+1` members to accept writes. For a 3-member cluster, 2 members must be available. For 5 members, 3 must be available.

| Cluster Size | Quorum Required | Tolerable Failures |
|-------------|-----------------|-------------------|
| 1 | 1 | 0 |
| 3 | 2 | 1 |
| 5 | 3 | 2 |
| 7 | 4 | 3 |

Production Kubernetes clusters should run 3 or 5 etcd members. Three members is the minimum for high availability; five provides an additional failure tolerance margin for large clusters where maintenance operations and failures may overlap.

### etcd Data Directory Structure

```bash
# Default etcd data directory in kubeadm clusters
ls -la /var/lib/etcd/
# member/
#   snap/      — Snapshots and WAL
#   wal/       — Write-Ahead Log entries

# Size check — etcd should stay under 2GB for healthy compaction
du -sh /var/lib/etcd/
```

## etcdctl Configuration

### Environment Setup

All etcd operations require TLS client certificates. Establish a reusable environment:

```bash
# For kubeadm clusters, certificates are in /etc/kubernetes/pki/etcd/
export ETCDCTL_API=3
export ETCDCTL_ENDPOINTS="https://127.0.0.1:2379"
export ETCDCTL_CACERT="/etc/kubernetes/pki/etcd/ca.crt"
export ETCDCTL_CERT="/etc/kubernetes/pki/etcd/server.crt"
export ETCDCTL_KEY="/etc/kubernetes/pki/etcd/server.key"

# Verify connectivity
etcdctl endpoint health
etcdctl endpoint status -w table
```

For multi-member clusters, target all endpoints:

```bash
export ETCDCTL_ENDPOINTS="https://10.0.1.10:2379,https://10.0.1.11:2379,https://10.0.1.12:2379"

etcdctl endpoint status -w table
# +---------------------------+------------------+---------+---------+-----------+
# |         ENDPOINT          |        ID        | VERSION | DB SIZE | IS LEADER |
# +---------------------------+------------------+---------+---------+-----------+
# | https://10.0.1.10:2379   | 8e9e05c52164694d |  3.5.9  |  125 MB |     true  |
# | https://10.0.1.11:2379   | 91bc3c398fb3c146 |  3.5.9  |  125 MB |    false  |
# | https://10.0.1.12:2379   | fd422379fda50e48 |  3.5.9  |  125 MB |    false  |
# +---------------------------+------------------+---------+---------+-----------+
```

## Backup Strategies

### Snapshot Backup with etcdctl

The `snapshot save` command creates a consistent point-in-time backup:

```bash
#!/usr/bin/env bash
# etcd-backup.sh
set -euo pipefail

BACKUP_DIR="/backup/etcd"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
SNAPSHOT_FILE="${BACKUP_DIR}/etcd-snapshot-${TIMESTAMP}.db"

export ETCDCTL_API=3
export ETCDCTL_ENDPOINTS="https://127.0.0.1:2379"
export ETCDCTL_CACERT="/etc/kubernetes/pki/etcd/ca.crt"
export ETCDCTL_CERT="/etc/kubernetes/pki/etcd/server.crt"
export ETCDCTL_KEY="/etc/kubernetes/pki/etcd/server.key"

mkdir -p "$BACKUP_DIR"

echo "[$(date)] Starting etcd snapshot backup..."
etcdctl snapshot save "$SNAPSHOT_FILE"

# Verify the snapshot
etcdctl snapshot status "$SNAPSHOT_FILE" -w table
echo "[$(date)] Snapshot saved: $SNAPSHOT_FILE"

# Compress to save space
gzip "$SNAPSHOT_FILE"
echo "[$(date)] Compressed: ${SNAPSHOT_FILE}.gz"

# Retain only the last 7 days of backups
find "$BACKUP_DIR" -name "etcd-snapshot-*.db.gz" -mtime +7 -delete
echo "[$(date)] Cleaned up old backups"

# Upload to S3 (replace with actual bucket name)
aws s3 cp "${SNAPSHOT_FILE}.gz" \
  "s3://BACKUP_BUCKET_NAME_REPLACE_ME/etcd/$(hostname)/${TIMESTAMP}.db.gz" \
  --storage-class STANDARD_IA

echo "[$(date)] Backup complete: ${SNAPSHOT_FILE}.gz"
```

Schedule via cron or a Kubernetes CronJob:

```yaml
# etcd-backup-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: etcd-backup
  namespace: kube-system
spec:
  schedule: "0 */6 * * *"    # Every 6 hours
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          hostNetwork: true
          tolerations:
            - key: "node-role.kubernetes.io/control-plane"
              effect: NoSchedule
          nodeSelector:
            node-role.kubernetes.io/control-plane: ""
          containers:
            - name: etcd-backup
              image: gcr.io/etcd-development/etcd:v3.5.9
              command:
                - /bin/sh
                - -c
                - |
                  TIMESTAMP=$(date +%Y%m%d_%H%M%S)
                  etcdctl snapshot save /backup/etcd-${TIMESTAMP}.db
                  etcdctl snapshot status /backup/etcd-${TIMESTAMP}.db
              env:
                - name: ETCDCTL_API
                  value: "3"
                - name: ETCDCTL_ENDPOINTS
                  value: "https://127.0.0.1:2379"
                - name: ETCDCTL_CACERT
                  value: "/etc/kubernetes/pki/etcd/ca.crt"
                - name: ETCDCTL_CERT
                  value: "/etc/kubernetes/pki/etcd/server.crt"
                - name: ETCDCTL_KEY
                  value: "/etc/kubernetes/pki/etcd/server.key"
              volumeMounts:
                - name: etcd-certs
                  mountPath: /etc/kubernetes/pki/etcd
                  readOnly: true
                - name: backup-dir
                  mountPath: /backup
          volumes:
            - name: etcd-certs
              hostPath:
                path: /etc/kubernetes/pki/etcd
            - name: backup-dir
              hostPath:
                path: /backup/etcd
          restartPolicy: OnFailure
```

### Velero for Application-Consistent Backups

While etcdctl snapshots cover cluster state, Velero provides application-aware backups:

```bash
velero backup create cluster-state-backup \
  --include-cluster-resources=true \
  --storage-location default \
  --wait

velero backup describe cluster-state-backup
```

## Point-in-Time Restore Procedures

### Full Cluster Restore from Snapshot

This procedure restores a cluster to the state at snapshot time. All changes after the snapshot are lost.

```bash
#!/usr/bin/env bash
# etcd-restore.sh
# Run on EACH control plane node with the SAME snapshot file
set -euo pipefail

SNAPSHOT_FILE="${1:?Usage: etcd-restore.sh <snapshot-file>}"
NODE_NAME="${2:?Usage: etcd-restore.sh <snapshot-file> <node-name>}"
ETCD_DATA_DIR="/var/lib/etcd"
ETCD_BACKUP_DIR="/var/lib/etcd-backup-$(date +%Y%m%d_%H%M%S)"

# Stop kube-apiserver to prevent writes during restore
# (kubeadm clusters: move static pod manifests)
mkdir -p /tmp/k8s-manifests-backup
mv /etc/kubernetes/manifests/*.yaml /tmp/k8s-manifests-backup/
sleep 10  # Wait for containers to stop

echo "Backing up existing etcd data..."
mv "$ETCD_DATA_DIR" "$ETCD_BACKUP_DIR"

echo "Restoring snapshot: $SNAPSHOT_FILE"
ETCDCTL_API=3 etcdctl snapshot restore "$SNAPSHOT_FILE" \
  --name "$NODE_NAME" \
  --data-dir "$ETCD_DATA_DIR" \
  --initial-cluster "$(cat /etc/kubernetes/manifests-backup/etcd.yaml | \
    grep initial-cluster | awk '{print $2}')" \
  --initial-cluster-token "etcd-cluster-1" \
  --initial-advertise-peer-urls "https://$(hostname -I | awk '{print $1}'):2380"

# Fix ownership
chown -R etcd:etcd "$ETCD_DATA_DIR" 2>/dev/null || true

echo "Restoring kube-apiserver and other manifests..."
mv /tmp/k8s-manifests-backup/*.yaml /etc/kubernetes/manifests/

echo "Restore complete. Waiting for etcd to start..."
sleep 15
ETCDCTL_API=3 etcdctl endpoint health \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key
```

For a 3-node cluster, run the restore on each node with the cluster topology:

```bash
# Node 1
etcdctl snapshot restore snapshot.db \
  --name etcd-1 \
  --data-dir /var/lib/etcd \
  --initial-cluster "etcd-1=https://10.0.1.10:2380,etcd-2=https://10.0.1.11:2380,etcd-3=https://10.0.1.12:2380" \
  --initial-cluster-token etcd-cluster-restore-1 \
  --initial-advertise-peer-urls https://10.0.1.10:2380

# Node 2
etcdctl snapshot restore snapshot.db \
  --name etcd-2 \
  --data-dir /var/lib/etcd \
  --initial-cluster "etcd-1=https://10.0.1.10:2380,etcd-2=https://10.0.1.11:2380,etcd-3=https://10.0.1.12:2380" \
  --initial-cluster-token etcd-cluster-restore-1 \
  --initial-advertise-peer-urls https://10.0.1.11:2380

# Node 3
etcdctl snapshot restore snapshot.db \
  --name etcd-3 \
  --data-dir /var/lib/etcd \
  --initial-cluster "etcd-1=https://10.0.1.10:2380,etcd-2=https://10.0.1.11:2380,etcd-3=https://10.0.1.12:2380" \
  --initial-cluster-token etcd-cluster-restore-1 \
  --initial-advertise-peer-urls https://10.0.1.12:2380
```

## Compaction and Defragmentation

### Why Compaction is Required

etcd uses MVCC (Multi-Version Concurrency Control), retaining all historical versions of every key. Without compaction, the database grows unbounded. At the 8GB default quota, etcd raises an alarm and the Kubernetes API server becomes read-only.

```bash
# Check current DB size and quota
etcdctl endpoint status -w json | jq '.[].Status | {
  db_size_mb: (.dbSize / 1024 / 1024),
  db_size_in_use_mb: (.dbSizeInUse / 1024 / 1024),
  raft_applied_index: .raftAppliedIndex
}'

# Check if etcd has raised a space alarm
etcdctl alarm list
```

### Automated Compaction

etcd supports auto-compaction via startup flags:

```yaml
# etcd static pod flags (kubeadm: /etc/kubernetes/manifests/etcd.yaml)
- --auto-compaction-mode=revision
- --auto-compaction-retention=10000   # Keep last 10,000 revisions
# OR
- --auto-compaction-mode=periodic
- --auto-compaction-retention=1h      # Keep last 1 hour of history
```

### Manual Compaction and Defragmentation

```bash
#!/usr/bin/env bash
# etcd-compact-defrag.sh
set -euo pipefail

export ETCDCTL_API=3
export ETCDCTL_ENDPOINTS="https://127.0.0.1:2379"
export ETCDCTL_CACERT="/etc/kubernetes/pki/etcd/ca.crt"
export ETCDCTL_CERT="/etc/kubernetes/pki/etcd/server.crt"
export ETCDCTL_KEY="/etc/kubernetes/pki/etcd/server.key"

echo "=== Before compaction ==="
etcdctl endpoint status -w table

# Get the current revision
REVISION=$(etcdctl endpoint status -w json | jq -r '.[0].Status.header.revision')
echo "Current revision: $REVISION"

# Compact to the current revision (discards all history up to now)
echo "Compacting to revision $REVISION..."
etcdctl compact "$REVISION"

# Defragment each member individually
# IMPORTANT: Defrag one member at a time to avoid quorum loss
for ENDPOINT in $(echo "$ETCDCTL_ENDPOINTS" | tr ',' '\n'); do
  echo "Defragmenting $ENDPOINT..."
  etcdctl defrag --endpoints="$ENDPOINT"
  sleep 5
done

# Clear any space alarms
etcdctl alarm disarm

echo "=== After defragmentation ==="
etcdctl endpoint status -w table
```

Running defragmentation: allow 30–60 seconds per member. For a 3-member cluster, the total downtime window per member is brief, but scheduling during low-traffic periods is recommended.

## Cluster Membership Changes

### Adding a New etcd Member

```bash
# Step 1: Add the member to the cluster (run from existing member)
etcdctl member add etcd-4 \
  --peer-urls="https://10.0.1.13:2380"

# Output includes the initial-cluster string for the new member
# ETCD_NAME="etcd-4"
# ETCD_INITIAL_CLUSTER="etcd-1=https://10.0.1.10:2380,...,etcd-4=https://10.0.1.13:2380"
# ETCD_INITIAL_CLUSTER_STATE="existing"

# Step 2: Start etcd on the new node with the output values
# Use --initial-cluster-state=existing (NOT new)

# Step 3: Verify the new member joined
etcdctl member list -w table
```

### Removing a Failed Member

```bash
# Get member IDs
etcdctl member list -w table

# Remove the failed member (use its ID from the list)
etcdctl member remove <member-id>

# Verify removal
etcdctl member list -w table

# Repair quorum if majority is lost (disaster recovery):
# Stop all remaining etcd processes
# On the surviving member with the most recent data:
# Start etcd with --force-new-cluster flag
# This promotes the single node to a new single-member cluster
# Then add other members back
```

## TLS Certificate Rotation

### Checking Certificate Expiry

```bash
# Check all etcd certificate expiry dates
for cert in /etc/kubernetes/pki/etcd/*.crt; do
  echo "=== $cert ==="
  openssl x509 -in "$cert" -noout -dates -subject
done

# Check via kubeadm (shows days remaining)
kubeadm certs check-expiration | grep etcd
```

### Rotating Certificates with kubeadm

```bash
# Renew all etcd certificates
kubeadm certs renew etcd-ca
kubeadm certs renew etcd-server
kubeadm certs renew etcd-peer
kubeadm certs renew etcd-healthcheck-client
kubeadm certs renew apiserver-etcd-client

# Verify new expiry
kubeadm certs check-expiration | grep etcd

# Restart etcd to load new certificates
# (kubeadm: update the static pod manifest to trigger restart)
# The API server must also be restarted to pick up the new client cert
kubectl delete pod -n kube-system -l component=etcd
kubectl delete pod -n kube-system -l component=kube-apiserver
```

## Monitoring etcd Health

### Prometheus Metrics and Alerts

```yaml
# etcd-prometheus-alerts.yaml
groups:
  - name: etcd
    rules:
      - alert: EtcdInsufficientMembers
        expr: count(etcd_server_has_leader{job="etcd"} == 1) < ((count(etcd_server_has_leader{job="etcd"}) + 2) / 2)
        for: 3m
        labels:
          severity: critical
        annotations:
          summary: "etcd cluster has insufficient members for quorum"

      - alert: EtcdNoLeader
        expr: etcd_server_has_leader{job="etcd"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "etcd member {{ $labels.instance }} has no leader"

      - alert: EtcdHighNumberOfLeaderChanges
        expr: rate(etcd_server_leader_changes_seen_total{job="etcd"}[15m]) > 3
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "etcd experiencing frequent leader elections"

      - alert: EtcdDatabaseSpaceExceeded
        expr: etcd_mvcc_db_total_size_in_bytes{job="etcd"} / etcd_server_quota_backend_bytes{job="etcd"} > 0.8
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "etcd database is {{ $value | humanizePercentage }} of quota"

      - alert: EtcdDatabaseQuotaLow
        expr: etcd_mvcc_db_total_size_in_bytes{job="etcd"} / etcd_server_quota_backend_bytes{job="etcd"} > 0.95
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "etcd database approaching quota limit — immediate compaction required"

      - alert: EtcdHighCommitDurations
        expr: histogram_quantile(0.99, sum(rate(etcd_disk_backend_commit_duration_seconds_bucket{job="etcd"}[5m])) by (le, instance)) > 0.25
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "etcd commit p99 latency {{ $value }}s — check disk performance"

      - alert: EtcdHighWalFsyncDurations
        expr: histogram_quantile(0.99, sum(rate(etcd_disk_wal_fsync_duration_seconds_bucket{job="etcd"}[5m])) by (le, instance)) > 0.5
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "etcd WAL fsync p99 latency {{ $value }}s — disk may be overloaded"
```

### Key Metrics Explained

```promql
# Cluster leadership health
etcd_server_has_leader             # 1 = has leader, 0 = no leader

# Performance
etcd_disk_wal_fsync_duration_seconds_bucket   # WAL write latency
etcd_disk_backend_commit_duration_seconds_bucket  # DB commit latency
etcd_network_peer_round_trip_time_seconds_bucket  # Inter-member latency

# Database size
etcd_mvcc_db_total_size_in_bytes   # Total allocated size
etcd_mvcc_db_total_size_in_use_bytes  # Actual data size (after compaction)
etcd_server_quota_backend_bytes    # Configured quota (default 8GB)

# Revision tracking
etcd_mvcc_db_total_size_in_use_bytes / etcd_mvcc_db_total_size_in_bytes
# Low ratio indicates compaction has freed space but defrag hasn't reclaimed it
```

### Health Check Script

```bash
#!/usr/bin/env bash
# etcd-healthcheck.sh
set -euo pipefail

export ETCDCTL_API=3
export ETCDCTL_ENDPOINTS="https://127.0.0.1:2379"
export ETCDCTL_CACERT="/etc/kubernetes/pki/etcd/ca.crt"
export ETCDCTL_CERT="/etc/kubernetes/pki/etcd/server.crt"
export ETCDCTL_KEY="/etc/kubernetes/pki/etcd/server.key"

echo "=== etcd Cluster Health ==="
etcdctl endpoint health -w table

echo ""
echo "=== etcd Cluster Status ==="
etcdctl endpoint status -w table

echo ""
echo "=== Member List ==="
etcdctl member list -w table

echo ""
echo "=== Active Alarms ==="
etcdctl alarm list

echo ""
echo "=== Certificate Expiry ==="
kubeadm certs check-expiration 2>/dev/null | grep etcd || \
  openssl x509 -in /etc/kubernetes/pki/etcd/server.crt -noout -enddate
```

Maintaining etcd health requires discipline in three areas: frequent backups with tested restore procedures (not just backup verification), proactive compaction before the 8GB quota becomes a crisis, and continuous monitoring of fsync latency as the earliest indicator of disk performance degradation. etcd's performance is directly tied to storage I/O — placing etcd data on dedicated SSDs with low write latency is a prerequisite for production-grade cluster stability.
