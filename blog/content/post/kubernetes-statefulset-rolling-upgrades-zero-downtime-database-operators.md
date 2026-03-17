---
title: "Kubernetes StatefulSet Rolling Upgrades: Zero-Downtime Database Operator Patterns"
date: 2030-06-02T00:00:00-05:00
draft: false
tags: ["Kubernetes", "StatefulSet", "Rolling Upgrades", "PostgreSQL", "Redis", "Operators", "Databases"]
categories:
- Kubernetes
- Databases
- Operators
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to StatefulSet upgrade strategies: updateStrategy, partition-based upgrades, orderedReady vs parallel pod management, handling PVC migrations, and zero-downtime patterns for PostgreSQL/Redis operators."
more_link: "yes"
url: "/kubernetes-statefulset-rolling-upgrades-zero-downtime-database-operators/"
---

StatefulSet rolling upgrades in Kubernetes present unique challenges compared to Deployment updates. While Deployments can roll forward by bringing up new pods while old ones handle traffic, StatefulSets manage stateful workloads—databases, message queues, distributed caches—where the order of restarts, replication lag, leader election, and persistent volume compatibility all affect whether the upgrade succeeds or causes a data-affecting incident.

This guide covers the full spectrum of StatefulSet upgrade strategies: the `updateStrategy` configuration, partition-based canary upgrades, `podManagementPolicy` impact on upgrade speed, PVC migration patterns, and zero-downtime upgrade procedures for PostgreSQL (via CloudNativePG) and Redis (via Redis Operator) in production.

<!--more-->

## StatefulSet Update Strategy

### RollingUpdate (Default)

The default `RollingUpdate` strategy replaces pods one at a time in reverse ordinal order (highest index first), waiting for each pod to become Ready before proceeding to the next.

```yaml
# statefulset-basic.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: production
spec:
  serviceName: postgres-headless
  replicas: 3
  selector:
    matchLabels:
      app: postgres
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      # Partition: only pods with ordinal >= partition are updated
      # partition: 0 = update all pods (default)
      partition: 0
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
        - name: postgres
          image: postgres:16.3
```

With 3 replicas and no partition, the update order is:
1. `postgres-2` restarted (highest ordinal)
2. Wait until `postgres-2` is Ready
3. `postgres-1` restarted
4. Wait until `postgres-1` is Ready
5. `postgres-0` restarted
6. Wait until `postgres-0` is Ready

### OnDelete Strategy

`OnDelete` requires manual pod deletion to trigger updates. This provides maximum control for databases where upgrade timing must align with maintenance windows or replication state:

```yaml
spec:
  updateStrategy:
    type: OnDelete
```

With `OnDelete`, changing the pod template does not trigger any pod restarts. Each pod is upgraded only when it is manually deleted:

```bash
# Check which pods are running the old version
kubectl rollout status statefulset/postgres -n production
# Partitioned roll out complete: 0 new pods have been updated...

# Update pod template (image, config, etc.)
kubectl set image statefulset/postgres postgres=postgres:16.4 -n production

# Verify pods are NOT auto-restarted
kubectl get pods -n production -l app=postgres -o wide
# postgres-0   1/1   Running   0   5d    10.0.1.10
# postgres-1   1/1   Running   0   5d    10.0.1.11
# postgres-2   1/1   Running   0   5d    10.0.1.12
# All still running old image

# Manually upgrade postgres-2 first (the secondary replica)
kubectl delete pod postgres-2 -n production
# Wait for postgres-2 to become Ready on new image
kubectl wait pod/postgres-2 -n production \
    --for=condition=Ready \
    --timeout=5m

# Verify replication is healthy before proceeding
kubectl exec -n production postgres-0 -- \
    psql -U postgres -c "SELECT client_addr, state, sent_lsn, replay_lsn, sync_state FROM pg_stat_replication;"

# Upgrade postgres-1
kubectl delete pod postgres-1 -n production
kubectl wait pod/postgres-1 -n production --for=condition=Ready --timeout=5m

# Primary (postgres-0) last
kubectl delete pod postgres-0 -n production
kubectl wait pod/postgres-0 -n production --for=condition=Ready --timeout=5m
```

## Partition-Based Canary Upgrades

The `partition` field in `RollingUpdate` controls which pods are updated. Setting `partition: 2` means only pods with ordinal >= 2 are updated when the template changes; pods with ordinal 0 and 1 are left untouched.

```yaml
# Initial: set partition to all-but-last (canary one replica)
spec:
  replicas: 3
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      partition: 2    # Only postgres-2 gets the new version
```

```bash
# Step 1: Set partition to 2 (update only postgres-2)
kubectl patch statefulset postgres -n production \
    --type='json' \
    -p='[{"op":"replace","path":"/spec/updateStrategy/rollingUpdate/partition","value":2}]'

# Step 2: Update the image
kubectl set image statefulset/postgres postgres=postgres:16.4 -n production

# Step 3: postgres-2 automatically updates; postgres-0 and postgres-1 stay on old version
kubectl get pods -n production -l app=postgres \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.containerStatuses[0].image}{"\n"}{end}'
# postgres-0    postgres:16.3
# postgres-1    postgres:16.3
# postgres-2    postgres:16.4  (updated)

# Step 4: Validate postgres-2 health (run your smoke tests)
kubectl exec -n production postgres-2 -- postgres --version
kubectl exec -n production postgres-2 -- pg_isready

# Step 5: If healthy, extend update to postgres-1
kubectl patch statefulset postgres -n production \
    --type='json' \
    -p='[{"op":"replace","path":"/spec/updateStrategy/rollingUpdate/partition","value":1}]'
kubectl wait pod/postgres-1 -n production --for=condition=Ready --timeout=5m

# Step 6: Complete the upgrade by setting partition to 0
kubectl patch statefulset postgres -n production \
    --type='json' \
    -p='[{"op":"replace","path":"/spec/updateStrategy/rollingUpdate/partition","value":0}]'
kubectl wait pod/postgres-0 -n production --for=condition=Ready --timeout=5m

# Verify all pods on new image
kubectl rollout status statefulset/postgres -n production
```

### Rollback via Partition

If the new version has issues at postgres-2, rolling back is simple:

```bash
# Roll back to previous image
kubectl set image statefulset/postgres postgres=postgres:16.3 -n production

# The partition ensures only postgres-2 rolls back to the old image
# (Since partition=2, only ordinal >=2 update to match spec)
kubectl wait pod/postgres-2 -n production --for=condition=Ready --timeout=5m
```

## Pod Management Policy

### OrderedReady vs Parallel

```yaml
spec:
  # OrderedReady (default): Pods created/updated one at a time, in order
  podManagementPolicy: OrderedReady

  # Parallel: All pods created/deleted simultaneously
  # WARNING: Do NOT use Parallel for databases with leader election
  podManagementPolicy: Parallel
```

`Parallel` is appropriate only for stateless or fully independent stateful pods (e.g., independent Elasticsearch data nodes that don't coordinate with each other during startup). For PostgreSQL, MySQL, Redis, or any system with leader election or replication, use `OrderedReady`.

### Startup Time Impact

```bash
# With OrderedReady, scaling from 0 to 5 replicas takes:
# Time = sum(pod_startup_time for each replica) = 5 * 30s = 150s minimum

# With Parallel:
# Time = max(pod_startup_time) = ~30s

# For initialization containers that take 60 seconds:
kubectl describe statefulset postgres -n production | grep -A5 "Init Containers"
# Scaling with OrderedReady: 5 * 60s = 300s
# Scaling with Parallel:      60s (all init containers run simultaneously)
```

## PVC Migration During Upgrades

Changing storage class or PVC size during a StatefulSet upgrade requires special handling because `volumeClaimTemplates` is immutable after StatefulSet creation.

### Expanding PVC Size (In-Place)

```bash
# If the storage class supports volume expansion (allowVolumeExpansion: true)
# Patch each PVC directly — the StatefulSet's volumeClaimTemplate does not need to change

for i in 0 1 2; do
    kubectl patch pvc data-postgres-$i -n production \
        --type='json' \
        -p='[{"op":"replace","path":"/spec/resources/requests/storage","value":"200Gi"}]'
    echo "PVC data-postgres-$i patched, waiting for resize..."
    kubectl wait pvc/data-postgres-$i -n production \
        --for=jsonpath='{.status.capacity.storage}=200Gi' \
        --timeout=10m
    echo "PVC data-postgres-$i resized to 200Gi"
done
```

### Changing Storage Class (Migration Required)

Changing storage class requires deleting and recreating the StatefulSet with the new `volumeClaimTemplate`:

```bash
#!/bin/bash
# migrate-storage-class.sh
# Migrates a StatefulSet to a new storage class

NAMESPACE="production"
STATEFULSET="postgres"
OLD_STORAGE_CLASS="standard"
NEW_STORAGE_CLASS="fast-ssd"
REPLICA_COUNT=3
PVC_SIZE="100Gi"
PVC_PREFIX="data"

echo "=== StatefulSet Storage Class Migration ==="
echo "Target: $NAMESPACE/$STATEFULSET"
echo "From: $OLD_STORAGE_CLASS -> To: $NEW_STORAGE_CLASS"
echo ""

# Step 1: Scale down the StatefulSet gracefully
echo "Step 1: Scaling down StatefulSet..."
kubectl scale statefulset/$STATEFULSET -n $NAMESPACE --replicas=0
kubectl wait statefulset/$STATEFULSET -n $NAMESPACE \
    --for=jsonpath='{.status.readyReplicas}=0' \
    --timeout=5m

# Step 2: Create new PVCs with new storage class
echo "Step 2: Creating new PVCs with $NEW_STORAGE_CLASS..."
for i in $(seq 0 $((REPLICA_COUNT - 1))); do
    cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${PVC_PREFIX}-new-${STATEFULSET}-${i}
  namespace: ${NAMESPACE}
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: ${NEW_STORAGE_CLASS}
  resources:
    requests:
      storage: ${PVC_SIZE}
EOF
done

# Step 3: Wait for PVCs to bind
echo "Step 3: Waiting for PVCs to bind..."
for i in $(seq 0 $((REPLICA_COUNT - 1))); do
    kubectl wait pvc/${PVC_PREFIX}-new-${STATEFULSET}-${i} -n $NAMESPACE \
        --for=jsonpath='{.status.phase}=Bound' \
        --timeout=5m
done

# Step 4: Data migration via rsync job (conceptual)
echo "Step 4: Data migration (requires manual data copy job)"
echo "  Mount old PVC (${PVC_PREFIX}-${STATEFULSET}-0) and new PVC (${PVC_PREFIX}-new-${STATEFULSET}-0)"
echo "  Use a migration Job to rsync data between PVCs"

# Step 5: Delete old StatefulSet (keep PVCs with --cascade=orphan)
echo "Step 5: Deleting StatefulSet (keeping PVCs)..."
kubectl delete statefulset/$STATEFULSET -n $NAMESPACE --cascade=orphan

# Step 6: Rename new PVCs to match expected StatefulSet naming
echo "Step 6: PVC renaming (requires manual steps - PVCs cannot be renamed)"
echo "  Option A: Use a StatefulSet with volumeClaimTemplate pointing to the new PVCs"
echo "  Option B: Create a StatefulSet with a different PVC prefix and update app config"

echo ""
echo "Migration preparation complete. Review above steps before proceeding."
```

## Zero-Downtime PostgreSQL Upgrades with CloudNativePG

The CloudNativePG operator manages PostgreSQL StatefulSets with awareness of replication state and switchover timing.

### Cluster Configuration

```yaml
# postgres-cluster.yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: postgres-production
  namespace: production
spec:
  instances: 3

  imageName: ghcr.io/cloudnative-pg/postgresql:16.3

  # Primary update strategy: switchover before restarting primary
  primaryUpdateStrategy: unsupervised
  primaryUpdateMethod: switchover  # switchover (graceful) vs restart

  # Update ordering controls
  # renovate: enable = auto-update on new image tags
  enableSuperuserAccess: false

  storage:
    size: 100Gi
    storageClass: fast-ssd

  resources:
    requests:
      memory: "2Gi"
      cpu: "1000m"
    limits:
      memory: "4Gi"
      cpu: "2000m"

  postgresql:
    parameters:
      max_connections: "200"
      shared_buffers: "512MB"
      wal_level: logical

  monitoring:
    enablePodMonitor: true

  backup:
    barmanObjectStore:
      destinationPath: s3://postgres-backups-prod/
      endpointURL: https://s3.amazonaws.com
      s3Credentials:
        accessKeyId:
          name: s3-credentials
          key: ACCESS_KEY_ID
        secretAccessKey:
          name: s3-credentials
          key: ACCESS_SECRET_KEY
      wal:
        compression: gzip
    retentionPolicy: "30d"
```

### Minor Version Upgrade (e.g., 16.3 to 16.4)

```bash
# Update the cluster image tag
kubectl patch cluster postgres-production -n production \
    --type='merge' \
    -p='{"spec":{"imageName":"ghcr.io/cloudnative-pg/postgresql:16.4"}}'

# CloudNativePG automatically:
# 1. Upgrades replicas first (one at a time, verifies replication)
# 2. Performs a switchover to elect a new primary from updated replicas
# 3. Updates the old primary (now a replica)

# Watch the upgrade progress
kubectl cnpg status postgres-production -n production --watch

# Or watch pod events
kubectl get events -n production --field-selector involvedObject.name=postgres-production \
    -w --sort-by='.lastTimestamp'
```

### Major Version Upgrade (e.g., 15 to 16)

Major version upgrades require `pg_upgrade`, which CloudNativePG handles through an import workflow:

```yaml
# postgres-v16-cluster.yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: postgres-production-v16
  namespace: production
spec:
  instances: 3
  imageName: ghcr.io/cloudnative-pg/postgresql:16.3

  bootstrap:
    initdb:
      import:
        type: microservice   # or monolith for full pg_upgrade
        databases:
          - appdb
        source:
          externalCluster: postgres-production-v15

  externalClusters:
    - name: postgres-production-v15
      connectionParameters:
        host: postgres-production-rw.production.svc.cluster.local
        user: streaming_replica
        dbname: appdb
        sslmode: require
      password:
        name: postgres-production-v15-app
        key: password

  storage:
    size: 100Gi
    storageClass: fast-ssd
```

## Redis Cluster Upgrades with Redis Operator

### Redis Cluster Configuration

```yaml
# redis-cluster.yaml
apiVersion: redis.redis.opstreelabs.in/v1beta2
kind: RedisCluster
metadata:
  name: redis-production
  namespace: production
spec:
  clusterSize: 3                # 3 master + 3 replica = 6 pods
  clusterVersion: v7            # Enables Redis 7.x features

  kubernetesConfig:
    image: redis:7.2.4
    imagePullPolicy: IfNotPresent
    resources:
      requests:
        cpu: "100m"
        memory: "128Mi"
      limits:
        cpu: "500m"
        memory: "512Mi"

  redisCluster:
    leader:
      replicas: 3
    follower:
      replicas: 3

  storage:
    persistenceEnabled: true
    redisDataVolumeClaimTemplate:
      spec:
        accessModes:
          - ReadWriteOnce
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 10Gi

  redisConfig:
    maxmemory: "400mb"
    maxmemory-policy: "allkeys-lru"
    save: "900 1 300 10 60 10000"
```

### Redis Rolling Upgrade Procedure

```bash
# Update Redis image version
kubectl patch rediscluster redis-production -n production \
    --type='merge' \
    -p='{"spec":{"kubernetesConfig":{"image":"redis:7.2.5"}}}'

# The operator updates replicas first, then triggers failover to promote updated replicas
# Watch the StatefulSet update
kubectl rollout status statefulset/redis-production-leader -n production
kubectl rollout status statefulset/redis-production-follower -n production

# Verify cluster health after upgrade
kubectl exec -n production redis-production-leader-0 -- \
    redis-cli cluster info | grep -E "cluster_state|cluster_slots_assigned|cluster_known_nodes"
# cluster_state:ok
# cluster_slots_assigned:16384
# cluster_known_nodes:6

# Check each master's replication status
for i in 0 1 2; do
    echo "=== redis-production-leader-$i ==="
    kubectl exec -n production redis-production-leader-$i -- \
        redis-cli info replication | grep -E "role:|connected_slaves:|master_link_status:"
done
```

## StatefulSet Upgrade Monitoring

### Pre-Upgrade Health Verification

```bash
#!/bin/bash
# pre-upgrade-check.sh
# Verify StatefulSet health before triggering upgrade

NAMESPACE="${1:?Usage: $0 <namespace> <statefulset-name>}"
STATEFULSET="${2:?Usage: $0 <namespace> <statefulset-name>}"

echo "Pre-upgrade health check for $NAMESPACE/$STATEFULSET"

# 1. Verify all pods are Ready
READY=$(kubectl get statefulset/$STATEFULSET -n $NAMESPACE \
    -o jsonpath='{.status.readyReplicas}')
DESIRED=$(kubectl get statefulset/$STATEFULSET -n $NAMESPACE \
    -o jsonpath='{.spec.replicas}')

if [[ "$READY" != "$DESIRED" ]]; then
    echo "FAIL: Only $READY/$DESIRED replicas are Ready"
    exit 1
fi
echo "PASS: All $DESIRED replicas are Ready"

# 2. Verify no pending updates
UPDATED=$(kubectl get statefulset/$STATEFULSET -n $NAMESPACE \
    -o jsonpath='{.status.updatedReplicas}')
if [[ "$UPDATED" != "$DESIRED" ]]; then
    echo "WARN: Only $UPDATED/$DESIRED replicas are on current template (ongoing update?)"
fi

# 3. Check recent restart rate
RESTART_COUNT=$(kubectl get pods -n $NAMESPACE \
    -l "$(kubectl get statefulset/$STATEFULSET -n $NAMESPACE \
        -o jsonpath='{.spec.selector.matchLabels}' | \
        python3 -c 'import sys,json; d=json.load(sys.stdin); print(",".join(f"{k}={v}" for k,v in d.items()))')" \
    -o jsonpath='{range .items[*]}{.status.containerStatuses[0].restartCount}{"\n"}{end}' | \
    awk '{sum+=$1} END {print sum}')

echo "Total restart count across pods: $RESTART_COUNT"
[[ "$RESTART_COUNT" -gt 10 ]] && echo "WARN: High restart count may indicate instability"

echo ""
echo "Pre-upgrade check complete. Proceed if all checks passed."
```

### Post-Upgrade Verification

```bash
#!/bin/bash
# post-upgrade-verify.sh

NAMESPACE="${1:?Usage: $0 <namespace> <statefulset-name> <expected-image>}"
STATEFULSET="${2:?}"
EXPECTED_IMAGE="${3:?}"

echo "Post-upgrade verification for $NAMESPACE/$STATEFULSET"

# 1. All pods running expected image
WRONG_IMAGE=$(kubectl get pods -n $NAMESPACE \
    -l app=$STATEFULSET \
    -o jsonpath='{range .items[*]}{.metadata.name}: {.status.containerStatuses[0].image}{"\n"}{end}' | \
    grep -v "$EXPECTED_IMAGE" | wc -l)

if [[ "$WRONG_IMAGE" -gt 0 ]]; then
    echo "FAIL: $WRONG_IMAGE pod(s) not running expected image $EXPECTED_IMAGE"
    kubectl get pods -n $NAMESPACE -l app=$STATEFULSET \
        -o jsonpath='{range .items[*]}{.metadata.name}: {.status.containerStatuses[0].image}{"\n"}{end}'
    exit 1
fi
echo "PASS: All pods running $EXPECTED_IMAGE"

# 2. All pods Ready
kubectl wait statefulset/$STATEFULSET -n $NAMESPACE \
    --for=jsonpath='{.status.readyReplicas}={.spec.replicas}' \
    --timeout=5m
echo "PASS: All pods Ready"

# 3. No pods in CrashLoopBackOff or Error state
BAD_PODS=$(kubectl get pods -n $NAMESPACE -l app=$STATEFULSET \
    --field-selector='status.phase!=Running' \
    --no-headers | wc -l)
if [[ "$BAD_PODS" -gt 0 ]]; then
    echo "FAIL: $BAD_PODS pod(s) in non-Running state"
    exit 1
fi
echo "PASS: No pods in error state"

echo ""
echo "Upgrade verification complete: PASSED"
```

## Handling Failed Upgrades

### Rollback Procedure

```bash
# StatefulSet rollback (restore previous pod template)
kubectl rollout undo statefulset/postgres -n production

# Check rollout history
kubectl rollout history statefulset/postgres -n production
# REVISION  CHANGE-CAUSE
# 1         <none>
# 2         image update to postgres:16.4

# Rollback to specific revision
kubectl rollout undo statefulset/postgres -n production --to-revision=1

# Watch rollback progress
kubectl rollout status statefulset/postgres -n production -w
```

### Emergency: Stuck StatefulSet Update

```bash
# A StatefulSet update can stall if a pod fails to become Ready
# Check which pod is stuck
kubectl get pods -n production -l app=postgres -o wide

# Force delete the stuck pod (use with caution — may cause data loss for primary)
kubectl delete pod postgres-2 -n production --grace-period=0 --force

# If the update strategy is OnDelete, stuck pods won't update automatically
# Check if pods need manual deletion
kubectl get pods -n production -l app=postgres \
    -o jsonpath='{range .items[*]}{.metadata.name}: {.status.containerStatuses[0].image}{"\n"}{end}'

# Pause update by increasing partition beyond current stuck ordinal
kubectl patch statefulset postgres -n production \
    --type='json' \
    -p='[{"op":"replace","path":"/spec/updateStrategy/rollingUpdate/partition","value":3}]'
```

## Summary

StatefulSet upgrade strategy selection is one of the most consequential decisions for database operators in Kubernetes. The `RollingUpdate` with partition provides the safest path: upgrade one replica at a time, validate replication health and query correctness, then proceed to the next. `OnDelete` provides explicit control for maintenance-window-based upgrades where the ordering and timing must align with external factors like downstream service deployments.

Purpose-built database operators like CloudNativePG and Redis Operator abstract the most complex upgrade logic—primary switchover, replication lag verification, cluster slot rebalancing—into controller reconciliation loops that implement the same patterns described here but with deeper database-specific knowledge. For databases without dedicated operators, these same partition-based patterns, combined with pre- and post-upgrade health verification scripts, deliver zero-downtime upgrades with full rollback capability.
