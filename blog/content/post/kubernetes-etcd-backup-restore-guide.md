---
title: "Kubernetes etcd: Backup, Restore, and Production Operations Guide"
date: 2027-04-16T00:00:00-05:00
draft: false
tags: ["Kubernetes", "etcd", "Backup", "Disaster Recovery", "Control Plane"]
categories: ["Kubernetes", "Operations", "Disaster Recovery"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Kubernetes etcd operations covering automated snapshot backups to S3, point-in-time restore procedures, etcd cluster health monitoring, defragmentation scheduling, member replacement for failed nodes, etcd encryption configuration, and disaster recovery runbooks."
more_link: "yes"
url: "/kubernetes-etcd-backup-restore-guide/"
---

etcd is the single source of truth for every Kubernetes cluster. All cluster state — every Deployment, Service, ConfigMap, Secret, Pod spec, and RBAC policy — lives exclusively in etcd. When etcd fails, the Kubernetes control plane goes dark: the API server cannot serve reads, controllers cannot reconcile, and schedulers cannot place pods. Losing etcd data without a backup means losing the cluster entirely. Yet in practice, many teams treat etcd backup as an afterthought, discovering the gap only during a disaster recovery exercise or an actual incident. This guide covers automated backup, verification, restore procedures, health monitoring, defragmentation, member replacement, and encryption — the complete operational picture for etcd in production.

<!--more-->

## etcd Architecture in Kubernetes

### Raft Consensus and Quorum

etcd uses the Raft distributed consensus protocol. A cluster of `n` members can tolerate `(n-1)/2` failures while maintaining quorum. Common cluster sizes:

| Members | Fault tolerance | Notes |
|---|---|---|
| 1 | 0 | Dev/test only — any failure = total loss |
| 3 | 1 | Minimum production size |
| 5 | 2 | Recommended for high availability |
| 7 | 3 | Use only if 2-fault-tolerance is required; adds write latency |

```bash
# Verify current etcd member count and health
ETCDCTL_API=3 etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/peer.crt \
  --key=/etc/kubernetes/pki/etcd/peer.key \
  member list --write-out=table
# Output:
# +------------------+---------+------------------+---------------------------+---------------------------+------------+
# |        ID        | STATUS  |       NAME       |        PEER ADDRS         |       CLIENT ADDRS        | IS LEARNER |
# +------------------+---------+------------------+---------------------------+---------------------------+------------+
# | 5b52c39a8a82e46a | started | control-plane-01 | https://10.0.1.10:2380    | https://10.0.1.10:2379    |      false |
# | 9c4cf8b1d3f7a201 | started | control-plane-02 | https://10.0.1.11:2380    | https://10.0.1.11:2379    |      false |
# | b7d2e5f4c8a91304 | started | control-plane-03 | https://10.0.1.12:2380    | https://10.0.1.12:2379    |      false |
# +------------------+---------+------------------+---------------------------+---------------------------+------------+
```

### etcdctl Wrapper Script

Create a wrapper script on each control plane node to avoid retyping connection flags:

```bash
#!/bin/bash
# /usr/local/bin/etcdctlw — etcdctl wrapper with standard flags pre-configured
# Place on all control plane nodes and chmod +x
ETCDCTL_API=3 etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
  --key=/etc/kubernetes/pki/etcd/healthcheck-client.key \
  "$@"
```

```bash
# Common etcdctl operations using the wrapper
etcdctlw endpoint health
etcdctlw endpoint status --write-out=table
etcdctlw member list --write-out=table

# Check which member is the current leader
etcdctlw endpoint status --write-out=json | \
  jq -r '.[] | select(.Status.leader == .Status.header.member_id) | .Endpoint'
```

## etcd Snapshot Backup

### Manual Snapshot

```bash
#!/bin/bash
# etcd-snapshot.sh — Create a single etcd snapshot
# Run from a control plane node
set -euo pipefail

SNAPSHOT_DIR="/var/lib/etcd-backups"
SNAPSHOT_FILE="${SNAPSHOT_DIR}/etcd-snapshot-$(date +%Y%m%d-%H%M%S).db"

mkdir -p "${SNAPSHOT_DIR}"

ETCDCTL_API=3 etcdctl snapshot save "${SNAPSHOT_FILE}" \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
  --key=/etc/kubernetes/pki/etcd/healthcheck-client.key

echo "Snapshot saved to ${SNAPSHOT_FILE}"

# Verify the snapshot immediately after creation
ETCDCTL_API=3 etcdctl snapshot status "${SNAPSHOT_FILE}" --write-out=table
```

### Snapshot Verification

```bash
# Verify an existing snapshot file
ETCDCTL_API=3 etcdctl snapshot status /var/lib/etcd-backups/etcd-snapshot-20250310-020000.db \
  --write-out=table
# Output:
# +----------+----------+------------+------------+
#     HASH | REVISION | TOTAL KEYS | TOTAL SIZE |
# +----------+----------+------------+------------+
# | 3c6b82f1 |  4891023 |       9847 |     284 MB |
# +----------+----------+------------+------------+

# A valid snapshot will show a non-zero revision and key count
# Total size should be within expected range for the cluster
```

### Automated Backup CronJob with S3 Upload

```yaml
# etcd-backup-cronjob.yaml — Runs on control plane nodes via hostPath access
# This CronJob is deployed in kube-system and runs with host-level access to etcd certs
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
  # Needs no Kubernetes RBAC — accesses etcd directly via hostPath certs
  # But needs to read cluster info for labeling
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
  schedule: "0 */4 * * *"   # Every 4 hours
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 5
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 2
      activeDeadlineSeconds: 600    # Fail job if it runs > 10 minutes
      template:
        spec:
          serviceAccountName: etcd-backup
          restartPolicy: OnFailure
          # Must run on a control plane node to access etcd certs
          nodeSelector:
            node-role.kubernetes.io/control-plane: ""
          tolerations:
            - key: node-role.kubernetes.io/control-plane
              operator: Exists
              effect: NoSchedule
          containers:
          - name: etcd-backup
            image: registry.support.tools/tools/etcd-backup:3.5.12
            env:
              - name: ETCD_ENDPOINTS
                value: https://127.0.0.1:2379
              - name: S3_BUCKET
                value: payments-prod-etcd-backups
              - name: S3_REGION
                value: us-east-1
              - name: S3_PREFIX
                value: prod-us-east-1
              - name: RETENTION_DAYS
                value: "30"
              - name: AWS_ROLE_ARN
                value: arn:aws:iam::123456789012:role/EtcdBackupRole
              - name: NODE_NAME
                valueFrom:
                  fieldRef:
                    fieldPath: spec.nodeName
            command:
            - /bin/bash
            - -c
            - |
              set -euo pipefail

              TIMESTAMP=$(date +%Y%m%d-%H%M%S)
              SNAPSHOT_FILE="/tmp/etcd-snapshot-${TIMESTAMP}.db"
              CLUSTER_ID=$(kubectl get namespace kube-system \
                -o jsonpath='{.metadata.uid}' | cut -c1-8)
              S3_KEY="${S3_PREFIX}/${CLUSTER_ID}/etcd-snapshot-${TIMESTAMP}.db"

              echo "Creating etcd snapshot on node ${NODE_NAME}..."
              ETCDCTL_API=3 etcdctl snapshot save "${SNAPSHOT_FILE}" \
                --endpoints="${ETCD_ENDPOINTS}" \
                --cacert=/etc/kubernetes/pki/etcd/ca.crt \
                --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
                --key=/etc/kubernetes/pki/etcd/healthcheck-client.key

              echo "Verifying snapshot..."
              ETCDCTL_API=3 etcdctl snapshot status "${SNAPSHOT_FILE}" \
                --write-out=json > /tmp/snapshot-status.json

              REVISION=$(jq -r '.revision' /tmp/snapshot-status.json)
              TOTAL_KEYS=$(jq -r '.totalKey' /tmp/snapshot-status.json)
              DB_SIZE=$(jq -r '.totalSize' /tmp/snapshot-status.json)

              echo "Snapshot verified: revision=${REVISION} keys=${TOTAL_KEYS} size=${DB_SIZE}"

              # Fail if snapshot looks empty (fewer than 100 keys is suspicious)
              if [[ "${TOTAL_KEYS}" -lt 100 ]]; then
                echo "ERROR: Snapshot has fewer than 100 keys — aborting upload"
                exit 1
              fi

              echo "Uploading to s3://${S3_BUCKET}/${S3_KEY}..."
              aws s3 cp "${SNAPSHOT_FILE}" "s3://${S3_BUCKET}/${S3_KEY}" \
                --sse aws:kms \
                --metadata "revision=${REVISION},total-keys=${TOTAL_KEYS},node=${NODE_NAME}"

              echo "Upload complete. Cleaning up local file..."
              rm -f "${SNAPSHOT_FILE}"

              # Write backup metadata to a well-known S3 location for monitoring
              cat > /tmp/latest-backup.json <<EOF
              {
                "timestamp": "${TIMESTAMP}",
                "s3_key": "${S3_KEY}",
                "revision": ${REVISION},
                "total_keys": ${TOTAL_KEYS},
                "db_size_bytes": ${DB_SIZE},
                "node": "${NODE_NAME}"
              }
              EOF

              aws s3 cp /tmp/latest-backup.json \
                "s3://${S3_BUCKET}/${S3_PREFIX}/${CLUSTER_ID}/latest-backup.json" \
                --sse aws:kms

              echo "etcd backup completed successfully."

            volumeMounts:
            - name: etcd-certs
              mountPath: /etc/kubernetes/pki/etcd
              readOnly: true
            resources:
              requests:
                cpu: 100m
                memory: 128Mi
              limits:
                cpu: 500m
                memory: 512Mi
            securityContext:
              runAsNonRoot: false    # Must run as root to read etcd certs
              allowPrivilegeEscalation: false
          volumes:
          - name: etcd-certs
            hostPath:
              path: /etc/kubernetes/pki/etcd
              type: Directory
```

### Backup Monitoring Prometheus Rule

```yaml
# etcd-backup-alert.yaml — Alert if backup has not run in 6 hours
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: etcd-backup-alerts
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
  - name: etcd-backup
    interval: 5m
    rules:
    - alert: EtcdBackupMissing
      expr: |
        (time() - etcd_backup_last_success_timestamp_seconds) > 21600
      for: 15m
      labels:
        severity: critical
        team: platform
      annotations:
        summary: "etcd backup has not succeeded in over 6 hours"
        description: >
          The last successful etcd backup was {{ humanizeDuration $value }} ago.
          Check the etcd-backup CronJob in kube-system for failures.
          A missed backup increases data loss risk in a disaster recovery scenario.
    - alert: EtcdBackupJobFailed
      expr: |
        kube_job_status_failed{namespace="kube-system", job_name=~"etcd-backup-.*"} > 0
      for: 5m
      labels:
        severity: warning
        team: platform
      annotations:
        summary: "etcd backup job failed"
        description: "etcd backup job {{ $labels.job_name }} has failed."
```

## Restore Procedures

### Single-Node Cluster Restore

```bash
#!/bin/bash
# etcd-restore-single-node.sh — Restore etcd from snapshot on a single-node cluster
# Run ONLY on the control plane node as root
# DANGER: This procedure will cause downtime — all workloads will be unavailable
# during the restore. Have this runbook printed and available offline.
set -euo pipefail

SNAPSHOT_FILE="${1:?Snapshot file path required}"
ETCD_DATA_DIR="/var/lib/etcd"
ETCD_BACKUP_DIR="/var/lib/etcd-backup-$(date +%Y%m%d-%H%M%S)"

# Pre-flight check: verify snapshot before proceeding
echo "Verifying snapshot integrity..."
ETCDCTL_API=3 etcdctl snapshot status "${SNAPSHOT_FILE}" --write-out=table

read -p "Snapshot verified. Proceed with restore? This will cause downtime. [yes/no]: " CONFIRM
[[ "${CONFIRM}" != "yes" ]] && { echo "Aborted."; exit 0; }

# Step 1: Stop the API server and etcd by moving static pod manifests
echo "Stopping control plane components..."
mkdir -p /tmp/manifests-backup
mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/manifests-backup/
mv /etc/kubernetes/manifests/kube-controller-manager.yaml /tmp/manifests-backup/
mv /etc/kubernetes/manifests/kube-scheduler.yaml /tmp/manifests-backup/
mv /etc/kubernetes/manifests/etcd.yaml /tmp/manifests-backup/

# Wait for API server and etcd to fully stop
echo "Waiting for control plane containers to stop..."
sleep 20
while crictl ps 2>/dev/null | grep -q "kube-apiserver\|etcd"; do
  echo "  Still stopping..."
  sleep 5
done
echo "Control plane containers stopped."

# Step 2: Back up the existing etcd data directory
echo "Backing up existing etcd data to ${ETCD_BACKUP_DIR}..."
cp -rp "${ETCD_DATA_DIR}" "${ETCD_BACKUP_DIR}"

# Step 3: Remove the existing data directory
echo "Removing existing etcd data directory..."
rm -rf "${ETCD_DATA_DIR}"

# Step 4: Restore from snapshot
echo "Restoring etcd from snapshot ${SNAPSHOT_FILE}..."
ETCDCTL_API=3 etcdctl snapshot restore "${SNAPSHOT_FILE}" \
  --data-dir="${ETCD_DATA_DIR}" \
  --name=control-plane-01 \
  --initial-cluster="control-plane-01=https://10.0.1.10:2380" \
  --initial-cluster-token="etcd-cluster-production" \
  --initial-advertise-peer-urls="https://10.0.1.10:2380"

# Step 5: Fix ownership (etcd runs as uid 1000 in many distributions)
chown -R etcd:etcd "${ETCD_DATA_DIR}" 2>/dev/null || true

# Step 6: Restore control plane manifests to restart components
echo "Restoring control plane manifests..."
mv /tmp/manifests-backup/etcd.yaml /etc/kubernetes/manifests/
sleep 15    # Wait for etcd to start before apiserver

mv /tmp/manifests-backup/kube-apiserver.yaml /etc/kubernetes/manifests/
mv /tmp/manifests-backup/kube-controller-manager.yaml /etc/kubernetes/manifests/
mv /tmp/manifests-backup/kube-scheduler.yaml /etc/kubernetes/manifests/

# Step 7: Wait for API server to become healthy
echo "Waiting for API server to become healthy..."
until kubectl get nodes >/dev/null 2>&1; do
  echo "  API server not ready yet..."
  sleep 5
done

echo "Restore complete. API server is healthy."
echo "Verify cluster state:"
kubectl get nodes
kubectl get pods --all-namespaces | grep -v Running | head -30
```

### Multi-Node Cluster Restore

Restoring a multi-node etcd cluster requires the same procedure on all members simultaneously, each using the same snapshot but with different `--name` and `--initial-cluster` peer URLs:

```bash
#!/bin/bash
# etcd-restore-member.sh — Run on each control plane node during multi-node restore
# Pass the member-specific arguments for this node
set -euo pipefail

SNAPSHOT_FILE="${1:?Snapshot file required}"
MEMBER_NAME="${2:?Member name required (e.g. control-plane-01)}"
MEMBER_PEER_URL="${3:?Member peer URL required (e.g. https://10.0.1.10:2380)}"

# All three nodes must use the SAME initial-cluster value
INITIAL_CLUSTER="control-plane-01=https://10.0.1.10:2380,control-plane-02=https://10.0.1.11:2380,control-plane-03=https://10.0.1.12:2380"
CLUSTER_TOKEN="etcd-cluster-production"
ETCD_DATA_DIR="/var/lib/etcd"

echo "Restoring etcd member ${MEMBER_NAME}..."

ETCDCTL_API=3 etcdctl snapshot restore "${SNAPSHOT_FILE}" \
  --data-dir="${ETCD_DATA_DIR}" \
  --name="${MEMBER_NAME}" \
  --initial-cluster="${INITIAL_CLUSTER}" \
  --initial-cluster-token="${CLUSTER_TOKEN}" \
  --initial-advertise-peer-urls="${MEMBER_PEER_URL}"

echo "Restore complete on ${MEMBER_NAME}. Start etcd when all members are restored."
```

```bash
# Coordination script — run from a jump host with SSH access to all control planes
#!/bin/bash
# coordinate-multi-node-restore.sh
set -euo pipefail

SNAPSHOT_LOCAL="/tmp/etcd-snapshot-20250310.db"
NODES=(control-plane-01 control-plane-02 control-plane-03)
PEER_URLS=(https://10.0.1.10:2380 https://10.0.1.11:2380 https://10.0.1.12:2380)

# Copy snapshot to all nodes
for i in "${!NODES[@]}"; do
  echo "Copying snapshot to ${NODES[$i]}..."
  scp "${SNAPSHOT_LOCAL}" "root@${NODES[$i]}:/tmp/etcd-snapshot.db"
done

# Run restore on all nodes simultaneously
for i in "${!NODES[@]}"; do
  echo "Starting restore on ${NODES[$i]}..."
  ssh "root@${NODES[$i]}" \
    "/usr/local/bin/etcd-restore-member.sh /tmp/etcd-snapshot.db ${NODES[$i]} ${PEER_URLS[$i]}" &
done

wait
echo "Restore completed on all nodes. Restart etcd and control plane components."
```

## etcd Defragmentation

### Why Defragmentation Is Necessary

etcd's bbolt storage engine marks deleted keys as free space but does not reclaim that space automatically. Over time, the on-disk database size grows even when the logical data size remains stable. Defragmentation rewrites the database file, reclaiming free pages and reducing actual disk usage. Without periodic defragmentation, etcd databases commonly grow to 4–8x the logical data size.

```bash
# Check current etcd database size vs logical size
etcdctlw endpoint status --write-out=json | \
  jq -r '.[] | {endpoint: .Endpoint, dbSize: .Status.dbSize, dbSizeInUse: .Status.dbSizeInUse}'
# dbSize = physical file size
# dbSizeInUse = logical data size
# (dbSize - dbSizeInUse) = reclaimable space via defragmentation

# Check the etcd quota alert threshold (default: 2GB)
etcdctlw endpoint status --write-out=json | \
  jq -r '.[] | .Status.dbSize / (1024*1024) | tostring + " MB"'
```

### Defragmentation CronJob

```yaml
# etcd-defrag-cronjob.yaml — Weekly defragmentation during maintenance window
# Defragmentation causes a brief (~1-5 second) pause on the defragmented member.
# Run members one at a time to avoid impacting quorum.
apiVersion: batch/v1
kind: CronJob
metadata:
  name: etcd-defrag
  namespace: kube-system
spec:
  schedule: "0 3 * * 0"   # Sundays at 03:00 UTC
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 0
      activeDeadlineSeconds: 1800
      template:
        spec:
          serviceAccountName: etcd-backup
          restartPolicy: Never
          nodeSelector:
            node-role.kubernetes.io/control-plane: ""
          tolerations:
            - key: node-role.kubernetes.io/control-plane
              operator: Exists
              effect: NoSchedule
          containers:
          - name: etcd-defrag
            image: registry.support.tools/tools/etcd-backup:3.5.12
            command:
            - /bin/bash
            - -c
            - |
              set -euo pipefail

              ETCD_ENDPOINTS="https://10.0.1.10:2379,https://10.0.1.11:2379,https://10.0.1.12:2379"

              defrag_member() {
                local endpoint="${1}"
                echo "Defragmenting ${endpoint}..."

                # Get size before defrag
                SIZE_BEFORE=$(ETCDCTL_API=3 etcdctl endpoint status \
                  --endpoints="${endpoint}" \
                  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
                  --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
                  --key=/etc/kubernetes/pki/etcd/healthcheck-client.key \
                  --write-out=json | jq -r '.[0].Status.dbSize')

                # Run defragmentation
                ETCDCTL_API=3 etcdctl defrag \
                  --endpoints="${endpoint}" \
                  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
                  --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
                  --key=/etc/kubernetes/pki/etcd/healthcheck-client.key

                # Get size after defrag
                SIZE_AFTER=$(ETCDCTL_API=3 etcdctl endpoint status \
                  --endpoints="${endpoint}" \
                  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
                  --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
                  --key=/etc/kubernetes/pki/etcd/healthcheck-client.key \
                  --write-out=json | jq -r '.[0].Status.dbSize')

                SAVED=$(( (SIZE_BEFORE - SIZE_AFTER) / 1024 / 1024 ))
                echo "  ${endpoint}: ${SIZE_BEFORE} -> ${SIZE_AFTER} bytes (saved ${SAVED} MB)"

                # Wait for member to re-join the cluster before proceeding
                sleep 10
              }

              # Defragment followers first, then leader last
              # This minimizes leader election disruption
              LEADER=$(ETCDCTL_API=3 etcdctl endpoint status \
                --endpoints="${ETCD_ENDPOINTS}" \
                --cacert=/etc/kubernetes/pki/etcd/ca.crt \
                --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
                --key=/etc/kubernetes/pki/etcd/healthcheck-client.key \
                --write-out=json | \
                jq -r '.[] | select(.Status.leader == .Status.header.member_id) | .Endpoint')

              echo "Current leader: ${LEADER}"
              echo "Defragmenting followers first..."

              IFS=',' read -ra ENDPOINTS <<< "${ETCD_ENDPOINTS}"
              for ep in "${ENDPOINTS[@]}"; do
                if [[ "${ep}" != "${LEADER}" ]]; then
                  defrag_member "${ep}"
                fi
              done

              echo "Defragmenting leader: ${LEADER}"
              defrag_member "${LEADER}"

              echo "Defragmentation complete."

            volumeMounts:
            - name: etcd-certs
              mountPath: /etc/kubernetes/pki/etcd
              readOnly: true
            resources:
              requests:
                cpu: 100m
                memory: 64Mi
              limits:
                cpu: 200m
                memory: 128Mi
          volumes:
          - name: etcd-certs
            hostPath:
              path: /etc/kubernetes/pki/etcd
              type: Directory
```

## etcd Health Monitoring with Prometheus

### Prometheus Scrape Configuration

```yaml
# etcd-service-monitor.yaml — ServiceMonitor for etcd metrics
# etcd exposes Prometheus metrics on port 2381 by default
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: etcd
  namespace: monitoring
  labels:
    app: kube-prometheus-stack
spec:
  endpoints:
  - bearerTokenFile: /var/run/secrets/kubernetes.io/serviceaccount/token
    interval: 30s
    port: http-metrics
    scheme: https
    tlsConfig:
      caFile: /etc/prometheus/secrets/etcd-client-cert/ca.crt
      certFile: /etc/prometheus/secrets/etcd-client-cert/healthcheck-client.crt
      keyFile: /etc/prometheus/secrets/etcd-client-cert/healthcheck-client.key
      insecureSkipVerify: false
  jobLabel: app
  namespaceSelector:
    matchNames:
    - kube-system
  selector:
    matchLabels:
      component: etcd
```

### Key etcd Metrics

| Metric | Description | Alert threshold |
|---|---|---|
| `etcd_server_has_leader` | 1 if the member has a leader, 0 if no quorum | Alert if 0 for > 1 minute |
| `etcd_server_leader_changes_seen_total` | Total leader election count | Alert if rate > 2/hour |
| `etcd_disk_wal_fsync_duration_seconds` | WAL fsync latency (p99) | Alert if p99 > 100ms |
| `etcd_disk_backend_commit_duration_seconds` | Backend commit latency (p99) | Alert if p99 > 250ms |
| `etcd_mvcc_db_total_size_in_bytes` | Physical database size | Alert if > 80% of quota (1.6GB for 2GB quota) |
| `etcd_mvcc_db_total_size_in_use_in_bytes` | Logical database size | Baseline for defrag benefit estimation |
| `etcd_network_peer_round_trip_time_seconds` | Peer network latency (p99) | Alert if p99 > 150ms |
| `etcd_server_slow_apply_total` | Count of slow apply operations | Alert if increasing steadily |

### Alertmanager Rules

```yaml
# etcd-prometheus-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: etcd-critical-alerts
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
  - name: etcd.critical
    interval: 30s
    rules:

    - alert: EtcdNoLeader
      expr: etcd_server_has_leader == 0
      for: 1m
      labels:
        severity: critical
        team: platform
      annotations:
        summary: "etcd member has no leader — cluster may have lost quorum"
        description: >
          etcd member {{ $labels.instance }} has no leader for over 1 minute.
          The cluster may have lost quorum. Kubernetes control plane operations
          will fail. Check all etcd members immediately.
          Runbook: https://runbooks.support.tools/etcd/no-leader

    - alert: EtcdHighNumberOfLeaderChanges
      expr: increase(etcd_server_leader_changes_seen_total[1h]) > 3
      for: 5m
      labels:
        severity: warning
        team: platform
      annotations:
        summary: "etcd has had more than 3 leader elections in the past hour"
        description: >
          etcd member {{ $labels.instance }} has had {{ $value }} leader changes
          in the past hour. This indicates network instability or disk I/O issues.
          Check etcd peer latency and disk fsync times.

    - alert: EtcdDatabaseSizeApproachingQuota
      expr: |
        (etcd_mvcc_db_total_size_in_bytes / 1073741824) > 1.6
      for: 5m
      labels:
        severity: warning
        team: platform
      annotations:
        summary: "etcd database size approaching quota limit"
        description: >
          etcd database size is {{ $value | humanize }}B, approaching the default
          2GB quota. When the quota is exceeded, etcd will stop accepting write
          requests. Run defragmentation or increase the quota.
          Current member: {{ $labels.instance }}

    - alert: EtcdDatabaseQuotaExceeded
      expr: |
        (etcd_mvcc_db_total_size_in_bytes / 1073741824) > 1.9
      for: 1m
      labels:
        severity: critical
        team: platform
      annotations:
        summary: "etcd database quota nearly exhausted — writes may fail"
        description: >
          etcd database is {{ $value | humanize }}B, within 100MB of the default
          2GB quota. Write operations will start failing. Immediate defragmentation
          or quota increase required.

    - alert: EtcdHighFsyncLatency
      expr: |
        histogram_quantile(0.99, rate(etcd_disk_wal_fsync_duration_seconds_bucket[5m])) > 0.1
      for: 10m
      labels:
        severity: warning
        team: platform
      annotations:
        summary: "etcd WAL fsync latency is elevated (p99 > 100ms)"
        description: >
          etcd WAL fsync p99 is {{ $value | humanizeDuration }} on {{ $labels.instance }}.
          High fsync latency causes slow writes and may lead to leader elections.
          Check for noisy neighbors, disk I/O saturation, or storage class issues.

    - alert: EtcdHighCommitLatency
      expr: |
        histogram_quantile(0.99, rate(etcd_disk_backend_commit_duration_seconds_bucket[5m])) > 0.25
      for: 10m
      labels:
        severity: warning
        team: platform
      annotations:
        summary: "etcd backend commit latency is elevated (p99 > 250ms)"
        description: >
          etcd backend commit p99 is {{ $value | humanizeDuration }} on {{ $labels.instance }}.
          This may cause slow API server responses. Check disk performance.
```

## Member Replacement for Failed Nodes

### Replacing a Failed etcd Member

When an etcd member fails (disk corruption, node failure, certificate expiry) and cannot be recovered, the procedure is to remove it from the cluster and add a new member:

```bash
#!/bin/bash
# replace-etcd-member.sh — Remove a failed member and add a replacement
# Run from a HEALTHY control plane node
set -euo pipefail

FAILED_MEMBER_NAME="${1:?Failed member name required (e.g. control-plane-02)}"
NEW_MEMBER_IP="${2:?New member IP required (e.g. 10.0.1.14)}"
NEW_MEMBER_NAME="${3:?New member name required (e.g. control-plane-02-replacement)}"

echo "=== Step 1: Verify cluster health before member replacement ==="
etcdctlw endpoint health
etcdctlw member list --write-out=table

echo ""
echo "=== Step 2: Find the member ID of the failed member ==="
FAILED_MEMBER_ID=$(etcdctlw member list --write-out=json | \
  jq -r --arg NAME "${FAILED_MEMBER_NAME}" \
  '.members[] | select(.name == $NAME) | .ID | tostring')

if [[ -z "${FAILED_MEMBER_ID}" ]]; then
  echo "ERROR: Could not find member named ${FAILED_MEMBER_NAME}"
  etcdctlw member list
  exit 1
fi

echo "Failed member ID: ${FAILED_MEMBER_ID}"

echo ""
echo "=== Step 3: Remove the failed member ==="
etcdctlw member remove "${FAILED_MEMBER_ID}"
echo "Member removed."

echo ""
echo "=== Step 4: Add the new member (in learner state first) ==="
etcdctlw member add "${NEW_MEMBER_NAME}" \
  --peer-urls="https://${NEW_MEMBER_IP}:2380"
# Note the member add output — it provides ETCD_INITIAL_CLUSTER for the new node

echo ""
echo "=== Step 5: Actions required on the NEW node ==="
echo "On ${NEW_MEMBER_NAME} (${NEW_MEMBER_IP}), run the following before starting etcd:"
echo ""

CURRENT_CLUSTER=$(etcdctlw member list --write-out=json | \
  jq -r '[.members[] | .name + "=" + .peerURLs[0]] | join(",")')

cat <<EOF
# Set these environment variables for the new etcd member
export ETCD_NAME="${NEW_MEMBER_NAME}"
export ETCD_INITIAL_CLUSTER="${CURRENT_CLUSTER}"
export ETCD_INITIAL_CLUSTER_STATE="existing"
export ETCD_INITIAL_ADVERTISE_PEER_URLS="https://${NEW_MEMBER_IP}:2380"
export ETCD_ADVERTISE_CLIENT_URLS="https://${NEW_MEMBER_IP}:2379"
export ETCD_LISTEN_PEER_URLS="https://${NEW_MEMBER_IP}:2380"
export ETCD_LISTEN_CLIENT_URLS="https://${NEW_MEMBER_IP}:2379"

# Remove any old data directory on the new node
rm -rf /var/lib/etcd

# Then start etcd with these environment variables
# The new member will sync all data from the existing cluster peers
EOF

echo ""
echo "After the new member starts and syncs, verify with:"
echo "  etcdctlw member list --write-out=table"
echo "  etcdctlw endpoint health"
```

## etcd Encryption at Rest

etcd encryption at rest is covered in the Secret Management section, but the configuration impacts etcd operations:

```bash
# After enabling/changing encryption, verify keys are encrypted in etcd
# Check a known secret — should show encrypted data, not plaintext
ETCDCTL_API=3 etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  get /registry/secrets/default/test-secret | \
  hexdump -C | head -5
# Encrypted output will show: k8s:enc:aescbc:v1 prefix
# Unencrypted output will show readable text

# Force re-encryption of all secrets after enabling encryption-at-rest
kubectl get secrets --all-namespaces -o json | kubectl replace -f -
```

## Backup Retention and DR Targets

### Retention Policy

| Backup type | Frequency | Retention | Storage |
|---|---|---|---|
| Hourly snapshot | Every 4 hours | 7 days (42 snapshots) | S3 standard |
| Daily snapshot | Daily at 02:00 | 30 days | S3 standard |
| Weekly snapshot | Sunday at 03:00 | 12 weeks | S3 infrequent access |
| Monthly snapshot | 1st of month | 12 months | S3 Glacier |

### RTO and RPO Targets

| Scenario | RPO target | RTO target | Notes |
|---|---|---|---|
| Single etcd member failure | 0 (cluster continues) | 15 minutes (member replacement) | No data loss; quorum maintained |
| Two member failure (3-member cluster) | 0 (read-only mode) | 30 minutes | Restore third member from snapshot + sync |
| Total cluster loss | ≤ 4 hours | 60 minutes | Restore from latest S3 snapshot |
| Ransomware / data corruption | ≤ 24 hours | 120 minutes | Point-in-time restore from daily snapshot |

### DR Readiness Verification

```bash
#!/bin/bash
# verify-dr-readiness.sh — Monthly DR readiness check
# Tests that the latest backup is restorable without impacting production
set -euo pipefail

S3_BUCKET="payments-prod-etcd-backups"
TEST_RESTORE_DIR="/tmp/etcd-dr-test-$(date +%Y%m%d)"

echo "=== etcd DR Readiness Verification ==="
echo "Date: $(date)"

echo ""
echo "--- Checking latest backup metadata ---"
aws s3 cp "s3://${S3_BUCKET}/prod-us-east-1/latest-backup.json" - | jq .

echo ""
echo "--- Downloading latest backup for restore test ---"
LATEST_KEY=$(aws s3 cp "s3://${S3_BUCKET}/prod-us-east-1/latest-backup.json" - | \
  jq -r '.s3_key')
aws s3 cp "s3://${S3_BUCKET}/${LATEST_KEY}" /tmp/etcd-dr-test.db

echo ""
echo "--- Verifying snapshot integrity ---"
ETCDCTL_API=3 etcdctl snapshot status /tmp/etcd-dr-test.db --write-out=table

echo ""
echo "--- Test restore to temporary directory ---"
mkdir -p "${TEST_RESTORE_DIR}"
ETCDCTL_API=3 etcdctl snapshot restore /tmp/etcd-dr-test.db \
  --data-dir="${TEST_RESTORE_DIR}" \
  --name=dr-test-member \
  --initial-cluster="dr-test-member=https://127.0.0.1:2380" \
  --initial-cluster-token="etcd-dr-test-$(date +%Y%m%d)" \
  --initial-advertise-peer-urls="https://127.0.0.1:2380"

echo ""
echo "--- Restore test successful ---"
echo "Data directory size: $(du -sh ${TEST_RESTORE_DIR})"

# Cleanup
rm -rf "${TEST_RESTORE_DIR}" /tmp/etcd-dr-test.db

echo ""
echo "=== DR Verification PASSED ==="
echo "Latest backup is valid and restorable."
echo "Record this result in the DR runbook log."
```

## Summary

Production etcd operations require attention across five areas:

1. Automated backups run every 4 hours with integrity verification before S3 upload, plus Prometheus alerts for backup staleness.
2. Monthly DR verification exercises using the `verify-dr-readiness.sh` script — backup validity is not meaningful unless the restore path is tested.
3. Weekly defragmentation to prevent database growth from consuming the quota and triggering write failures — defragment followers before the leader to minimize disruption.
4. Prometheus monitoring of the six key health metrics (has_leader, leader_changes, wal_fsync_duration, backend_commit_duration, db_total_size, peer_rtt) with alerting thresholds tuned to cluster-specific baselines.
5. Documented and tested member replacement runbooks, because a graceful member replacement in under 30 minutes is the difference between a minor incident and a prolonged outage.

etcd backup and recovery is not a one-time configuration task — it requires regular testing, monitoring, and operational discipline to ensure the cluster can be recovered when it matters most.
