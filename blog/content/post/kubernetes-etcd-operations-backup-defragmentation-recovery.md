---
title: "Kubernetes EtcD Operations: Backup, Defragmentation, and Recovery"
date: 2029-05-05T00:00:00-05:00
draft: false
tags: ["Kubernetes", "etcd", "Backup", "Disaster Recovery", "Operations", "etcdctl"]
categories:
- Kubernetes
- Operations
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes etcd operations: the etcd data model, snapshot backup procedures, defragmentation scheduling, compaction, disaster recovery workflows, multi-member cluster operations, and etcdctl usage."
more_link: "yes"
url: "/kubernetes-etcd-operations-backup-defragmentation-recovery/"
---

etcd is the single source of truth for every Kubernetes cluster. Every API object — every Pod, Deployment, ConfigMap, Secret, and RBAC rule — lives in etcd. When etcd fails or becomes corrupted, the cluster stops functioning. When etcd runs out of space or becomes fragmented, API calls slow down or fail entirely. Mastering etcd operations — backup, defragmentation, compaction, and multi-member recovery — is a non-negotiable skill for any team running Kubernetes in production.

<!--more-->

# Kubernetes EtcD Operations: Backup, Defragmentation, and Recovery

## The etcd Data Model

etcd is a strongly-consistent, distributed key-value store based on the Raft consensus algorithm. Understanding its data model helps explain why certain operational patterns are necessary.

### MVCC: Multi-Version Concurrency Control

etcd uses MVCC to provide serializable snapshot isolation. Every write creates a new revision of the key, rather than overwriting the old value:

```
Revision 1: /registry/pods/default/my-pod = <pod spec v1>
Revision 2: /registry/pods/default/my-pod = <pod spec v2>  (update)
Revision 3: /registry/pods/default/my-pod = <deleted>
```

Both revision 1 and 2 are retained in the BoltDB database until compaction removes old revisions. This is why etcd databases grow over time even without adding new objects.

### Revision vs Version

- **Revision**: A cluster-wide monotonically increasing integer. Each write increments the revision.
- **Version**: A per-key counter. Starts at 1 when the key is created, increments on each write.
- **ModRevision**: The cluster revision at the time of the last write to this key.
- **CreateRevision**: The cluster revision when the key was first created.

```bash
etcdctl get /registry/pods/default/my-pod -w json | jq '.kvs[0] | {
  key: (.key | @base64d),
  create_revision: .create_revision,
  mod_revision: .mod_revision,
  version: .version
}'
```

### BoltDB Storage

etcd stores data in BoltDB, an embedded B-tree key-value store. The database file is at `${ETCD_DATA_DIR}/member/snap/db`.

```bash
# Check etcd data directory
ls -lh /var/lib/etcd/member/
# snap/
#   db          (BoltDB database file)
# wal/          (Write-ahead log files)

# Check database file size
du -sh /var/lib/etcd/member/snap/db
```

The BoltDB file has two size metrics that matter:
- **Physical size**: Actual bytes on disk
- **Allocated size**: Pages allocated in the B-tree, including freed pages not yet reclaimed

After deletes and compaction, allocated pages are released back to BoltDB's free list but not returned to the OS. Defragmentation rebuilds the database from scratch, returning free space to the OS.

## etcdctl Setup

```bash
# Set environment variables for etcdctl
export ETCDCTL_API=3
export ETCDCTL_ENDPOINTS=https://127.0.0.1:2379
export ETCDCTL_CACERT=/etc/kubernetes/pki/etcd/ca.crt
export ETCDCTL_CERT=/etc/kubernetes/pki/etcd/healthcheck-client.crt
export ETCDCTL_KEY=/etc/kubernetes/pki/etcd/healthcheck-client.key

# For kubeadm clusters, the certs are in:
# /etc/kubernetes/pki/etcd/ca.crt
# /etc/kubernetes/pki/etcd/peer.crt  (or server.crt)
# /etc/kubernetes/pki/etcd/peer.key  (or server.key)

# Verify connectivity
etcdctl endpoint health
# https://127.0.0.1:2379 is healthy: successfully committed proposal: took = 2.1ms

# Check cluster status
etcdctl endpoint status -w table
# +------------------------+------------------+---------+---------+-----------+------------+
# |        ENDPOINT        |        ID        | VERSION | DB SIZE | IS LEADER | IS LEARNER |
# +------------------------+------------------+---------+---------+-----------+------------+
# | https://127.0.0.1:2379 | 8e9e05c52164694d |  3.5.9  |   42 MB |      true |      false |
# +------------------------+------------------+---------+---------+-----------+------------+
```

## Snapshot Backup

### Manual Snapshot

```bash
# Take a snapshot (must run on a healthy member)
BACKUP_FILE="/backup/etcd-snapshot-$(date +%Y%m%d-%H%M%S).db"
etcdctl snapshot save "$BACKUP_FILE"
# {"level":"info","ts":"2024-01-15T10:23:45.123Z","msg":"saving snapshot","path":"/backup/etcd-snapshot-20240115-102345.db"}
# Snapshot saved at /backup/etcd-snapshot-20240115-102345.db

# Verify snapshot integrity
etcdctl snapshot status "$BACKUP_FILE" -w table
# +----------+----------+------------+------------+
# |   HASH   | REVISION | TOTAL KEYS | TOTAL SIZE |
# +----------+----------+------------+------------+
# | 6afa1943 |   243821 |       4821 |    42 MB   |
# +----------+----------+------------+------------+
```

### Automated Backup Script

```bash
#!/bin/bash
# /usr/local/bin/etcd-backup.sh
# Run via cron or systemd timer

set -euo pipefail

BACKUP_DIR="/backup/etcd"
RETENTION_DAYS=7
ETCD_DATA_DIR="/var/lib/etcd"
LOG_FILE="/var/log/etcd-backup.log"

# Environment for etcdctl
export ETCDCTL_API=3
export ETCDCTL_ENDPOINTS="https://127.0.0.1:2379"
export ETCDCTL_CACERT="/etc/kubernetes/pki/etcd/ca.crt"
export ETCDCTL_CERT="/etc/kubernetes/pki/etcd/healthcheck-client.crt"
export ETCDCTL_KEY="/etc/kubernetes/pki/etcd/healthcheck-client.key"

log() {
    echo "$(date -Iseconds) $*" | tee -a "$LOG_FILE"
}

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Check etcd health before backup
if ! etcdctl endpoint health &>/dev/null; then
    log "ERROR: etcd is not healthy, skipping backup"
    exit 1
fi

# Take snapshot
SNAPSHOT_FILE="$BACKUP_DIR/snapshot-$(date +%Y%m%d-%H%M%S).db"
log "Taking snapshot: $SNAPSHOT_FILE"
etcdctl snapshot save "$SNAPSHOT_FILE" >> "$LOG_FILE" 2>&1

# Verify snapshot
HASH=$(etcdctl snapshot status "$SNAPSHOT_FILE" -w json | jq -r '.hash')
SIZE=$(stat -c%s "$SNAPSHOT_FILE")
log "Snapshot saved: hash=$HASH size=${SIZE}B"

# Compress
gzip "$SNAPSHOT_FILE"
log "Compressed: ${SNAPSHOT_FILE}.gz"

# Upload to S3 (optional)
if command -v aws &>/dev/null; then
    aws s3 cp "${SNAPSHOT_FILE}.gz" \
      "s3://my-cluster-backups/etcd/$(basename ${SNAPSHOT_FILE}.gz)" \
      --sse aws:kms
    log "Uploaded to S3"
fi

# Prune old local backups
find "$BACKUP_DIR" -name "snapshot-*.db.gz" -mtime +"$RETENTION_DAYS" -delete
REMAINING=$(find "$BACKUP_DIR" -name "snapshot-*.db.gz" | wc -l)
log "Pruned old backups. Remaining: $REMAINING"
```

```bash
# systemd timer for every 6 hours
cat > /etc/systemd/system/etcd-backup.service << 'EOF'
[Unit]
Description=etcd backup
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/etcd-backup.sh
User=root
EOF

cat > /etc/systemd/system/etcd-backup.timer << 'EOF'
[Unit]
Description=Run etcd backup every 6 hours

[Timer]
OnBootSec=15min
OnUnitActiveSec=6h
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl enable --now etcd-backup.timer
systemctl list-timers etcd-backup.timer
```

### Kubernetes CronJob Backup

For clusters where node-level cron is not appropriate:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: etcd-backup-script
  namespace: kube-system
data:
  backup.sh: |
    #!/bin/sh
    set -e
    ETCDCTL_API=3 etcdctl snapshot save /backup/etcd-$(date +%Y%m%d-%H%M%S).db \
      --endpoints=https://127.0.0.1:2379 \
      --cacert=/etc/kubernetes/pki/etcd/ca.crt \
      --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
      --key=/etc/kubernetes/pki/etcd/healthcheck-client.key
    ls -lh /backup/etcd-*.db | tail -5

---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: etcd-backup
  namespace: kube-system
spec:
  schedule: "0 */6 * * *"
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 1
  jobTemplate:
    spec:
      template:
        spec:
          hostNetwork: true
          nodeName: control-plane-node-1    # Must run on control plane
          tolerations:
          - key: node-role.kubernetes.io/control-plane
            operator: Exists
            effect: NoSchedule
          containers:
          - name: backup
            image: registry.k8s.io/etcd:3.5.9-0
            command: ["/bin/sh", "/scripts/backup.sh"]
            volumeMounts:
            - name: script
              mountPath: /scripts
            - name: etcd-certs
              mountPath: /etc/kubernetes/pki/etcd
              readOnly: true
            - name: backup
              mountPath: /backup
          volumes:
          - name: script
            configMap:
              name: etcd-backup-script
              defaultMode: 0755
          - name: etcd-certs
            hostPath:
              path: /etc/kubernetes/pki/etcd
          - name: backup
            hostPath:
              path: /backup/etcd
          restartPolicy: OnFailure
```

## Compaction

Compaction removes old MVCC revisions, freeing space in BoltDB's free list (but not returning it to the OS — that requires defragmentation).

### Manual Compaction

```bash
# Get current revision
REV=$(etcdctl endpoint status -w json | jq -r '.[0].Status.header.revision')
echo "Current revision: $REV"

# Compact to current revision (removes all history)
etcdctl compact $REV
# compacted revision 243821

# Note: after compaction, clients with watchers at older revisions will get errors
# This is normal and expected
```

### Auto-Compaction

Configure in etcd to compact automatically:

```yaml
# etcd.yaml (or systemd unit flags)
# Compact every 8 hours
auto-compaction-mode: periodic
auto-compaction-retention: "8h"

# Or compact when revision increases by 10000
auto-compaction-mode: revision
auto-compaction-retention: "10000"
```

For Kubernetes, auto-compaction is configured in the etcd pod manifest:

```yaml
# /etc/kubernetes/manifests/etcd.yaml
spec:
  containers:
  - command:
    - etcd
    - --auto-compaction-mode=periodic
    - --auto-compaction-retention=8h
    - --quota-backend-bytes=8589934592   # 8 GB quota
    # ...
```

### Compaction in kubeadm Clusters

kubeadm enables auto-compaction by default in newer versions. Verify:

```bash
grep -E "auto-compaction" /etc/kubernetes/manifests/etcd.yaml
```

## Defragmentation

Defragmentation rebuilds the BoltDB database from scratch, reclaiming fragmented free space. It blocks all reads and writes during execution.

### When to Defragment

```bash
# Check if defragmentation is needed
etcdctl endpoint status -w json | jq '.[].Status | {
  db_size: .dbSize,
  db_size_in_use: .dbSizeInUse
}'
# {
#   "db_size": 524288000,        (500 MB physical)
#   "db_size_in_use": 104857600  (100 MB actually used)
# }
# Fragmentation ratio: (500-100)/500 = 80% fragmented — defrag needed!
```

Rule of thumb: defragment when `db_size > 2 * db_size_in_use`.

### Defragmentation Procedure

**Critical: defragment one member at a time to avoid cluster downtime.**

```bash
# Step 1: Identify leader
etcdctl endpoint status -w table | grep "true"

# Step 2: Defragment followers first
# Replace the endpoint with each follower's address
for ENDPOINT in \
    https://etcd-1:2379 \
    https://etcd-2:2379 \
    https://etcd-3:2379; do

  echo "Defragmenting $ENDPOINT"

  # Check if it's the leader
  IS_LEADER=$(etcdctl endpoint status \
    --endpoints="$ENDPOINT" -w json | \
    jq -r '.[0].Status.leader == .[0].Status.header.member_id')

  if [ "$IS_LEADER" = "true" ]; then
    echo "Skipping leader $ENDPOINT (will defrag last)"
    continue
  fi

  # Defragment this follower
  START=$(date +%s)
  etcdctl defrag --endpoints="$ENDPOINT"
  DURATION=$(($(date +%s) - START))
  echo "Defrag of $ENDPOINT completed in ${DURATION}s"

  # Wait for member to rejoin cluster
  sleep 5
  etcdctl endpoint health --endpoints="$ENDPOINT"
done

# Step 3: Defragment the leader last
# (triggers a leader election during defrag)
LEADER_ENDPOINT=$(etcdctl endpoint status -w json | \
  jq -r '.[] | select(.Status.leader == .Status.header.member_id) | .Endpoint')
echo "Defragmenting leader: $LEADER_ENDPOINT"
etcdctl defrag --endpoints="$LEADER_ENDPOINT"

# Step 4: Verify cluster health
etcdctl endpoint health -w table
etcdctl endpoint status -w table
```

### Automated Defragmentation Script

```bash
#!/bin/bash
# /usr/local/bin/etcd-defrag.sh
# Run weekly when fragmentation exceeds threshold

set -euo pipefail

export ETCDCTL_API=3
export ETCDCTL_CACERT="/etc/kubernetes/pki/etcd/ca.crt"
export ETCDCTL_CERT="/etc/kubernetes/pki/etcd/healthcheck-client.crt"
export ETCDCTL_KEY="/etc/kubernetes/pki/etcd/healthcheck-client.key"

FRAGMENTATION_THRESHOLD=0.5    # Defrag if > 50% fragmented
MIN_SIZE_BYTES=104857600        # Only defrag if DB > 100MB

log() { echo "$(date -Iseconds) [etcd-defrag] $*"; }

# Get all endpoints
ENDPOINTS=$(etcdctl \
  --endpoints="https://127.0.0.1:2379" \
  member list -w json | \
  jq -r '.members[].clientURLs[]' | \
  paste -sd,)

log "Cluster endpoints: $ENDPOINTS"

# Check each member
etcdctl endpoint status \
  --endpoints="$ENDPOINTS" -w json | \
jq -r '.[] | [.Endpoint, .Status.dbSize, .Status.dbSizeInUse,
  (.Status.leader == .Status.header.member_id | tostring)] | @tsv' | \
while IFS=$'\t' read -r endpoint db_size db_in_use is_leader; do

  fragmentation=$(awk "BEGIN {printf \"%.2f\", ($db_size - $db_in_use) / $db_size}")
  log "Member $endpoint: size=${db_size}B in_use=${db_in_use}B fragmentation=${fragmentation} leader=${is_leader}"

  if (( $(echo "$fragmentation > $FRAGMENTATION_THRESHOLD" | bc -l) )) && \
     (( db_size > MIN_SIZE_BYTES )); then

    if [ "$is_leader" = "true" ]; then
      log "Skipping leader $endpoint (will process last)"
      echo "$endpoint" >> /tmp/etcd-leader-endpoint
      continue
    fi

    log "Defragmenting follower $endpoint (fragmentation: ${fragmentation})"
    etcdctl defrag --endpoints="$endpoint"
    sleep 5
    etcdctl endpoint health --endpoints="$endpoint"
  fi
done

# Defrag leader if needed
if [ -f /tmp/etcd-leader-endpoint ]; then
  LEADER=$(cat /tmp/etcd-leader-endpoint)
  rm /tmp/etcd-leader-endpoint
  log "Defragmenting leader $LEADER"
  etcdctl defrag --endpoints="$LEADER"
  sleep 10
fi

log "Defragmentation complete"
etcdctl endpoint status --endpoints="$ENDPOINTS" -w table
```

## etcd Quota Management

When etcd exceeds its quota (`--quota-backend-bytes`), it enters a read-only alarm state:

```bash
# Check for alarms
etcdctl alarm list
# memberID:8e9e05c52164694d alarm:NOSPACE

# Emergency: disarm alarm after compaction + defrag
etcdctl alarm disarm

# The NOSPACE alarm occurs when db_size > quota
# Default quota is 2GB. Kubernetes recommends 8GB.
```

### Setting the Quota

```yaml
# /etc/kubernetes/manifests/etcd.yaml
- --quota-backend-bytes=8589934592   # 8 GB
```

Monitor quota usage:

```bash
# Alert when usage exceeds 80% of quota
QUOTA=$(grep quota-backend-bytes /etc/kubernetes/manifests/etcd.yaml | \
  grep -o '[0-9]*')
DB_SIZE=$(etcdctl endpoint status -w json | jq '.[0].Status.dbSize')
USAGE_PCT=$(awk "BEGIN {printf \"%.0f\", ($DB_SIZE / $QUOTA) * 100}")
echo "etcd quota usage: ${USAGE_PCT}%"
```

## Disaster Recovery: Single-Member Restore

### Restore Procedure

```bash
# Step 1: Stop the API server and controller manager to prevent writes
systemctl stop kube-apiserver kube-controller-manager kube-scheduler 2>/dev/null || true

# For kubeadm: move static pod manifests to prevent kubelet from starting them
mkdir -p /tmp/k8s-backup
mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/k8s-backup/
mv /etc/kubernetes/manifests/kube-controller-manager.yaml /tmp/k8s-backup/
mv /etc/kubernetes/manifests/kube-scheduler.yaml /tmp/k8s-backup/

# Wait for API server to stop
sleep 10

# Step 2: Stop etcd
mv /etc/kubernetes/manifests/etcd.yaml /tmp/k8s-backup/
sleep 5

# Step 3: Backup current data directory (in case restore fails)
mv /var/lib/etcd /var/lib/etcd.bak.$(date +%Y%m%d-%H%M%S)

# Step 4: Restore from snapshot
SNAPSHOT="/backup/etcd-snapshot-20240115-102345.db"
MEMBER_NAME="etcd-master-1"
INITIAL_CLUSTER="etcd-master-1=https://192.168.1.10:2380"
INITIAL_CLUSTER_TOKEN="etcd-cluster-1"
ADVERTISE_URL="https://192.168.1.10:2379"
INITIAL_ADVERTISE_PEER_URL="https://192.168.1.10:2380"

ETCDCTL_API=3 etcdctl snapshot restore "$SNAPSHOT" \
  --name="$MEMBER_NAME" \
  --initial-cluster="$INITIAL_CLUSTER" \
  --initial-cluster-token="$INITIAL_CLUSTER_TOKEN" \
  --initial-advertise-peer-urls="$INITIAL_ADVERTISE_PEER_URL" \
  --data-dir=/var/lib/etcd \
  --skip-hash-check=false

# Step 5: Fix permissions
chown -R etcd:etcd /var/lib/etcd 2>/dev/null || chown -R root:root /var/lib/etcd

# Step 6: Restore etcd manifest
mv /tmp/k8s-backup/etcd.yaml /etc/kubernetes/manifests/

# Step 7: Wait for etcd to start
sleep 15
ETCDCTL_API=3 etcdctl endpoint health \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
  --key=/etc/kubernetes/pki/etcd/healthcheck-client.key

# Step 8: Restore API server and other control plane components
mv /tmp/k8s-backup/kube-apiserver.yaml /etc/kubernetes/manifests/
mv /tmp/k8s-backup/kube-controller-manager.yaml /etc/kubernetes/manifests/
mv /tmp/k8s-backup/kube-scheduler.yaml /etc/kubernetes/manifests/

echo "Restore complete. Verify cluster health."
kubectl get nodes
kubectl get pods -A
```

## Multi-Member Cluster Operations

### Adding a New Member

```bash
# Step 1: Add member to the cluster
etcdctl member add etcd-new-member \
  --peer-urls=https://192.168.1.14:2380

# Output includes cluster state for new member:
# ETCD_NAME="etcd-new-member"
# ETCD_INITIAL_CLUSTER="etcd-1=https://192.168.1.10:2380,etcd-2=https://192.168.1.11:2380,etcd-3=https://192.168.1.12:2380,etcd-new-member=https://192.168.1.14:2380"
# ETCD_INITIAL_CLUSTER_STATE="existing"

# Step 2: Configure new member with these values and start etcd
# Important: ETCD_INITIAL_CLUSTER_STATE must be "existing", not "new"
```

### Removing a Failed Member

```bash
# List members to get the ID of the failed member
etcdctl member list -w table
# +------------------+-------+------------------+-----------------------------+----------------------------+------------+
# |        ID        | STATUS|       NAME       |         PEER ADDRS          |        CLIENT ADDRS        | IS LEARNER |
# +------------------+-------+------------------+-----------------------------+----------------------------+------------+
# | 8e9e05c52164694d | started | etcd-1          | https://192.168.1.10:2380   | https://192.168.1.10:2379  |      false |
# | a8266ecf031671f3 | started | etcd-2          | https://192.168.1.11:2380   | https://192.168.1.11:2379  |      false |
# | ade526d28b1f92f3 | unreachable | etcd-3      | https://192.168.1.12:2380   | https://192.168.1.12:2379  |      false |

# Remove the failed member
etcdctl member remove ade526d28b1f92f3

# Verify quorum is maintained (2/3 members still running)
etcdctl endpoint health
```

### Three-Member Cluster Recovery

If two of three members fail (loss of quorum):

```bash
# On the surviving member, force new cluster from current state
# WARNING: This discards any writes that were not replicated to the survivor

# Step 1: Stop etcd on the survivor
systemctl stop etcd

# Step 2: Force new cluster (survivor becomes sole member)
# This is destructive — only do this after other members are confirmed lost
etcd --force-new-cluster \
  --data-dir=/var/lib/etcd \
  --name=etcd-1 \
  --listen-peer-urls=https://192.168.1.10:2380 \
  --listen-client-urls=https://192.168.1.10:2379,https://127.0.0.1:2379 \
  &

sleep 10

# Step 3: Verify single-member cluster
etcdctl endpoint health
etcdctl member list

# Step 4: Add new members to restore quorum
etcdctl member add etcd-2 --peer-urls=https://192.168.1.11:2380
```

## Monitoring etcd

### Prometheus Metrics

etcd exposes rich Prometheus metrics:

```yaml
# prometheus/rules/etcd.yaml
groups:
- name: etcd
  rules:
  - alert: EtcdInsufficientMembers
    expr: count(etcd_server_id) % 2 == 0
    for: 3m
    labels:
      severity: critical
    annotations:
      summary: "etcd cluster has even number of members (split-brain risk)"

  - alert: EtcdNoLeader
    expr: etcd_server_has_leader == 0
    for: 1m
    labels:
      severity: critical
    annotations:
      summary: "etcd member has no leader"

  - alert: EtcdHighNumberOfLeaderChanges
    expr: increase(etcd_server_leader_changes_seen_total[1h]) > 3
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "etcd has high number of leader changes"

  - alert: EtcdDatabaseSizeHigh
    expr: etcd_mvcc_db_total_size_in_bytes / etcd_server_quota_backend_bytes > 0.80
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "etcd database size is above 80% of quota"
      description: "etcd database is {{ $value | humanizePercentage }} of quota"

  - alert: EtcdHighFsyncDuration
    expr: histogram_quantile(0.99, rate(etcd_disk_wal_fsync_duration_seconds_bucket[5m])) > 0.5
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "etcd WAL fsync latency is high (p99 > 500ms)"

  - alert: EtcdHighCommitDuration
    expr: histogram_quantile(0.99, rate(etcd_disk_backend_commit_duration_seconds_bucket[5m])) > 0.25
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "etcd backend commit latency is high (p99 > 250ms)"
```

### Key Metrics to Watch

```bash
# Real-time metrics via etcdctl
etcdctl check perf --load="s"
# Starting 3 client(s) ...
# Total write: 15013 keys, each with value size of 1 bytes, speed: 5002/s
# Slowest request latency: 6.6ms
# Fastest request latency: 0.2ms
# p10: 0.5ms, p25: 0.7ms, p50: 1.0ms, p75: 1.5ms, p90: 2.1ms, p99: 4.5ms, p99.9: 6.0ms
```

```bash
# Watch etcd metrics directly
curl -s https://127.0.0.1:2379/metrics \
  --cacert /etc/kubernetes/pki/etcd/ca.crt \
  --cert /etc/kubernetes/pki/etcd/healthcheck-client.crt \
  --key /etc/kubernetes/pki/etcd/healthcheck-client.key | \
  grep -E "^(etcd_mvcc_db_total_size|etcd_server_has_leader|etcd_server_leader_changes)"
```

etcd is the foundation of cluster reliability. Treat it accordingly: back up every 4-6 hours, monitor fragmentation weekly, keep the database size below 80% of quota, and practice the restore procedure in a non-production environment at least quarterly.
