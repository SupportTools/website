---
title: "Kubernetes StatefulSet Rolling Updates: Zero-Downtime Database Upgrades"
date: 2028-12-20T00:00:00-05:00
draft: false
tags: ["Kubernetes", "StatefulSet", "Rolling Updates", "Databases", "Zero Downtime", "PostgreSQL"]
categories:
- Kubernetes
- Databases
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to executing zero-downtime database upgrades using Kubernetes StatefulSet rolling update strategies, covering PostgreSQL, MySQL, and distributed datastores with production-tested patterns."
more_link: "yes"
url: "/kubernetes-statefulset-rolling-updates-zero-downtime-database-upgrades/"
---

Upgrading stateful workloads in Kubernetes demands a different approach than upgrading stateless microservices. Databases carry persistent data, maintain replication topologies, and rely on quorum. A poorly orchestrated StatefulSet rolling update can corrupt data, partition a cluster, or cause cascading failures that take hours to recover from. This post examines production-grade patterns for zero-downtime database upgrades using Kubernetes StatefulSet rolling update semantics, covering readiness gates, partition-based staged rollouts, pre- and post-upgrade hooks, and real-world examples with PostgreSQL and Cassandra.

<!--more-->

## StatefulSet Update Mechanics

Unlike Deployments, StatefulSets update pods in a strictly ordered, one-at-a-time sequence — highest ordinal first. This matters enormously for databases where replica topology (primary, secondary, replica) follows ordinal assignments.

The update strategy is configured under `.spec.updateStrategy`:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: prod-db
spec:
  serviceName: postgres-headless
  replicas: 3
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      partition: 3        # Start with partition=replicas to pause rollout
      maxUnavailable: 1   # Kubernetes 1.24+ feature
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      terminationGracePeriodSeconds: 120
      containers:
      - name: postgres
        image: postgres:16.2
        ports:
        - containerPort: 5432
          name: postgres
        env:
        - name: PGDATA
          value: /var/lib/postgresql/data/pgdata
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-credentials
              key: password
        readinessProbe:
          exec:
            command:
            - /bin/sh
            - -c
            - pg_isready -U postgres -d postgres
          initialDelaySeconds: 10
          periodSeconds: 5
          failureThreshold: 6
        livenessProbe:
          exec:
            command:
            - /bin/sh
            - -c
            - pg_isready -U postgres -d postgres
          initialDelaySeconds: 30
          periodSeconds: 10
          failureThreshold: 3
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
        resources:
          requests:
            cpu: "500m"
            memory: "2Gi"
          limits:
            cpu: "2000m"
            memory: "8Gi"
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: gp3-encrypted
      resources:
        requests:
          storage: 100Gi
```

### The Partition Field

The `partition` field is the most important lever for controlled StatefulSet upgrades. Pods with ordinal >= partition are updated; pods with ordinal < partition retain their current revision. Setting `partition` equal to the replica count effectively freezes the rollout — no pods update until the partition is lowered.

This enables a canary-style approach for databases:

1. Set `partition: 3` (all pods frozen)
2. Update the image tag
3. Lower to `partition: 2` — only pod-2 (replica) updates
4. Validate replication health
5. Lower to `partition: 1` — pod-1 (replica) updates
6. Validate again
7. Lower to `partition: 0` — pod-0 (primary) updates last

## Pre-Upgrade Validation Framework

Before modifying any StatefulSet, validate cluster health comprehensively.

### PostgreSQL Pre-Upgrade Checklist Script

```bash
#!/bin/bash
# pre-upgrade-validate.sh
# Validates PostgreSQL StatefulSet readiness before rolling update

set -euo pipefail

NAMESPACE="${1:-prod-db}"
STATEFULSET="${2:-postgres}"
REPLICAS=$(kubectl get sts "${STATEFULSET}" -n "${NAMESPACE}" -o jsonpath='{.spec.replicas}')

echo "=== Pre-Upgrade Validation: ${STATEFULSET} in ${NAMESPACE} ==="
echo "Expected replicas: ${REPLICAS}"

# 1. Verify all pods are Running and Ready
echo ""
echo "--- Pod Status ---"
READY_PODS=$(kubectl get pods -n "${NAMESPACE}" \
  -l "app=${STATEFULSET}" \
  --field-selector=status.phase=Running \
  -o jsonpath='{.items[*].status.conditions[?(@.type=="Ready")].status}' | \
  tr ' ' '\n' | grep -c "True" || true)

if [ "${READY_PODS}" -ne "${REPLICAS}" ]; then
  echo "ERROR: Only ${READY_PODS}/${REPLICAS} pods are Ready"
  kubectl get pods -n "${NAMESPACE}" -l "app=${STATEFULSET}"
  exit 1
fi
echo "OK: All ${REPLICAS} pods are Ready"

# 2. Check replication lag on all replicas
echo ""
echo "--- Replication Lag ---"
for i in $(seq 0 $((REPLICAS - 1))); do
  POD="${STATEFULSET}-${i}"
  LAG=$(kubectl exec -n "${NAMESPACE}" "${POD}" -- \
    psql -U postgres -t -c \
    "SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::INT AS lag_seconds;" \
    2>/dev/null | tr -d ' ' || echo "primary")
  echo "  ${POD}: lag=${LAG}s"
  if [[ "${LAG}" =~ ^[0-9]+$ ]] && [ "${LAG}" -gt 30 ]; then
    echo "ERROR: Replication lag on ${POD} is ${LAG}s — exceeds 30s threshold"
    exit 1
  fi
done

# 3. Verify PVC health
echo ""
echo "--- PVC Status ---"
for i in $(seq 0 $((REPLICAS - 1))); do
  PVC="data-${STATEFULSET}-${i}"
  STATUS=$(kubectl get pvc "${PVC}" -n "${NAMESPACE}" -o jsonpath='{.status.phase}')
  echo "  ${PVC}: ${STATUS}"
  if [ "${STATUS}" != "Bound" ]; then
    echo "ERROR: PVC ${PVC} is not Bound"
    exit 1
  fi
done

# 4. Snapshot PVCs before upgrade
echo ""
echo "--- Creating Volume Snapshots ---"
for i in $(seq 0 $((REPLICAS - 1))); do
  PVC="data-${STATEFULSET}-${i}"
  SNAPSHOT_NAME="${STATEFULSET}-pre-upgrade-$(date +%Y%m%d%H%M)-${i}"
  cat <<EOF | kubectl apply -f -
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: ${SNAPSHOT_NAME}
  namespace: ${NAMESPACE}
  labels:
    upgrade-pre-snapshot: "true"
    statefulset: ${STATEFULSET}
spec:
  volumeSnapshotClassName: csi-aws-vsc
  source:
    persistentVolumeClaimName: ${PVC}
EOF
  echo "  Created snapshot: ${SNAPSHOT_NAME}"
done

echo ""
echo "=== Pre-upgrade validation PASSED ==="
```

## Staged Partition Rollout

### Rollout Controller Script

```bash
#!/bin/bash
# staged-rollout.sh
# Executes a partition-based staged rollout for a StatefulSet

set -euo pipefail

NAMESPACE="${1:-prod-db}"
STATEFULSET="${2:-postgres}"
NEW_IMAGE="${3:-postgres:16.3}"
VALIDATION_WAIT="${4:-120}"  # seconds to wait between stages

REPLICAS=$(kubectl get sts "${STATEFULSET}" -n "${NAMESPACE}" \
  -o jsonpath='{.spec.replicas}')

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

wait_for_pod_ready() {
  local pod="$1"
  local timeout="${2:-300}"
  log "Waiting for ${pod} to be Ready (timeout: ${timeout}s)..."
  kubectl wait pod "${pod}" -n "${NAMESPACE}" \
    --for=condition=Ready \
    --timeout="${timeout}s"
}

validate_replication() {
  log "Validating replication health..."
  local unhealthy=0
  for i in $(seq 0 $((REPLICAS - 1))); do
    local pod="${STATEFULSET}-${i}"
    local is_primary
    is_primary=$(kubectl exec -n "${NAMESPACE}" "${pod}" -- \
      psql -U postgres -t -c \
      "SELECT pg_is_in_recovery();" 2>/dev/null | tr -d ' \n')
    if [ "${is_primary}" = "f" ]; then
      log "  ${pod}: PRIMARY"
      local standby_count
      standby_count=$(kubectl exec -n "${NAMESPACE}" "${pod}" -- \
        psql -U postgres -t -c \
        "SELECT COUNT(*) FROM pg_stat_replication WHERE state='streaming';" \
        2>/dev/null | tr -d ' \n')
      log "  ${pod}: streaming standbys=${standby_count}"
      if [ "${standby_count}" -lt $((REPLICAS - 1)) ]; then
        log "WARNING: Not all standbys are streaming"
        unhealthy=1
      fi
    else
      log "  ${pod}: REPLICA"
    fi
  done
  return "${unhealthy}"
}

# Step 1: Freeze rollout by setting partition=replicas
log "Step 1: Freezing rollout (partition=${REPLICAS})"
kubectl patch sts "${STATEFULSET}" -n "${NAMESPACE}" \
  --type=json \
  -p="[{\"op\":\"replace\",\"path\":\"/spec/updateStrategy/rollingUpdate/partition\",\"value\":${REPLICAS}}]"

# Step 2: Update the image
log "Step 2: Updating image to ${NEW_IMAGE}"
kubectl set image statefulset/"${STATEFULSET}" \
  postgres="${NEW_IMAGE}" \
  -n "${NAMESPACE}"

# Step 3: Roll out one pod at a time, highest ordinal first
for i in $(seq $((REPLICAS - 1)) -1 0); do
  log "Step 3.${i}: Updating pod ${STATEFULSET}-${i}"

  # Lower the partition to include pod i
  kubectl patch sts "${STATEFULSET}" -n "${NAMESPACE}" \
    --type=json \
    -p="[{\"op\":\"replace\",\"path\":\"/spec/updateStrategy/rollingUpdate/partition\",\"value\":${i}}]"

  # Wait for the pod to terminate and restart
  sleep 5
  wait_for_pod_ready "${STATEFULSET}-${i}" 300

  # Validate after each pod update
  log "Validating after updating ${STATEFULSET}-${i}..."
  sleep "${VALIDATION_WAIT}"

  if ! validate_replication; then
    log "ERROR: Replication validation failed after updating ${STATEFULSET}-${i}"
    log "Halting rollout at partition=${i}. Manual intervention required."
    exit 1
  fi

  log "Pod ${STATEFULSET}-${i} updated and validated successfully"
done

log "=== Rollout complete. All pods running ${NEW_IMAGE} ==="
kubectl get pods -n "${NAMESPACE}" -l "app=${STATEFULSET}" \
  -o custom-columns='NAME:.metadata.name,IMAGE:.spec.containers[0].image,STATUS:.status.phase'
```

## Readiness Gates for Database-Aware Health Checks

Standard readiness probes check whether a process accepts connections. For databases, readiness must also encompass replication state.

### Custom Readiness Gate with Sidecar

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: prod-db
spec:
  serviceName: postgres-headless
  replicas: 3
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      partition: 3
  readinessGates:
  - conditionType: "db.support.tools/replication-ready"
  template:
    spec:
      serviceAccountName: postgres-readiness-sa
      initContainers:
      - name: init-permissions
        image: busybox:1.36
        command: ['sh', '-c', 'chown -R 999:999 /var/lib/postgresql/data']
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
      containers:
      - name: postgres
        image: postgres:16.3
        ports:
        - containerPort: 5432
          name: postgres
        readinessProbe:
          exec:
            command:
            - /bin/sh
            - -c
            - |
              pg_isready -U postgres -d postgres && \
              psql -U postgres -t -c "SELECT 1" > /dev/null
          initialDelaySeconds: 15
          periodSeconds: 5
          failureThreshold: 3
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
      - name: replication-readiness-gate
        image: bitnami/kubectl:1.29
        command:
        - /bin/sh
        - -c
        - |
          POD_NAME=${HOSTNAME}
          NAMESPACE=$(cat /var/run/secrets/kubernetes.io/serviceaccount/namespace)

          while true; do
            # Check if this pod is primary or replica
            IS_RECOVERY=$(psql -h 127.0.0.1 -U postgres -t -c \
              "SELECT pg_is_in_recovery();" 2>/dev/null | tr -d ' \n')

            if [ "${IS_RECOVERY}" = "f" ]; then
              # Primary: check all replicas are connected
              STREAMING=$(psql -h 127.0.0.1 -U postgres -t -c \
                "SELECT COUNT(*) FROM pg_stat_replication WHERE state='streaming';" \
                2>/dev/null | tr -d ' \n')
              CONDITION_STATUS=$([ "${STREAMING}" -ge 1 ] && echo "True" || echo "False")
            else
              # Replica: check we are receiving WAL
              LAG=$(psql -h 127.0.0.1 -U postgres -t -c \
                "SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::INT;" \
                2>/dev/null | tr -d ' \n')
              CONDITION_STATUS=$([ "${LAG}" -le 60 ] && echo "True" || echo "False")
            fi

            # Patch the pod condition via kubectl
            kubectl patch pod "${POD_NAME}" -n "${NAMESPACE}" \
              --subresource=status \
              --type=json \
              -p="[{\"op\":\"add\",\"path\":\"/status/conditions/-\",\"value\":{\"type\":\"db.support.tools/replication-ready\",\"status\":\"${CONDITION_STATUS}\",\"lastTransitionTime\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}}]" \
              2>/dev/null || true

            sleep 10
          done
        env:
        - name: PGPASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-credentials
              key: password
```

## PodDisruptionBudget for Database StatefulSets

A well-configured PDB prevents Kubernetes from draining too many database nodes simultaneously during upgrades or node maintenance.

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: postgres-pdb
  namespace: prod-db
spec:
  selector:
    matchLabels:
      app: postgres
  maxUnavailable: 1
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: postgres-primary-pdb
  namespace: prod-db
spec:
  selector:
    matchLabels:
      app: postgres
      role: primary
  minAvailable: 1
```

### Labeling Pods by Role

Kubernetes does not natively know which database pod is primary. A sidecar or operator must maintain role labels. For environments without a full operator:

```bash
#!/bin/bash
# label-db-roles.sh — runs periodically via CronJob or operator

NAMESPACE="prod-db"
STATEFULSET="postgres"

for pod in $(kubectl get pods -n "${NAMESPACE}" -l "app=${STATEFULSET}" -o name); do
  POD_NAME="${pod#pod/}"
  IS_RECOVERY=$(kubectl exec -n "${NAMESPACE}" "${POD_NAME}" -- \
    psql -U postgres -t -c "SELECT pg_is_in_recovery();" 2>/dev/null | tr -d ' \n')

  if [ "${IS_RECOVERY}" = "f" ]; then
    ROLE="primary"
  else
    ROLE="replica"
  fi

  kubectl label pod "${POD_NAME}" -n "${NAMESPACE}" \
    role="${ROLE}" \
    --overwrite
  echo "Labeled ${POD_NAME} as ${ROLE}"
done
```

## Cassandra Rolling Upgrade Pattern

Cassandra has stricter requirements: nodes must complete repair cycles before being upgraded, and the cluster must remain above quorum throughout.

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: cassandra
  namespace: prod-db
spec:
  serviceName: cassandra
  replicas: 6
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      partition: 6          # Freeze until manually lowered
  podManagementPolicy: OrderedReady
  template:
    metadata:
      labels:
        app: cassandra
    spec:
      terminationGracePeriodSeconds: 180
      containers:
      - name: cassandra
        image: cassandra:5.0.2
        ports:
        - containerPort: 7000
          name: intra-node
        - containerPort: 7001
          name: tls-intra-node
        - containerPort: 9042
          name: cql
        env:
        - name: CASSANDRA_SEEDS
          value: "cassandra-0.cassandra.prod-db.svc.cluster.local,cassandra-1.cassandra.prod-db.svc.cluster.local"
        - name: CASSANDRA_CLUSTER_NAME
          value: "prod-cluster"
        - name: CASSANDRA_DC
          value: "dc1"
        - name: CASSANDRA_RACK
          value: "rack1"
        - name: MAX_HEAP_SIZE
          value: "8G"
        - name: HEAP_NEWSIZE
          value: "2G"
        readinessProbe:
          exec:
            command:
            - /bin/bash
            - -c
            - |
              nodetool status | grep -E "^UN\s+$(hostname -I | awk '{print $1}')"
          initialDelaySeconds: 60
          periodSeconds: 10
          failureThreshold: 6
        livenessProbe:
          exec:
            command:
            - nodetool
            - status
          initialDelaySeconds: 90
          periodSeconds: 30
          failureThreshold: 5
        lifecycle:
          preStop:
            exec:
              command:
              - /bin/bash
              - -c
              - |
                # Drain node before shutdown to prevent data loss
                nodetool drain
                sleep 10
        volumeMounts:
        - name: data
          mountPath: /var/lib/cassandra/data
        resources:
          requests:
            cpu: "2000m"
            memory: "16Gi"
          limits:
            cpu: "4000m"
            memory: "20Gi"
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: io2-high-iops
      resources:
        requests:
          storage: 500Gi
```

### Cassandra Pre-Upgrade Repair Script

```bash
#!/bin/bash
# cassandra-pre-upgrade-repair.sh
# Runs nodetool repair on all keyspaces before upgrade

set -euo pipefail

NAMESPACE="prod-db"
STATEFULSET="cassandra"
REPLICAS=$(kubectl get sts "${STATEFULSET}" -n "${NAMESPACE}" \
  -o jsonpath='{.spec.replicas}')

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

for i in $(seq 0 $((REPLICAS - 1))); do
  POD="${STATEFULSET}-${i}"
  log "Running repair on ${POD}..."

  # Full repair with -pr (primary range) to avoid redundancy
  kubectl exec -n "${NAMESPACE}" "${POD}" -- \
    nodetool repair --full --pr 2>&1 | tail -5

  log "Checking cluster status after repair on ${POD}..."
  kubectl exec -n "${NAMESPACE}" "${POD}" -- nodetool status

  # Verify all nodes are UN (Up/Normal)
  UN_COUNT=$(kubectl exec -n "${NAMESPACE}" "${POD}" -- \
    nodetool status | grep -c "^UN" || true)
  log "UN nodes: ${UN_COUNT}/${REPLICAS}"

  if [ "${UN_COUNT}" -ne "${REPLICAS}" ]; then
    log "ERROR: Not all nodes are UN. Halting repairs."
    exit 1
  fi
done

log "All nodes repaired and healthy. Cluster ready for upgrade."
```

## Post-Upgrade Validation

After completing a rolling update, systematic validation catches silent failures.

```bash
#!/bin/bash
# post-upgrade-validate.sh

set -euo pipefail

NAMESPACE="${1:-prod-db}"
STATEFULSET="${2:-postgres}"
EXPECTED_IMAGE="${3:-postgres:16.3}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

REPLICAS=$(kubectl get sts "${STATEFULSET}" -n "${NAMESPACE}" \
  -o jsonpath='{.spec.replicas}')

log "=== Post-Upgrade Validation ==="

# 1. Verify all pods running expected image
log "Checking image versions..."
WRONG_IMAGE=0
for i in $(seq 0 $((REPLICAS - 1))); do
  POD="${STATEFULSET}-${i}"
  ACTUAL=$(kubectl get pod "${POD}" -n "${NAMESPACE}" \
    -o jsonpath='{.spec.containers[0].image}')
  if [ "${ACTUAL}" != "${EXPECTED_IMAGE}" ]; then
    log "ERROR: ${POD} is running ${ACTUAL}, expected ${EXPECTED_IMAGE}"
    WRONG_IMAGE=1
  else
    log "OK: ${POD} running ${EXPECTED_IMAGE}"
  fi
done
[ "${WRONG_IMAGE}" -eq 0 ] || exit 1

# 2. Run write/read test
log "Running write/read validation..."
kubectl exec -n "${NAMESPACE}" "${STATEFULSET}-0" -- \
  psql -U postgres -c "
    CREATE TABLE IF NOT EXISTS upgrade_validation (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ DEFAULT NOW(),
      value TEXT
    );
    INSERT INTO upgrade_validation (value) VALUES ('post-upgrade-test-$(date +%s)');
    SELECT COUNT(*) FROM upgrade_validation;
  "

# 3. Check WAL archiving
log "Checking WAL archive status..."
kubectl exec -n "${NAMESPACE}" "${STATEFULSET}-0" -- \
  psql -U postgres -c "SELECT * FROM pg_stat_archiver;"

# 4. Verify replication is streaming on all replicas
log "Verifying streaming replication..."
kubectl exec -n "${NAMESPACE}" "${STATEFULSET}-0" -- \
  psql -U postgres -c "
    SELECT client_addr, state, sent_lsn, write_lsn, flush_lsn, replay_lsn,
           write_lag, flush_lag, replay_lag
    FROM pg_stat_replication;
  "

# 5. Clean up pre-upgrade snapshots older than 7 days (keep recent ones)
log "Listing pre-upgrade snapshots..."
kubectl get volumesnapshot -n "${NAMESPACE}" \
  -l "upgrade-pre-snapshot=true,statefulset=${STATEFULSET}"

log "=== Post-upgrade validation PASSED ==="
```

## Monitoring StatefulSet Rollouts

Prometheus alerts to detect stalled or failed StatefulSet upgrades:

```yaml
groups:
- name: statefulset-rollout
  interval: 30s
  rules:
  - alert: StatefulSetRolloutStalled
    expr: |
      (
        kube_statefulset_status_update_revision != kube_statefulset_status_current_revision
      ) and (
        changes(kube_statefulset_status_replicas_ready[10m]) == 0
      )
    for: 15m
    labels:
      severity: warning
      team: platform
    annotations:
      summary: "StatefulSet {{ $labels.namespace }}/{{ $labels.statefulset }} rollout stalled"
      description: "No progress in rolling update for 15 minutes. Current partition may be blocking."
      runbook: "https://runbooks.support.tools/statefulset-rollout-stalled"

  - alert: StatefulSetReplicaMismatch
    expr: |
      kube_statefulset_replicas != kube_statefulset_status_replicas_ready
    for: 5m
    labels:
      severity: critical
      team: platform
    annotations:
      summary: "StatefulSet {{ $labels.namespace }}/{{ $labels.statefulset }} has mismatched replica count"
      description: "Expected {{ $value }} ready replicas but current state diverges."

  - alert: StatefulSetOldRevision
    expr: |
      kube_statefulset_status_update_revision != kube_statefulset_status_current_revision
    for: 30m
    labels:
      severity: warning
    annotations:
      summary: "StatefulSet {{ $labels.namespace }}/{{ $labels.statefulset }} has pods on old revision"
      description: "Rolling update has been in progress for >30 minutes."
```

## Handling Upgrade Failures and Rollback

When a rolling update fails mid-way, rolling back requires restoring the old image while respecting database consistency.

```bash
#!/bin/bash
# rollback-statefulset.sh

set -euo pipefail

NAMESPACE="${1:-prod-db}"
STATEFULSET="${2:-postgres}"
ROLLBACK_IMAGE="${3:-postgres:16.2}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

REPLICAS=$(kubectl get sts "${STATEFULSET}" -n "${NAMESPACE}" \
  -o jsonpath='{.spec.replicas}')

log "=== Rolling back ${STATEFULSET} to ${ROLLBACK_IMAGE} ==="

# Freeze rollout
kubectl patch sts "${STATEFULSET}" -n "${NAMESPACE}" \
  --type=json \
  -p="[{\"op\":\"replace\",\"path\":\"/spec/updateStrategy/rollingUpdate/partition\",\"value\":${REPLICAS}}]"

# Update image to previous version
kubectl set image statefulset/"${STATEFULSET}" \
  postgres="${ROLLBACK_IMAGE}" \
  -n "${NAMESPACE}"

# Roll back pod by pod, but this time lowest ordinal first
# to restore primary before replicas
for i in $(seq 0 $((REPLICAS - 1))); do
  log "Rolling back ${STATEFULSET}-${i}..."
  kubectl patch sts "${STATEFULSET}" -n "${NAMESPACE}" \
    --type=json \
    -p="[{\"op\":\"replace\",\"path\":\"/spec/updateStrategy/rollingUpdate/partition\",\"value\":${i}}]"

  sleep 5
  kubectl wait pod "${STATEFULSET}-${i}" -n "${NAMESPACE}" \
    --for=condition=Ready \
    --timeout=300s

  log "Pod ${STATEFULSET}-${i} rolled back successfully"
  sleep 30
done

log "=== Rollback to ${ROLLBACK_IMAGE} complete ==="
kubectl rollout history statefulset/"${STATEFULSET}" -n "${NAMESPACE}"
```

## MinReadySeconds and maxUnavailable for StatefulSets

Kubernetes 1.25+ introduced `minReadySeconds` for StatefulSets, and 1.24+ added `maxUnavailable`. These dramatically improve upgrade safety:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: prod-db
spec:
  replicas: 3
  minReadySeconds: 30          # Pod must be Ready for 30s before considered updated
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      partition: 0
      maxUnavailable: 1        # Never take more than 1 pod down simultaneously
  template:
    spec:
      containers:
      - name: postgres
        image: postgres:16.3
        readinessProbe:
          exec:
            command:
            - /bin/sh
            - -c
            - |
              # Multi-condition readiness: connections + replication health
              pg_isready -U postgres && \
              psql -U postgres -t -c "
                SELECT CASE
                  WHEN pg_is_in_recovery() THEN
                    EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) < 60
                  ELSE
                    (SELECT COUNT(*) FROM pg_stat_replication WHERE state='streaming') >= 1
                END AS healthy;
              " | grep -q 't'
          initialDelaySeconds: 20
          periodSeconds: 5
          failureThreshold: 3
          successThreshold: 2   # Must pass twice to be considered Ready
```

## Summary and Decision Matrix

Choosing the right upgrade strategy depends on database type, replica count, and risk tolerance:

| Database | Recommended Strategy | Key Consideration |
|---|---|---|
| PostgreSQL (Patroni) | Partition-based, replicas first | Patroni handles failover automatically |
| PostgreSQL (manual) | Partition-based, primary last | Manual failover promotion required |
| MySQL (InnoDB Cluster) | Partition-based with quorum check | Group Replication requires 3+ nodes |
| Cassandra | Repair-then-partition, one DC at a time | Token ownership must remain valid |
| Redis Sentinel | Replicas first, manual sentinel failover | Sentinel election takes ~30s |
| MongoDB ReplicaSet | Partition-based, stepDown primary first | rs.stepDown() before primary upgrade |

Zero-downtime database upgrades in Kubernetes are achievable with partition-controlled rollouts, deep readiness probes, pre-upgrade validation, and post-upgrade verification. The partition field is the most underutilized StatefulSet feature in production environments and provides the precise control needed to upgrade databases safely without risking data loss or prolonged downtime.
