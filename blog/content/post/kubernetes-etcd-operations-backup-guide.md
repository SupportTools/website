---
title: "Kubernetes etcd Operations: Backup, Restore, and Cluster Recovery"
date: 2028-01-10T00:00:00-05:00
draft: false
tags: ["Kubernetes", "etcd", "Backup", "Disaster Recovery", "Operations", "Database"]
categories:
- Kubernetes
- Operations
- Infrastructure
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive operational guide to Kubernetes etcd covering snapshot backup and restore, compaction and defragmentation, member replacement procedures, disaster recovery from backup, TLS certificate rotation, performance tuning, and etcd metrics monitoring."
more_link: "yes"
url: "/kubernetes-etcd-operations-backup-guide/"
---

etcd is the source of truth for all Kubernetes cluster state. Every object—pods, deployments, configmaps, secrets, custom resources—lives in etcd. A corrupted or unavailable etcd cluster renders a Kubernetes cluster non-functional: the API server cannot serve reads or writes, controllers cannot reconcile, and new pods cannot be scheduled. Despite this criticality, etcd operations are frequently neglected until an incident exposes the gap. This guide covers the complete operational lifecycle of etcd in production Kubernetes clusters: automated backup, tested restore procedures, member management, defragmentation, and performance tuning.

<!--more-->

# Kubernetes etcd Operations: Backup, Restore, and Cluster Recovery

## Section 1: etcd Architecture in Kubernetes

### How Kubernetes Uses etcd

The kube-apiserver is the only Kubernetes component that directly reads from and writes to etcd. All other components (scheduler, controller-manager, kubelet) interact with the API server, which in turn translates those operations into etcd reads and writes.

```
kubectl / other clients
          │
          ▼
┌─────────────────────┐
│   kube-apiserver    │──── etcd client (gRPC)
└─────────────────────┘
          │                         ┌─────────────────┐
          │                    ┌───▶│  etcd member 1  │
          │                    │    └─────────────────┘
          │          ┌─────────┴─┐
          │          │   etcd    │  ┌─────────────────┐
          └─────────▶│  cluster  │─▶│  etcd member 2  │
                     └─────────┬─┘  └─────────────────┘
                               │
                               │    ┌─────────────────┐
                               └───▶│  etcd member 3  │
                                    └─────────────────┘
```

### Raft Consensus and Quorum

etcd uses the Raft distributed consensus algorithm. A cluster requires a quorum (majority) of members to be healthy to process writes:

| Cluster Size | Quorum Required | Tolerated Failures |
|---|---|---|
| 1 | 1 | 0 (no HA) |
| 3 | 2 | 1 |
| 5 | 3 | 2 |
| 7 | 4 | 3 |

For production Kubernetes, three etcd members (one per control-plane node) is the minimum for high availability. Five members provide higher write availability at the cost of increased replication overhead.

### etcd Data Storage Layout

```bash
# etcd stores data in a BoltDB file (by default)
ls -la /var/lib/etcd/member/

# Key structure in etcd for Kubernetes objects
# /registry/<resource>/<namespace>/<name>
# Examples:
#   /registry/pods/production/api-server-abc123
#   /registry/secrets/production/db-credentials
#   /registry/deployments/production/api-server
#   /registry/configmaps/kube-system/coredns

# View etcd key space size
etcdctl \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  endpoint status --write-out=table
```

## Section 2: Snapshot Backup

### Manual Snapshot with etcdctl

```bash
#!/bin/bash
# etcd-backup.sh - Single node backup

ETCD_CACERT="/etc/kubernetes/pki/etcd/ca.crt"
ETCD_CERT="/etc/kubernetes/pki/etcd/server.crt"
ETCD_KEY="/etc/kubernetes/pki/etcd/server.key"
ETCD_ENDPOINTS="https://127.0.0.1:2379"
BACKUP_DIR="/var/backup/etcd"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
SNAPSHOT_FILE="${BACKUP_DIR}/etcd-snapshot-${TIMESTAMP}.db"

mkdir -p "${BACKUP_DIR}"

echo "Starting etcd snapshot backup..."

ETCDCTL_API=3 etcdctl snapshot save "${SNAPSHOT_FILE}" \
  --endpoints="${ETCD_ENDPOINTS}" \
  --cacert="${ETCD_CACERT}" \
  --cert="${ETCD_CERT}" \
  --key="${ETCD_KEY}"

EXIT_CODE=$?
if [[ "${EXIT_CODE}" -ne 0 ]]; then
  echo "ERROR: etcd snapshot failed with exit code ${EXIT_CODE}"
  exit "${EXIT_CODE}"
fi

echo "Verifying snapshot integrity..."
ETCDCTL_API=3 etcdctl snapshot status "${SNAPSHOT_FILE}" \
  --write-out=table

FILE_SIZE=$(stat -c%s "${SNAPSHOT_FILE}")
echo "Snapshot file: ${SNAPSHOT_FILE}"
echo "Snapshot size: $(numfmt --to=iec "${FILE_SIZE}")"

# Compress snapshot
gzip -9 "${SNAPSHOT_FILE}"
echo "Compressed snapshot: ${SNAPSHOT_FILE}.gz"

# Remove backups older than 7 days
find "${BACKUP_DIR}" -name "etcd-snapshot-*.db.gz" -mtime +7 -delete
echo "Cleaned up old backups (>7 days)"
```

### Automated Backup as a Kubernetes CronJob

```yaml
# etcd-backup-cronjob.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: etcd-backup
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: etcd-backup-role
rules:
- apiGroups: [""]
  resources: ["pods/exec"]
  verbs: ["create"]
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: etcd-backup-binding
subjects:
- kind: ServiceAccount
  name: etcd-backup
  namespace: kube-system
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: etcd-backup-role
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: etcd-backup
  namespace: kube-system
spec:
  # Run every hour
  schedule: "0 * * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: etcd-backup
          restartPolicy: OnFailure
          hostNetwork: true
          tolerations:
          - key: node-role.kubernetes.io/control-plane
            operator: Exists
            effect: NoSchedule
          nodeSelector:
            node-role.kubernetes.io/control-plane: ""
          containers:
          - name: etcd-backup
            image: registry.k8s.io/etcd:3.5.10-0
            command:
            - /bin/sh
            - -c
            - |
              set -e
              TIMESTAMP=$(date +%Y%m%d_%H%M%S)
              SNAPSHOT="/tmp/etcd-snapshot-${TIMESTAMP}.db"

              echo "Taking etcd snapshot..."
              etcdctl snapshot save "${SNAPSHOT}" \
                --endpoints=https://127.0.0.1:2379 \
                --cacert=/etc/kubernetes/pki/etcd/ca.crt \
                --cert=/etc/kubernetes/pki/etcd/server.crt \
                --key=/etc/kubernetes/pki/etcd/server.key

              echo "Verifying snapshot..."
              etcdctl snapshot status "${SNAPSHOT}" --write-out=table

              echo "Uploading to S3..."
              aws s3 cp "${SNAPSHOT}" \
                "s3://etcd-backups-prod/snapshots/etcd-snapshot-${TIMESTAMP}.db" \
                --sse aws:kms \
                --sse-kms-key-id "arn:aws:kms:us-east-1:123456789012:key/placeholder-key-id"

              echo "Backup complete: etcd-snapshot-${TIMESTAMP}.db"

              # Prune old backups (keep 72 hours)
              aws s3 ls "s3://etcd-backups-prod/snapshots/" \
                | awk '{print $4}' \
                | sort \
                | head -n -72 \
                | xargs -I {} aws s3 rm "s3://etcd-backups-prod/snapshots/{}" || true
            env:
            - name: AWS_REGION
              value: us-east-1
            - name: ETCDCTL_API
              value: "3"
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
          volumes:
          - name: etcd-certs
            hostPath:
              path: /etc/kubernetes/pki/etcd
              type: Directory
```

### Verifying Backup Integrity

```bash
#!/bin/bash
# verify-etcd-backup.sh
# Download and verify a recent backup

S3_BUCKET="etcd-backups-prod"
VERIFY_DIR="/tmp/etcd-verify"
mkdir -p "${VERIFY_DIR}"

echo "Listing recent backups..."
LATEST=$(aws s3 ls "s3://${S3_BUCKET}/snapshots/" \
  | sort -k1,2 \
  | tail -1 \
  | awk '{print $4}')

echo "Latest backup: ${LATEST}"
echo "Downloading for verification..."

aws s3 cp "s3://${S3_BUCKET}/snapshots/${LATEST}" "${VERIFY_DIR}/${LATEST}"

echo "Verifying snapshot status..."
ETCDCTL_API=3 etcdctl snapshot status \
  "${VERIFY_DIR}/${LATEST}" \
  --write-out=table

# Output should show:
# +----------+----------+------------+------------+
# |   HASH   | REVISION | TOTAL KEYS | TOTAL SIZE |
# +----------+----------+------------+------------+
# | abc12345 |   123456 |       1523 |     8.5 MB |
# +----------+----------+------------+------------+

echo "Backup verification complete."
rm -rf "${VERIFY_DIR}"
```

## Section 3: Compaction and Defragmentation

etcd maintains a complete history of all key revisions. Without compaction, the database grows indefinitely and memory usage increases proportionally.

### Automatic Compaction Configuration

```yaml
# kube-apiserver flags for automatic etcd compaction
# In /etc/kubernetes/manifests/kube-apiserver.yaml
spec:
  containers:
  - command:
    - kube-apiserver
    # Compact etcd history every 5 minutes
    - --etcd-compaction-interval=5m
    # Keep 8 hours of history
    - --etcd-count-compaction-revision=0
```

### Manual Compaction

```bash
# Get current revision
REVISION=$(etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  endpoint status \
  --write-out=json \
  | jq '.[0].Status.header.revision')

echo "Current revision: ${REVISION}"

# Compact history up to current revision
etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  compact "${REVISION}"

echo "Compaction complete."
```

### Defragmentation

Compaction removes the logical history but does not reclaim disk space. Defragmentation reclaims the freed space from the BoltDB database file.

```bash
#!/bin/bash
# etcd-defrag.sh
# Safe defragmentation procedure for a 3-node cluster

ETCD_ENDPOINTS=(
  "https://10.0.1.1:2379"
  "https://10.0.1.2:2379"
  "https://10.0.1.3:2379"
)

CACERT="/etc/kubernetes/pki/etcd/ca.crt"
CERT="/etc/kubernetes/pki/etcd/server.crt"
KEY="/etc/kubernetes/pki/etcd/server.key"

# Identify the leader (defrag followers first, leader last)
LEADER=$(ETCDCTL_API=3 etcdctl endpoint status \
  --endpoints="${ETCD_ENDPOINTS[*]}" \
  --cacert="${CACERT}" \
  --cert="${CERT}" \
  --key="${KEY}" \
  --write-out=json \
  | jq -r '.[] | select(.Status.leader == .Status.header.member_id) | .Endpoint')

echo "Cluster leader: ${LEADER}"

# Defragment followers first
for ENDPOINT in "${ETCD_ENDPOINTS[@]}"; do
  if [[ "${ENDPOINT}" == "${LEADER}" ]]; then
    echo "Skipping leader ${LEADER} (will defrag last)"
    continue
  fi

  echo "Defragmenting follower: ${ENDPOINT}"
  BEFORE=$(ETCDCTL_API=3 etcdctl endpoint status \
    --endpoints="${ENDPOINT}" \
    --cacert="${CACERT}" \
    --cert="${CERT}" \
    --key="${KEY}" \
    --write-out=json \
    | jq -r '.[0].Status.dbSizeInUse')

  ETCDCTL_API=3 etcdctl defrag \
    --endpoints="${ENDPOINT}" \
    --cacert="${CACERT}" \
    --cert="${CERT}" \
    --key="${KEY}"

  AFTER=$(ETCDCTL_API=3 etcdctl endpoint status \
    --endpoints="${ENDPOINT}" \
    --cacert="${CACERT}" \
    --cert="${CERT}" \
    --key="${KEY}" \
    --write-out=json \
    | jq -r '.[0].Status.dbSizeInUse')

  echo "  Before: $(numfmt --to=iec "${BEFORE}")"
  echo "  After:  $(numfmt --to=iec "${AFTER}")"

  # Wait for follower to fully recover
  sleep 30
done

# Defragment the leader last
echo "Defragmenting leader: ${LEADER}"
ETCDCTL_API=3 etcdctl defrag \
  --endpoints="${LEADER}" \
  --cacert="${CACERT}" \
  --cert="${CERT}" \
  --key="${KEY}"

echo "Defragmentation complete."

# Verify cluster health
ETCDCTL_API=3 etcdctl endpoint health \
  --endpoints="${ETCD_ENDPOINTS[*]}" \
  --cacert="${CACERT}" \
  --cert="${CERT}" \
  --key="${KEY}" \
  --write-out=table
```

## Section 4: Member Management

### Adding a New etcd Member

When recovering a failed member or expanding a cluster, the procedure must follow a strict order to avoid data loss.

```bash
#!/bin/bash
# add-etcd-member.sh
# Add a new etcd member to an existing cluster

NEW_MEMBER_NAME="etcd-node-4"
NEW_MEMBER_IP="10.0.1.4"
NEW_PEER_URL="https://${NEW_MEMBER_IP}:2380"

CACERT="/etc/kubernetes/pki/etcd/ca.crt"
CERT="/etc/kubernetes/pki/etcd/server.crt"
KEY="/etc/kubernetes/pki/etcd/server.key"
EXISTING_ENDPOINT="https://10.0.1.1:2379"

echo "Step 1: Register new member with cluster..."
ETCDCTL_API=3 etcdctl member add "${NEW_MEMBER_NAME}" \
  --endpoints="${EXISTING_ENDPOINT}" \
  --cacert="${CACERT}" \
  --cert="${CERT}" \
  --key="${KEY}" \
  --peer-urls="${NEW_PEER_URL}"

echo ""
echo "Step 2: Note the INITIAL_CLUSTER and INITIAL_CLUSTER_STATE from output above"
echo "Step 3: Start etcd on the new node with:"
echo ""
echo "etcd \\"
echo "  --name=${NEW_MEMBER_NAME} \\"
echo "  --data-dir=/var/lib/etcd \\"
echo "  --listen-peer-urls=https://${NEW_MEMBER_IP}:2380 \\"
echo "  --listen-client-urls=https://${NEW_MEMBER_IP}:2379 \\"
echo "  --advertise-client-urls=https://${NEW_MEMBER_IP}:2379 \\"
echo "  --initial-advertise-peer-urls=${NEW_PEER_URL} \\"
echo "  --initial-cluster=<FROM_MEMBER_ADD_OUTPUT> \\"
echo "  --initial-cluster-state=existing \\"  # Important: existing, not new
echo "  --cert-file=/etc/kubernetes/pki/etcd/server.crt \\"
echo "  --key-file=/etc/kubernetes/pki/etcd/server.key \\"
echo "  --trusted-ca-file=/etc/kubernetes/pki/etcd/ca.crt \\"
echo "  --peer-cert-file=/etc/kubernetes/pki/etcd/peer.crt \\"
echo "  --peer-key-file=/etc/kubernetes/pki/etcd/peer.key \\"
echo "  --peer-trusted-ca-file=/etc/kubernetes/pki/etcd/ca.crt \\"
echo "  --peer-client-cert-auth=true \\"
echo "  --client-cert-auth=true"
```

### Removing a Failed Member

```bash
# List current members
ETCDCTL_API=3 etcdctl member list \
  --endpoints=https://10.0.1.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  --write-out=table

# Remove a failed member (use the member ID from the list output)
FAILED_MEMBER_ID="1a2b3c4d5e6f7a8b"

ETCDCTL_API=3 etcdctl member remove "${FAILED_MEMBER_ID}" \
  --endpoints=https://10.0.1.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key

# Verify member removed
ETCDCTL_API=3 etcdctl member list \
  --endpoints=https://10.0.1.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key
```

## Section 5: Disaster Recovery from Backup

### Single Control-Plane Restore

```bash
#!/bin/bash
# restore-single-node.sh
# Restore a single control-plane etcd from snapshot

SNAPSHOT_FILE="$1"
ETCD_DATA_DIR="/var/lib/etcd"
NODE_NAME=$(hostname)
NODE_IP=$(hostname -I | awk '{print $1}')

if [[ -z "${SNAPSHOT_FILE}" ]]; then
  echo "Usage: $0 <snapshot-file>"
  exit 1
fi

if [[ ! -f "${SNAPSHOT_FILE}" ]]; then
  echo "ERROR: Snapshot file not found: ${SNAPSHOT_FILE}"
  exit 1
fi

echo "=== etcd Single Node Restore ==="
echo "Snapshot: ${SNAPSHOT_FILE}"
echo "Node: ${NODE_NAME} (${NODE_IP})"
echo ""

# Step 1: Stop kube-apiserver and etcd
echo "Step 1: Stopping kube-apiserver and etcd..."
mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/kube-apiserver.yaml.restore
mv /etc/kubernetes/manifests/etcd.yaml /tmp/etcd.yaml.restore

# Wait for containers to stop
echo "Waiting for containers to stop..."
sleep 20

# Verify stopped
if crictl pods 2>/dev/null | grep -q "kube-apiserver\|etcd"; then
  echo "WARNING: Pods still running, waiting longer..."
  sleep 30
fi

# Step 2: Backup existing data
echo "Step 2: Backing up existing etcd data..."
mv "${ETCD_DATA_DIR}" "${ETCD_DATA_DIR}.bak.$(date +%s)"

# Step 3: Restore snapshot
echo "Step 3: Restoring etcd from snapshot..."
ETCDCTL_API=3 etcdctl snapshot restore "${SNAPSHOT_FILE}" \
  --data-dir="${ETCD_DATA_DIR}" \
  --name="${NODE_NAME}" \
  --initial-cluster="${NODE_NAME}=https://${NODE_IP}:2380" \
  --initial-advertise-peer-urls="https://${NODE_IP}:2380" \
  --initial-cluster-token="etcd-cluster-restored-$(date +%s)"

# Step 4: Fix permissions
chown -R etcd:etcd "${ETCD_DATA_DIR}" 2>/dev/null || \
  chown -R root:root "${ETCD_DATA_DIR}"

# Step 5: Restore static pod manifests
echo "Step 5: Restoring kube-apiserver and etcd manifests..."
mv /tmp/etcd.yaml.restore /etc/kubernetes/manifests/etcd.yaml

echo "Waiting for etcd to start..."
sleep 30

# Step 6: Verify etcd is healthy
for i in $(seq 1 12); do
  if ETCDCTL_API=3 etcdctl endpoint health \
     --endpoints=https://127.0.0.1:2379 \
     --cacert=/etc/kubernetes/pki/etcd/ca.crt \
     --cert=/etc/kubernetes/pki/etcd/server.crt \
     --key=/etc/kubernetes/pki/etcd/server.key \
     2>/dev/null; then
    echo "etcd is healthy"
    break
  fi
  echo "Waiting for etcd... (attempt ${i}/12)"
  sleep 10
done

# Step 7: Restore API server
mv /tmp/kube-apiserver.yaml.restore /etc/kubernetes/manifests/kube-apiserver.yaml

echo "Waiting for API server..."
for i in $(seq 1 24); do
  if kubectl get nodes --request-timeout=5s &>/dev/null; then
    echo "API server is healthy"
    break
  fi
  echo "Waiting for API server... (attempt ${i}/24)"
  sleep 10
done

echo ""
echo "=== Restore Complete ==="
kubectl get nodes
kubectl -n kube-system get pods | head -20
```

### Multi-Control-Plane Restore

Restoring a multi-node etcd cluster requires restoring from the same snapshot on all members simultaneously:

```bash
#!/bin/bash
# restore-multi-node.sh
# Restore 3-node etcd cluster from single snapshot

SNAPSHOT_FILE="$1"
NODES=(
  "master-1:10.0.1.1"
  "master-2:10.0.1.2"
  "master-3:10.0.1.3"
)

INITIAL_CLUSTER="master-1=https://10.0.1.1:2380,master-2=https://10.0.1.2:2380,master-3=https://10.0.1.3:2380"
CLUSTER_TOKEN="etcd-cluster-restored-$(date +%s)"

if [[ -z "${SNAPSHOT_FILE}" ]]; then
  echo "Usage: $0 <snapshot-file>"
  exit 1
fi

echo "Distributing snapshot to all nodes..."
for entry in "${NODES[@]}"; do
  NAME="${entry%%:*}"
  IP="${entry##*:}"
  scp "${SNAPSHOT_FILE}" "root@${IP}:/tmp/etcd-restore-snapshot.db"
done

echo "Stopping kube-apiserver on all nodes..."
for entry in "${NODES[@]}"; do
  IP="${entry##*:}"
  ssh "root@${IP}" "mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/kube-apiserver.yaml.bak && \
                   mv /etc/kubernetes/manifests/etcd.yaml /tmp/etcd.yaml.bak"
done

sleep 30

echo "Restoring etcd on all nodes simultaneously..."
for entry in "${NODES[@]}"; do
  NAME="${entry%%:*}"
  IP="${entry##*:}"

  ssh "root@${IP}" "
    ETCDCTL_API=3 etcdctl snapshot restore /tmp/etcd-restore-snapshot.db \
      --data-dir=/var/lib/etcd \
      --name=${NAME} \
      --initial-cluster=${INITIAL_CLUSTER} \
      --initial-advertise-peer-urls=https://${IP}:2380 \
      --initial-cluster-token=${CLUSTER_TOKEN}
  " &
done

wait
echo "Snapshot restore commands launched on all nodes."

echo "Starting etcd on all nodes..."
for entry in "${NODES[@]}"; do
  IP="${entry##*:}"
  ssh "root@${IP}" "mv /tmp/etcd.yaml.bak /etc/kubernetes/manifests/etcd.yaml"
done

sleep 45

echo "Verifying etcd cluster health..."
ETCDCTL_API=3 etcdctl endpoint health \
  --endpoints="https://10.0.1.1:2379,https://10.0.1.2:2379,https://10.0.1.3:2379" \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  --write-out=table

echo "Starting kube-apiserver on all nodes..."
for entry in "${NODES[@]}"; do
  IP="${entry##*:}"
  ssh "root@${IP}" "mv /tmp/kube-apiserver.yaml.bak /etc/kubernetes/manifests/kube-apiserver.yaml"
done

echo "Restore complete."
```

## Section 6: TLS Certificate Rotation

etcd uses mTLS for peer-to-peer communication and client-to-server communication. Certificates must be rotated before expiry.

### Checking etcd Certificate Expiry

```bash
#!/bin/bash
# check-etcd-cert-expiry.sh

CERT_DIR="/etc/kubernetes/pki/etcd"
CERTS=(
  "ca.crt"
  "server.crt"
  "peer.crt"
  "healthcheck-client.crt"
)

WARN_DAYS=30

echo "=== etcd Certificate Expiry Report ==="
echo ""

for cert in "${CERTS[@]}"; do
  CERT_PATH="${CERT_DIR}/${cert}"
  if [[ -f "${CERT_PATH}" ]]; then
    EXPIRY=$(openssl x509 -enddate -noout -in "${CERT_PATH}" | sed 's/notAfter=//')
    EXPIRY_EPOCH=$(date -d "${EXPIRY}" +%s)
    NOW_EPOCH=$(date +%s)
    DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))

    if [[ "${DAYS_LEFT}" -lt "${WARN_DAYS}" ]]; then
      STATUS="WARNING"
    else
      STATUS="OK"
    fi

    printf "%-40s  Expires: %-30s  Days remaining: %d  [%s]\n" \
      "${cert}" "${EXPIRY}" "${DAYS_LEFT}" "${STATUS}"
  fi
done
```

### Rotating etcd Certificates with kubeadm

```bash
# Renew etcd certificates using kubeadm
kubeadm certs renew etcd-ca
kubeadm certs renew etcd-server
kubeadm certs renew etcd-peer
kubeadm certs renew etcd-healthcheck-client
kubeadm certs renew apiserver-etcd-client

# Verify renewal
kubeadm certs check-expiration

# Restart etcd to pick up new certificates
kubectl -n kube-system delete pod -l component=etcd
kubectl -n kube-system wait --for=condition=Ready pod -l component=etcd --timeout=120s

# Restart kube-apiserver (uses apiserver-etcd-client cert)
kubectl -n kube-system delete pod -l component=kube-apiserver
kubectl -n kube-system wait --for=condition=Ready pod -l component=kube-apiserver --timeout=120s
```

### Manual Certificate Rotation

For clusters not managed by kubeadm:

```bash
#!/bin/bash
# rotate-etcd-certs.sh

CERT_DIR="/etc/kubernetes/pki/etcd"
CA_CERT="${CERT_DIR}/ca.crt"
CA_KEY="${CERT_DIR}/ca.key"
NODE_IP="10.0.1.1"
NODE_NAME=$(hostname)

echo "Generating new server certificate..."
openssl genrsa -out "${CERT_DIR}/server-new.key" 4096

openssl req -new \
  -key "${CERT_DIR}/server-new.key" \
  -subj "/CN=etcd-server/O=system:masters" \
  -out "${CERT_DIR}/server-new.csr"

cat > /tmp/etcd-server-ext.cnf <<EOF
subjectAltName = IP:${NODE_IP},IP:127.0.0.1,DNS:localhost,DNS:${NODE_NAME}
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth, clientAuth
EOF

openssl x509 -req \
  -in "${CERT_DIR}/server-new.csr" \
  -CA "${CA_CERT}" \
  -CAkey "${CA_KEY}" \
  -CAcreateserial \
  -out "${CERT_DIR}/server-new.crt" \
  -days 365 \
  -extfile /tmp/etcd-server-ext.cnf

echo "Verifying new certificate..."
openssl verify -CAfile "${CA_CERT}" "${CERT_DIR}/server-new.crt"

echo "Backing up existing certificates..."
cp "${CERT_DIR}/server.crt" "${CERT_DIR}/server.crt.bak.$(date +%s)"
cp "${CERT_DIR}/server.key" "${CERT_DIR}/server.key.bak.$(date +%s)"

echo "Replacing certificates..."
mv "${CERT_DIR}/server-new.crt" "${CERT_DIR}/server.crt"
mv "${CERT_DIR}/server-new.key" "${CERT_DIR}/server.key"

echo "Restarting etcd..."
systemctl restart etcd  # or kill static pod
```

## Section 7: etcd Performance Tuning

### Key Performance Parameters

```yaml
# etcd configuration for production performance
# In /etc/kubernetes/manifests/etcd.yaml

spec:
  containers:
  - name: etcd
    command:
    - etcd
    - --name=$(HOSTNAME)
    - --data-dir=/var/lib/etcd
    # Disk latency thresholds
    - --heartbeat-interval=250       # ms between leader heartbeats
    - --election-timeout=1250        # ms for follower to call election
    # Database size limit
    - --quota-backend-bytes=8589934592  # 8GB quota before alarms
    # Snapshots for faster follower recovery
    - --snapshot-count=10000
    # TLS configuration
    - --cert-file=/etc/kubernetes/pki/etcd/server.crt
    - --key-file=/etc/kubernetes/pki/etcd/server.key
    - --trusted-ca-file=/etc/kubernetes/pki/etcd/ca.crt
    - --client-cert-auth=true
    - --peer-cert-file=/etc/kubernetes/pki/etcd/peer.crt
    - --peer-key-file=/etc/kubernetes/pki/etcd/peer.key
    - --peer-trusted-ca-file=/etc/kubernetes/pki/etcd/ca.crt
    - --peer-client-cert-auth=true
    # Logging
    - --logger=zap
    - --log-level=warn
    # Auto compaction
    - --auto-compaction-retention=8h
    - --auto-compaction-mode=periodic
```

### Storage Requirements

```bash
# Check current etcd database size
ETCDCTL_API=3 etcdctl endpoint status \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  --write-out=table

# Check for space alarm (triggered when quota is reached)
ETCDCTL_API=3 etcdctl alarm list \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key

# Disarm alarm after compaction and defragmentation
ETCDCTL_API=3 etcdctl alarm disarm \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key
```

### Disk Latency Tuning

etcd is highly sensitive to disk write latency. For production clusters:

```bash
# Verify disk I/O performance (should see <10ms for 99th percentile)
fio --filename=/var/lib/etcd/etcd-disk-test \
    --direct=1 \
    --sync=1 \
    --rw=write \
    --bs=22b \
    --numjobs=1 \
    --iodepth=1 \
    --runtime=120 \
    --time_based \
    --group_reporting \
    --name=etcd-fsync-test \
    --output-format=json \
    | jq '.jobs[0].sync.lat_ns | {
        mean: (.mean/1000000),
        p99: (.percentile."99.000000"/1000000),
        max: (.max/1000000)
      }'

# Recommended: Use dedicated SSD or NVMe
# AWS: io2 EBS volumes with 3000+ IOPS
# GCP: SSD persistent disks
# Azure: Premium SSD
```

## Section 8: Monitoring with etcd Metrics

### Key etcd Metrics to Monitor

```yaml
# etcd-prometheusrule.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: etcd-alerts
  namespace: monitoring
spec:
  groups:
  - name: etcd.alerts
    rules:
    - alert: EtcdInsufficientMembers
      expr: |
        count(etcd_server_id) < 2
      for: 3m
      labels:
        severity: critical
      annotations:
        summary: "etcd cluster has insufficient members"
        description: "etcd cluster has only {{ $value }} members (quorum requires 2)."

    - alert: EtcdHighCommitDuration
      expr: |
        histogram_quantile(0.99,
          rate(etcd_disk_backend_commit_duration_seconds_bucket[5m])
        ) > 0.25
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "etcd commit latency high"
        description: "99th percentile commit duration is {{ $value }}s (threshold: 0.25s)."

    - alert: EtcdHighWalFsyncDuration
      expr: |
        histogram_quantile(0.99,
          rate(etcd_disk_wal_fsync_duration_seconds_bucket[5m])
        ) > 0.5
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "etcd WAL fsync latency high"
        description: "99th percentile WAL fsync is {{ $value }}s. Check disk I/O."

    - alert: EtcdDatabaseSizeWarning
      expr: |
        etcd_mvcc_db_total_size_in_bytes > 6e9
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "etcd database size approaching quota"
        description: "etcd database is {{ $value | humanize1024 }}B. Quota is 8GB."

    - alert: EtcdLeaderChanges
      expr: |
        increase(etcd_server_leader_changes_seen_total[1h]) > 3
      for: 0m
      labels:
        severity: warning
      annotations:
        summary: "etcd frequent leader changes"
        description: "{{ $value }} leader changes in the last hour. Check network and disk latency."

    - alert: EtcdNoLeader
      expr: |
        etcd_server_has_leader == 0
      for: 1m
      labels:
        severity: critical
      annotations:
        summary: "etcd has no leader"
        description: "etcd member {{ $labels.instance }} has no leader. Cluster may be unavailable."
```

### Grafana Dashboard Queries for etcd

```promql
# Write throughput (keys per second)
rate(etcd_mvcc_put_total[5m])

# Read throughput
rate(etcd_mvcc_range_total[5m])

# Backend commit duration (99th percentile)
histogram_quantile(0.99, rate(etcd_disk_backend_commit_duration_seconds_bucket[5m]))

# WAL fsync duration (99th percentile)
histogram_quantile(0.99, rate(etcd_disk_wal_fsync_duration_seconds_bucket[5m]))

# Database size
etcd_mvcc_db_total_size_in_bytes

# Active connections
etcd_network_active_peers

# Proposal failure rate
rate(etcd_server_proposals_failed_total[5m])

# Raft peer RTT
histogram_quantile(0.99, rate(etcd_network_peer_round_trip_time_seconds_bucket[5m]))
```

## Section 9: Operational Runbook

### Pre-Maintenance Checklist

```bash
#!/bin/bash
# etcd-pre-maintenance-check.sh

echo "=== etcd Pre-Maintenance Health Check ==="
echo ""

ENDPOINTS="https://10.0.1.1:2379,https://10.0.1.2:2379,https://10.0.1.3:2379"
CACERT="/etc/kubernetes/pki/etcd/ca.crt"
CERT="/etc/kubernetes/pki/etcd/server.crt"
KEY="/etc/kubernetes/pki/etcd/server.key"

echo "1. Cluster endpoint health:"
ETCDCTL_API=3 etcdctl endpoint health \
  --endpoints="${ENDPOINTS}" \
  --cacert="${CACERT}" \
  --cert="${CERT}" \
  --key="${KEY}" \
  --write-out=table

echo ""
echo "2. Cluster status:"
ETCDCTL_API=3 etcdctl endpoint status \
  --endpoints="${ENDPOINTS}" \
  --cacert="${CACERT}" \
  --cert="${CERT}" \
  --key="${KEY}" \
  --write-out=table

echo ""
echo "3. Active alarms:"
ALARMS=$(ETCDCTL_API=3 etcdctl alarm list \
  --endpoints="${ENDPOINTS%,*}" \
  --cacert="${CACERT}" \
  --cert="${CERT}" \
  --key="${KEY}" 2>&1)
if [[ -z "${ALARMS}" ]]; then
  echo "   No active alarms"
else
  echo "${ALARMS}"
fi

echo ""
echo "4. Certificate expiry:"
for cert in /etc/kubernetes/pki/etcd/*.crt; do
  DAYS=$(( ($(date -d "$(openssl x509 -enddate -noout -in "${cert}" | cut -d= -f2)" +%s) - $(date +%s)) / 86400 ))
  printf "   %-50s  %d days\n" "${cert##*/}" "${DAYS}"
done

echo ""
echo "5. Database size and fragmentation:"
DB_SIZE=$(ETCDCTL_API=3 etcdctl endpoint status \
  --endpoints="${ENDPOINTS%,*}" \
  --cacert="${CACERT}" \
  --cert="${CERT}" \
  --key="${KEY}" \
  --write-out=json 2>/dev/null | jq -r '.[0].Status.dbSize')
DB_IN_USE=$(ETCDCTL_API=3 etcdctl endpoint status \
  --endpoints="${ENDPOINTS%,*}" \
  --cacert="${CACERT}" \
  --cert="${CERT}" \
  --key="${KEY}" \
  --write-out=json 2>/dev/null | jq -r '.[0].Status.dbSizeInUse')
FRAGMENTATION=$(echo "scale=1; (1 - ${DB_IN_USE} / ${DB_SIZE}) * 100" | bc)
echo "   Total size: $(numfmt --to=iec "${DB_SIZE}")"
echo "   In use:     $(numfmt --to=iec "${DB_IN_USE}")"
echo "   Fragmentation: ${FRAGMENTATION}%"
if (( $(echo "${FRAGMENTATION} > 20" | bc -l) )); then
  echo "   WARNING: High fragmentation, consider running defrag"
fi

echo ""
echo "Pre-maintenance check complete."
```

## Conclusion

etcd operational excellence requires three practices working in concert: automated and tested backups, proactive monitoring with alerts on performance and health signals, and documented recovery procedures that have been exercised in drills.

The backup procedure is only as valuable as the restore test. Every backup system that has never been tested in a restore scenario should be treated as unverified. Scheduling quarterly restore drills against a non-production cluster validates that the snapshot is intact, the restore procedure works, and the team members responsible know how to execute it under pressure.

Defragmentation and compaction are not optional maintenance tasks—they are prerequisites for long-lived clusters that avoid hitting the etcd space quota, which triggers an alarm that causes the API server to reject all write requests. Automating these operations with proper safeguards (one member at a time, health verification between steps) keeps the cluster healthy without requiring manual intervention.
