---
title: "Kubernetes etcd Operations: Backup, Restore, Compaction, Defragmentation, and Cluster Health"
date: 2028-08-11T00:00:00-05:00
draft: false
tags: ["Kubernetes", "etcd", "Backup", "Restore", "Operations", "High Availability"]
categories:
  - Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive deep-dive into etcd operational practices for Kubernetes clusters: automated backups with etcdctl snapshot, multi-member restore procedures, compaction and defragmentation scheduling, TLS certificate management, performance tuning, and production monitoring with Prometheus alerting."
more_link: "yes"
url: "/kubernetes-etcd-operations-backup-restore-guide/"
---

etcd is the single source of truth for every Kubernetes cluster. Every object, every secret, every ConfigMap, every pod spec — all of it lives in etcd. Yet it is one of the most underappreciated components in the stack until the moment it fails. When etcd goes down or becomes corrupted, your entire control plane stops working. No new pods can be scheduled, no changes can be applied, and existing workloads may begin failing as their state can no longer be reconciled.

This guide covers every operational aspect of etcd in a production Kubernetes environment: automated snapshot backups, verified restore procedures for single-node and multi-member clusters, compaction to reclaim space, defragmentation to reclaim disk fragmentation, TLS certificate management, performance tuning, and comprehensive monitoring.

<!--more-->

## Understanding etcd's Role in Kubernetes

Before diving into operations, understanding *why* etcd behaves the way it does makes all the operational decisions obvious.

etcd uses the **Raft consensus protocol** to provide strong consistency guarantees across a cluster of nodes. Every write goes through the following path:

```
Client Write → Leader Receives → Leader Appends to Log →
Leader Sends AppendEntries to Followers →
Quorum Acknowledges → Leader Commits →
Leader Responds to Client → Followers Apply
```

This means:
- **Quorum is required for writes**: a 3-member cluster can tolerate 1 failure (quorum = 2); a 5-member cluster can tolerate 2 failures (quorum = 3)
- **Every write is durable before acknowledgment**: data loss on a healthy cluster should be impossible
- **Read performance scales with members**: but write performance does not — more members means more round trips

### etcd Data Directory Structure

```
/var/lib/etcd/
├── member/
│   ├── snap/
│   │   ├── 0000000000000001-0000000000000001.snap  # periodic snapshots
│   │   └── db                                      # bolt DB file
│   └── wal/
│       ├── 0000000000000000-0000000000000000.wal   # write-ahead log
│       └── 0.tmp
```

The WAL (Write-Ahead Log) contains every mutation since the last compaction. The snap directory contains periodic in-process snapshots that allow faster recovery on restart. The `db` file is the actual BoltDB backing store.

### etcd Revision vs Term vs Index

Understanding these three concepts is essential for backup and compaction operations:

- **Term**: monotonically increasing number representing a leader election cycle. Every time a new leader is elected, the term increments.
- **Index**: monotonically increasing number representing a committed log entry. Every write increments the index.
- **Revision**: the global version counter for the key-value store. Every mutation (put or delete) increments the revision.

Compaction targets a specific revision, discarding all history before that point.

---

## etcd Cluster Topology for Production

### 3-Member HA Cluster

For most production clusters, a 3-member etcd cluster provides the right balance of resilience and performance:

```yaml
# kubeadm-config.yaml for 3-member etcd
apiVersion: kubeadm.k8s.io/v1beta3
kind: ClusterConfiguration
kubernetesVersion: "1.29.0"
controlPlaneEndpoint: "k8s-api.example.com:6443"
etcd:
  local:
    dataDir: /var/lib/etcd
    extraArgs:
      # Heartbeat and election timeouts
      heartbeat-interval: "250"
      election-timeout: "2500"
      # Snapshot settings
      snapshot-count: "10000"
      # Quota (8 GiB)
      quota-backend-bytes: "8589934592"
      # Auto-compaction
      auto-compaction-retention: "8"
      auto-compaction-mode: "revision"
      # Metrics
      metrics: "extensive"
      # Logging
      log-level: "warn"
```

### Dedicated etcd Nodes (5-Member)

For large clusters (500+ nodes), running etcd on dedicated hardware with local NVMe SSDs is recommended:

```yaml
# External etcd topology
apiVersion: kubeadm.k8s.io/v1beta3
kind: ClusterConfiguration
etcd:
  external:
    endpoints:
      - "https://etcd-0.example.com:2379"
      - "https://etcd-1.example.com:2379"
      - "https://etcd-2.example.com:2379"
      - "https://etcd-3.example.com:2379"
      - "https://etcd-4.example.com:2379"
    caFile: /etc/etcd/pki/ca.crt
    certFile: /etc/etcd/pki/etcd.crt
    keyFile: /etc/etcd/pki/etcd.key
```

### Viewing Current Cluster Members

```bash
# Check cluster membership
ETCDCTL_API=3 etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/peer.crt \
  --key=/etc/kubernetes/pki/etcd/peer.key \
  member list -w table

# Output:
# +------------------+---------+----------+---------------------------+---------------------------+------------+
# |        ID        | STATUS  |   NAME   |        PEER ADDRS         |       CLIENT ADDRS        | IS LEARNER |
# +------------------+---------+----------+---------------------------+---------------------------+------------+
# | 2fb96bc4efe7fc15 | started | master-0 | https://10.0.0.1:2380     | https://10.0.0.1:2379     | false      |
# | 7f5d2b3a8c1e9042 | started | master-1 | https://10.0.0.2:2380     | https://10.0.0.2:2379     | false      |
# | 9a8c4d6e2f1b3507 | started | master-2 | https://10.0.0.3:2380     | https://10.0.0.3:2379     | false      |
# +------------------+---------+----------+---------------------------+---------------------------+------------+
```

---

## Backup: etcdctl Snapshot

### Understanding Snapshot Semantics

An etcd snapshot is a point-in-time, consistent view of the entire key-value store. It is taken at the application level — the snapshot captures the state as of a specific revision and includes all key-value data, including deleted keys' tombstones up to the snapshot revision.

**Critical**: snapshots taken from a healthy member are safe. Snapshots taken from a learner or from a member that is behind the leader are still consistent — they reflect the member's committed state.

### Basic Snapshot Command

```bash
#!/usr/bin/env bash
# etcd-backup.sh — Basic etcd backup

set -euo pipefail

ETCD_ENDPOINTS="https://127.0.0.1:2379"
ETCD_CACERT="/etc/kubernetes/pki/etcd/ca.crt"
ETCD_CERT="/etc/kubernetes/pki/etcd/healthcheck-client.crt"
ETCD_KEY="/etc/kubernetes/pki/etcd/healthcheck-client.key"
BACKUP_DIR="/var/backup/etcd"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
SNAPSHOT_FILE="${BACKUP_DIR}/etcd-snapshot-${TIMESTAMP}.db"

mkdir -p "${BACKUP_DIR}"

# Take the snapshot
ETCDCTL_API=3 etcdctl \
  --endpoints="${ETCD_ENDPOINTS}" \
  --cacert="${ETCD_CACERT}" \
  --cert="${ETCD_CERT}" \
  --key="${ETCD_KEY}" \
  snapshot save "${SNAPSHOT_FILE}"

# Verify the snapshot
ETCDCTL_API=3 etcdctl snapshot status "${SNAPSHOT_FILE}" -w table

# Compress for storage efficiency
gzip "${SNAPSHOT_FILE}"
echo "Backup completed: ${SNAPSHOT_FILE}.gz"
```

### Production Backup Script with Verification and Rotation

```bash
#!/usr/bin/env bash
# /usr/local/bin/etcd-backup-production.sh
# Production-grade etcd backup with verification, S3 upload, and rotation

set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────
CLUSTER_NAME="${CLUSTER_NAME:-production}"
ETCD_ENDPOINTS="${ETCD_ENDPOINTS:-https://127.0.0.1:2379}"
ETCD_CACERT="${ETCD_CACERT:-/etc/kubernetes/pki/etcd/ca.crt}"
ETCD_CERT="${ETCD_CERT:-/etc/kubernetes/pki/etcd/healthcheck-client.crt}"
ETCD_KEY="${ETCD_KEY:-/etc/kubernetes/pki/etcd/healthcheck-client.key}"
BACKUP_DIR="${BACKUP_DIR:-/var/backup/etcd}"
S3_BUCKET="${S3_BUCKET:-}"
LOCAL_RETENTION_DAYS="${LOCAL_RETENTION_DAYS:-7}"
S3_RETENTION_DAYS="${S3_RETENTION_DAYS:-30}"
SLACK_WEBHOOK="${SLACK_WEBHOOK:-}"
MIN_SNAPSHOT_SIZE_MB=5  # Alert if snapshot smaller than this

# ─── Helpers ──────────────────────────────────────────────────────────────────
log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" >&2; }
die() { log "FATAL: $*"; notify_failure "$*"; exit 1; }

notify_failure() {
  local message="$1"
  if [[ -n "${SLACK_WEBHOOK}" ]]; then
    curl -s -X POST "${SLACK_WEBHOOK}" \
      -H 'Content-type: application/json' \
      --data "{\"text\":\":x: etcd backup FAILED on ${CLUSTER_NAME}: ${message}\"}" || true
  fi
}

notify_success() {
  local file="$1"
  local size="$2"
  if [[ -n "${SLACK_WEBHOOK}" ]]; then
    curl -s -X POST "${SLACK_WEBHOOK}" \
      -H 'Content-type: application/json' \
      --data "{\"text\":\":white_check_mark: etcd backup OK on ${CLUSTER_NAME}: ${file} (${size})\"}" || true
  fi
}

etcdctl_cmd() {
  ETCDCTL_API=3 etcdctl \
    --endpoints="${ETCD_ENDPOINTS}" \
    --cacert="${ETCD_CACERT}" \
    --cert="${ETCD_CERT}" \
    --key="${ETCD_KEY}" \
    "$@"
}

# ─── Pre-flight Checks ────────────────────────────────────────────────────────
log "Starting etcd backup for cluster: ${CLUSTER_NAME}"

# Check etcd health before backup
log "Checking etcd endpoint health..."
if ! etcdctl_cmd endpoint health --timeout=10s 2>&1; then
  die "etcd endpoint is not healthy, aborting backup"
fi

# Check disk space (need at least 2x the current DB size)
DB_SIZE_BYTES=$(etcdctl_cmd endpoint status --write-out=json | \
  python3 -c "import json,sys; data=json.load(sys.stdin); print(data[0]['Status']['dbSize'])" 2>/dev/null || echo "0")
DB_SIZE_MB=$(( DB_SIZE_BYTES / 1024 / 1024 ))
FREE_DISK_MB=$(df -BM "${BACKUP_DIR}" | tail -1 | awk '{print $4}' | tr -d 'M')

log "etcd DB size: ${DB_SIZE_MB}MB, Free disk: ${FREE_DISK_MB}MB"

if (( FREE_DISK_MB < DB_SIZE_MB * 3 )); then
  die "Insufficient disk space: need $((DB_SIZE_MB * 3))MB, have ${FREE_DISK_MB}MB"
fi

# ─── Take Snapshot ────────────────────────────────────────────────────────────
mkdir -p "${BACKUP_DIR}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
SNAPSHOT_FILE="${BACKUP_DIR}/etcd-snapshot-${CLUSTER_NAME}-${TIMESTAMP}.db"

log "Taking snapshot to ${SNAPSHOT_FILE}..."
if ! etcdctl_cmd snapshot save "${SNAPSHOT_FILE}"; then
  die "etcdctl snapshot save failed"
fi

# ─── Verify Snapshot ─────────────────────────────────────────────────────────
log "Verifying snapshot integrity..."
SNAPSHOT_STATUS=$(ETCDCTL_API=3 etcdctl snapshot status "${SNAPSHOT_FILE}" --write-out=json)
SNAPSHOT_HASH=$(echo "${SNAPSHOT_STATUS}" | python3 -c "import json,sys; print(json.load(sys.stdin)['hash'])")
SNAPSHOT_REVISION=$(echo "${SNAPSHOT_STATUS}" | python3 -c "import json,sys; print(json.load(sys.stdin)['revision'])")
SNAPSHOT_TOTAL_KEY=$(echo "${SNAPSHOT_STATUS}" | python3 -c "import json,sys; print(json.load(sys.stdin)['totalKey'])")
SNAPSHOT_SIZE_MB=$(du -m "${SNAPSHOT_FILE}" | cut -f1)

log "Snapshot stats: revision=${SNAPSHOT_REVISION}, keys=${SNAPSHOT_TOTAL_KEY}, size=${SNAPSHOT_SIZE_MB}MB, hash=${SNAPSHOT_HASH}"

# Sanity check: snapshot should have some reasonable size
if (( SNAPSHOT_SIZE_MB < MIN_SNAPSHOT_SIZE_MB )); then
  die "Snapshot suspiciously small: ${SNAPSHOT_SIZE_MB}MB (minimum: ${MIN_SNAPSHOT_SIZE_MB}MB)"
fi

# ─── Compress and Checksum ────────────────────────────────────────────────────
log "Compressing snapshot..."
gzip -9 "${SNAPSHOT_FILE}"
COMPRESSED_FILE="${SNAPSHOT_FILE}.gz"
sha256sum "${COMPRESSED_FILE}" > "${COMPRESSED_FILE}.sha256"

COMPRESSED_SIZE=$(du -h "${COMPRESSED_FILE}" | cut -f1)
log "Compressed size: ${COMPRESSED_SIZE}"

# ─── Upload to S3 ─────────────────────────────────────────────────────────────
if [[ -n "${S3_BUCKET}" ]]; then
  log "Uploading to S3: s3://${S3_BUCKET}/etcd/${CLUSTER_NAME}/"

  aws s3 cp "${COMPRESSED_FILE}" \
    "s3://${S3_BUCKET}/etcd/${CLUSTER_NAME}/" \
    --storage-class STANDARD_IA \
    --metadata "cluster=${CLUSTER_NAME},revision=${SNAPSHOT_REVISION},keys=${SNAPSHOT_TOTAL_KEY},hash=${SNAPSHOT_HASH}"

  aws s3 cp "${COMPRESSED_FILE}.sha256" \
    "s3://${S3_BUCKET}/etcd/${CLUSTER_NAME}/"

  # Apply lifecycle policy tag for S3 retention
  aws s3api put-object-tagging \
    --bucket "${S3_BUCKET}" \
    --key "etcd/${CLUSTER_NAME}/$(basename "${COMPRESSED_FILE}")" \
    --tagging "TagSet=[{Key=RetentionDays,Value=${S3_RETENTION_DAYS}}]" 2>/dev/null || true

  log "S3 upload complete"
fi

# ─── Local Rotation ───────────────────────────────────────────────────────────
log "Rotating local backups older than ${LOCAL_RETENTION_DAYS} days..."
find "${BACKUP_DIR}" -name "etcd-snapshot-${CLUSTER_NAME}-*.db.gz" \
  -mtime "+${LOCAL_RETENTION_DAYS}" -delete -print | while read -r f; do
  log "Deleted old backup: ${f}"
  rm -f "${f}.sha256"
done

# ─── Metadata File ────────────────────────────────────────────────────────────
# Write metadata for monitoring and restore reference
cat > "${BACKUP_DIR}/latest-${CLUSTER_NAME}.json" <<EOF
{
  "cluster": "${CLUSTER_NAME}",
  "timestamp": "${TIMESTAMP}",
  "file": "$(basename "${COMPRESSED_FILE}")",
  "revision": ${SNAPSHOT_REVISION},
  "totalKeys": ${SNAPSHOT_TOTAL_KEY},
  "hash": ${SNAPSHOT_HASH},
  "sizeMB": ${SNAPSHOT_SIZE_MB},
  "compressedSize": "${COMPRESSED_SIZE}"
}
EOF

log "Backup completed successfully: $(basename "${COMPRESSED_FILE}") (${COMPRESSED_SIZE})"
notify_success "$(basename "${COMPRESSED_FILE}")" "${COMPRESSED_SIZE}"
```

### Kubernetes CronJob for Automated Backups

```yaml
---
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
# ClusterRole to list nodes (for finding control-plane nodes)
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
    namespace: etcd-backup
---
apiVersion: v1
kind: Secret
metadata:
  name: etcd-backup-config
  namespace: etcd-backup
type: Opaque
stringData:
  CLUSTER_NAME: "production"
  S3_BUCKET: "my-cluster-backups"
  SLACK_WEBHOOK: "https://hooks.slack.com/services/XXXXX"
  LOCAL_RETENTION_DAYS: "3"
  S3_RETENTION_DAYS: "90"
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: etcd-backup
  namespace: etcd-backup
spec:
  # Every 4 hours
  schedule: "0 */4 * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 5
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: etcd-backup
          # Must run on a control-plane node to access etcd PKI
          nodeSelector:
            node-role.kubernetes.io/control-plane: ""
          tolerations:
            - key: node-role.kubernetes.io/control-plane
              operator: Exists
              effect: NoSchedule
          hostNetwork: true  # Access etcd on localhost
          containers:
            - name: etcd-backup
              image: bitnami/etcd:3.5.12
              command:
                - /bin/bash
                - -c
                - |
                  apt-get install -y awscli curl > /dev/null 2>&1
                  /scripts/etcd-backup-production.sh
              envFrom:
                - secretRef:
                    name: etcd-backup-config
              env:
                - name: ETCD_ENDPOINTS
                  value: "https://127.0.0.1:2379"
                - name: ETCD_CACERT
                  value: "/etc/kubernetes/pki/etcd/ca.crt"
                - name: ETCD_CERT
                  value: "/etc/kubernetes/pki/etcd/healthcheck-client.crt"
                - name: ETCD_KEY
                  value: "/etc/kubernetes/pki/etcd/healthcheck-client.key"
                - name: BACKUP_DIR
                  value: "/backup"
              volumeMounts:
                - name: etcd-pki
                  mountPath: /etc/kubernetes/pki/etcd
                  readOnly: true
                - name: backup-storage
                  mountPath: /backup
                - name: backup-script
                  mountPath: /scripts
              resources:
                requests:
                  cpu: 100m
                  memory: 128Mi
                limits:
                  cpu: 500m
                  memory: 512Mi
          volumes:
            - name: etcd-pki
              hostPath:
                path: /etc/kubernetes/pki/etcd
                type: Directory
            - name: backup-storage
              hostPath:
                path: /var/backup/etcd
                type: DirectoryOrCreate
            - name: backup-script
              configMap:
                name: etcd-backup-script
                defaultMode: 0755
          restartPolicy: OnFailure
```

---

## Restore: Single-Node Cluster

Restoring etcd is a multi-step process that requires stopping the API server first. The API server continuously watches etcd — if it is running during a restore, it will immediately begin writing back state that conflicts with the restored snapshot.

### Step-by-Step Single Control-Plane Restore

```bash
#!/usr/bin/env bash
# etcd-restore-single.sh — Restore etcd on a single control-plane node
# Run as root on the control-plane node.

set -euo pipefail

SNAPSHOT_FILE="${1:-}"
ETCD_DATA_DIR="${ETCD_DATA_DIR:-/var/lib/etcd}"
ETCD_BACKUP_DIR="/var/lib/etcd.bak.$(date +%Y%m%d-%H%M%S)"
STATIC_PODS_DIR="/etc/kubernetes/manifests"
STATIC_PODS_BACKUP="/etc/kubernetes/manifests.bak.$(date +%Y%m%d-%H%M%S)"

if [[ -z "${SNAPSHOT_FILE}" ]]; then
  echo "Usage: $0 <snapshot-file.db>" >&2
  exit 1
fi

# Decompress if needed
if [[ "${SNAPSHOT_FILE}" == *.gz ]]; then
  echo "Decompressing snapshot..."
  gunzip -k "${SNAPSHOT_FILE}"
  SNAPSHOT_FILE="${SNAPSHOT_FILE%.gz}"
fi

# Verify snapshot before starting
echo "Verifying snapshot..."
ETCDCTL_API=3 etcdctl snapshot status "${SNAPSHOT_FILE}" -w table || {
  echo "ERROR: Snapshot verification failed" >&2
  exit 1
}

echo "=== RESTORE PLAN ==="
echo "Snapshot:  ${SNAPSHOT_FILE}"
echo "Data dir:  ${ETCD_DATA_DIR}"
echo "Backup to: ${ETCD_BACKUP_DIR}"
echo ""
read -rp "Proceed? This will STOP the cluster. [yes/NO]: " confirm
[[ "${confirm}" == "yes" ]] || { echo "Aborted."; exit 0; }

# Step 1: Stop the static pod manifests so kubelet removes them
echo "Step 1: Stopping static pods (API server, scheduler, controller-manager)..."
mkdir -p "${STATIC_PODS_BACKUP}"
mv "${STATIC_PODS_DIR}"/kube-apiserver.yaml "${STATIC_PODS_BACKUP}/" 2>/dev/null || true
mv "${STATIC_PODS_DIR}"/kube-scheduler.yaml "${STATIC_PODS_BACKUP}/" 2>/dev/null || true
mv "${STATIC_PODS_DIR}"/kube-controller-manager.yaml "${STATIC_PODS_BACKUP}/" 2>/dev/null || true
mv "${STATIC_PODS_DIR}"/etcd.yaml "${STATIC_PODS_BACKUP}/" 2>/dev/null || true

echo "Waiting for static pods to stop..."
sleep 10

# Confirm containers are gone
if crictl ps 2>/dev/null | grep -qE 'etcd|kube-apiserver'; then
  echo "WARNING: Containers still running. Waiting longer..."
  sleep 20
fi

# Step 2: Back up existing data directory
echo "Step 2: Backing up existing data directory..."
if [[ -d "${ETCD_DATA_DIR}" ]]; then
  mv "${ETCD_DATA_DIR}" "${ETCD_BACKUP_DIR}"
  echo "Backed up to: ${ETCD_BACKUP_DIR}"
fi

# Step 3: Restore the snapshot
echo "Step 3: Restoring snapshot..."

# Get node name and advertise peer URL from the backed-up etcd manifest
PEER_URL=$(grep -oP '(?<=--initial-advertise-peer-urls=)https?://[^ ]+' \
  "${STATIC_PODS_BACKUP}/etcd.yaml" 2>/dev/null || echo "https://127.0.0.1:2380")
NODE_NAME=$(grep -oP '(?<=--name=)[^ ]+' \
  "${STATIC_PODS_BACKUP}/etcd.yaml" 2>/dev/null || hostname)

echo "Node name:  ${NODE_NAME}"
echo "Peer URL:   ${PEER_URL}"

ETCDCTL_API=3 etcdctl snapshot restore "${SNAPSHOT_FILE}" \
  --name="${NODE_NAME}" \
  --initial-cluster="${NODE_NAME}=${PEER_URL}" \
  --initial-advertise-peer-urls="${PEER_URL}" \
  --data-dir="${ETCD_DATA_DIR}"

# Fix ownership
chown -R root:root "${ETCD_DATA_DIR}"
chmod 700 "${ETCD_DATA_DIR}"

# Step 4: Restore static pod manifests
echo "Step 4: Restoring static pod manifests..."
cp "${STATIC_PODS_BACKUP}"/etcd.yaml "${STATIC_PODS_DIR}/"
sleep 5  # Give etcd a moment to start before API server

cp "${STATIC_PODS_BACKUP}"/kube-apiserver.yaml "${STATIC_PODS_DIR}/"
cp "${STATIC_PODS_BACKUP}"/kube-scheduler.yaml "${STATIC_PODS_DIR}/"
cp "${STATIC_PODS_DIR_BACKUP}"/kube-controller-manager.yaml "${STATIC_PODS_DIR}/"

# Step 5: Verify recovery
echo "Step 5: Waiting for control plane to recover..."
for i in $(seq 1 60); do
  if kubectl get nodes 2>/dev/null | grep -q "Ready"; then
    echo "Control plane is up! (took ${i}s)"
    break
  fi
  echo "  Waiting... (${i}/60)"
  sleep 5
done

echo ""
echo "=== POST-RESTORE VERIFICATION ==="
kubectl get nodes
kubectl get pods -n kube-system

echo ""
echo "Restore complete. Backup of old data at: ${ETCD_BACKUP_DIR}"
echo "If restore is healthy, you may delete: ${ETCD_BACKUP_DIR}"
```

---

## Restore: Multi-Member Cluster

Restoring a multi-member etcd cluster is more complex because you must restore all members from the **same snapshot** and bootstrap them as a new cluster — otherwise Raft will reject the divergent state.

```bash
#!/usr/bin/env bash
# etcd-restore-multi.sh — Restore a 3-member etcd cluster
# Must be run on ALL control-plane nodes (ideally in parallel via pssh/ansible)

set -euo pipefail

SNAPSHOT_FILE="${1:-}"
THIS_NODE="${THIS_NODE:-$(hostname)}"

# All cluster members — must match your cluster topology
declare -A MEMBERS=(
  ["master-0"]="https://10.0.0.1:2380"
  ["master-1"]="https://10.0.0.2:2380"
  ["master-2"]="https://10.0.0.3:2380"
)

ETCD_DATA_DIR="/var/lib/etcd"
STATIC_PODS_DIR="/etc/kubernetes/manifests"

if [[ -z "${SNAPSHOT_FILE}" ]]; then
  echo "Usage: THIS_NODE=master-0 $0 <snapshot.db>" >&2
  exit 1
fi

# Decompress if needed
[[ "${SNAPSHOT_FILE}" == *.gz ]] && { gunzip -k "${SNAPSHOT_FILE}"; SNAPSHOT_FILE="${SNAPSHOT_FILE%.gz}"; }

# Verify this node is in the member list
if [[ -z "${MEMBERS[${THIS_NODE}]+x}" ]]; then
  echo "ERROR: ${THIS_NODE} not in MEMBERS map" >&2
  exit 1
fi

# Build initial-cluster string
INITIAL_CLUSTER=$(printf '%s=%s,' "${!MEMBERS[@]}" "${MEMBERS[@]}" | sed 's/,$//')
# Sort for determinism
INITIAL_CLUSTER=$(for k in "${!MEMBERS[@]}"; do echo "${k}=${MEMBERS[$k]}"; done | sort | paste -sd,)

ADVERTISE_PEER_URL="${MEMBERS[${THIS_NODE}]}"

echo "=== Multi-Member Restore ==="
echo "Node:             ${THIS_NODE}"
echo "Advertise URL:    ${ADVERTISE_PEER_URL}"
echo "Initial cluster:  ${INITIAL_CLUSTER}"
echo "Snapshot:         ${SNAPSHOT_FILE}"

# Stop static pods on THIS node
echo "Stopping static pods..."
BACKUP_DIR="/etc/kubernetes/manifests.restore.$(date +%Y%m%d-%H%M%S)"
mkdir -p "${BACKUP_DIR}"
for manifest in etcd kube-apiserver kube-scheduler kube-controller-manager; do
  [[ -f "${STATIC_PODS_DIR}/${manifest}.yaml" ]] && \
    mv "${STATIC_PODS_DIR}/${manifest}.yaml" "${BACKUP_DIR}/"
done
sleep 15

# Back up and restore data dir
[[ -d "${ETCD_DATA_DIR}" ]] && mv "${ETCD_DATA_DIR}" "${ETCD_DATA_DIR}.bak.$(date +%Y%m%d-%H%M%S)"

# Restore from snapshot — note --initial-cluster includes ALL members
ETCDCTL_API=3 etcdctl snapshot restore "${SNAPSHOT_FILE}" \
  --name="${THIS_NODE}" \
  --initial-cluster="${INITIAL_CLUSTER}" \
  --initial-cluster-token="etcd-cluster-restored-$(date +%s)" \
  --initial-advertise-peer-urls="${ADVERTISE_PEER_URL}" \
  --data-dir="${ETCD_DATA_DIR}"

chown -R root:root "${ETCD_DATA_DIR}"

# Restore etcd manifest first
cp "${BACKUP_DIR}/etcd.yaml" "${STATIC_PODS_DIR}/"
echo "etcd manifest restored. Waiting for etcd to form quorum..."
echo "IMPORTANT: Run this script on ALL other members simultaneously before proceeding."
echo "Once all members have run this script, etcd will form quorum automatically."
echo ""
echo "After all members complete, restore API server manifests:"
echo "  cp ${BACKUP_DIR}/kube-apiserver.yaml ${STATIC_PODS_DIR}/"
echo "  cp ${BACKUP_DIR}/kube-scheduler.yaml ${STATIC_PODS_DIR}/"
echo "  cp ${BACKUP_DIR}/kube-controller-manager.yaml ${STATIC_PODS_DIR}/"
```

### Ansible Playbook for Coordinated Multi-Member Restore

```yaml
---
# etcd-restore.yml — Ansible playbook for coordinated multi-member restore
- name: Restore etcd on all control-plane nodes
  hosts: control_plane
  become: true
  serial: 0  # Run all hosts simultaneously (critical for multi-member restore)
  vars:
    snapshot_file: "{{ snapshot }}"  # pass with -e snapshot=/path/to/snapshot.db
    etcd_data_dir: /var/lib/etcd
    manifests_dir: /etc/kubernetes/manifests
    etcd_pki_dir: /etc/kubernetes/pki/etcd

  tasks:
    - name: Verify snapshot file exists
      stat:
        path: "{{ snapshot_file }}"
      register: snapshot_stat
      failed_when: not snapshot_stat.stat.exists

    - name: Verify snapshot integrity
      command: etcdctl snapshot status "{{ snapshot_file }}" -w table
      environment:
        ETCDCTL_API: "3"
      changed_when: false

    - name: Stop static pod manifests
      shell: |
        for f in etcd kube-apiserver kube-scheduler kube-controller-manager; do
          [ -f "{{ manifests_dir }}/${f}.yaml" ] && \
            mv "{{ manifests_dir }}/${f}.yaml" /tmp/${f}.yaml.bak || true
        done
      changed_when: true

    - name: Wait for containers to stop
      pause:
        seconds: 20

    - name: Backup existing data directory
      command: "mv {{ etcd_data_dir }} {{ etcd_data_dir }}.bak.{{ ansible_date_time.iso8601_basic_short }}"
      ignore_errors: true

    - name: Get node-specific advertise-peer-url
      set_fact:
        advertise_peer_url: "https://{{ ansible_host }}:2380"

    - name: Build initial-cluster string
      set_fact:
        initial_cluster: >-
          {{ groups['control_plane'] | map('extract', hostvars, 'ansible_host') |
             zip(groups['control_plane']) |
             map('reverse') | map('join', '=https://') |
             map('regex_replace', '$', ':2380') |
             join(',') }}

    - name: Restore snapshot
      command: >
        etcdctl snapshot restore {{ snapshot_file }}
        --name={{ inventory_hostname }}
        --initial-cluster={{ initial_cluster }}
        --initial-cluster-token=etcd-restored-{{ ansible_date_time.epoch }}
        --initial-advertise-peer-urls={{ advertise_peer_url }}
        --data-dir={{ etcd_data_dir }}
      environment:
        ETCDCTL_API: "3"

    - name: Fix ownership
      file:
        path: "{{ etcd_data_dir }}"
        owner: root
        group: root
        mode: "0700"
        recurse: true

    - name: Restore etcd manifest
      copy:
        src: /tmp/etcd.yaml.bak
        dest: "{{ manifests_dir }}/etcd.yaml"
        remote_src: true

    - name: Wait for etcd quorum
      command: >
        etcdctl --endpoints=https://127.0.0.1:2379
        --cacert={{ etcd_pki_dir }}/ca.crt
        --cert={{ etcd_pki_dir }}/healthcheck-client.crt
        --key={{ etcd_pki_dir }}/healthcheck-client.key
        endpoint health
      environment:
        ETCDCTL_API: "3"
      register: etcd_health
      until: etcd_health.rc == 0
      retries: 30
      delay: 10

    - name: Restore API server and other control plane components
      copy:
        src: "/tmp/{{ item }}.yaml.bak"
        dest: "{{ manifests_dir }}/{{ item }}.yaml"
        remote_src: true
      loop:
        - kube-apiserver
        - kube-scheduler
        - kube-controller-manager

    - name: Verify node is Ready
      command: kubectl get node {{ inventory_hostname }}
      changed_when: false
      register: node_status
      until: "'Ready' in node_status.stdout"
      retries: 30
      delay: 10
```

---

## Compaction: Managing etcd History

etcd maintains a complete revision history of all key-value changes. Without compaction, the database grows indefinitely. Compaction discards all revisions before a specified point, reclaiming space in the logical sense (the physical space is reclaimed by defragmentation).

### Understanding Auto-Compaction

etcd supports built-in auto-compaction in two modes:

```bash
# Periodic mode: compact every N hours of wall-clock time
--auto-compaction-mode=periodic
--auto-compaction-retention=8h   # keep 8 hours of history

# Revision mode: keep the last N revisions
--auto-compaction-mode=revision
--auto-compaction-retention=100000  # keep last 100,000 revisions
```

**Revision mode is generally preferred** for production because:
- It's predictable based on write rate, not wall-clock time
- With a revision window of ~100,000, you typically have several hours of history on a busy cluster
- Burst write scenarios don't cause sudden history loss

### Manual Compaction

```bash
#!/usr/bin/env bash
# etcd-compact.sh — Manual etcd compaction

ETCDCTL_API=3
ETCD_ENDPOINTS="https://127.0.0.1:2379"
ETCD_CACERT="/etc/kubernetes/pki/etcd/ca.crt"
ETCD_CERT="/etc/kubernetes/pki/etcd/healthcheck-client.crt"
ETCD_KEY="/etc/kubernetes/pki/etcd/healthcheck-client.key"

etcdctl_cmd() {
  ETCDCTL_API=3 etcdctl \
    --endpoints="${ETCD_ENDPOINTS}" \
    --cacert="${ETCD_CACERT}" \
    --cert="${ETCD_CERT}" \
    --key="${ETCD_KEY}" \
    "$@"
}

# Get current revision
CURRENT_REVISION=$(etcdctl_cmd endpoint status --write-out=json | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['Status']['header']['revision'])")
echo "Current revision: ${CURRENT_REVISION}"

# Keep last 10 minutes of history (adjust based on your write rate)
# A busy cluster might have ~50,000 revisions per 10 minutes
REVISIONS_TO_KEEP=100000
TARGET_REVISION=$(( CURRENT_REVISION - REVISIONS_TO_KEEP ))

if (( TARGET_REVISION <= 0 )); then
  echo "Not enough revisions to compact (current: ${CURRENT_REVISION}, target would be: ${TARGET_REVISION})"
  exit 0
fi

echo "Compacting to revision ${TARGET_REVISION} (keeping last ${REVISIONS_TO_KEEP} revisions)..."
etcdctl_cmd compact "${TARGET_REVISION}"
echo "Compaction complete."

# Show DB size before defrag
echo ""
etcdctl_cmd endpoint status --write-out=table
```

### Compaction Script with Prometheus Pushgateway

```bash
#!/usr/bin/env bash
# etcd-compact-with-metrics.sh — Compaction with Prometheus metrics

set -euo pipefail

PUSHGATEWAY_URL="${PUSHGATEWAY_URL:-http://prometheus-pushgateway:9091}"
CLUSTER_NAME="${CLUSTER_NAME:-production}"
KEEP_REVISIONS="${KEEP_REVISIONS:-100000}"

etcdctl_cmd() {
  ETCDCTL_API=3 etcdctl \
    --endpoints="${ETCD_ENDPOINTS:-https://127.0.0.1:2379}" \
    --cacert="${ETCD_CACERT:-/etc/kubernetes/pki/etcd/ca.crt}" \
    --cert="${ETCD_CERT:-/etc/kubernetes/pki/etcd/healthcheck-client.crt}" \
    --key="${ETCD_KEY:-/etc/kubernetes/pki/etcd/healthcheck-client.key}" \
    "$@"
}

push_metric() {
  local metric_name="$1"
  local value="$2"
  local help="${3:-etcd compaction metric}"

  cat <<EOF | curl -s --data-binary @- "${PUSHGATEWAY_URL}/metrics/job/etcd-compaction/cluster/${CLUSTER_NAME}"
# HELP ${metric_name} ${help}
# TYPE ${metric_name} gauge
${metric_name}{cluster="${CLUSTER_NAME}"} ${value}
EOF
}

START_TIME=$(date +%s)

# Get pre-compaction state
STATUS_JSON=$(etcdctl_cmd endpoint status --write-out=json)
CURRENT_REVISION=$(echo "${STATUS_JSON}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['Status']['header']['revision'])")
DB_SIZE_BEFORE=$(echo "${STATUS_JSON}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['Status']['dbSize'])")
DB_SIZE_IN_USE_BEFORE=$(echo "${STATUS_JSON}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['Status']['dbSizeInUse'])")

TARGET_REVISION=$(( CURRENT_REVISION - KEEP_REVISIONS ))
echo "Compacting: current_rev=${CURRENT_REVISION}, target_rev=${TARGET_REVISION}"

if (( TARGET_REVISION > 0 )); then
  etcdctl_cmd compact "${TARGET_REVISION}" --physical=true
  COMPACT_STATUS=1
else
  echo "Nothing to compact"
  COMPACT_STATUS=0
fi

END_TIME=$(date +%s)
DURATION=$(( END_TIME - START_TIME ))

# Push metrics
push_metric "etcd_compaction_last_run_timestamp" "${END_TIME}" "Timestamp of last compaction run"
push_metric "etcd_compaction_duration_seconds" "${DURATION}" "Duration of compaction in seconds"
push_metric "etcd_compaction_success" "${COMPACT_STATUS}" "Whether last compaction succeeded"
push_metric "etcd_compaction_target_revision" "${TARGET_REVISION}" "Revision compacted to"
push_metric "etcd_db_size_bytes" "${DB_SIZE_BEFORE}" "DB size before compaction"
push_metric "etcd_db_size_in_use_bytes" "${DB_SIZE_IN_USE_BEFORE}" "DB size in use before compaction"

echo "Compaction metrics pushed to Pushgateway"
```

---

## Defragmentation: Physical Space Reclamation

Compaction removes logical entries but leaves "holes" in BoltDB's file. These holes are not returned to the OS until defragmentation runs. **Defragmentation rewrites the entire BoltDB file**, temporarily doubling disk usage.

### Critical Defragmentation Rules

1. **Never defrag all members simultaneously** — it takes a member offline briefly
2. **Defrag followers first**, then the leader last
3. **Check free disk space** before defrag (need ~2x the DB size free)
4. **Monitor etcd metrics** during defrag for latency spikes
5. **Defrag during low-traffic windows** (maintenance windows, off-peak hours)

```bash
#!/usr/bin/env bash
# etcd-defrag-rolling.sh — Rolling defragmentation of all cluster members

set -euo pipefail

# Cluster endpoints — all members
ALL_ENDPOINTS="${ALL_ENDPOINTS:-https://10.0.0.1:2379,https://10.0.0.2:2379,https://10.0.0.3:2379}"
ETCD_CACERT="/etc/kubernetes/pki/etcd/ca.crt"
ETCD_CERT="/etc/kubernetes/pki/etcd/healthcheck-client.crt"
ETCD_KEY="/etc/kubernetes/pki/etcd/healthcheck-client.key"
HEALTH_WAIT_SECONDS=30
MIN_FREE_DISK_MB=5000  # Require 5GB free before defrag

etcdctl_all() {
  ETCDCTL_API=3 etcdctl \
    --endpoints="${ALL_ENDPOINTS}" \
    --cacert="${ETCD_CACERT}" \
    --cert="${ETCD_CERT}" \
    --key="${ETCD_KEY}" \
    "$@"
}

etcdctl_endpoint() {
  local endpoint="$1"
  shift
  ETCDCTL_API=3 etcdctl \
    --endpoints="${endpoint}" \
    --cacert="${ETCD_CACERT}" \
    --cert="${ETCD_CERT}" \
    --key="${ETCD_KEY}" \
    "$@"
}

get_leader_endpoint() {
  ETCDCTL_API=3 etcdctl \
    --endpoints="${ALL_ENDPOINTS}" \
    --cacert="${ETCD_CACERT}" \
    --cert="${ETCD_CERT}" \
    --key="${ETCD_KEY}" \
    endpoint status --write-out=json | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
leader_id = None
for member in data:
    if member['Status']['leader'] == member['Status']['header']['member_id']:
        leader_id = member['Endpoint']
print(leader_id or '')
"
}

check_cluster_health() {
  echo "Checking cluster health..."
  if ! etcdctl_all endpoint health --timeout=10s 2>&1; then
    echo "ERROR: Cluster is not healthy, aborting defrag" >&2
    exit 1
  fi
}

defrag_member() {
  local endpoint="$1"
  echo ""
  echo "=== Defragmenting ${endpoint} ==="

  # Pre-defrag size
  STATUS=$(etcdctl_endpoint "${endpoint}" endpoint status --write-out=json)
  DB_SIZE=$(echo "${STATUS}" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['Status']['dbSize'])")
  DB_SIZE_IN_USE=$(echo "${STATUS}" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['Status']['dbSizeInUse'])")
  DB_SIZE_MB=$(( DB_SIZE / 1024 / 1024 ))
  DB_SIZE_IN_USE_MB=$(( DB_SIZE_IN_USE / 1024 / 1024 ))
  FRAGMENTATION_MB=$(( DB_SIZE_MB - DB_SIZE_IN_USE_MB ))

  echo "  Pre-defrag: total=${DB_SIZE_MB}MB, in-use=${DB_SIZE_IN_USE_MB}MB, fragmented=${FRAGMENTATION_MB}MB"

  if (( FRAGMENTATION_MB < 100 )); then
    echo "  Skipping: fragmentation < 100MB, not worth defragging"
    return 0
  fi

  # Check free disk space on the node hosting this endpoint
  # (This assumes we can reach the node; in practice use a more robust check)

  # Run defrag
  START=$(date +%s%N)
  etcdctl_endpoint "${endpoint}" defrag --timeout=300s
  END=$(date +%s%N)
  DURATION_MS=$(( (END - START) / 1000000 ))

  # Post-defrag size
  STATUS_AFTER=$(etcdctl_endpoint "${endpoint}" endpoint status --write-out=json)
  DB_SIZE_AFTER=$(echo "${STATUS_AFTER}" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['Status']['dbSize'])")
  DB_SIZE_AFTER_MB=$(( DB_SIZE_AFTER / 1024 / 1024 ))
  RECLAIMED_MB=$(( DB_SIZE_MB - DB_SIZE_AFTER_MB ))

  echo "  Post-defrag: total=${DB_SIZE_AFTER_MB}MB, reclaimed=${RECLAIMED_MB}MB, duration=${DURATION_MS}ms"

  # Verify health after defrag
  echo "  Verifying health after defrag..."
  sleep "${HEALTH_WAIT_SECONDS}"
  if ! etcdctl_endpoint "${endpoint}" endpoint health --timeout=30s; then
    echo "ERROR: ${endpoint} is unhealthy after defrag!" >&2
    exit 1
  fi
  echo "  Health OK"
}

# ─── Main ─────────────────────────────────────────────────────────────────────
echo "=== etcd Rolling Defragmentation ==="
check_cluster_health

# Get leader (defrag leader last)
LEADER=$(get_leader_endpoint)
echo "Current leader: ${LEADER}"

# Show pre-defrag state
echo ""
echo "Pre-defrag cluster state:"
etcdctl_all endpoint status --write-out=table

# Defrag followers first
IFS=',' read -ra ENDPOINTS <<< "${ALL_ENDPOINTS}"
for endpoint in "${ENDPOINTS[@]}"; do
  if [[ "${endpoint}" != "${LEADER}" ]]; then
    defrag_member "${endpoint}"
    check_cluster_health
  fi
done

# Defrag leader last
echo ""
echo "Defragging leader (${LEADER})..."
defrag_member "${LEADER}"

# Final health check
echo ""
echo "=== Final cluster state ==="
check_cluster_health
etcdctl_all endpoint status --write-out=table

echo ""
echo "Defragmentation complete!"
```

---

## Cluster Health Monitoring

### Key etcd Metrics

etcd exposes comprehensive Prometheus metrics at the `/metrics` endpoint. Here are the most important ones for production monitoring:

```yaml
# etcd-monitoring-rules.yaml — Prometheus alerting rules for etcd

apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: etcd-alerts
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    - name: etcd.rules
      interval: 1m
      rules:
        # ─── Availability ─────────────────────────────────────────────────────
        - alert: EtcdDown
          expr: up{job="etcd"} == 0
          for: 1m
          labels:
            severity: critical
            team: platform
          annotations:
            summary: "etcd instance {{ $labels.instance }} is down"
            description: "etcd {{ $labels.instance }} has been down for more than 1 minute."
            runbook_url: "https://runbooks.example.com/etcd-down"

        - alert: EtcdNoLeader
          expr: etcd_server_has_leader{job="etcd"} == 0
          for: 1m
          labels:
            severity: critical
            team: platform
          annotations:
            summary: "etcd cluster has no leader"
            description: "etcd member {{ $labels.instance }} has no leader. Writes are blocked."

        - alert: EtcdHighNumberOfLeaderChanges
          expr: |
            increase(etcd_server_leader_changes_seen_total{job="etcd"}[15m]) > 3
          for: 5m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "High number of etcd leader changes"
            description: "etcd instance {{ $labels.instance }} has seen {{ $value }} leader changes in 15 minutes."

        # ─── Storage ──────────────────────────────────────────────────────────
        - alert: EtcdDatabaseQuotaLow
          expr: |
            (etcd_mvcc_db_total_size_in_bytes{job="etcd"} / etcd_server_quota_backend_bytes{job="etcd"}) > 0.80
          for: 10m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "etcd database is approaching quota limit"
            description: "etcd {{ $labels.instance }} database is {{ $value | humanizePercentage }} full. Run compaction and defrag."

        - alert: EtcdDatabaseQuotaCritical
          expr: |
            (etcd_mvcc_db_total_size_in_bytes{job="etcd"} / etcd_server_quota_backend_bytes{job="etcd"}) > 0.95
          for: 1m
          labels:
            severity: critical
            team: platform
          annotations:
            summary: "etcd database is near quota limit — writes will be rejected!"
            description: "etcd {{ $labels.instance }} database is {{ $value | humanizePercentage }} full."

        - alert: EtcdLargeDatabase
          expr: etcd_mvcc_db_total_size_in_bytes{job="etcd"} > 8e9
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "etcd database larger than 8GB"
            description: "etcd {{ $labels.instance }} database is {{ $value | humanize1024 }}B."

        - alert: EtcdHighFragmentation
          expr: |
            (1 - (etcd_mvcc_db_total_size_in_use_in_bytes{job="etcd"} / etcd_mvcc_db_total_size_in_bytes{job="etcd"})) > 0.30
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "etcd database has high fragmentation"
            description: "etcd {{ $labels.instance }} has {{ $value | humanizePercentage }} fragmentation. Run defragmentation."

        # ─── Performance ──────────────────────────────────────────────────────
        - alert: EtcdHighCommitDurations
          expr: |
            histogram_quantile(0.99, sum by (instance, le) (
              rate(etcd_disk_backend_commit_duration_seconds_bucket{job="etcd"}[5m])
            )) > 0.25
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "etcd has slow disk commit latency"
            description: "etcd {{ $labels.instance }} p99 commit latency is {{ $value | humanizeDuration }}. Check disk performance."

        - alert: EtcdHighFsyncDurations
          expr: |
            histogram_quantile(0.99, sum by (instance, le) (
              rate(etcd_disk_wal_fsync_duration_seconds_bucket{job="etcd"}[5m])
            )) > 0.5
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "etcd WAL fsync is slow"
            description: "etcd {{ $labels.instance }} p99 WAL fsync latency is {{ $value | humanizeDuration }}."

        - alert: EtcdHighApplyDurations
          expr: |
            histogram_quantile(0.99, sum by (instance, le) (
              rate(etcd_server_apply_duration_seconds_bucket{job="etcd"}[5m])
            )) > 2.0
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "etcd apply operations are slow"
            description: "etcd {{ $labels.instance }} p99 apply duration is {{ $value | humanizeDuration }}."

        # ─── Network ──────────────────────────────────────────────────────────
        - alert: EtcdMemberCommunicationSlow
          expr: |
            histogram_quantile(0.99, sum by (To, le) (
              rate(etcd_network_peer_round_trip_time_seconds_bucket{job="etcd"}[5m])
            )) > 0.15
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "etcd cluster member communication is slow"
            description: "etcd peer round-trip latency to {{ $labels.To }} p99 is {{ $value | humanizeDuration }}."

        - alert: EtcdHighGRPCRequestsFailRate
          expr: |
            sum(rate(grpc_server_handled_total{job="etcd", grpc_code=~"Unknown|FailedPrecondition|ResourceExhausted|Internal|Unavailable|DataLoss|DeadlineExceeded"}[5m]))
            /
            sum(rate(grpc_server_handled_total{job="etcd"}[5m])) > 0.01
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "etcd gRPC error rate is high"
            description: "etcd gRPC error rate is {{ $value | humanizePercentage }}."

        # ─── Backup ───────────────────────────────────────────────────────────
        - alert: EtcdBackupNotRunning
          expr: |
            (time() - etcd_compaction_last_run_timestamp{cluster="production"}) > 14400
          for: 5m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "etcd backup has not run in 4 hours"
            description: "The last etcd backup was {{ $value | humanizeDuration }} ago."
```

### Grafana Dashboard Queries

```promql
# etcd DB size vs quota
100 * etcd_mvcc_db_total_size_in_bytes{job="etcd"} / etcd_server_quota_backend_bytes{job="etcd"}

# Compaction frequency
rate(etcd_compaction_duration_seconds_count{job="etcd"}[1h])

# Write rate (mutations per second)
rate(etcd_mvcc_put_total{job="etcd"}[5m]) + rate(etcd_mvcc_delete_total{job="etcd"}[5m])

# Leader change rate
increase(etcd_server_leader_changes_seen_total{job="etcd"}[1h])

# Disk commit p99
histogram_quantile(0.99, sum by (instance, le) (rate(etcd_disk_backend_commit_duration_seconds_bucket{job="etcd"}[5m])))

# Network peer RTT p99
histogram_quantile(0.99, sum by (To, le) (rate(etcd_network_peer_round_trip_time_seconds_bucket{job="etcd"}[5m])))

# DB fragmentation ratio
1 - (etcd_mvcc_db_total_size_in_use_in_bytes{job="etcd"} / etcd_mvcc_db_total_size_in_bytes{job="etcd"})

# Keys total
etcd_debugging_mvcc_keys_total{job="etcd"}

# Watch streams
etcd_debugging_mvcc_watch_stream_total{job="etcd"}
```

### etcd Health Check Script

```bash
#!/usr/bin/env bash
# etcd-health-check.sh — Comprehensive etcd health diagnostic

set -euo pipefail

ETCD_ENDPOINTS="${ETCD_ENDPOINTS:-https://127.0.0.1:2379}"
ETCD_CACERT="${ETCD_CACERT:-/etc/kubernetes/pki/etcd/ca.crt}"
ETCD_CERT="${ETCD_CERT:-/etc/kubernetes/pki/etcd/healthcheck-client.crt}"
ETCD_KEY="${ETCD_KEY:-/etc/kubernetes/pki/etcd/healthcheck-client.key}"

etcdctl_cmd() {
  ETCDCTL_API=3 etcdctl \
    --endpoints="${ETCD_ENDPOINTS}" \
    --cacert="${ETCD_CACERT}" \
    --cert="${ETCD_CERT}" \
    --key="${ETCD_KEY}" \
    "$@"
}

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║              etcd Cluster Health Diagnostic                  ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ─── Endpoint Health ──────────────────────────────────────────────────────────
echo "── Endpoint Health ──────────────────────────────────────────────"
etcdctl_cmd endpoint health -w table 2>&1 || echo "HEALTH CHECK FAILED"
echo ""

# ─── Member List ──────────────────────────────────────────────────────────────
echo "── Cluster Members ──────────────────────────────────────────────"
etcdctl_cmd member list -w table
echo ""

# ─── Endpoint Status ──────────────────────────────────────────────────────────
echo "── Endpoint Status ──────────────────────────────────────────────"
etcdctl_cmd endpoint status -w table
echo ""

# ─── Storage Analysis ─────────────────────────────────────────────────────────
echo "── Storage Analysis ─────────────────────────────────────────────"
STATUS_JSON=$(etcdctl_cmd endpoint status --write-out=json)

python3 - <<'PYTHON' "${STATUS_JSON}"
import json, sys

data = json.loads(sys.argv[1])
for member in data:
    ep = member['Endpoint']
    s = member['Status']
    db_size = s['dbSize']
    db_size_in_use = s['dbSizeInUse']
    db_size_mb = db_size / 1024 / 1024
    db_in_use_mb = db_size_in_use / 1024 / 1024
    fragmented_mb = db_size_mb - db_in_use_mb
    fragmentation_pct = (1 - db_size_in_use / db_size) * 100 if db_size > 0 else 0
    revision = s['header']['revision']

    print(f"  {ep}:")
    print(f"    DB Size:       {db_size_mb:.1f} MB")
    print(f"    In Use:        {db_in_use_mb:.1f} MB")
    print(f"    Fragmented:    {fragmented_mb:.1f} MB ({fragmentation_pct:.1f}%)")
    print(f"    Revision:      {revision:,}")
    print(f"    Is Leader:     {s['leader'] == s['header']['member_id']}")

    # Warnings
    if fragmentation_pct > 30:
        print(f"    ⚠ WARNING: High fragmentation ({fragmentation_pct:.1f}%) — consider defrag")
    if db_size_mb > 6000:
        print(f"    ⚠ WARNING: Large DB size ({db_size_mb:.1f} MB) — check compaction")
PYTHON

echo ""

# ─── Key Count and Namespace Distribution ─────────────────────────────────────
echo "── Kubernetes Key Distribution ──────────────────────────────────"
echo "Total key count:"
etcdctl_cmd get / --prefix --keys-only 2>/dev/null | grep -c '^/' || echo "0"

echo ""
echo "Top-level prefix distribution:"
etcdctl_cmd get / --prefix --keys-only 2>/dev/null | \
  grep '^/' | \
  sed 's|^/[^/]*/[^/]*/\([^/]*\).*|\1|; s|^\(/[^/]*/[^/]*\).*|\1|' | \
  sort | uniq -c | sort -rn | head -20

echo ""

# ─── Alarm Check ──────────────────────────────────────────────────────────────
echo "── Active Alarms ────────────────────────────────────────────────"
ALARMS=$(etcdctl_cmd alarm list 2>&1)
if [[ -z "${ALARMS}" ]]; then
  echo "  No active alarms"
else
  echo "${ALARMS}"
  echo ""
  echo "  To resolve NOSPACE alarm after compaction+defrag:"
  echo "  etcdctl alarm disarm"
fi

echo ""
echo "── Certificates ─────────────────────────────────────────────────"
for cert in \
  /etc/kubernetes/pki/etcd/ca.crt \
  /etc/kubernetes/pki/etcd/peer.crt \
  /etc/kubernetes/pki/etcd/server.crt \
  /etc/kubernetes/pki/etcd/healthcheck-client.crt; do
  if [[ -f "${cert}" ]]; then
    EXPIRY=$(openssl x509 -noout -enddate -in "${cert}" | cut -d= -f2)
    EXPIRY_EPOCH=$(date -d "${EXPIRY}" +%s)
    NOW_EPOCH=$(date +%s)
    DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))
    WARN=""
    [[ ${DAYS_LEFT} -lt 30 ]] && WARN=" ⚠ EXPIRES SOON"
    [[ ${DAYS_LEFT} -lt 0 ]] && WARN=" ✗ EXPIRED"
    printf "  %-45s %s days%s\n" "$(basename "${cert}"):" "${DAYS_LEFT}" "${WARN}"
  fi
done

echo ""
echo "── Recommendation ───────────────────────────────────────────────"
DB_SIZE_MB=$(etcdctl_cmd endpoint status --write-out=json | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(int(d[0]['Status']['dbSize']) // 1024 // 1024)")
DB_IN_USE_MB=$(etcdctl_cmd endpoint status --write-out=json | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(int(d[0]['Status']['dbSizeInUse']) // 1024 // 1024)")
FRAG_PCT=$(( 100 * (DB_SIZE_MB - DB_IN_USE_MB) / (DB_SIZE_MB + 1) ))

if (( FRAG_PCT > 30 )); then
  echo "  → Defragmentation recommended (${FRAG_PCT}% fragmentation)"
fi

if (( DB_SIZE_MB > 6000 )); then
  echo "  → DB size is large (${DB_SIZE_MB}MB). Verify auto-compaction is enabled."
fi

echo ""
echo "Diagnostic complete."
```

---

## TLS Certificate Management

### etcd TLS Certificate Hierarchy

etcd uses a 3-certificate PKI:

```
etcd CA (ca.crt)
├── server.crt     — etcd server (serves gRPC on :2379)
├── peer.crt       — etcd peer-to-peer communication (:2380)
└── clients:
    ├── apiserver-etcd-client.crt  — kube-apiserver → etcd
    └── healthcheck-client.crt    — health checks, etcdctl
```

### Certificate Rotation (kubeadm clusters)

```bash
#!/usr/bin/env bash
# etcd-cert-rotation.sh — Rotate etcd certificates on a kubeadm cluster

set -euo pipefail

echo "=== etcd Certificate Rotation ==="

# Check current certificate expiry
echo "Current certificate expiry dates:"
kubeadm certs check-expiration | grep -i etcd

# Confirm
read -rp "Rotate etcd certificates now? [yes/NO]: " confirm
[[ "${confirm}" == "yes" ]] || exit 0

# Rotate only etcd certificates
kubeadm certs renew etcd-ca
kubeadm certs renew etcd-server
kubeadm certs renew etcd-peer
kubeadm certs renew etcd-healthcheck-client
kubeadm certs renew apiserver-etcd-client

echo "Certificates rotated. Restarting etcd and API server..."

# Kill static pods to force restart
kill "$(pgrep -f 'etcd')" 2>/dev/null || true
kill "$(pgrep -f 'kube-apiserver')" 2>/dev/null || true

# Wait for kubelet to restart static pods
sleep 30

# Verify
echo "Verifying new certificate expiry:"
kubeadm certs check-expiration | grep -i etcd

echo "Verifying etcd health:"
ETCDCTL_API=3 etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
  --key=/etc/kubernetes/pki/etcd/healthcheck-client.key \
  endpoint health

echo "Certificate rotation complete."
```

### Certificate Monitoring with cert-manager

```yaml
---
# Certificate health monitoring via Prometheus
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: etcd-cert-alerts
  namespace: monitoring
spec:
  groups:
    - name: etcd-certificates
      rules:
        - alert: EtcdCertificateExpiringSoon
          expr: |
            x509_cert_expiry{filepath=~".*/etcd/.*"} - time() < 30 * 24 * 3600
          for: 1h
          labels:
            severity: warning
          annotations:
            summary: "etcd certificate expiring in < 30 days"
            description: "Certificate {{ $labels.filepath }} expires in {{ $value | humanizeDuration }}."

        - alert: EtcdCertificateExpired
          expr: |
            x509_cert_expiry{filepath=~".*/etcd/.*"} - time() < 0
          labels:
            severity: critical
          annotations:
            summary: "etcd certificate has expired!"
            description: "Certificate {{ $labels.filepath }} expired {{ $value | humanizeDuration }} ago."
```

---

## Performance Tuning

### etcd Hardware Requirements

| Cluster Size | Control Plane | etcd Storage | etcd Memory | etcd CPU |
|---|---|---|---|---|
| Up to 100 nodes | 3 members | 50 GB NVMe | 8 GB | 4 cores |
| 100–500 nodes | 3 members | 100 GB NVMe | 16 GB | 8 cores |
| 500–1000 nodes | 5 members | 200 GB NVMe | 32 GB | 16 cores |
| 1000+ nodes | 5 members external | 400 GB NVMe RAID | 64 GB | 32 cores |

**Disk performance is the #1 bottleneck**. etcd requires fsync on every write. NVMe with low fsync latency is critical. Test with `fio`:

```bash
# Test disk fsync performance (etcd requirement: p99 < 10ms for healthy operation)
fio --rw=write --ioengine=sync --fdatasync=1 --directory=/var/lib/etcd \
  --size=22m --bs=2300 --name=etcd-fsync-test

# Interpret: fsync latency p99 > 10ms → leader elections, p99 > 100ms → cluster instability
```

### etcd Configuration Tuning

```yaml
# etcd extraArgs in kubeadm-config.yaml
etcd:
  local:
    extraArgs:
      # Heartbeat: how often leader pings followers (default 100ms)
      # Increase if network latency is high (multi-region: 500ms)
      heartbeat-interval: "250"

      # Election timeout: how long before followers start election
      # Must be >= 10x heartbeat-interval
      election-timeout: "2500"

      # Snapshot count: compact WAL after this many entries (default 10000)
      # Increase for write-heavy clusters to reduce snapshot overhead
      snapshot-count: "10000"

      # Backend quota (default 2GB, max 8GB)
      quota-backend-bytes: "8589934592"  # 8 GiB

      # Auto-compaction: keep last N revisions
      auto-compaction-retention: "100000"
      auto-compaction-mode: "revision"

      # Metrics verbosity (extensive provides more detailed histograms)
      metrics: "extensive"

      # Peer traffic with TLS (always in production)
      peer-auto-tls: "false"

      # Maximum client gRPC message size (default 1.5MB)
      # Kubernetes Secrets can be large
      max-request-bytes: "10485760"  # 10 MiB

      # Logger format
      logger: "zap"
      log-level: "warn"

      # Experimental: increase concurrent reads
      experimental-max-learners: "1"
```

### Reducing etcd Load from Kubernetes

```bash
# Audit what's generating the most etcd writes (watch for high event counts)
kubectl get --raw /metrics | grep apiserver_storage_objects | sort -t= -k2 -rn | head -20

# Find resources generating excessive watch traffic
kubectl get --raw /metrics | grep etcd_request_duration | grep 'watch' | head -20

# Check if LIST calls are paginated (un-paginated LIST = full scan)
kubectl get --raw /metrics | grep apiserver_request_total | grep '"LIST"'
```

**Common sources of excessive etcd load**:

1. **Un-paginated LIST calls**: operators calling `List` without `Limit` scan the entire keyspace
2. **Excessive Watch connections**: each `kubectl get --watch` maintains a watch stream
3. **Large Secret/ConfigMap objects**: base64-encoded content can exceed 1MB per object
4. **Frequent reconciliation**: operators with aggressive requeue intervals
5. **Status update storms**: every pod status change propagates through etcd

```go
// Good: paginated list in an operator
package main

import (
    "context"
    "fmt"

    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes"
)

func listAllPodsEfficiently(ctx context.Context, client kubernetes.Interface) ([]corev1.Pod, error) {
    var allPods []corev1.Pod
    var continueToken string

    for {
        list, err := client.CoreV1().Pods("").List(ctx, metav1.ListOptions{
            Limit:    500,           // Page size — never omit this
            Continue: continueToken,
            // Use resource version for watch-cache (avoids etcd hit)
            ResourceVersion:      "0",
            ResourceVersionMatch: metav1.ResourceVersionMatchNotOlderThan,
        })
        if err != nil {
            return nil, fmt.Errorf("listing pods: %w", err)
        }

        allPods = append(allPods, list.Items...)

        if list.Continue == "" {
            break
        }
        continueToken = list.Continue
    }

    return allPods, nil
}
```

---

## Disaster Recovery Scenarios

### Scenario 1: Single Member Failure

```bash
# A single member fails in a 3-member cluster
# Cluster is still functional (quorum = 2 of 3)

# Step 1: Remove the failed member
ETCDCTL_API=3 etcdctl member remove <MEMBER_ID> \
  --endpoints=https://surviving-member:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/peer.crt \
  --key=/etc/kubernetes/pki/etcd/peer.key

# Step 2: Clean up the failed node's data directory
ssh failed-node "rm -rf /var/lib/etcd"

# Step 3: Add the member back (before starting etcd)
ETCDCTL_API=3 etcdctl member add master-0 \
  --peer-urls=https://10.0.0.1:2380 \
  --endpoints=https://10.0.0.2:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/peer.crt \
  --key=/etc/kubernetes/pki/etcd/peer.key

# Step 4: Update the etcd manifest on the failed node to set:
# --initial-cluster-state=existing
# Then restart the static pod (kubeadm will handle cert regeneration)
kubeadm init phase etcd local --node-name=master-0
```

### Scenario 2: Complete Quorum Loss (All Members Failed)

When all etcd members fail simultaneously (e.g., datacenter power loss), you must restore from backup:

```bash
# This is exactly the multi-member restore procedure.
# The key insight: you MUST restore ALL members from the SAME snapshot.
# A subset restore with some members having newer data will fail
# because Raft will detect the term/index mismatch.

# Emergency recovery checklist:
# 1. Identify the most recent valid snapshot
# 2. Copy snapshot to ALL control-plane nodes
# 3. Stop all static pods on ALL nodes simultaneously
# 4. Restore data dir on ALL nodes from the SAME snapshot
# 5. Start etcd on ALL nodes simultaneously (they must form quorum together)
# 6. Start API server only after etcd quorum is confirmed
```

### Scenario 3: etcd in Split-Brain

Split-brain occurs when network partitions cause two subsets of members to each believe they are the majority. With proper odd-number quorum (3 or 5 members), only one side can achieve quorum. However, network partitions can cause data divergence if not handled correctly.

```bash
# Detect split-brain: look for multiple leaders
ETCDCTL_API=3 etcdctl endpoint status \
  --endpoints=https://10.0.0.1:2379,https://10.0.0.2:2379,https://10.0.0.3:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/peer.crt \
  --key=/etc/kubernetes/pki/etcd/peer.key \
  --write-out=json | python3 -c "
import json, sys
data = json.load(sys.stdin)
leaders = set()
for m in data:
    if m['Status']['leader'] == m['Status']['header']['member_id']:
        leaders.add(m['Endpoint'])
print(f'Leaders: {leaders}')
print('SPLIT BRAIN DETECTED' if len(leaders) > 1 else 'No split brain')
"

# Resolution: force the partition-minority members to rejoin
# by removing and re-adding them (same as single member failure)
```

### Scenario 4: NOSPACE Alarm

When etcd exceeds its quota, it raises an NOSPACE alarm and rejects all write operations. This is a critical incident because Kubernetes can no longer schedule pods or create resources.

```bash
#!/usr/bin/env bash
# etcd-resolve-nospace.sh — Resolve etcd NOSPACE alarm

set -euo pipefail

etcdctl_cmd() {
  ETCDCTL_API=3 etcdctl \
    --endpoints="${ETCD_ENDPOINTS:-https://127.0.0.1:2379}" \
    --cacert="${ETCD_CACERT:-/etc/kubernetes/pki/etcd/ca.crt}" \
    --cert="${ETCD_CERT:-/etc/kubernetes/pki/etcd/healthcheck-client.crt}" \
    --key="${ETCD_KEY:-/etc/kubernetes/pki/etcd/healthcheck-client.key}" \
    "$@"
}

echo "=== Resolving etcd NOSPACE Alarm ==="
echo "Current alarms:"
etcdctl_cmd alarm list

echo ""
echo "Current DB size:"
etcdctl_cmd endpoint status -w table

# Step 1: Compact to current revision
CURRENT_REVISION=$(etcdctl_cmd endpoint status --write-out=json | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['Status']['header']['revision'])")
echo ""
echo "Step 1: Compacting to revision ${CURRENT_REVISION}..."
etcdctl_cmd compact "${CURRENT_REVISION}"

# Step 2: Defrag all members
echo ""
echo "Step 2: Defragmenting all members..."
IFS=',' read -ra ENDPOINTS <<< "${ETCD_ENDPOINTS}"
for ep in "${ENDPOINTS[@]}"; do
  echo "  Defragging ${ep}..."
  ETCDCTL_API=3 etcdctl \
    --endpoints="${ep}" \
    --cacert="${ETCD_CACERT:-/etc/kubernetes/pki/etcd/ca.crt}" \
    --cert="${ETCD_CERT:-/etc/kubernetes/pki/etcd/healthcheck-client.crt}" \
    --key="${ETCD_KEY:-/etc/kubernetes/pki/etcd/healthcheck-client.key}" \
    defrag
  sleep 5
done

# Step 3: Disarm the alarm
echo ""
echo "Step 3: Disarming NOSPACE alarm..."
etcdctl_cmd alarm disarm

# Step 4: Verify
echo ""
echo "Post-recovery status:"
etcdctl_cmd endpoint status -w table
etcdctl_cmd alarm list

echo ""
echo "NOSPACE alarm resolved. Monitor etcd DB size and review:"
echo "  - quota-backend-bytes setting (consider increasing)"
echo "  - auto-compaction settings"
echo "  - Object count (look for leaked resources)"
```

---

## Scheduled Maintenance Runbook

Here is a complete weekly maintenance checklist for etcd in production:

```bash
#!/usr/bin/env bash
# etcd-weekly-maintenance.sh — Weekly etcd maintenance routine

set -euo pipefail

MAINTENANCE_WINDOW="${MAINTENANCE_WINDOW:-Sunday 02:00-04:00 UTC}"
echo "=== etcd Weekly Maintenance ==="
echo "Window: ${MAINTENANCE_WINDOW}"
echo "Date:   $(date -u)"
echo ""

etcdctl_cmd() {
  ETCDCTL_API=3 etcdctl \
    --endpoints="${ETCD_ENDPOINTS:-https://127.0.0.1:2379}" \
    --cacert="${ETCD_CACERT:-/etc/kubernetes/pki/etcd/ca.crt}" \
    --cert="${ETCD_CERT:-/etc/kubernetes/pki/etcd/healthcheck-client.crt}" \
    --key="${ETCD_KEY:-/etc/kubernetes/pki/etcd/healthcheck-client.key}" \
    "$@"
}

# 1. Pre-maintenance health check
echo "[1/6] Pre-maintenance health check..."
etcdctl_cmd endpoint health -w table
etcdctl_cmd alarm list

# 2. Backup before any operations
echo ""
echo "[2/6] Taking pre-maintenance backup..."
/usr/local/bin/etcd-backup-production.sh

# 3. Verify recent auto-compaction
echo ""
echo "[3/6] Checking compaction status..."
STATUS=$(etcdctl_cmd endpoint status --write-out=json)
REVISION=$(echo "${STATUS}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['Status']['header']['revision'])")
DB_SIZE_MB=$(echo "${STATUS}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(int(d[0]['Status']['dbSize'])//1024//1024)")
echo "  Current revision: ${REVISION}"
echo "  DB size: ${DB_SIZE_MB}MB"

# Manual compaction for good measure
KEEP=100000
TARGET=$(( REVISION - KEEP ))
if (( TARGET > 0 )); then
  echo "  Compacting to revision ${TARGET}..."
  etcdctl_cmd compact "${TARGET}"
fi

# 4. Rolling defragmentation
echo ""
echo "[4/6] Running rolling defragmentation..."
/usr/local/bin/etcd-defrag-rolling.sh

# 5. Certificate expiry check
echo ""
echo "[5/6] Certificate expiry check..."
for cert in \
  /etc/kubernetes/pki/etcd/ca.crt \
  /etc/kubernetes/pki/etcd/peer.crt \
  /etc/kubernetes/pki/etcd/server.crt \
  /etc/kubernetes/pki/etcd/healthcheck-client.crt; do
  EXPIRY=$(openssl x509 -noout -enddate -in "${cert}" | cut -d= -f2)
  DAYS=$(( ( $(date -d "${EXPIRY}" +%s) - $(date +%s) ) / 86400 ))
  echo "  $(basename ${cert}): ${DAYS} days remaining"
  if (( DAYS < 60 )); then
    echo "  WARNING: Certificate expires in < 60 days — schedule rotation!"
  fi
done

# 6. Post-maintenance verification
echo ""
echo "[6/6] Post-maintenance verification..."
etcdctl_cmd endpoint health -w table
etcdctl_cmd endpoint status -w table
etcdctl_cmd alarm list

echo ""
echo "=== Weekly Maintenance Complete ==="
```

---

## Summary

etcd operational excellence for Kubernetes requires covering every dimension of the lifecycle:

**Backup**: Take encrypted, verified snapshots every 4 hours at minimum. Store in S3 with multi-region replication. Test restores regularly — a backup you have never restored is a backup you cannot trust.

**Restore**: The multi-member restore is an all-or-nothing operation. All members must restore from the identical snapshot simultaneously. The API server must be stopped before and started only after etcd quorum reforms.

**Compaction**: Enable `auto-compaction-mode=revision` with a retention of 100,000 revisions. This provides predictable behavior regardless of write rate. Monitor `etcd_mvcc_db_total_size_in_bytes` vs `etcd_server_quota_backend_bytes`.

**Defragmentation**: Run weekly, rolling, during maintenance windows. Defrag followers before the leader. Always check disk space first (you need ~2x DB size free).

**Monitoring**: Alert on leader changes, DB quota utilization, disk commit latency, and backup freshness. The most important single metric is `etcd_disk_wal_fsync_duration_seconds` — if WAL fsyncs are slow, cluster stability will degrade.

**Hardware**: Disk performance is the primary determinant of etcd stability. NVMe with sub-millisecond fsync latency is worth the investment at any scale.

The scripts and configurations in this guide form a complete operational foundation. Automate the backup CronJob immediately; schedule the weekly maintenance runbook; deploy the Prometheus alerting rules before you need them.
