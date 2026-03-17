---
title: "Kubernetes etcd Operations: Backup, Restore, and Performance Tuning"
date: 2028-03-01T00:00:00-05:00
draft: false
tags: ["Kubernetes", "etcd", "Backup", "Disaster Recovery", "Performance", "Raft"]
categories: ["Kubernetes", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to etcd operations for Kubernetes: Raft consensus, WAL architecture, automated snapshot backups, point-in-time restore, defragmentation, performance tuning, metrics and alerting, and TLS certificate rotation."
more_link: "yes"
url: "/kubernetes-etcd-operations-guide-deep-dive/"
---

etcd is the persistent backing store for all Kubernetes cluster state. Every API object—Pod, Service, ConfigMap, Secret, CRD—is stored in etcd as key-value data. etcd failures directly cause Kubernetes API server failures, which block all cluster operations. Understanding etcd's architecture, maintaining disciplined backup procedures, tuning for production workloads, and monitoring the right metrics is foundational to enterprise Kubernetes operations. This guide covers all aspects of etcd operations that Kubernetes administrators must master.

<!--more-->

## etcd Architecture: Raft Consensus and WAL

etcd uses the Raft distributed consensus algorithm to maintain strong consistency across a cluster of nodes. Key properties:

- **Leader election**: One node is elected leader. The leader handles all write requests.
- **Log replication**: The leader appends entries to its Write-Ahead Log (WAL) and replicates them to followers before committing.
- **Quorum**: A write is committed only when a majority of nodes (`⌊n/2⌋ + 1`) acknowledge it. For a 3-node cluster, 2 nodes must acknowledge.
- **Read from leader** (default): All reads go to the leader to guarantee linearizability.

### WAL and Snapshot

The Write-Ahead Log records all state changes as sequential entries. etcd periodically takes snapshots to bound WAL size:

```
WAL structure on disk:
/var/lib/etcd/
├── member/
│   ├── snap/
│   │   ├── 0000000000000001-0000000000000001.snap  # Snapshot file
│   │   └── db                                       # bbolt database
│   └── wal/
│       ├── 0000000000000000-0000000000000000.wal   # WAL segment
│       └── 0000000000000001-0000000000000001.wal
```

When the WAL reaches `--snapshot-count` entries (default 100,000), etcd creates a new snapshot and truncates the WAL. Snapshots contain the full state at a point in time.

## etcdctl Snapshot Backup Automation

A complete backup solution requires regular snapshots with verified integrity.

### Manual Snapshot

```bash
# Set environment variables for etcdctl
export ETCDCTL_API=3
export ETCDCTL_ENDPOINTS=https://127.0.0.1:2379
export ETCDCTL_CACERT=/etc/kubernetes/pki/etcd/ca.crt
export ETCDCTL_CERT=/etc/kubernetes/pki/etcd/healthcheck-client.crt
export ETCDCTL_KEY=/etc/kubernetes/pki/etcd/healthcheck-client.key

# Take a snapshot
BACKUP_DIR="/backup/etcd/$(date +%Y%m%d)"
mkdir -p "$BACKUP_DIR"

etcdctl snapshot save "${BACKUP_DIR}/etcd-snapshot-$(date +%H%M%S).db"

# Verify the snapshot
etcdctl snapshot status "${BACKUP_DIR}/etcd-snapshot-$(date +%H%M%S).db" \
  --write-out=table
# Output:
# +----------+----------+------------+------------+
# |   HASH   | REVISION | TOTAL KEYS | TOTAL SIZE |
# +----------+----------+------------+------------+
# | a8ead7b0 |   123456 |      18432 |    9.1 MB  |
# +----------+----------+------------+------------+
```

### Automated Backup CronJob

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: etcd-backup
  namespace: kube-system
spec:
  schedule: "*/30 * * * *"   # Every 30 minutes
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 5
  jobTemplate:
    spec:
      backoffLimit: 2
      template:
        spec:
          restartPolicy: OnFailure
          hostNetwork: true
          tolerations:
          - effect: NoSchedule
            operator: Exists
          nodeSelector:
            node-role.kubernetes.io/control-plane: ""
          containers:
          - name: etcd-backup
            image: registry.k8s.io/etcd:3.5.12-0
            command:
            - /bin/sh
            - -c
            - |
              set -e
              BACKUP_FILE="/backup/etcd-${NODE_NAME}-$(date +%Y%m%dT%H%M%S).db"

              echo "Taking etcd snapshot..."
              etcdctl snapshot save "$BACKUP_FILE" \
                --endpoints=https://127.0.0.1:2379 \
                --cacert=/etc/kubernetes/pki/etcd/ca.crt \
                --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
                --key=/etc/kubernetes/pki/etcd/healthcheck-client.key

              echo "Verifying snapshot..."
              etcdctl snapshot status "$BACKUP_FILE" --write-out=table

              echo "Compressing snapshot..."
              gzip -9 "$BACKUP_FILE"

              # Clean up snapshots older than 7 days
              find /backup -name "etcd-*.db.gz" -mtime +7 -delete
              echo "Backup complete: ${BACKUP_FILE}.gz"

            env:
            - name: ETCDCTL_API
              value: "3"
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
            resources:
              requests:
                cpu: "100m"
                memory: "128Mi"
              limits:
                cpu: "500m"
                memory: "512Mi"
            volumeMounts:
            - name: etcd-certs
              mountPath: /etc/kubernetes/pki/etcd
              readOnly: true
            - name: backup-storage
              mountPath: /backup
          volumes:
          - name: etcd-certs
            hostPath:
              path: /etc/kubernetes/pki/etcd
          - name: backup-storage
            persistentVolumeClaim:
              claimName: etcd-backup-pvc
```

### Off-Site Backup to S3

```bash
#!/bin/bash
# backup-to-s3.sh - Run as part of backup pipeline

set -euo pipefail

SNAPSHOT_FILE="$1"
S3_BUCKET="${ETCD_BACKUP_BUCKET:-s3://cluster-etcd-backups}"
CLUSTER_NAME="${CLUSTER_NAME:-production}"

# Upload with server-side encryption
aws s3 cp "${SNAPSHOT_FILE}" \
  "${S3_BUCKET}/${CLUSTER_NAME}/$(basename ${SNAPSHOT_FILE})" \
  --sse aws:kms \
  --sse-kms-key-id "${KMS_KEY_ID:-alias/etcd-backup}" \
  --storage-class STANDARD_IA

echo "Uploaded to ${S3_BUCKET}/${CLUSTER_NAME}/$(basename ${SNAPSHOT_FILE})"

# Verify the upload
aws s3api head-object \
  --bucket "${S3_BUCKET#s3://}" \
  --key "${CLUSTER_NAME}/$(basename ${SNAPSHOT_FILE})" \
  | jq '{ContentLength, ETag, ServerSideEncryption}'
```

## Point-in-Time Restore Procedure

Restoring etcd is the most critical recovery procedure in Kubernetes. It must be practiced regularly.

### Pre-Restore Checklist

```bash
# 1. Verify backup integrity before starting
etcdctl snapshot status backup.db --write-out=table

# 2. Document current cluster state (for reference)
kubectl get nodes -o wide > /tmp/pre-restore-nodes.txt
kubectl get pods -A --field-selector=status.phase=Running | wc -l

# 3. Identify all etcd member addresses
kubectl exec -n kube-system etcd-$(hostname) -- \
  etcdctl member list \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/peer.crt \
  --key=/etc/kubernetes/pki/etcd/peer.key
```

### Single-Node Restore (Kubeadm Cluster)

```bash
#!/bin/bash
# restore-etcd.sh - Run on each control plane node
# CAUTION: This procedure causes cluster downtime

BACKUP_FILE="/backup/etcd-snapshot-20280301T120000.db.gz"
ETCD_DATA_DIR="/var/lib/etcd"
RESTORE_DIR="/var/lib/etcd-restore-$(date +%s)"
NODE_NAME=$(hostname -f)

# 1. Stop the API server and etcd
# For kubeadm, move static pod manifests out
mkdir -p /tmp/kube-manifests-backup
mv /etc/kubernetes/manifests/etcd.yaml /tmp/kube-manifests-backup/
mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/kube-manifests-backup/

# Wait for pods to terminate
sleep 15

# 2. Decompress backup
gunzip -c "$BACKUP_FILE" > /tmp/etcd-restore.db

# 3. Restore snapshot
# IMPORTANT: cluster-name, initial-cluster, initial-cluster-token must match
# the values in the etcd static pod manifest

ETCD_INITIAL_CLUSTER="controlplane-1=https://10.0.0.1:2380,controlplane-2=https://10.0.0.2:2380,controlplane-3=https://10.0.0.3:2380"
ETCD_INITIAL_CLUSTER_TOKEN="etcd-cluster-production"
PEER_URL="https://$(hostname -I | awk '{print $1}'):2380"

ETCDCTL_API=3 etcdctl snapshot restore /tmp/etcd-restore.db \
  --name="$NODE_NAME" \
  --initial-cluster="$ETCD_INITIAL_CLUSTER" \
  --initial-cluster-token="$ETCD_INITIAL_CLUSTER_TOKEN" \
  --initial-advertise-peer-urls="$PEER_URL" \
  --data-dir="$RESTORE_DIR"

# 4. Replace etcd data directory
rm -rf "$ETCD_DATA_DIR"
mv "$RESTORE_DIR" "$ETCD_DATA_DIR"

# Fix permissions
chown -R etcd:etcd "$ETCD_DATA_DIR" 2>/dev/null || \
  chown -R root:root "$ETCD_DATA_DIR"

# 5. Restore API server and etcd manifests
mv /tmp/kube-manifests-backup/etcd.yaml /etc/kubernetes/manifests/
sleep 30  # Wait for etcd to start

mv /tmp/kube-manifests-backup/kube-apiserver.yaml /etc/kubernetes/manifests/
sleep 30  # Wait for API server to start

# 6. Verify cluster is healthy
kubectl get nodes
kubectl get pods -n kube-system
```

### Multi-Node Restore

For 3-node or 5-node HA etcd clusters, restore must be coordinated:

```bash
# Run on ALL control plane nodes simultaneously (or with a brief window)
# Each node must use the same snapshot but different member-specific flags

# Node 1 (10.0.0.1)
ETCDCTL_API=3 etcdctl snapshot restore /tmp/etcd-restore.db \
  --name="controlplane-1" \
  --initial-cluster="controlplane-1=https://10.0.0.1:2380,controlplane-2=https://10.0.0.2:2380,controlplane-3=https://10.0.0.3:2380" \
  --initial-cluster-token="etcd-cluster-production-restore-$(date +%s)" \
  --initial-advertise-peer-urls="https://10.0.0.1:2380" \
  --data-dir="/var/lib/etcd"

# Node 2 (10.0.0.2)
ETCDCTL_API=3 etcdctl snapshot restore /tmp/etcd-restore.db \
  --name="controlplane-2" \
  --initial-cluster="controlplane-1=https://10.0.0.1:2380,controlplane-2=https://10.0.0.2:2380,controlplane-3=https://10.0.0.3:2380" \
  --initial-cluster-token="etcd-cluster-production-restore-$(date +%s)" \
  --initial-advertise-peer-urls="https://10.0.0.2:2380" \
  --data-dir="/var/lib/etcd"

# Use the SAME --initial-cluster-token on all nodes
# A unique token prevents the restored cluster from joining an existing cluster accidentally
```

## Defragmentation and Compaction

etcd retains all historical revisions in its bbolt database. Without compaction, the database grows indefinitely.

### Compaction

Compaction removes all historical revisions, keeping only the current state:

```bash
# Get current revision
REVISION=$(etcdctl endpoint status --write-out=json | \
  jq -r '.[] | .Status.header.revision')

# Compact to current revision (keep only current state)
etcdctl compact "$REVISION"
```

For production, use the `--auto-compaction-retention` flag instead of manual compaction:

```yaml
# In etcd static pod manifest (/etc/kubernetes/manifests/etcd.yaml)
spec:
  containers:
  - command:
    - etcd
    - --auto-compaction-mode=periodic
    - --auto-compaction-retention=8h  # Retain 8 hours of history
    # OR:
    # - --auto-compaction-mode=revision
    # - --auto-compaction-retention=50000  # Retain last 50,000 revisions
```

### Defragmentation

After compaction, the database file retains empty space from deleted entries. Defragmentation reclaims this space:

```bash
#!/bin/bash
# defrag-etcd.sh - Run during maintenance window

set -euo pipefail

export ETCDCTL_API=3
export ETCDCTL_ENDPOINTS=https://127.0.0.1:2379
export ETCDCTL_CACERT=/etc/kubernetes/pki/etcd/ca.crt
export ETCDCTL_CERT=/etc/kubernetes/pki/etcd/healthcheck-client.crt
export ETCDCTL_KEY=/etc/kubernetes/pki/etcd/healthcheck-client.key

# Check current db size before defrag
echo "=== Before defragmentation ==="
etcdctl endpoint status --write-out=table

# Defragment the leader last to minimize disruption
LEADER_ID=$(etcdctl endpoint status --write-out=json | \
  jq -r '.[] | select(.Status.leader == .Status.header.member_id) | .Endpoint')

# Defragment followers first
for ENDPOINT in $(etcdctl endpoint status --write-out=json | \
  jq -r '.[] | select(.Status.leader != .Status.header.member_id) | .Endpoint'); do
  echo "Defragmenting follower: $ENDPOINT"
  etcdctl --endpoints="$ENDPOINT" defrag
  sleep 5
done

# Defragment leader
echo "Defragmenting leader: $LEADER_ID"
etcdctl --endpoints="$LEADER_ID" defrag

echo "=== After defragmentation ==="
etcdctl endpoint status --write-out=table
```

## etcd Performance Tuning

### Heartbeat and Election Timeout

```yaml
# In etcd static pod manifest
- --heartbeat-interval=100    # Default: 100ms, increase for slow networks
- --election-timeout=1000     # Default: 1000ms (10x heartbeat), must be > heartbeat * 5
```

For cloud environments with higher network latency:

```yaml
- --heartbeat-interval=250    # 250ms for cross-AZ latency
- --election-timeout=2500     # 10x heartbeat
```

### Backend Quota

```yaml
# Set maximum database size (default: 2GB, maximum: 8GB)
- --quota-backend-bytes=8589934592  # 8 GB
```

When the quota is exceeded, etcd enters a maintenance-only mode: reads succeed but writes fail with `mvcc: database space exceeded`. Alert before this threshold:

```yaml
# Alert at 85% of quota
- alert: EtcdDatabaseHighFragmentationRatio
  expr: >-
    last_over_time(etcd_mvcc_db_total_size_in_bytes[5m])
    / last_over_time(etcd_mvcc_db_total_size_in_use_in_bytes[5m]) > 1.5
  for: 10m
```

### Disk Performance Requirements

etcd is extremely sensitive to disk write latency. The `wal_fsync_duration_seconds` and `backend_commit_duration_seconds` metrics must stay below 10ms P99.

```bash
# Test disk latency for etcd suitability
# Install fio if not present
apt-get install -y fio

# Test sequential write performance (simulates WAL writes)
fio --rw=write \
    --ioengine=sync \
    --fdatasync=1 \
    --directory=/var/lib/etcd \
    --size=22m \
    --bs=2300 \
    --name=etcd-wal-test \
    --output-format=json | \
    jq '.jobs[0].sync.lat_ns.percentile."99.000000" / 1000000'
# Target: < 10ms (10000000 ns = 10ms)
```

For etcd on cloud VMs:
- AWS: Use io2 EBS volumes with 3000+ IOPS provisioned
- GCP: Use pd-ssd or hyperdisk-extreme
- Azure: Use Premium SSD P30 or higher

## Metrics and Alerting

### Critical etcd Metrics

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: etcd-alerts
  namespace: monitoring
spec:
  groups:
  - name: etcd.rules
    interval: 30s
    rules:
    - alert: EtcdMembersDown
      expr: max without (endpoint) (sum without (instance) (up{job="etcd"} == bool 0)) > 0
      for: 10m
      labels:
        severity: critical
      annotations:
        summary: "etcd cluster members are down"

    - alert: EtcdInsufficientMembers
      expr: >-
        count(up{job="etcd"} == 1) without (instance)
        < ((count(up{job="etcd"}) without (instance) + 1) / 2)
      for: 3m
      labels:
        severity: critical
      annotations:
        summary: "etcd cluster has insufficient healthy members for quorum"

    - alert: EtcdHighNumberOfLeaderChanges
      expr: rate(etcd_server_leader_changes_seen_total[15m]) > 0.05
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "etcd is experiencing frequent leader changes"
        description: "Leader changes: {{ $value | humanize }} per second"

    - alert: EtcdHighFsyncDurations
      expr: >-
        histogram_quantile(0.99,
          rate(etcd_disk_wal_fsync_duration_seconds_bucket[5m])
        ) > 0.01
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "etcd WAL fsync duration p99 exceeds 10ms"
        description: "Current p99: {{ $value | humanizeDuration }}"

    - alert: EtcdHighCommitDurations
      expr: >-
        histogram_quantile(0.99,
          rate(etcd_disk_backend_commit_duration_seconds_bucket[5m])
        ) > 0.025
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "etcd backend commit duration p99 exceeds 25ms"

    - alert: EtcdDatabaseSizeExceedsQuota
      expr: >-
        etcd_mvcc_db_total_size_in_bytes
        / etcd_server_quota_backend_bytes > 0.9
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "etcd database is above 90% of quota"
        description: "Database is {{ $value | humanizePercentage }} of quota. Defragmentation required."

    - alert: EtcdHighPeerRTT
      expr: >-
        histogram_quantile(0.99,
          rate(etcd_network_peer_round_trip_time_seconds_bucket[5m])
        ) > 0.1
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "etcd peer round-trip time p99 exceeds 100ms"
```

### Grafana Panels for etcd

```
# Panel: Leader ID (should be stable)
etcd_server_is_leader

# Panel: DB size vs quota
etcd_mvcc_db_total_size_in_bytes / etcd_server_quota_backend_bytes * 100

# Panel: WAL fsync p99 latency
histogram_quantile(0.99, rate(etcd_disk_wal_fsync_duration_seconds_bucket[5m]))

# Panel: Keys in etcd
etcd_debugging_mvcc_keys_total

# Panel: Client RPC rate
sum(rate(grpc_server_started_total{job="etcd"}[5m])) by (grpc_method)

# Panel: Leader changes per hour
increase(etcd_server_leader_changes_seen_total[1h])
```

## TLS Certificate Rotation

Kubernetes etcd TLS certificates typically expire after 1 year (kubeadm default). Certificate rotation must be planned.

### Checking Certificate Expiry

```bash
# Check all etcd certificates
for cert in /etc/kubernetes/pki/etcd/*.crt; do
  echo "=== $cert ==="
  openssl x509 -in "$cert" -noout -dates
done

# Get days until expiry for all certs
for cert in /etc/kubernetes/pki/etcd/*.crt; do
  EXPIRY=$(openssl x509 -in "$cert" -noout -enddate | \
    cut -d= -f2)
  EXPIRY_EPOCH=$(date -d "$EXPIRY" +%s)
  NOW_EPOCH=$(date +%s)
  DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))
  echo "$cert: $DAYS_LEFT days remaining"
done
```

### kubeadm Certificate Renewal

```bash
# Renew all certificates (kubeadm managed clusters)
# This renews certificates to 1 year from now
kubeadm certs renew all

# Verify new expiry dates
kubeadm certs check-expiration

# Restart static pods to pick up new certificates
# Move manifests out and back in
for component in kube-apiserver kube-controller-manager kube-scheduler etcd; do
  mv "/etc/kubernetes/manifests/${component}.yaml" /tmp/
  sleep 5
  mv "/tmp/${component}.yaml" /etc/kubernetes/manifests/
  sleep 15
  echo "Restarted $component"
done

# Regenerate kubeconfig files
kubeadm kubeconfig user --client-name admin > /etc/kubernetes/admin.conf
```

### Manual Certificate Rotation (Non-kubeadm)

```bash
#!/bin/bash
# rotate-etcd-certs.sh - For clusters not managed by kubeadm

ETCD_PKI_DIR="/etc/kubernetes/pki/etcd"
BACKUP_DIR="/backup/etcd-pki-$(date +%Y%m%d)"

# 1. Backup current certificates
mkdir -p "$BACKUP_DIR"
cp -r "$ETCD_PKI_DIR" "$BACKUP_DIR/"

# 2. Generate new server certificate
openssl genrsa -out "${ETCD_PKI_DIR}/server.key" 4096

openssl req -new \
  -key "${ETCD_PKI_DIR}/server.key" \
  -subj "/CN=etcd-server" \
  -config <(cat <<EOF
[req]
distinguished_name = req_distinguished_name
req_extensions = v3_req
[req_distinguished_name]
[v3_req]
subjectAltName = @alt_names
[alt_names]
IP.1 = 127.0.0.1
IP.2 = $(hostname -I | awk '{print $1}')
DNS.1 = localhost
DNS.2 = $(hostname -f)
EOF
) > "${ETCD_PKI_DIR}/server.csr"

openssl x509 -req \
  -in "${ETCD_PKI_DIR}/server.csr" \
  -CA "${ETCD_PKI_DIR}/ca.crt" \
  -CAkey "${ETCD_PKI_DIR}/ca.key" \
  -CAcreateserial \
  -out "${ETCD_PKI_DIR}/server.crt" \
  -days 365 \
  -extensions v3_req

# 3. Reload etcd
# (For static pods, restart the pod by touching the manifest)
touch /etc/kubernetes/manifests/etcd.yaml

echo "Certificate rotation complete. Verify with:"
echo "  openssl x509 -in ${ETCD_PKI_DIR}/server.crt -noout -dates"
```

## etcd Cluster Maintenance Checklist

```bash
# Weekly health check
etcdctl endpoint health --cluster
etcdctl endpoint status --cluster --write-out=table

# Check for slow requests
etcdctl metrics | grep etcd_server_slow_apply_total

# Verify all members are in sync
etcdctl endpoint status --write-out=json | \
  jq -r '.[] | "\(.Endpoint): revision=\(.Status.header.revision) leader=\(.Status.isLeader)"'

# Monthly: verify backup restore works
# In a test environment:
# 1. Download latest backup
# 2. Run restore procedure
# 3. Start a test etcd cluster from the restore
# 4. Verify key count matches production

# Quarterly: certificate expiry check
kubeadm certs check-expiration || \
  for cert in /etc/kubernetes/pki/etcd/*.crt; do
    openssl x509 -in "$cert" -noout -dates
  done
```

The discipline of regular backups, practiced restores, proactive defragmentation, and certificate rotation eliminates the most common causes of catastrophic etcd failures. A cluster where the etcd backup has never been tested for restorability is not a backed-up cluster—it is an untested assumption.
