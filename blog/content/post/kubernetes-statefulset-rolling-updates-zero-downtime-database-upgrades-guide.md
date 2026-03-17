---
title: "Kubernetes StatefulSet Rolling Updates: Zero-Downtime Database Upgrades"
date: 2029-07-10T00:00:00-05:00
draft: false
tags: ["Kubernetes", "StatefulSet", "Databases", "Rolling Updates", "Zero Downtime", "Production", "PostgreSQL"]
categories: ["Kubernetes", "Databases", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to zero-downtime database upgrades with Kubernetes StatefulSets: updateStrategy, partition-based staged rollouts, PodManagementPolicy, pre/post upgrade hooks, and readiness gates for databases."
more_link: "yes"
url: "/kubernetes-statefulset-rolling-updates-zero-downtime-database-upgrades-guide/"
---

Upgrading a stateful application in Kubernetes—particularly a database cluster—is one of the highest-risk operations in production. Unlike Deployments, StatefulSets maintain stable network identities and persistent storage, which means a botched upgrade can leave your data inaccessible. This guide covers every mechanism Kubernetes provides for zero-downtime StatefulSet upgrades, from update strategies and partition-based rollouts to pre/post hooks and readiness gates.

<!--more-->

# Kubernetes StatefulSet Rolling Updates: Zero-Downtime Database Upgrades

## StatefulSet Update Strategy Overview

StatefulSets support two update strategies: `RollingUpdate` and `OnDelete`. Understanding when to use each is the foundation of safe StatefulSet upgrades.

### RollingUpdate Strategy

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres-cluster
  namespace: production
spec:
  serviceName: postgres-headless
  replicas: 3
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      # partition: only pods with ordinal >= partition get updated
      # Default: 0 (update all pods)
      partition: 0
      # maxUnavailable: allow N pods to be unavailable during update
      # Default: 1 (one pod at a time)
      maxUnavailable: 1
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
      - name: postgres
        image: postgres:16.2
        readinessProbe:
          exec:
            command:
            - /bin/sh
            - -c
            - pg_isready -U postgres -h localhost
          initialDelaySeconds: 10
          periodSeconds: 5
          failureThreshold: 3
        resources:
          requests:
            cpu: "2"
            memory: "4Gi"
          limits:
            cpu: "4"
            memory: "8Gi"
```

### OnDelete Strategy

```yaml
updateStrategy:
  type: OnDelete
```

With `OnDelete`, the controller never automatically updates pods. You must manually delete a pod to trigger its replacement with the new template. This is useful when:
- You need complete manual control over each pod's upgrade
- Your database cluster requires specific leader/follower upgrade ordering
- You want to test the upgrade on a single pod before proceeding

```bash
# Manual OnDelete upgrade procedure
# 1. Update the StatefulSet template (no pods are updated yet)
kubectl set image statefulset/postgres-cluster postgres=postgres:16.3

# 2. Verify the update is staged
kubectl rollout status statefulset/postgres-cluster
# Waiting for partitioned roll out to finish: 0 out of 3 new pods have been updated...

# 3. Manually trigger update for replica pods first (ordinal 2, then 1)
kubectl delete pod postgres-cluster-2
kubectl wait pod/postgres-cluster-2 --for=condition=Ready --timeout=300s

kubectl delete pod postgres-cluster-1
kubectl wait pod/postgres-cluster-1 --for=condition=Ready --timeout=300s

# 4. Finally upgrade the primary (ordinal 0) during maintenance window
kubectl delete pod postgres-cluster-0
kubectl wait pod/postgres-cluster-0 --for=condition=Ready --timeout=300s
```

## Partition-Based Staged Rollouts

The `partition` field is the most powerful tool for controlled StatefulSet upgrades. When `partition` is set to N, only pods with ordinal >= N receive the update. This enables canary-style upgrades for stateful workloads.

### Partition-Based Upgrade Procedure

```bash
#!/bin/bash
# Staged StatefulSet upgrade with partition control

STATEFULSET="postgres-cluster"
NAMESPACE="production"
NEW_IMAGE="postgres:16.3"
TOTAL_REPLICAS=5

echo "=== Phase 1: Stage the update (no pods affected yet) ==="
kubectl set image statefulset/${STATEFULSET} \
  postgres=${NEW_IMAGE} \
  -n ${NAMESPACE}

# Set partition to total replicas to prevent any automatic updates
kubectl patch statefulset ${STATEFULSET} -n ${NAMESPACE} \
  --type=json \
  -p='[{"op": "replace", "path": "/spec/updateStrategy/rollingUpdate/partition", "value": '"${TOTAL_REPLICAS}"'}]'

echo "Partition set to ${TOTAL_REPLICAS}: no pods will be updated automatically"
kubectl rollout status statefulset/${STATEFULSET} -n ${NAMESPACE}

echo ""
echo "=== Phase 2: Update last replica (ordinal $((TOTAL_REPLICAS-1))) as canary ==="
CANARY_ORDINAL=$((TOTAL_REPLICAS - 1))
kubectl patch statefulset ${STATEFULSET} -n ${NAMESPACE} \
  --type=json \
  -p='[{"op": "replace", "path": "/spec/updateStrategy/rollingUpdate/partition", "value": '"${CANARY_ORDINAL}"'}]'

echo "Waiting for pod ${STATEFULSET}-${CANARY_ORDINAL} to update..."
kubectl rollout status statefulset/${STATEFULSET} -n ${NAMESPACE} --timeout=5m

# Verify canary pod
echo "Canary pod image:"
kubectl get pod ${STATEFULSET}-${CANARY_ORDINAL} -n ${NAMESPACE} \
  -o jsonpath='{.spec.containers[0].image}'

echo ""
echo "=== Phase 3: Validate canary for 5 minutes ==="
sleep 300

# Check canary health
if ! kubectl wait pod/${STATEFULSET}-${CANARY_ORDINAL} \
  --for=condition=Ready \
  --timeout=60s \
  -n ${NAMESPACE}; then
  echo "ERROR: Canary pod not ready, aborting upgrade"
  # Rollback: set partition back to TOTAL_REPLICAS
  kubectl patch statefulset ${STATEFULSET} -n ${NAMESPACE} \
    --type=json \
    -p='[{"op": "replace", "path": "/spec/updateStrategy/rollingUpdate/partition", "value": '"${TOTAL_REPLICAS}"'}]'
  exit 1
fi

echo "Canary validation passed"

echo ""
echo "=== Phase 4: Staged rollout of remaining replicas ==="
# Update ordinals 2, 3, ... (skipping 0 which is primary)
for ORDINAL in $(seq $((CANARY_ORDINAL - 1)) -1 1); do
  echo "Updating pod ${STATEFULSET}-${ORDINAL}..."
  kubectl patch statefulset ${STATEFULSET} -n ${NAMESPACE} \
    --type=json \
    -p='[{"op": "replace", "path": "/spec/updateStrategy/rollingUpdate/partition", "value": '"${ORDINAL}"'}]'

  kubectl wait pod/${STATEFULSET}-${ORDINAL} \
    --for=condition=Ready \
    --timeout=5m \
    -n ${NAMESPACE}

  echo "Pod ${STATEFULSET}-${ORDINAL} updated and ready"
  sleep 30  # Brief pause between pod updates
done

echo ""
echo "=== Phase 5: Update primary (ordinal 0) - requires brief write unavailability ==="
echo "Initiating primary failover to ordinal 1..."
# Database-specific failover command (PostgreSQL with patroni example)
kubectl exec ${STATEFULSET}-1 -n ${NAMESPACE} -- \
  patronictl -c /etc/patroni/config.yml failover \
  --master ${STATEFULSET}-0 \
  --candidate ${STATEFULSET}-1 \
  --force

# Wait for failover to complete
sleep 30

echo "Updating former primary (now replica)..."
kubectl patch statefulset ${STATEFULSET} -n ${NAMESPACE} \
  --type=json \
  -p='[{"op": "replace", "path": "/spec/updateStrategy/rollingUpdate/partition", "value": "0"}]'

kubectl wait pod/${STATEFULSET}-0 \
  --for=condition=Ready \
  --timeout=5m \
  -n ${NAMESPACE}

echo "=== Upgrade complete ==="
kubectl get pods -n ${NAMESPACE} -l app=postgres \
  -o custom-columns='NAME:.metadata.name,IMAGE:.spec.containers[0].image,READY:.status.conditions[?(@.type=="Ready")].status'
```

### Monitoring Partition Rollout Progress

```bash
#!/bin/bash
# Monitor StatefulSet update progress
STATEFULSET=$1
NAMESPACE=${2:-default}

while true; do
    clear
    echo "=== StatefulSet Update Progress: ${STATEFULSET} ==="
    echo "Time: $(date)"
    echo ""

    # Show update strategy and partition
    echo "Update Strategy:"
    kubectl get statefulset ${STATEFULSET} -n ${NAMESPACE} \
      -o jsonpath='{.spec.updateStrategy}' | python3 -m json.tool

    echo ""
    echo "Pod Status:"
    kubectl get pods -n ${NAMESPACE} -l "app=${STATEFULSET}" \
      -o custom-columns='NAME:.metadata.name,READY:.status.conditions[?(@.type=="Ready")].status,IMAGE:.spec.containers[0].image,NODE:.spec.nodeName'

    echo ""
    echo "StatefulSet Status:"
    kubectl get statefulset ${STATEFULSET} -n ${NAMESPACE} \
      -o custom-columns='NAME:.metadata.name,READY:.status.readyReplicas,CURRENT:.status.currentReplicas,UPDATED:.status.updatedReplicas,DESIRED:.spec.replicas'

    sleep 5
done
```

## PodManagementPolicy

The `podManagementPolicy` field controls how pods are created and deleted during scaling operations (not updates). This significantly impacts startup time for large clusters.

### OrderedReady (Default)

```yaml
spec:
  podManagementPolicy: OrderedReady
```

With `OrderedReady`, pods are created and deleted in strict ordinal order. Pod N must be Ready before pod N+1 is created. This is the safe default for databases where initialization order matters.

```
postgres-cluster-0 → Ready
postgres-cluster-1 → Ready
postgres-cluster-2 → Ready
```

### Parallel (For Independent Replicas)

```yaml
spec:
  podManagementPolicy: Parallel
```

With `Parallel`, all pods are started/stopped simultaneously. Use this for read replicas that can initialize independently, or when you need faster scaling:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis-replicas
spec:
  podManagementPolicy: Parallel  # All replicas start simultaneously
  replicas: 5
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 2   # Allow 2 unavailable at once
  template:
    spec:
      containers:
      - name: redis
        image: redis:7.2
        readinessProbe:
          exec:
            command: ["redis-cli", "ping"]
          initialDelaySeconds: 5
          periodSeconds: 3
```

Important: `Parallel` only affects scaling operations. Rolling updates always follow ordinal ordering regardless of `podManagementPolicy`.

## Pre and Post Upgrade Hooks

Kubernetes doesn't have built-in StatefulSet lifecycle hooks at the upgrade level. Implement them via:

### Init Containers for Pre-Upgrade Validation

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres-cluster
spec:
  template:
    spec:
      initContainers:
      # Pre-upgrade validation: runs before main container on each pod restart
      - name: upgrade-validator
        image: postgres:16.3
        command:
        - /bin/bash
        - -c
        - |
          echo "Running pre-upgrade validation for pod ${POD_NAME}..."

          # Check if we're upgrading (current data directory version != new binary version)
          if [ -f /data/pgdata/PG_VERSION ]; then
            DATA_VERSION=$(cat /data/pgdata/PG_VERSION)
            BINARY_VERSION=$(pg_config --version | grep -oP '\d+' | head -1)

            echo "Data directory version: ${DATA_VERSION}"
            echo "Binary version: ${BINARY_VERSION}"

            if [ "${DATA_VERSION}" -lt "${BINARY_VERSION}" ]; then
              echo "Major version upgrade detected: ${DATA_VERSION} -> ${BINARY_VERSION}"
              echo "Running pg_upgrade dry-run..."
              # In production: run actual pg_upgrade
              # pg_upgrade --old-datadir=/data/pgdata --new-datadir=/data/pgdata_new \
              #   --old-bindir=/usr/lib/postgresql/${DATA_VERSION}/bin \
              #   --new-bindir=/usr/lib/postgresql/${BINARY_VERSION}/bin \
              #   --check
            fi
          fi

          echo "Pre-upgrade validation complete"
        env:
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        volumeMounts:
        - name: postgres-data
          mountPath: /data/pgdata

      # Pre-upgrade: wait for primary to be ready before starting replica
      - name: wait-for-primary
        image: postgres:16.3
        command:
        - /bin/bash
        - -c
        - |
          # Only wait for replicas (not for ordinal 0 = primary)
          ORDINAL=$(echo ${POD_NAME} | grep -oP '\d+$')
          if [ "${ORDINAL}" -gt "0" ]; then
            echo "Replica pod ${POD_NAME} waiting for primary..."
            until pg_isready -h postgres-cluster-0.postgres-headless -U postgres; do
              echo "Primary not ready, waiting..."
              sleep 5
            done
            echo "Primary is ready, proceeding with replica startup"
          fi
        env:
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name

      containers:
      - name: postgres
        image: postgres:16.3
        # Pre-stop hook: graceful shutdown
        lifecycle:
          preStop:
            exec:
              command:
              - /bin/bash
              - -c
              - |
                echo "PreStop hook: initiating graceful PostgreSQL shutdown"

                # Check if this pod is the primary
                IS_PRIMARY=$(psql -U postgres -tAc "SELECT pg_is_in_recovery();" 2>/dev/null || echo "true")

                if [ "${IS_PRIMARY}" = "f" ]; then
                  echo "This is the PRIMARY. Triggering failover before shutdown..."
                  # Signal Patroni to failover
                  patronictl -c /etc/patroni/config.yml switchover \
                    --force \
                    --master $(hostname) || true
                  sleep 10
                fi

                echo "Stopping PostgreSQL gracefully..."
                pg_ctl stop -D /data/pgdata -m fast -t 60
                echo "PostgreSQL stopped"
```

### Job-Based Pre/Post Upgrade Hooks

For more complex upgrade operations, use Jobs:

```yaml
# pre-upgrade-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: postgres-pre-upgrade-16-3
  namespace: production
  annotations:
    upgrade-target-version: "16.3"
spec:
  backoffLimit: 3
  template:
    spec:
      restartPolicy: OnFailure
      serviceAccountName: upgrade-job-sa
      containers:
      - name: pre-upgrade
        image: postgres:16.3
        command:
        - /bin/bash
        - -c
        - |
          set -euo pipefail

          echo "=== Pre-Upgrade Job for PostgreSQL 16.3 ==="

          # 1. Create backup before upgrade
          echo "Creating backup snapshot..."
          BACKUP_NAME="pre-upgrade-$(date +%Y%m%d-%H%M%S)"
          kubectl annotate statefulset postgres-cluster \
            backup-before-upgrade=${BACKUP_NAME} \
            --overwrite

          # 2. Check replication lag
          echo "Checking replication lag..."
          LAG=$(psql -U postgres -h postgres-cluster-0.postgres-headless \
            -tAc "SELECT COALESCE(MAX(EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))), 0) FROM pg_stat_replication;")
          echo "Replication lag: ${LAG} seconds"
          if (( $(echo "$LAG > 60" | bc -l) )); then
            echo "ERROR: Replication lag too high (${LAG}s > 60s)"
            exit 1
          fi

          # 3. Verify all replicas are connected
          echo "Checking replica count..."
          REPLICAS=$(psql -U postgres -h postgres-cluster-0.postgres-headless \
            -tAc "SELECT COUNT(*) FROM pg_stat_replication WHERE state = 'streaming';")
          echo "Streaming replicas: ${REPLICAS}"
          EXPECTED_REPLICAS=2
          if [ "${REPLICAS}" -lt "${EXPECTED_REPLICAS}" ]; then
            echo "ERROR: Expected ${EXPECTED_REPLICAS} replicas, got ${REPLICAS}"
            exit 1
          fi

          # 4. Run compatibility checks
          echo "Running compatibility checks..."
          # Check for deprecated settings in postgresql.conf
          psql -U postgres -h postgres-cluster-0.postgres-headless \
            -c "SELECT name, setting FROM pg_settings WHERE name IN ('wal_keep_segments') AND setting != 'off';" || true

          echo "Pre-upgrade validation PASSED"
        env:
        - name: PGPASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-credentials
              key: password
```

```yaml
# post-upgrade-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: postgres-post-upgrade-16-3
  namespace: production
spec:
  backoffLimit: 3
  template:
    spec:
      restartPolicy: OnFailure
      containers:
      - name: post-upgrade
        image: postgres:16.3
        command:
        - /bin/bash
        - -c
        - |
          set -euo pipefail

          echo "=== Post-Upgrade Job for PostgreSQL 16.3 ==="

          # 1. Update statistics (important after major version upgrade)
          echo "Running ANALYZE on all databases..."
          psql -U postgres -h postgres-cluster-0.postgres-headless \
            -c "SELECT 'ANALYZE;' FROM pg_database WHERE datistemplate = false;" | \
            psql -U postgres -h postgres-cluster-0.postgres-headless

          # 2. Run REINDEX if needed (for major version upgrades)
          # echo "Rebuilding system catalog indexes..."
          # psql -U postgres -h postgres-cluster-0.postgres-headless -c "REINDEX SYSTEM postgres;"

          # 3. Update pg_stat extension if it changed
          echo "Updating extensions..."
          psql -U postgres -h postgres-cluster-0.postgres-headless \
            -c "ALTER EXTENSION pg_stat_statements UPDATE;" || true

          # 4. Verify replication is healthy post-upgrade
          echo "Verifying replication health..."
          sleep 30
          REPLICAS=$(psql -U postgres -h postgres-cluster-0.postgres-headless \
            -tAc "SELECT COUNT(*) FROM pg_stat_replication WHERE state = 'streaming';")
          echo "Post-upgrade streaming replicas: ${REPLICAS}"

          # 5. Run application-level smoke tests
          echo "Running smoke tests..."
          psql -U postgres -h postgres-cluster-0.postgres-headless -d app_database \
            -c "SELECT COUNT(*) FROM users;" || {
            echo "ERROR: Smoke test failed"
            exit 1
          }

          echo "Post-upgrade validation PASSED"
          echo "Upgrade to PostgreSQL 16.3 complete!"
```

### Automating the Full Upgrade Workflow

```bash
#!/bin/bash
# Full automated upgrade workflow
set -euo pipefail

NAMESPACE="production"
STATEFULSET="postgres-cluster"
NEW_VERSION="16.3"
NEW_IMAGE="postgres:${NEW_VERSION}"

echo "=== Starting Upgrade to PostgreSQL ${NEW_VERSION} ==="

# Step 1: Run pre-upgrade job
echo "Running pre-upgrade validation..."
kubectl apply -f pre-upgrade-job.yaml
kubectl wait job/postgres-pre-upgrade-${NEW_VERSION//./-} \
  -n ${NAMESPACE} \
  --for=condition=Complete \
  --timeout=10m

echo "Pre-upgrade validation complete"

# Step 2: Update the StatefulSet (with partition = replica count for safety)
REPLICAS=$(kubectl get statefulset ${STATEFULSET} -n ${NAMESPACE} \
  -o jsonpath='{.spec.replicas}')

kubectl patch statefulset ${STATEFULSET} -n ${NAMESPACE} --type=json -p="[
  {\"op\": \"replace\", \"path\": \"/spec/template/spec/containers/0/image\", \"value\": \"${NEW_IMAGE}\"},
  {\"op\": \"replace\", \"path\": \"/spec/updateStrategy/rollingUpdate/partition\", \"value\": ${REPLICAS}}
]"

# Step 3: Staged rollout (replicas first, primary last)
for ORDINAL in $(seq $((REPLICAS-1)) -1 0); do
  echo "Updating pod ${STATEFULSET}-${ORDINAL}..."

  # Set partition to allow this pod to update
  kubectl patch statefulset ${STATEFULSET} -n ${NAMESPACE} \
    --type=json \
    -p='[{"op": "replace", "path": "/spec/updateStrategy/rollingUpdate/partition", "value": '"${ORDINAL}"'}]'

  # Wait for pod to be updated and ready
  kubectl wait pod/${STATEFULSET}-${ORDINAL} \
    -n ${NAMESPACE} \
    --for=condition=Ready \
    --timeout=10m

  # Brief validation pause between pods
  sleep 30

  # Verify no replication errors after each pod update
  if [ "${ORDINAL}" -gt "0" ]; then
    LAG=$(kubectl exec ${STATEFULSET}-0 -n ${NAMESPACE} -- \
      psql -U postgres -tAc \
      "SELECT COALESCE(MAX(EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))), 0) FROM pg_stat_replication;" \
      2>/dev/null || echo "999")
    if (( $(echo "$LAG > 120" | bc -l) )); then
      echo "WARNING: High replication lag (${LAG}s) after updating pod ${ORDINAL}"
    fi
  fi
done

# Step 4: Run post-upgrade job
echo "Running post-upgrade tasks..."
kubectl apply -f post-upgrade-job.yaml
kubectl wait job/postgres-post-upgrade-${NEW_VERSION//./-} \
  -n ${NAMESPACE} \
  --for=condition=Complete \
  --timeout=15m

echo "=== Upgrade to PostgreSQL ${NEW_VERSION} COMPLETE ==="
```

## Readiness Gates for Databases

Kubernetes readiness probes check if a container is ready to receive traffic, but for database clusters, "ready" means more than "the process is running."

### Pod Readiness Gates

Pod Readiness Gates allow external controllers to gate pod readiness:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres-cluster
spec:
  template:
    metadata:
      labels:
        app: postgres
    spec:
      # Pod-level readiness gates: pod isn't Ready until these conditions are true
      readinessGates:
      - conditionType: "postgres.example.com/replication-ready"
      - conditionType: "postgres.example.com/backup-complete"

      containers:
      - name: postgres
        image: postgres:16.3
        readinessProbe:
          exec:
            command:
            - /bin/sh
            - -c
            - |
              # Check basic connectivity
              pg_isready -U postgres -h localhost || exit 1

              # For replicas: also check that replication is streaming
              IS_PRIMARY=$(psql -U postgres -tAc "SELECT pg_is_in_recovery();" 2>/dev/null)
              if [ "${IS_PRIMARY}" = "t" ]; then
                # Verify we're receiving WAL from primary
                LAG=$(psql -U postgres -tAc \
                  "SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()));" \
                  2>/dev/null || echo "999")
                if (( $(echo "$LAG > 300" | bc -l) )); then
                  echo "Replica lag too high: ${LAG}s"
                  exit 1
                fi
              fi
              exit 0
          initialDelaySeconds: 15
          periodSeconds: 10
          failureThreshold: 6
          successThreshold: 1
```

### Custom Controller for Database Readiness Gates

```go
package main

import (
    "context"
    "fmt"
    "time"

    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/tools/clientcmd"
)

const (
    replicationReadyCondition = "postgres.example.com/replication-ready"
    maxReplicationLagSeconds  = 30.0
)

type DatabaseReadinessController struct {
    client kubernetes.Interface
}

func (c *DatabaseReadinessController) reconcilePodReadiness(
    ctx context.Context,
    pod *corev1.Pod,
) error {
    // Check if this pod has our readiness gate
    hasGate := false
    for _, gate := range pod.Spec.ReadinessGates {
        if string(gate.ConditionType) == replicationReadyCondition {
            hasGate = true
            break
        }
    }
    if !hasGate {
        return nil
    }

    // Evaluate readiness condition
    isReady, message := c.evaluateReplicationReadiness(ctx, pod)

    // Update pod status condition
    now := metav1.Now()
    newCondition := corev1.PodCondition{
        Type:               corev1.PodConditionType(replicationReadyCondition),
        LastTransitionTime: now,
        LastProbeTime:      now,
    }

    if isReady {
        newCondition.Status = corev1.ConditionTrue
        newCondition.Reason = "ReplicationHealthy"
        newCondition.Message = message
    } else {
        newCondition.Status = corev1.ConditionFalse
        newCondition.Reason = "ReplicationUnhealthy"
        newCondition.Message = message
    }

    // Update existing condition or append new one
    conditionUpdated := false
    for i, cond := range pod.Status.Conditions {
        if string(cond.Type) == replicationReadyCondition {
            pod.Status.Conditions[i] = newCondition
            conditionUpdated = true
            break
        }
    }
    if !conditionUpdated {
        pod.Status.Conditions = append(pod.Status.Conditions, newCondition)
    }

    // Apply the status update
    _, err := c.client.CoreV1().Pods(pod.Namespace).UpdateStatus(
        ctx,
        pod,
        metav1.UpdateOptions{},
    )
    return err
}

func (c *DatabaseReadinessController) evaluateReplicationReadiness(
    ctx context.Context,
    pod *corev1.Pod,
) (bool, string) {
    // Check ordinal: primary (0) is always considered ready for this condition
    podName := pod.Name
    ordinal := 0
    fmt.Sscanf(podName[len(podName)-1:], "%d", &ordinal)

    if ordinal == 0 {
        return true, "Primary pod, replication condition always satisfied"
    }

    // For replicas: check replication lag via exec
    // In production: use a proper metrics endpoint
    lag, err := c.getReplicationLag(ctx, pod)
    if err != nil {
        return false, fmt.Sprintf("Failed to check replication lag: %v", err)
    }

    if lag > maxReplicationLagSeconds {
        return false, fmt.Sprintf("Replication lag too high: %.1fs (max %.1fs)", lag, maxReplicationLagSeconds)
    }

    return true, fmt.Sprintf("Replication healthy, lag: %.1fs", lag)
}

func (c *DatabaseReadinessController) getReplicationLag(
    ctx context.Context,
    pod *corev1.Pod,
) (float64, error) {
    // In production: query Prometheus or a dedicated metrics endpoint
    // This is a simplified placeholder
    return 5.0, nil
}
```

### Advanced Readiness Probe: Cluster-Aware

```yaml
# ConfigMap with database-aware readiness check script
apiVersion: v1
kind: ConfigMap
metadata:
  name: postgres-readiness-scripts
data:
  check-readiness.sh: |
    #!/bin/bash
    set -e

    POD_NAME=${POD_NAME:-$(hostname)}
    ORDINAL=$(echo ${POD_NAME} | grep -oP '\d+$')

    # Basic connectivity check
    if ! pg_isready -U postgres -h localhost -q; then
      echo "PostgreSQL not accepting connections"
      exit 1
    fi

    # Check if we're in recovery (replica)
    IS_REPLICA=$(psql -U postgres -tAc "SELECT pg_is_in_recovery();" 2>/dev/null | tr -d '[:space:]')

    if [ "${IS_REPLICA}" = "t" ]; then
      # Replica checks

      # 1. Verify WAL receiver is running
      WAL_RECEIVER=$(psql -U postgres -tAc \
        "SELECT COUNT(*) FROM pg_stat_wal_receiver WHERE status = 'streaming';" \
        2>/dev/null | tr -d '[:space:]')
      if [ "${WAL_RECEIVER}" = "0" ]; then
        echo "WAL receiver not streaming"
        exit 1
      fi

      # 2. Check replication lag
      LAG=$(psql -U postgres -tAc \
        "SELECT COALESCE(EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())), 0);" \
        2>/dev/null | tr -d '[:space:]')
      MAX_LAG=60
      if (( $(echo "$LAG > $MAX_LAG" | bc -l) )); then
        echo "Replica lag too high: ${LAG}s > ${MAX_LAG}s"
        exit 1
      fi

    else
      # Primary checks

      # 1. Verify we can write
      psql -U postgres -c "CREATE TEMP TABLE readiness_check (id int); DROP TABLE readiness_check;" \
        > /dev/null 2>&1 || {
        echo "Primary write check failed"
        exit 1
      }

      # 2. Check replication slots aren't blocking WAL too much
      INACTIVE_SLOTS=$(psql -U postgres -tAc \
        "SELECT COUNT(*) FROM pg_replication_slots WHERE NOT active AND pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) > 1073741824;" \
        2>/dev/null | tr -d '[:space:]')
      if [ "${INACTIVE_SLOTS}" -gt "0" ]; then
        echo "WARNING: ${INACTIVE_SLOTS} inactive replication slots blocking WAL"
        # Don't exit 1 for this - just warn
      fi
    fi

    echo "Readiness check passed (${IS_REPLICA})"
    exit 0
```

## Rollback Procedures

When an upgrade goes wrong, quick rollback is critical:

```bash
#!/bin/bash
# Emergency StatefulSet rollback

STATEFULSET="postgres-cluster"
NAMESPACE="production"

echo "=== Emergency Rollback ==="

# 1. Get previous revision info
PREVIOUS_IMAGE=$(kubectl rollout history statefulset/${STATEFULSET} \
  -n ${NAMESPACE} | tail -2 | head -1)
echo "Current rollout history:"
kubectl rollout history statefulset/${STATEFULSET} -n ${NAMESPACE}

# 2. Initiate rollback
kubectl rollout undo statefulset/${STATEFULSET} -n ${NAMESPACE}

# 3. Set partition to 0 to allow rollback of all pods
kubectl patch statefulset ${STATEFULSET} -n ${NAMESPACE} \
  --type=json \
  -p='[{"op": "replace", "path": "/spec/updateStrategy/rollingUpdate/partition", "value": 0}]'

# 4. Monitor rollback progress
kubectl rollout status statefulset/${STATEFULSET} -n ${NAMESPACE} --timeout=10m

echo "Rollback complete"
kubectl get pods -n ${NAMESPACE} -l app=postgres \
  -o custom-columns='NAME:.metadata.name,IMAGE:.spec.containers[0].image,READY:.status.conditions[?(@.type=="Ready")].status'
```

## maxUnavailable for StatefulSets

Since Kubernetes 1.24, StatefulSets support `maxUnavailable` in the rolling update strategy, allowing multiple pods to be updated simultaneously:

```yaml
updateStrategy:
  type: RollingUpdate
  rollingUpdate:
    maxUnavailable: 2   # Allow 2 pods unavailable at once
    partition: 0
```

For database clusters, use maxUnavailable carefully:
- Primary + one replica unavailable simultaneously is typically unacceptable
- For read-replica-only clusters, `maxUnavailable: 2` or more may be safe
- Always combine with PodDisruptionBudgets:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: postgres-pdb
  namespace: production
spec:
  minAvailable: 2  # Always keep at least 2 pods available (including primary)
  selector:
    matchLabels:
      app: postgres
```

## Summary

Zero-downtime database upgrades with StatefulSets require layering multiple Kubernetes mechanisms:

1. **OnDelete strategy** gives maximum manual control for high-risk upgrades
2. **Partition-based rollouts** enable canary-style upgrades by controlling which pods receive updates
3. **PodManagementPolicy** controls startup ordering during scaling, not updates
4. **Init containers and preStop hooks** provide application-level pre/post upgrade logic
5. **Job-based hooks** handle complex validation and post-upgrade tasks that need their own lifecycle
6. **Readiness gates** encode domain-specific readiness criteria (replication health, lag thresholds)
7. **PodDisruptionBudgets** provide a safety net against accidental simultaneous disruption

The most reliable approach combines partition-based rollouts (for staged canary), database-aware readiness probes (to prevent cascading failures), and pre-validated Job-based procedures (for complex migration steps) with clear rollback procedures tested before production use.
