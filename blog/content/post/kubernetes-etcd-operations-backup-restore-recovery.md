---
title: "Kubernetes ETCD Operations: Backup, Restore, Defragmentation, and Cluster Recovery"
date: 2030-06-22T00:00:00-05:00
draft: false
tags: ["Kubernetes", "etcd", "Backup", "Disaster Recovery", "Operations", "SRE"]
categories:
- Kubernetes
- Operations
author: "Matthew Mattox - mmattox@support.tools"
description: "Production etcd management: automated backup strategies, point-in-time restore procedures, defragmentation scheduling, cluster health monitoring, and disaster recovery procedures for Kubernetes clusters."
more_link: "yes"
url: "/kubernetes-etcd-operations-backup-restore-defragmentation-recovery/"
---

etcd is the Kubernetes control plane's single source of truth: every cluster configuration, workload definition, RBAC policy, and service account lives in etcd. A healthy etcd cluster is the prerequisite for everything Kubernetes does. Yet etcd operations — backup, restoration, defragmentation, and membership management — are often neglected until a crisis forces a panicked recovery attempt. This guide covers production-grade etcd management: automated backup pipelines, tested restoration procedures, maintenance scheduling, health monitoring, and step-by-step disaster recovery for both etcd member failures and full cluster loss.

<!--more-->

## etcd Architecture in Kubernetes

A production Kubernetes control plane runs three or five etcd members (odd numbers for Raft quorum). etcd uses the Raft consensus algorithm:

- **Leader**: handles all writes and forwards to followers
- **Followers**: replicate log entries from leader, serve reads
- **Quorum**: (N/2)+1 members must be healthy for the cluster to operate
  - 3-node cluster: requires 2 members (tolerates 1 failure)
  - 5-node cluster: requires 3 members (tolerates 2 failures)

```bash
# Check cluster membership
ETCDCTL_API=3 etcdctl member list \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
  --key=/etc/kubernetes/pki/etcd/healthcheck-client.key \
  --write-out=table

# Output:
# +------------------+---------+----------+--------------------------+---------------------------+------------+
# |        ID        | STATUS  |   NAME   |        PEER ADDRS        |       CLIENT ADDRS        | IS LEARNER |
# +------------------+---------+----------+--------------------------+---------------------------+------------+
# | 1a3f2c4b5d6e7f8a | started | master-1 | https://10.0.0.1:2380   | https://10.0.0.1:2379    |      false |
# | 2b4d6e8f1a2c3d4e | started | master-2 | https://10.0.0.2:2380   | https://10.0.0.2:2379    |      false |
# | 3c5e7f9a1b2d3e4f | started | master-3 | https://10.0.0.3:2380   | https://10.0.0.3:2379    |      false |
# +------------------+---------+----------+--------------------------+---------------------------+------------+
```

## Environment Setup

All etcd operations require TLS credentials. Create a helper script to avoid repeating connection parameters:

```bash
# /usr/local/bin/etcdctl-cluster
#!/bin/bash
# Wrapper for etcdctl with cluster credentials

ETCD_ENDPOINTS="${ETCD_ENDPOINTS:-https://10.0.0.1:2379,https://10.0.0.2:2379,https://10.0.0.3:2379}"
ETCD_CA="${ETCD_CA:-/etc/kubernetes/pki/etcd/ca.crt}"
ETCD_CERT="${ETCD_CERT:-/etc/kubernetes/pki/etcd/healthcheck-client.crt}"
ETCD_KEY="${ETCD_KEY:-/etc/kubernetes/pki/etcd/healthcheck-client.key}"

ETCDCTL_API=3 etcdctl \
  --endpoints="${ETCD_ENDPOINTS}" \
  --cacert="${ETCD_CA}" \
  --cert="${ETCD_CERT}" \
  --key="${ETCD_KEY}" \
  "$@"
```

```bash
chmod +x /usr/local/bin/etcdctl-cluster

# Verify connectivity
etcdctl-cluster endpoint health
# Output:
# https://10.0.0.1:2379 is healthy: successfully committed proposal: took = 1.2ms
# https://10.0.0.2:2379 is healthy: successfully committed proposal: took = 1.5ms
# https://10.0.0.3:2379 is healthy: successfully committed proposal: took = 1.8ms
```

## Backup Strategy

### Manual Snapshot

An etcd snapshot is a point-in-time copy of the keyspace. Snapshots are taken from a single member (recommended: the leader for consistency):

```bash
#!/bin/bash
# /usr/local/bin/etcd-backup.sh
# Creates a timestamped etcd snapshot and uploads to S3

set -euo pipefail

BACKUP_DIR="${ETCD_BACKUP_DIR:-/var/backups/etcd}"
S3_BUCKET="${ETCD_S3_BUCKET:-s3://my-cluster-etcd-backups}"
CLUSTER_NAME="${CLUSTER_NAME:-production-cluster}"
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
SNAPSHOT_FILE="${BACKUP_DIR}/${CLUSTER_NAME}-${TIMESTAMP}.db"
LOG_FILE="/var/log/etcd-backup.log"

log() {
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [etcd-backup] $*" | tee -a "${LOG_FILE}"
}

mkdir -p "${BACKUP_DIR}"

log "Starting etcd backup: ${SNAPSHOT_FILE}"

# Create snapshot
ETCDCTL_API=3 etcdctl snapshot save "${SNAPSHOT_FILE}" \
  --endpoints="${ETCD_ENDPOINTS:-https://127.0.0.1:2379}" \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
  --key=/etc/kubernetes/pki/etcd/healthcheck-client.key

# Verify snapshot integrity
VERIFY_OUTPUT=$(ETCDCTL_API=3 etcdctl snapshot status "${SNAPSHOT_FILE}" \
  --write-out=json 2>&1)

REVISION=$(echo "${VERIFY_OUTPUT}" | jq -r '.revision')
TOTAL_SIZE=$(echo "${VERIFY_OUTPUT}" | jq -r '.totalSize')
HASH=$(echo "${VERIFY_OUTPUT}" | jq -r '.hash')

log "Snapshot verified: revision=${REVISION} size=${TOTAL_SIZE} hash=${HASH}"

# Compress snapshot
gzip -f "${SNAPSHOT_FILE}"
COMPRESSED_FILE="${SNAPSHOT_FILE}.gz"
COMPRESSED_SIZE=$(stat -f%z "${COMPRESSED_FILE}" 2>/dev/null || stat -c%s "${COMPRESSED_FILE}")

log "Compressed: ${COMPRESSED_FILE} (${COMPRESSED_SIZE} bytes)"

# Upload to S3
aws s3 cp "${COMPRESSED_FILE}" \
  "${S3_BUCKET}/${CLUSTER_NAME}/${TIMESTAMP}.db.gz" \
  --sse aws:kms \
  --sse-kms-key-id "<kms-key-id>" \
  --metadata "cluster=${CLUSTER_NAME},revision=${REVISION},hash=${HASH}"

log "Uploaded to ${S3_BUCKET}/${CLUSTER_NAME}/${TIMESTAMP}.db.gz"

# Clean up local files older than 7 days
find "${BACKUP_DIR}" -name "*.db.gz" -mtime +7 -delete
log "Local cleanup completed"

# Track backup success in Prometheus pushgateway (optional)
if command -v curl &>/dev/null && [ -n "${PUSHGATEWAY_URL:-}" ]; then
  echo "etcd_backup_success_timestamp $(date +%s)" | \
    curl -s --data-binary @- \
    "${PUSHGATEWAY_URL}/metrics/job/etcd-backup/instance/${HOSTNAME}"
fi

log "Backup completed successfully"
```

### Automated Backup with Kubernetes CronJob

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
subjects:
  - kind: ServiceAccount
    name: etcd-backup
    namespace: kube-system
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: etcd-backup

---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: etcd-backup
  namespace: kube-system
spec:
  # Every 6 hours
  schedule: "0 */6 * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: etcd-backup
          hostNetwork: true
          hostPID: true
          restartPolicy: OnFailure

          # Run on master nodes only
          nodeSelector:
            node-role.kubernetes.io/control-plane: ""

          tolerations:
            - key: node-role.kubernetes.io/control-plane
              effect: NoSchedule

          containers:
            - name: etcd-backup
              image: bitnami/etcd:3.5.12
              command:
                - /bin/bash
                - /scripts/backup.sh
              env:
                - name: ETCD_ENDPOINTS
                  value: "https://127.0.0.1:2379"
                - name: ETCD_S3_BUCKET
                  valueFrom:
                    secretKeyRef:
                      name: etcd-backup-config
                      key: s3-bucket
                - name: CLUSTER_NAME
                  value: production-cluster
                - name: AWS_DEFAULT_REGION
                  value: us-east-1
              volumeMounts:
                - name: etcd-certs
                  mountPath: /etc/kubernetes/pki/etcd
                  readOnly: true
                - name: backup-scripts
                  mountPath: /scripts
                - name: backup-dir
                  mountPath: /var/backups/etcd

          volumes:
            - name: etcd-certs
              hostPath:
                path: /etc/kubernetes/pki/etcd
                type: Directory
            - name: backup-scripts
              configMap:
                name: etcd-backup-scripts
                defaultMode: 0755
            - name: backup-dir
              emptyDir: {}
```

### Listing and Verifying Backups

```bash
#!/bin/bash
# List available backups
aws s3 ls s3://my-cluster-etcd-backups/production-cluster/ \
  --human-readable \
  --summarize | tail -20

# Verify a specific backup
BACKUP_KEY="production-cluster/20300622T060000Z.db.gz"
TEMP_FILE="/tmp/etcd-verify-$(date +%s).db"

aws s3 cp "s3://my-cluster-etcd-backups/${BACKUP_KEY}" "${TEMP_FILE}.gz"
gunzip "${TEMP_FILE}.gz"

ETCDCTL_API=3 etcdctl snapshot status "${TEMP_FILE}" --write-out=table
# Output:
# +--------+----------+------------+------------+
# |  HASH  | REVISION | TOTAL KEYS | TOTAL SIZE |
# +--------+----------+------------+------------+
# | abc123 |  1234567 |       8432 |      89 MB |
# +--------+----------+------------+------------+

rm -f "${TEMP_FILE}"
```

## Defragmentation

etcd uses a B+tree with a write-ahead log. Over time, deleted keys leave holes in the backend, increasing disk usage. Defragmentation compacts these holes and reclaims disk space.

### When to Defragment

- After bulk deletions (e.g., cleaning up old deployments or secrets)
- When `etcd_mvcc_db_total_size_in_use_in_bytes` is significantly lower than `etcd_mvcc_db_total_size_in_bytes`
- On a schedule (e.g., weekly during low-traffic periods)

```bash
# Check database size vs in-use size
etcdctl-cluster endpoint status --write-out=table

# Output includes:
# DB SIZE: actual file size on disk
# DB SIZE IN USE: actual data size (holes = DB SIZE - DB SIZE IN USE)
```

### Defragmentation Procedure

**Critical**: Defragment one member at a time. Never defragment multiple members simultaneously.

```bash
#!/bin/bash
# /usr/local/bin/etcd-defrag.sh
# Defragments all etcd members sequentially

set -euo pipefail

ENDPOINTS=(
    "https://10.0.0.1:2379"
    "https://10.0.0.2:2379"
    "https://10.0.0.3:2379"
)

ETCD_CA="/etc/kubernetes/pki/etcd/ca.crt"
ETCD_CERT="/etc/kubernetes/pki/etcd/healthcheck-client.crt"
ETCD_KEY="/etc/kubernetes/pki/etcd/healthcheck-client.key"

etcdctl_endpoint() {
    local endpoint="$1"
    shift
    ETCDCTL_API=3 etcdctl \
      --endpoints="${endpoint}" \
      --cacert="${ETCD_CA}" \
      --cert="${ETCD_CERT}" \
      --key="${ETCD_KEY}" \
      "$@"
}

for endpoint in "${ENDPOINTS[@]}"; do
    echo "=== Defragmenting ${endpoint} ==="

    # Check status before
    echo "Before:"
    etcdctl_endpoint "${endpoint}" endpoint status --write-out=table

    # Perform defragmentation
    etcdctl_endpoint "${endpoint}" defrag

    # Verify cluster health after
    echo "After:"
    etcdctl_endpoint "${endpoint}" endpoint status --write-out=table

    # Brief pause between members
    sleep 5

    # Verify cluster is still healthy
    ETCDCTL_API=3 etcdctl endpoint health \
      --endpoints="${ENDPOINTS[*]}" \
      --cacert="${ETCD_CA}" \
      --cert="${ETCD_CERT}" \
      --key="${ETCD_KEY}"

    echo "Member ${endpoint} defragmented successfully"
    echo ""
done

echo "All members defragmented successfully"
```

### Compaction

Compaction removes historical revisions, reducing database size without defragmentation:

```bash
# Get current revision
CURRENT_REVISION=$(etcdctl-cluster endpoint status \
  --write-out=json | \
  jq -r '.[0].Status.header.revision')

echo "Current revision: ${CURRENT_REVISION}"

# Compact to keep only the last 5000 revisions
COMPACT_TO=$((CURRENT_REVISION - 5000))
if [ "${COMPACT_TO}" -gt 0 ]; then
    etcdctl-cluster compact "${COMPACT_TO}"
    echo "Compacted to revision ${COMPACT_TO}"
fi

# Defragment after compaction
etcdctl-cluster defrag --cluster
```

## Health Monitoring

### Key Metrics

```bash
# Check endpoint health
etcdctl-cluster endpoint health

# Check endpoint status (includes DB size, leader, revision)
etcdctl-cluster endpoint status --write-out=table

# Check cluster leader
etcdctl-cluster endpoint status --write-out=json | \
  jq -r '.[] | select(.Status.leader == .Status.header.member_id) | .Endpoint'
```

### Prometheus Monitoring

etcd exposes metrics at `/metrics`. Key metrics to monitor:

```yaml
groups:
  - name: etcd_health
    rules:
      # etcd member count below quorum
      - alert: ETCDClusterLostQuorum
        expr: |
          (count(etcd_server_id) % 2) == 0
        for: 1m
        labels:
          severity: critical
          team: platform
        annotations:
          summary: "etcd cluster has even number of members (split-brain risk)"

      # etcd leader change rate (instability indicator)
      - alert: ETCDHighNumberOfLeaderChanges
        expr: |
          increase(etcd_server_leader_changes_seen_total[1h]) > 4
        for: 5m
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "etcd has had {{ $value }} leader changes in the last hour"
          description: |
            Frequent leader changes indicate network instability or resource contention
            on etcd member nodes.

      # etcd peer communication failures
      - alert: ETCDMemberCommunicationSlow
        expr: |
          histogram_quantile(0.99,
            rate(etcd_network_peer_round_trip_time_seconds_bucket[5m])
          ) > 0.15
        for: 10m
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "etcd peer {{ $labels.To }} round-trip time is high"

      # Database size approaching quota
      - alert: ETCDDatabaseSizeApproachingQuota
        expr: |
          etcd_mvcc_db_total_size_in_bytes / etcd_server_quota_backend_bytes > 0.8
        for: 10m
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "etcd database size is {{ $value | humanizePercentage }} of quota"
          description: |
            etcd database is approaching its storage quota. Run compaction and
            defragmentation, or increase the quota if necessary.

      # etcd propose failures
      - alert: ETCDHighNumberOfFailedProposals
        expr: |
          rate(etcd_server_proposals_failed_total[5m]) > 0.01
        for: 5m
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "etcd has failed proposals at {{ $value }} per second"

      # Backup staleness
      - alert: ETCDBackupStale
        expr: |
          time() - etcd_backup_success_timestamp > 86400
        for: 1h
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "etcd backup is more than 24 hours old"
          description: |
            The last successful etcd backup was {{ $value | humanizeDuration }} ago.
            Check the backup CronJob status.
```

## Restore Procedures

### Restoring a Single Failed Member

When one etcd member fails (not all three), the cluster continues operating. Restore the failed member by re-joining it to the cluster.

```bash
#!/bin/bash
# Restore a single failed etcd member

FAILED_MEMBER_NAME="master-2"
FAILED_MEMBER_IP="10.0.0.2"

# Step 1: Remove the failed member from the cluster
# (run on a healthy member or master node)
FAILED_MEMBER_ID=$(etcdctl-cluster member list \
  --write-out=json | \
  jq -r --arg name "${FAILED_MEMBER_NAME}" \
  '.members[] | select(.name == $name) | .ID')

echo "Removing failed member ID: ${FAILED_MEMBER_ID}"
etcdctl-cluster member remove "${FAILED_MEMBER_ID}"

# Step 2: On the FAILED NODE — stop etcd
ssh "${FAILED_MEMBER_IP}" "systemctl stop etcd || true"
ssh "${FAILED_MEMBER_IP}" "systemctl stop kubelet || true"

# Step 3: Clear the failed member's data directory
ssh "${FAILED_MEMBER_IP}" "rm -rf /var/lib/etcd/*"

# Step 4: Add the member back to the cluster
NEW_PEER_URL="https://${FAILED_MEMBER_IP}:2380"
etcdctl-cluster member add "${FAILED_MEMBER_NAME}" \
  --peer-urls="${NEW_PEER_URL}"

# This outputs the ETCD_INITIAL_CLUSTER and ETCD_INITIAL_CLUSTER_STATE values
# that must be used when starting the new member

# Step 5: Update etcd configuration on the failed node with:
# --initial-cluster-state=existing
# --initial-cluster=<output from member add>
# Then start etcd
ssh "${FAILED_MEMBER_IP}" "systemctl start etcd"

# Step 6: Verify member rejoined
etcdctl-cluster member list --write-out=table
etcdctl-cluster endpoint health
```

### Full Cluster Restore from Snapshot

When all etcd members are lost (complete cluster failure), restore from the most recent snapshot.

**This procedure requires stopping the Kubernetes API server first.**

```bash
#!/bin/bash
# Full etcd cluster restore from snapshot
# Run on EACH control plane node

set -euo pipefail

SNAPSHOT_FILE="${1:?Usage: $0 <snapshot-file>}"
CLUSTER_NAME="${CLUSTER_NAME:-production-cluster}"

# Validate snapshot before proceeding
echo "=== Validating snapshot: ${SNAPSHOT_FILE} ==="
ETCDCTL_API=3 etcdctl snapshot status "${SNAPSHOT_FILE}" --write-out=table

# Node-specific configuration (customize per node)
NODE_NAME="${ETCD_NODE_NAME:?ETCD_NODE_NAME must be set}"
NODE_IP="${ETCD_NODE_IP:?ETCD_NODE_IP must be set}"
DATA_DIR="/var/lib/etcd"
INITIAL_CLUSTER="${ETCD_INITIAL_CLUSTER:?ETCD_INITIAL_CLUSTER must be set}"
# Example: "master-1=https://10.0.0.1:2380,master-2=https://10.0.0.2:2380,master-3=https://10.0.0.3:2380"

# Step 1: Stop Kubernetes API server and etcd
echo "=== Stopping kube-apiserver and etcd ==="
# For static pod deployments, move the manifest files
mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/
mv /etc/kubernetes/manifests/etcd.yaml /tmp/

# Wait for pods to terminate
sleep 10

# Step 2: Clear existing etcd data
echo "=== Clearing existing etcd data ==="
rm -rf "${DATA_DIR}"

# Step 3: Restore from snapshot
echo "=== Restoring snapshot to ${DATA_DIR} ==="
ETCDCTL_API=3 etcdctl snapshot restore "${SNAPSHOT_FILE}" \
  --name="${NODE_NAME}" \
  --initial-cluster="${INITIAL_CLUSTER}" \
  --initial-cluster-token="etcd-cluster-production-restored-$(date +%s)" \
  --initial-advertise-peer-urls="https://${NODE_IP}:2380" \
  --data-dir="${DATA_DIR}" \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key

echo "Snapshot restored to ${DATA_DIR}"

# Step 4: Fix ownership
chown -R etcd:etcd "${DATA_DIR}"

# Step 5: Restart etcd (restore manifests)
echo "=== Restoring etcd manifest ==="
mv /tmp/etcd.yaml /etc/kubernetes/manifests/

# Wait for etcd to start
sleep 30

# Step 6: Verify etcd is running
ETCDCTL_API=3 etcdctl endpoint health \
  --endpoints="https://127.0.0.1:2379" \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
  --key=/etc/kubernetes/pki/etcd/healthcheck-client.key

# Step 7: Restore API server
echo "=== Restoring kube-apiserver manifest ==="
mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/

# Wait for API server
sleep 60
kubectl get nodes
```

### Automated Restore Script

```bash
#!/bin/bash
# Orchestrate restore across all control plane nodes

SNAPSHOT_S3_PATH="${1:?Usage: $0 <s3-path>}"
CONTROL_PLANE_NODES=("10.0.0.1" "10.0.0.2" "10.0.0.3")
CONTROL_PLANE_NAMES=("master-1" "master-2" "master-3")

INITIAL_CLUSTER="master-1=https://10.0.0.1:2380,master-2=https://10.0.0.2:2380,master-3=https://10.0.0.3:2380"
TOKEN="etcd-cluster-restored-$(date +%s)"

# Download snapshot to all nodes
for node in "${CONTROL_PLANE_NODES[@]}"; do
    echo "Downloading snapshot to ${node}"
    ssh "${node}" "aws s3 cp '${SNAPSHOT_S3_PATH}' /tmp/etcd-restore.db.gz && gunzip -f /tmp/etcd-restore.db.gz"
done

# Run restore on all nodes simultaneously
for i in "${!CONTROL_PLANE_NODES[@]}"; do
    node="${CONTROL_PLANE_NODES[$i]}"
    name="${CONTROL_PLANE_NAMES[$i]}"

    ssh "${node}" \
      ETCD_NODE_NAME="${name}" \
      ETCD_NODE_IP="${node}" \
      ETCD_INITIAL_CLUSTER="${INITIAL_CLUSTER}" \
      /usr/local/bin/etcd-restore.sh /tmp/etcd-restore.db &
done

# Wait for all restores to complete
wait

echo "Restore completed on all nodes. Verifying cluster health..."
sleep 60

ETCDCTL_API=3 etcdctl endpoint health \
  --endpoints="https://10.0.0.1:2379,https://10.0.0.2:2379,https://10.0.0.3:2379" \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
  --key=/etc/kubernetes/pki/etcd/healthcheck-client.key

kubectl get nodes
kubectl get pods -A | head -30
```

## etcd Quota Management

etcd has a default storage quota of 8 GiB. When exceeded, etcd switches to alarm mode and rejects all writes:

```bash
# Check if alarm is triggered
etcdctl-cluster alarm list

# If "NOSPACE" alarm is active:
# Step 1: Compact old revisions
REVISION=$(etcdctl-cluster endpoint status --write-out=json | \
  jq -r '.[0].Status.header.revision')
etcdctl-cluster compact $((REVISION - 1000))

# Step 2: Defragment all members
etcdctl-cluster defrag --cluster

# Step 3: Disarm the alarm
etcdctl-cluster alarm disarm

# Verify alarm is cleared
etcdctl-cluster alarm list
```

### Increasing the Quota

```yaml
# In the etcd pod spec or kubeadm ClusterConfiguration
# /etc/kubernetes/manifests/etcd.yaml (for static pods)
spec:
  containers:
    - name: etcd
      command:
        - etcd
        - --quota-backend-bytes=8589934592  # 8 GiB (default)
        # Increase to 16 GiB for large clusters:
        # - --quota-backend-bytes=17179869184
```

## etcd Encryption at Rest

Kubernetes secrets are stored in etcd. Enable encryption for sensitive data:

```yaml
# /etc/kubernetes/encryption-config.yaml
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
  - resources:
      - secrets
      - configmaps
    providers:
      - aescbc:
          keys:
            - name: key1
              secret: "<base64-encoded-32-byte-key>"
      - identity: {}
```

```bash
# Add to kube-apiserver flags:
# --encryption-provider-config=/etc/kubernetes/encryption-config.yaml

# Rotate existing secrets after enabling encryption
kubectl get secrets --all-namespaces -o json | \
  kubectl replace -f -
```

## Disaster Recovery Runbook Summary

```
SCENARIO 1: One etcd member down (2 of 3 healthy)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Identify failed member: etcdctl member list
2. Remove failed member: etcdctl member remove <id>
3. Clear data dir on failed node: rm -rf /var/lib/etcd/*
4. Add member back: etcdctl member add <name> --peer-urls=<url>
5. Start etcd on rejoined node with --initial-cluster-state=existing
6. Monitor until member catches up: etcdctl endpoint health

SCENARIO 2: Two etcd members down (1 of 3 healthy, no quorum)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WARNING: Cluster cannot accept writes. All API server requests fail.
1. Stop API servers on all control plane nodes
2. Start etcd in force-new-cluster mode on the surviving member:
   etcd --force-new-cluster
3. Restore failed members using snapshot restore procedure
4. Restart API servers

SCENARIO 3: All etcd members down
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Obtain most recent backup from S3
2. Download and decompress snapshot on all control plane nodes
3. Stop kube-apiserver on all nodes (move manifests)
4. Run etcdctl snapshot restore on all nodes simultaneously
5. Restore etcd manifests on all nodes
6. Wait for etcd cluster to form quorum
7. Restore kube-apiserver manifests
8. Verify cluster health

Recovery Time Objectives (typical):
- Single member: 5-15 minutes
- Two members (force-new-cluster): 15-30 minutes
- Full restore from snapshot: 30-60 minutes
```

## Summary

etcd health is the foundation of Kubernetes cluster reliability. Production etcd operations require:

- **Automated backups** every 6 hours minimum, retained for at least 30 days, stored encrypted in durable object storage
- **Regular defragmentation** — weekly during low-traffic windows — to reclaim space and maintain performance
- **Comprehensive monitoring** of leader changes, proposal failures, database size, and backup staleness
- **Tested restore procedures** — the worst time to discover a broken restore script is during an incident
- **Documented recovery runbooks** accessible offline, covering single-member failure through complete cluster loss
- **Encryption at rest** for secrets stored in etcd

The key difference between clusters that recover from etcd failures in minutes versus hours is practice: running restore drills on staging clusters, validating backup integrity weekly, and ensuring every engineer on the team knows the recovery procedures before they are needed.
