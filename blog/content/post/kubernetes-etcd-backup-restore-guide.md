---
title: "Kubernetes etcd: Backup, Restore, and Disaster Recovery for Production Clusters"
date: 2027-04-18T00:00:00-05:00
draft: false
tags: ["Kubernetes", "etcd", "Backup", "Disaster Recovery", "High Availability"]
categories: ["Kubernetes", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide for etcd backup strategies, snapshot procedures, cluster restoration, disaster recovery workflows, and maintaining etcd health in large-scale Kubernetes deployments."
more_link: "yes"
url: "/kubernetes-etcd-backup-restore-guide/"
---

etcd is the backbone of every Kubernetes cluster. It stores all cluster state: node registrations, pod assignments, service endpoints, RBAC policies, secrets, ConfigMaps, and custom resources. Losing etcd data without a backup means losing the cluster entirely — every workload specification, every configuration, every credential. A Kubernetes backup strategy that does not include etcd snapshot backups is incomplete by definition.

This guide covers the complete etcd operations lifecycle for production clusters: architecture and data model, snapshot backup procedures, automated backup with CronJobs and S3 storage, full cluster restore, defragmentation and compaction, encryption at rest, and monitoring etcd health with meaningful alerts.

<!--more-->

## Section 1: etcd Architecture and Data Model

### How Kubernetes Uses etcd

```
┌─────────────────────────────────────────────────────────────────┐
│  kube-apiserver                                                  │
│  - Only component that reads/writes etcd directly               │
│  - All other control plane components use the API server        │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  etcd Cluster (3 or 5 nodes for HA)                      │   │
│  │                                                          │   │
│  │  /registry/pods/default/nginx-abc123                     │   │
│  │  /registry/services/default/my-service                   │   │
│  │  /registry/secrets/production/db-password                │   │
│  │  /registry/configmaps/kube-system/kube-proxy             │   │
│  │  /registry/deployments.apps/default/my-app               │   │
│  │                                                          │   │
│  │  Raft consensus: writes go to leader, replicated to      │   │
│  │  quorum (2 of 3, or 3 of 5) before acknowledging         │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### Raft Quorum Requirements

```
Cluster Size │ Fault Tolerance │ Quorum Required
─────────────┼─────────────────┼────────────────
1            │ 0               │ 1
3            │ 1               │ 2
5            │ 2               │ 3
7            │ 3               │ 4
```

For production clusters, 3-node etcd is the minimum. 5-node etcd is recommended for large clusters or when maintenance windows are rare.

### etcd Data Directory Layout

```bash
# Default data directory
ls /var/lib/etcd/

# Contents:
# member/
#   snap/         — snapshot files and WAL snapshot index
#   wal/          — Write-Ahead Log entries
#     0000000000000000-0000000000000000.wal
#     0000000000000001-000000000000abcd.wal
#   db            — bbolt key-value database file (after snap)
```

---

## Section 2: etcdctl Setup

All backup and restore operations use `etcdctl`, the etcd command-line client. It must be configured with TLS credentials matching the etcd cluster.

### Install etcdctl

```bash
# Install the same version as the cluster's etcd
ETCD_VERSION="3.5.13"
curl -Lo etcd.tar.gz \
  "https://github.com/etcd-io/etcd/releases/download/v${ETCD_VERSION}/etcd-v${ETCD_VERSION}-linux-amd64.tar.gz"
tar xzf etcd.tar.gz
sudo mv etcd-v${ETCD_VERSION}-linux-amd64/etcdctl /usr/local/bin/
etcdctl version
```

### Environment Variables for etcdctl

```bash
# Set environment variables to avoid repeating flags
export ETCDCTL_API=3
export ETCDCTL_ENDPOINTS="https://127.0.0.1:2379"
export ETCDCTL_CACERT="/etc/kubernetes/pki/etcd/ca.crt"
export ETCDCTL_CERT="/etc/kubernetes/pki/etcd/server.crt"
export ETCDCTL_KEY="/etc/kubernetes/pki/etcd/server.key"

# For multi-node clusters, list all endpoints
export ETCDCTL_ENDPOINTS="https://10.0.1.10:2379,https://10.0.1.11:2379,https://10.0.1.12:2379"

# Test connectivity
etcdctl endpoint health
# Output:
# https://10.0.1.10:2379 is healthy: successfully committed proposal
# https://10.0.1.11:2379 is healthy: successfully committed proposal
# https://10.0.1.12:2379 is healthy: successfully committed proposal

etcdctl endpoint status --write-out=table
# Output shows: leader, raft term, raft index, DB size
```

---

## Section 3: Manual Snapshot Backup

### Taking a Snapshot

```bash
# Create a snapshot — connects to the leader automatically
BACKUP_DIR="/var/backups/etcd"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
SNAPSHOT_FILE="${BACKUP_DIR}/etcd-snapshot-${TIMESTAMP}.db"

mkdir -p "${BACKUP_DIR}"

ETCDCTL_API=3 etcdctl snapshot save "${SNAPSHOT_FILE}" \
  --endpoints="https://127.0.0.1:2379" \
  --cacert="/etc/kubernetes/pki/etcd/ca.crt" \
  --cert="/etc/kubernetes/pki/etcd/server.crt" \
  --key="/etc/kubernetes/pki/etcd/server.key"

echo "Snapshot saved: ${SNAPSHOT_FILE}"

# Verify the snapshot
ETCDCTL_API=3 etcdctl snapshot status "${SNAPSHOT_FILE}" \
  --write-out=table
# Output:
# +----------+----------+------------+------------+
# |   HASH   | REVISION | TOTAL KEYS | TOTAL SIZE |
# +----------+----------+------------+------------+
# | 5b37a92c |  1234567 |       8423 |      45 MB |
# +----------+----------+------------+------------+
```

### Compress and Secure the Snapshot

```bash
# Compress the snapshot
gzip "${SNAPSHOT_FILE}"
COMPRESSED="${SNAPSHOT_FILE}.gz"

# Verify integrity
echo "Snapshot: $(du -sh ${COMPRESSED})"
md5sum "${COMPRESSED}" > "${COMPRESSED}.md5"

# Encrypt the snapshot before uploading (optional but recommended)
gpg --symmetric \
  --cipher-algo AES256 \
  --output "${COMPRESSED}.gpg" \
  "${COMPRESSED}"

# Remove unencrypted copy
rm "${COMPRESSED}"
```

### Upload to S3

```bash
# Upload the snapshot to S3 with server-side encryption
aws s3 cp "${COMPRESSED}.gpg" \
  "s3://company-etcd-backups/production/$(basename ${COMPRESSED}.gpg)" \
  --server-side-encryption aws:kms \
  --sse-kms-key-id "alias/etcd-backup-key" \
  --storage-class STANDARD_IA

# Verify upload
aws s3 ls "s3://company-etcd-backups/production/" --human-readable | tail -5
```

---

## Section 4: Automated Backup CronJob

### Backup Script

```bash
# etcd-backup.sh — deployed as a ConfigMap and executed by the CronJob
#!/bin/bash
set -euo pipefail

ETCD_ENDPOINTS="${ETCD_ENDPOINTS:-https://127.0.0.1:2379}"
ETCD_CACERT="${ETCD_CACERT:-/etc/kubernetes/pki/etcd/ca.crt}"
ETCD_CERT="${ETCD_CERT:-/etc/kubernetes/pki/etcd/server.crt}"
ETCD_KEY="${ETCD_KEY:-/etc/kubernetes/pki/etcd/server.key}"
S3_BUCKET="${S3_BUCKET:-company-etcd-backups}"
S3_PREFIX="${S3_PREFIX:-production}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
BACKUP_DIR="/tmp/etcd-backup"
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
CLUSTER_NAME="${CLUSTER_NAME:-unknown}"

log() {
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"
}

cleanup() {
    log "Cleaning up temporary files"
    rm -rf "${BACKUP_DIR}"
}
trap cleanup EXIT

log "Starting etcd backup for cluster: ${CLUSTER_NAME}"

# Create working directory
mkdir -p "${BACKUP_DIR}"
SNAPSHOT_FILE="${BACKUP_DIR}/etcd-snapshot-${CLUSTER_NAME}-${TIMESTAMP}.db"

# Take the snapshot
log "Taking etcd snapshot..."
ETCDCTL_API=3 etcdctl snapshot save "${SNAPSHOT_FILE}" \
    --endpoints="${ETCD_ENDPOINTS}" \
    --cacert="${ETCD_CACERT}" \
    --cert="${ETCD_CERT}" \
    --key="${ETCD_KEY}"

# Verify snapshot integrity
log "Verifying snapshot..."
ETCDCTL_API=3 etcdctl snapshot status "${SNAPSHOT_FILE}" \
    --write-out=json | tee "${BACKUP_DIR}/snapshot-status.json"

SNAPSHOT_SIZE=$(stat -c%s "${SNAPSHOT_FILE}")
log "Snapshot size: $(numfmt --to=iec ${SNAPSHOT_SIZE})"

# Compress
log "Compressing snapshot..."
gzip "${SNAPSHOT_FILE}"
COMPRESSED="${SNAPSHOT_FILE}.gz"

# Upload to S3
S3_KEY="${S3_PREFIX}/${CLUSTER_NAME}/etcd-snapshot-${TIMESTAMP}.db.gz"
log "Uploading to s3://${S3_BUCKET}/${S3_KEY}..."
aws s3 cp "${COMPRESSED}" "s3://${S3_BUCKET}/${S3_KEY}" \
    --server-side-encryption aws:kms

# Delete old backups beyond retention period
log "Pruning backups older than ${BACKUP_RETENTION_DAYS} days..."
CUTOFF_DATE=$(date -u -d "${BACKUP_RETENTION_DAYS} days ago" +%Y-%m-%d)
aws s3api list-objects-v2 \
    --bucket "${S3_BUCKET}" \
    --prefix "${S3_PREFIX}/${CLUSTER_NAME}/" \
    --query "Contents[?LastModified<='${CUTOFF_DATE}T00:00:00Z'].Key" \
    --output text | \
    tr '\t' '\n' | \
    grep -v '^$' | \
    while read -r key; do
        log "Deleting old backup: ${key}"
        aws s3api delete-object --bucket "${S3_BUCKET}" --key "${key}"
    done

log "Backup complete: s3://${S3_BUCKET}/${S3_KEY}"
```

### CronJob Manifest

```yaml
# etcd-backup-cronjob.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: etcd-backup-script
  namespace: kube-system
data:
  backup.sh: |
    #!/bin/bash
    # (full script content from above)
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: etcd-backup
  namespace: kube-system
spec:
  # Run every 6 hours
  schedule: "0 */6 * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 2
      activeDeadlineSeconds: 600     # Fail if not complete within 10 minutes
      template:
        spec:
          restartPolicy: OnFailure
          serviceAccountName: etcd-backup
          nodeSelector:
            node-role.kubernetes.io/control-plane: ""
          tolerations:
            - key: node-role.kubernetes.io/control-plane
              operator: Exists
              effect: NoSchedule
          hostNetwork: true
          containers:
            - name: etcd-backup
              image: registry.company.internal/etcd-backup:3.5.13
              command: ["/bin/bash", "/scripts/backup.sh"]
              env:
                - name: ETCD_ENDPOINTS
                  value: "https://127.0.0.1:2379"
                - name: ETCD_CACERT
                  value: "/etc/kubernetes/pki/etcd/ca.crt"
                - name: ETCD_CERT
                  value: "/etc/kubernetes/pki/etcd/server.crt"
                - name: ETCD_KEY
                  value: "/etc/kubernetes/pki/etcd/server.key"
                - name: S3_BUCKET
                  valueFrom:
                    configMapKeyRef:
                      name: etcd-backup-config
                      key: s3_bucket
                - name: CLUSTER_NAME
                  valueFrom:
                    fieldRef:
                      fieldPath: spec.nodeName
                - name: BACKUP_RETENTION_DAYS
                  value: "30"
              resources:
                requests:
                  cpu: "100m"
                  memory: "128Mi"
                limits:
                  cpu: "500m"
                  memory: "256Mi"
              volumeMounts:
                - name: etcd-pki
                  mountPath: /etc/kubernetes/pki/etcd
                  readOnly: true
                - name: backup-scripts
                  mountPath: /scripts
                  readOnly: true
                - name: tmp
                  mountPath: /tmp
          volumes:
            - name: etcd-pki
              hostPath:
                path: /etc/kubernetes/pki/etcd
                type: Directory
            - name: backup-scripts
              configMap:
                name: etcd-backup-script
                defaultMode: 0755
            - name: tmp
              emptyDir: {}
```

### RBAC for Backup ServiceAccount

```yaml
# etcd-backup-rbac.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: etcd-backup
  namespace: kube-system
  annotations:
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/etcd-backup-role"
---
# S3 access is provided via IRSA — no additional ClusterRole needed for Kubernetes resources
# Only needed if the backup pod needs to read cluster info
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
```

---

## Section 5: Cluster Restore Procedures

### Prerequisites for Restore

```bash
# 1. Document the current cluster topology before restore
etcdctl member list --write-out=table
# Note: member IDs, peer URLs, and which node is the leader

# 2. Download the backup snapshot from S3
aws s3 cp \
  "s3://company-etcd-backups/production/cluster-name/etcd-snapshot-20270418T020000Z.db.gz" \
  /tmp/etcd-restore/snapshot.db.gz

gunzip /tmp/etcd-restore/snapshot.db.gz

# 3. Verify snapshot integrity
etcdctl snapshot status /tmp/etcd-restore/snapshot.db --write-out=table
```

### Single-Node Restore (kubeadm Cluster)

```bash
# On the control plane node — this procedure assumes a single control plane node
# or is the first step in a multi-node restore

# Step 1: Stop the API server and etcd
# On kubeadm clusters, move static pod manifests to disable them
mkdir -p /tmp/kubernetes-manifests-backup
mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/kubernetes-manifests-backup/
mv /etc/kubernetes/manifests/etcd.yaml /tmp/kubernetes-manifests-backup/

# Wait for containers to stop
sleep 15

# Verify the containers have stopped
crictl ps | grep -E "etcd|kube-apiserver"

# Step 2: Remove the existing etcd data
mv /var/lib/etcd /var/lib/etcd.bak.$(date +%Y%m%d_%H%M%S)

# Step 3: Restore the snapshot
ETCDCTL_API=3 etcdctl snapshot restore /tmp/etcd-restore/snapshot.db \
    --name=master-1 \
    --initial-cluster="master-1=https://10.0.1.10:2380" \
    --initial-cluster-token="etcd-cluster-production" \
    --initial-advertise-peer-urls="https://10.0.1.10:2380" \
    --data-dir="/var/lib/etcd"

# Fix ownership
chown -R etcd:etcd /var/lib/etcd 2>/dev/null || true

# Step 4: Restore the static pod manifests
mv /tmp/kubernetes-manifests-backup/etcd.yaml /etc/kubernetes/manifests/
mv /tmp/kubernetes-manifests-backup/kube-apiserver.yaml /etc/kubernetes/manifests/

# Step 5: Wait for etcd and API server to come back
sleep 30
kubectl get nodes
kubectl get pods --all-namespaces | head -20
```

### Multi-Node etcd Restore

Restoring a multi-node etcd cluster requires running the restore procedure on all nodes simultaneously, each with node-specific parameters.

```bash
# ---- NODE 1 (master-1: 10.0.1.10) ----
# Stop etcd on all control plane nodes first
# (SSH to each node and stop etcd before proceeding)
ssh master-1 "mv /etc/kubernetes/manifests/etcd.yaml /tmp/ && \
              mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/"

ssh master-2 "mv /etc/kubernetes/manifests/etcd.yaml /tmp/ && \
              mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/"

ssh master-3 "mv /etc/kubernetes/manifests/etcd.yaml /tmp/ && \
              mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/"

# Wait for etcd containers to stop
sleep 30

# Copy snapshot to each node
for node in master-1 master-2 master-3; do
  scp /tmp/etcd-restore/snapshot.db "${node}:/tmp/etcd-restore/snapshot.db"
done

# ---- Restore on NODE 1 (master-1: 10.0.1.10) ----
ssh master-1 << 'EOF'
mv /var/lib/etcd /var/lib/etcd.bak
ETCDCTL_API=3 etcdctl snapshot restore /tmp/etcd-restore/snapshot.db \
    --name=master-1 \
    --initial-cluster="master-1=https://10.0.1.10:2380,master-2=https://10.0.1.11:2380,master-3=https://10.0.1.12:2380" \
    --initial-cluster-token="etcd-cluster-production" \
    --initial-advertise-peer-urls="https://10.0.1.10:2380" \
    --data-dir="/var/lib/etcd"
mv /tmp/etcd.yaml /etc/kubernetes/manifests/
EOF

# ---- Restore on NODE 2 (master-2: 10.0.1.11) ----
ssh master-2 << 'EOF'
mv /var/lib/etcd /var/lib/etcd.bak
ETCDCTL_API=3 etcdctl snapshot restore /tmp/etcd-restore/snapshot.db \
    --name=master-2 \
    --initial-cluster="master-1=https://10.0.1.10:2380,master-2=https://10.0.1.11:2380,master-3=https://10.0.1.12:2380" \
    --initial-cluster-token="etcd-cluster-production" \
    --initial-advertise-peer-urls="https://10.0.1.11:2380" \
    --data-dir="/var/lib/etcd"
mv /tmp/etcd.yaml /etc/kubernetes/manifests/
EOF

# ---- Restore on NODE 3 (master-3: 10.0.1.12) ----
ssh master-3 << 'EOF'
mv /var/lib/etcd /var/lib/etcd.bak
ETCDCTL_API=3 etcdctl snapshot restore /tmp/etcd-restore/snapshot.db \
    --name=master-3 \
    --initial-cluster="master-1=https://10.0.1.10:2380,master-2=https://10.0.1.11:2380,master-3=https://10.0.1.12:2380" \
    --initial-cluster-token="etcd-cluster-production" \
    --initial-advertise-peer-urls="https://10.0.1.12:2380" \
    --data-dir="/var/lib/etcd"
mv /tmp/etcd.yaml /etc/kubernetes/manifests/
EOF

# Restore API servers on all nodes
for node in master-1 master-2 master-3; do
  ssh "${node}" "mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/"
done

# Verify cluster health
sleep 60
etcdctl endpoint health --write-out=table
kubectl get nodes
```

---

## Section 6: Defragmentation and Compaction

### Why Defragmentation Is Necessary

etcd keeps old versions of all keys to support watch events and consistent list operations. Over time, the on-disk database grows even after keys are deleted (space is not reclaimed). Defragmentation reclaims this space but temporarily stalls the etcd member being defragmented.

```bash
# Check current DB size vs. in-use size
etcdctl endpoint status --write-out=json | \
  jq '.[] | {endpoint: .Endpoint, db_size: .Status.dbSize, db_size_in_use: .Status.dbSizeInUse}'

# Fragmentation ratio (>50% fragmentation warrants defragmentation)
# fragmentation = (db_size - db_size_in_use) / db_size
etcdctl endpoint status --write-out=json | \
  jq '.[] | {
    endpoint: .Endpoint,
    fragmentation_pct: ((.Status.dbSize - .Status.dbSizeInUse) / .Status.dbSize * 100 | floor)
  }'
```

### Defragmenting etcd Members

```bash
# Defragment replicas first, then the leader last
# Find the current leader
etcdctl endpoint status --write-out=json | \
  jq '.[] | select(.Status.leader == .Status.raftIndex) | .Endpoint'

# Defragment a specific endpoint (non-leader first)
ETCDCTL_API=3 etcdctl defrag \
  --endpoints="https://10.0.1.11:2379" \
  --cacert="${ETCD_CACERT}" \
  --cert="${ETCD_CERT}" \
  --key="${ETCD_KEY}"

ETCDCTL_API=3 etcdctl defrag \
  --endpoints="https://10.0.1.12:2379" \
  --cacert="${ETCD_CACERT}" \
  --cert="${ETCD_CERT}" \
  --key="${ETCD_KEY}"

# Defragment the leader last (causes brief leader election)
ETCDCTL_API=3 etcdctl defrag \
  --endpoints="https://10.0.1.10:2379" \
  --cacert="${ETCD_CACERT}" \
  --cert="${ETCD_CERT}" \
  --key="${ETCD_KEY}"

# Verify space reclaimed
etcdctl endpoint status --write-out=table
```

### Configuring Auto-Compaction

```yaml
# etcd configuration — add to etcd static pod manifest
spec:
  containers:
    - name: etcd
      command:
        - etcd
        # Compact revisions older than 5 hours automatically
        - --auto-compaction-retention=5
        - --auto-compaction-mode=periodic
        # Trigger compaction when quota usage exceeds 80%
        - --quota-backend-bytes=8589934592   # 8 GiB
```

### Manual Compaction

```bash
# Get the current revision
CURRENT_REV=$(etcdctl endpoint status --write-out=json | \
  jq -r '.[0].Status.header.revision')

# Compact to keep only the last 1000 revisions
COMPACT_REV=$((CURRENT_REV - 1000))
etcdctl compact "${COMPACT_REV}"

# After compaction, defragment to reclaim disk space
etcdctl defrag --endpoints="https://10.0.1.10:2379,https://10.0.1.11:2379,https://10.0.1.12:2379"
```

---

## Section 7: etcd Encryption at Rest

Enabling encryption for secrets in etcd protects against unauthorized access to the raw etcd data files.

### KMS-Based Encryption (AWS KMS)

```yaml
# /etc/kubernetes/pki/encryption-config.yaml
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
  - resources:
      - secrets
      - configmaps
    providers:
      # KMS v2 provider for AWS KMS
      - kms:
          apiVersion: v2
          name: aws-kms
          endpoint: unix:///var/run/kmsplugin/socket.sock
          timeout: 3s
      # Identity provider as fallback during rotation
      - identity: {}
```

```yaml
# AWS KMS plugin DaemonSet on control plane nodes
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: aws-encryption-provider
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: aws-encryption-provider
  template:
    metadata:
      labels:
        app: aws-encryption-provider
    spec:
      nodeSelector:
        node-role.kubernetes.io/control-plane: ""
      tolerations:
        - key: node-role.kubernetes.io/control-plane
          operator: Exists
          effect: NoSchedule
      containers:
        - name: aws-encryption-provider
          image: registry.company.internal/aws-encryption-provider:0.4.0
          command:
            - /aws-encryption-provider
            - --key=arn:aws:kms:us-east-1:123456789012:key/mrk-REPLACE_WITH_KEY_ID
            - --region=us-east-1
            - --listen=/var/run/kmsplugin/socket.sock
            - --health-port=:8083
          volumeMounts:
            - name: socket
              mountPath: /var/run/kmsplugin
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 128Mi
      volumes:
        - name: socket
          hostPath:
            path: /var/run/kmsplugin
            type: DirectoryOrCreate
```

### Verifying Encryption

```bash
# After enabling encryption, re-encrypt all secrets
kubectl get secrets --all-namespaces -o json | kubectl replace -f -

# Verify a secret is encrypted in etcd
# (requires direct etcd access)
ETCDCTL_API=3 etcdctl get \
  /registry/secrets/default/my-secret \
  --print-value-only | hexdump -C | head -5
# The output should start with: k8s:enc:kms:v2:aws-kms:
```

---

## Section 8: Monitoring etcd Health

### Key Metrics

```bash
# Check etcd cluster health
etcdctl endpoint health --write-out=table

# Check leader status
etcdctl endpoint status --write-out=table
# Columns: ENDPOINT, ID, VERSION, DB SIZE, IS LEADER, IS LEARNER, RAFT TERM, RAFT INDEX

# Check for slow operations (watch latency)
etcdctl check perf \
  --endpoints="https://10.0.1.10:2379" \
  --cacert="${ETCD_CACERT}" \
  --cert="${ETCD_CERT}" \
  --key="${ETCD_KEY}"
```

### Prometheus Alerting Rules

```yaml
# etcd-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: etcd-alerts
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: etcd
      interval: 30s
      rules:
        # etcd cluster does not have a quorum
        - alert: EtcdInsufficientMembers
          expr: |
            count(up{job="etcd"} == 1) < (count(up{job="etcd"}) / 2 + 1)
          for: 3m
          labels:
            severity: critical
          annotations:
            summary: "etcd cluster has insufficient healthy members"
            description: >
              etcd cluster has only {{ $value }} healthy members out of
              {{ printf `count(up{job="etcd"})` | query | first | value }} total.
              A quorum may not be achievable.

        # etcd leader changes are happening too frequently
        - alert: EtcdHighNumberOfLeaderChanges
          expr: |
            rate(etcd_server_leader_changes_seen_total[15m]) > 3
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "etcd is experiencing frequent leader changes"
            description: >
              etcd member {{ $labels.instance }} has seen {{ $value | humanize }}
              leader changes per minute in the last 15 minutes.

        # etcd database is approaching quota
        - alert: EtcdDatabaseHighFragmentationRatio
          expr: |
            (etcd_mvcc_db_total_size_in_bytes - etcd_mvcc_db_total_size_in_use_in_bytes)
            / etcd_mvcc_db_total_size_in_bytes > 0.5
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "etcd database has high fragmentation"
            description: >
              etcd member {{ $labels.instance }} has {{ $value | humanizePercentage }}
              database fragmentation. Defragmentation is recommended.

        # etcd database size is approaching quota
        - alert: EtcdDatabaseSizeLimitApproaching
          expr: |
            etcd_mvcc_db_total_size_in_bytes / etcd_server_quota_backend_bytes > 0.8
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "etcd database is approaching size limit"
            description: >
              etcd member {{ $labels.instance }} is using
              {{ $value | humanizePercentage }} of its {{ printf `etcd_server_quota_backend_bytes{instance="%s"}` $labels.instance | query | first | value | humanize1024 }}B quota.
              Compaction and defragmentation are needed.

        # etcd database has exceeded quota (cluster will become read-only)
        - alert: EtcdDatabaseSizeLimitExceeded
          expr: |
            etcd_mvcc_db_total_size_in_bytes / etcd_server_quota_backend_bytes >= 1
          labels:
            severity: critical
          annotations:
            summary: "etcd database quota exceeded — cluster is read-only"
            description: >
              etcd member {{ $labels.instance }} has exceeded its quota.
              The cluster is now read-only. Immediate compaction and defragmentation required.

        # High write latency
        - alert: EtcdHighCommitDurations
          expr: |
            histogram_quantile(0.99,
              rate(etcd_disk_backend_commit_duration_seconds_bucket[5m])
            ) > 0.25
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "etcd is experiencing high commit latency"
            description: >
              etcd member {{ $labels.instance }} p99 commit latency is {{ $value }}s.
              This may indicate disk I/O pressure.

        # etcd backup has not completed
        - alert: EtcdBackupMissing
          expr: |
            time() - etcd_backup_last_success_timestamp_seconds > 43200
          labels:
            severity: critical
          annotations:
            summary: "etcd backup has not run in 12 hours"
            description: >
              No successful etcd backup has been recorded for cluster
              {{ $labels.cluster }} in the last 12 hours.
```

### Custom Backup Success Metric

```bash
# Add to the backup script to push a metric to Pushgateway
push_metric() {
    local PUSHGATEWAY_URL="${PUSHGATEWAY_URL:-http://prometheus-pushgateway.monitoring.svc:9091}"
    local TIMESTAMP=$(date +%s)

    cat << METRIC | curl --silent --data-binary @- \
        "${PUSHGATEWAY_URL}/metrics/job/etcd-backup/cluster/${CLUSTER_NAME}"
# HELP etcd_backup_last_success_timestamp_seconds Unix timestamp of last successful etcd backup
# TYPE etcd_backup_last_success_timestamp_seconds gauge
etcd_backup_last_success_timestamp_seconds ${TIMESTAMP}
# HELP etcd_backup_snapshot_size_bytes Size of the last etcd backup snapshot in bytes
# TYPE etcd_backup_snapshot_size_bytes gauge
etcd_backup_snapshot_size_bytes ${SNAPSHOT_SIZE}
METRIC
}

# Call at end of successful backup
push_metric
log "Metrics pushed to Pushgateway"
```

---

## Section 9: etcd Disaster Recovery Runbooks

### Runbook: Single etcd Member Failure

```bash
# Step 1: Identify the failed member
etcdctl member list --write-out=table
# Look for the member with is_leader=false and that stopped responding

# Step 2: Remove the failed member
FAILED_MEMBER_ID="abc123def456"   # Replace with actual ID from member list
etcdctl member remove "${FAILED_MEMBER_ID}"

# Step 3: Re-provision the node and add it back as a new member
# On the etcd leader:
NEW_NODE_PEER_URL="https://10.0.1.13:2380"
etcdctl member add master-new --peer-urls="${NEW_NODE_PEER_URL}"

# Step 4: On the new node, start etcd with INITIAL_CLUSTER_STATE=existing
# This is handled automatically by kubeadm on re-join:
kubeadm join phase control-plane-join etcd --config=/etc/kubernetes/kubeadm-config.yaml

# Step 5: Verify the cluster is healthy
etcdctl endpoint health --write-out=table
```

### Runbook: Complete Cluster Loss

```bash
# This procedure applies when all etcd members are lost

# Step 1: Find the most recent backup
aws s3 ls "s3://company-etcd-backups/production/cluster-name/" \
  --recursive \
  --human-readable \
  | sort | tail -5

# Step 2: Download the latest snapshot
aws s3 cp \
  "s3://company-etcd-backups/production/cluster-name/etcd-snapshot-20270418T020000Z.db.gz" \
  /tmp/snapshot.db.gz
gunzip /tmp/snapshot.db.gz
etcdctl snapshot status /tmp/snapshot.db --write-out=table

# Step 3: Initialize the first control plane node with the snapshot
# On master-1:
kubeadm init phase etcd local \
  --config=/etc/kubernetes/kubeadm-config.yaml

# Stop etcd immediately after init
mv /etc/kubernetes/manifests/etcd.yaml /tmp/

# Restore the snapshot (single-member bootstrap)
ETCDCTL_API=3 etcdctl snapshot restore /tmp/snapshot.db \
    --name=master-1 \
    --initial-cluster="master-1=https://10.0.1.10:2380" \
    --initial-cluster-token="etcd-cluster-new-$(date +%s)" \
    --initial-advertise-peer-urls="https://10.0.1.10:2380" \
    --data-dir="/var/lib/etcd-restored"

mv /var/lib/etcd /var/lib/etcd.old
mv /var/lib/etcd-restored /var/lib/etcd

# Update etcd manifest to use new cluster token if needed
mv /tmp/etcd.yaml /etc/kubernetes/manifests/

# Step 4: Restore API server and verify
mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/
sleep 30
kubectl get nodes

# Step 5: Join remaining control plane nodes
# (Follow multi-node restore procedure from Section 5)
```

### Runbook: etcd Quota Exceeded (Read-Only Mode)

```bash
# Symptom: etcd returns "etcdserver: mvcc: database space exceeded"
# Immediate remediation:

# Step 1: Verify quota exceeded
etcdctl endpoint status --write-out=table
# DB SIZE column will equal or exceed the quota

# Step 2: Get current revision and compact aggressively
CURRENT_REV=$(etcdctl endpoint status --write-out=json | \
  jq -r '.[0].Status.header.revision')

# Compact keeping only last 100 revisions
COMPACT_REV=$((CURRENT_REV - 100))
etcdctl compact "${COMPACT_REV}"

# Step 3: Defragment all members
etcdctl defrag \
  --endpoints="https://10.0.1.10:2379,https://10.0.1.11:2379,https://10.0.1.12:2379"

# Step 4: Verify space is reclaimed
etcdctl endpoint status --write-out=table

# Step 5: If quota is still exceeded, temporarily increase it
# Edit /etc/kubernetes/manifests/etcd.yaml:
# --quota-backend-bytes=10737418240   # 10 GiB (from default 8 GiB)

# Step 6: Alert on root cause — usually too many CustomResources or stale watch resources
kubectl get crds --all-namespaces | wc -l
etcdctl get "" --prefix --keys-only | \
  awk -F'/' '{print $3}' | \
  sort | uniq -c | sort -rn | head -20
```

---

## Section 10: Backup Verification and DR Testing

### Automated Backup Verification

```bash
# verify-backup.sh — run after each backup as part of the CronJob
#!/bin/bash
set -euo pipefail

SNAPSHOT_FILE="${1}"
VERIFY_DATA_DIR="/tmp/etcd-verify-$(date +%s)"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# Step 1: Restore the snapshot to a temporary directory
log "Restoring snapshot for verification..."
ETCDCTL_API=3 etcdctl snapshot restore "${SNAPSHOT_FILE}" \
    --data-dir="${VERIFY_DATA_DIR}" \
    --name=verify-node \
    --initial-cluster="verify-node=http://127.0.0.1:2388" \
    --initial-advertise-peer-urls="http://127.0.0.1:2388"

# Step 2: Start a temporary etcd instance from the restored data
etcd \
    --name=verify-node \
    --data-dir="${VERIFY_DATA_DIR}" \
    --listen-client-urls="http://127.0.0.1:2389" \
    --advertise-client-urls="http://127.0.0.1:2389" \
    --listen-peer-urls="http://127.0.0.1:2388" \
    --initial-cluster="verify-node=http://127.0.0.1:2388" \
    --initial-cluster-state=new &
ETCD_PID=$!

sleep 10

# Step 3: Verify key counts match expectations
NODE_COUNT=$(ETCDCTL_API=3 etcdctl \
    --endpoints="http://127.0.0.1:2389" \
    get /registry/nodes --prefix --keys-only | wc -l)

NAMESPACE_COUNT=$(ETCDCTL_API=3 etcdctl \
    --endpoints="http://127.0.0.1:2389" \
    get /registry/namespaces --prefix --keys-only | wc -l)

log "Verification results:"
log "  Nodes in backup: ${NODE_COUNT}"
log "  Namespaces in backup: ${NAMESPACE_COUNT}"

# Step 4: Clean up
kill "${ETCD_PID}"
rm -rf "${VERIFY_DATA_DIR}"

if [ "${NAMESPACE_COUNT}" -lt 3 ]; then
    log "ERROR: Backup appears incomplete — fewer than 3 namespaces found"
    exit 1
fi

log "Backup verification passed"
```

---

A comprehensive etcd backup strategy combines frequent automated snapshots (every 4-6 hours), encrypted off-cluster storage in S3 with appropriate retention, automated verification of each backup, documented restore procedures tested quarterly, and continuous monitoring with meaningful alerts. The combination of etcd encryption at rest, compact/defrag maintenance, and proactive quota management ensures the control plane remains stable and recoverable under any failure scenario.
