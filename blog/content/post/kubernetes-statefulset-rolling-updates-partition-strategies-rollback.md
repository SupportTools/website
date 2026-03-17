---
title: "Kubernetes StatefulSet Rolling Updates: Partition-Based Updates, maxUnavailable, Update Strategies, and Rollback"
date: 2032-01-30T00:00:00-05:00
draft: false
tags: ["Kubernetes", "StatefulSet", "Rolling Updates", "Database", "Operations", "Rollback"]
categories:
- Kubernetes
- Operations
author: "Matthew Mattox - mmattox@support.tools"
description: "In-depth guide to Kubernetes StatefulSet update strategies covering partition-based canary updates, maxUnavailable for parallel updates, update ordering, persistent volume handling during rollouts, and safe rollback procedures for stateful workloads like databases and message queues."
more_link: "yes"
url: "/kubernetes-statefulset-rolling-updates-partition-strategies-rollback/"
---

StatefulSets manage ordered, stateful workloads like databases, message queues, and distributed stores. Updating them safely requires understanding their ordered update semantics, the partition mechanism for canary testing, and the careful interaction with persistent volumes. Getting a StatefulSet update wrong can mean data corruption or extended downtime. This guide covers every aspect of StatefulSet updates for production operations.

<!--more-->

# Kubernetes StatefulSet Rolling Updates

## StatefulSet Update Strategy Overview

StatefulSets support two update strategies, configured under `.spec.updateStrategy`:

```yaml
spec:
  updateStrategy:
    type: RollingUpdate  # or OnDelete
    rollingUpdate:
      partition: 0       # only update pods with ordinal >= partition
      maxUnavailable: 1  # (Kubernetes 1.24+) allow parallel updates
```

**RollingUpdate** (default): Kubernetes automatically replaces pods in reverse ordinal order (N, N-1, ..., 0). Each pod is terminated and recreated before the next one is replaced.

**OnDelete**: Pods are only replaced when manually deleted. The controller does not automatically update running pods. Useful when you need to coordinate updates with application-level logic.

## Understanding Pod Ordinals and Update Order

```bash
# A StatefulSet with 5 replicas
kubectl get pods -l app=my-db --sort-by='.metadata.name'
# NAME       READY   STATUS    RESTARTS   AGE
# my-db-0    1/1     Running   0          24h
# my-db-1    1/1     Running   0          24h
# my-db-2    1/1     Running   0          24h
# my-db-3    1/1     Running   0          24h
# my-db-4    1/1     Running   0          24h

# After updating the image:
# Update order (RollingUpdate): my-db-4 -> my-db-3 -> my-db-2 -> my-db-1 -> my-db-0

# The controller waits for each pod to be Running and Ready before proceeding
# readinessProbe is the gate — ensure it accurately reflects application health
```

## Partition-Based Canary Updates

The `partition` field is the most powerful StatefulSet update feature. Only pods with ordinal >= partition are eligible for the update. This enables:

1. Testing the new version on a subset of replicas before full rollout
2. Progressive rollout coordinated with application-level membership management
3. Safe database primary/secondary update ordering

### Step-by-Step Partition Rollout

```yaml
# Initial state: 5-replica StatefulSet, all on version v1.2
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: kafka
  namespace: production
spec:
  replicas: 5
  serviceName: kafka-headless
  podManagementPolicy: OrderedReady
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      partition: 5  # Initially set to replicas: NO pods will be updated
  selector:
    matchLabels:
      app: kafka
  template:
    metadata:
      labels:
        app: kafka
    spec:
      containers:
      - name: kafka
        image: confluentinc/cp-kafka:7.7.1
        # ... (was 7.7.0)
```

**Phase 1: Update a single broker (ordinal 4)**

```bash
# First: set partition to 4 to update only kafka-4
kubectl patch statefulset kafka \
  --type='json' \
  -p='[{"op":"replace","path":"/spec/updateStrategy/rollingUpdate/partition","value":4}]'

# Also update the image
kubectl set image statefulset/kafka kafka=confluentinc/cp-kafka:7.7.1

# Watch kafka-4 update
kubectl rollout status statefulset/kafka
# Waiting for 1 pods to be ready...
# Waiting for pod kafka/kafka-4 to be updated...

# Verify kafka-4 is on new version, others are not
kubectl get pods -l app=kafka -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[0].image}{"\n"}{end}'
# kafka-0  confluentinc/cp-kafka:7.7.0
# kafka-1  confluentinc/cp-kafka:7.7.0
# kafka-2  confluentinc/cp-kafka:7.7.0
# kafka-3  confluentinc/cp-kafka:7.7.0
# kafka-4  confluentinc/cp-kafka:7.7.1

# Validate: run integration tests against the cluster
# Check broker metrics, partition leadership, consumer lag
kubectl exec -n production kafka-4 -- kafka-broker-api-versions.sh --bootstrap-server kafka-4:9092
```

**Phase 2: Expand to ordinals 3-4**

```bash
kubectl patch statefulset kafka \
  --type='json' \
  -p='[{"op":"replace","path":"/spec/updateStrategy/rollingUpdate/partition","value":3}]'

kubectl rollout status statefulset/kafka
# Waiting for pod kafka/kafka-3 to be updated...
```

**Phase 3: Complete rollout**

```bash
# Set partition to 0 to update all remaining pods
kubectl patch statefulset kafka \
  --type='json' \
  -p='[{"op":"replace","path":"/spec/updateStrategy/rollingUpdate/partition","value":0}]'

kubectl rollout status statefulset/kafka
# statefulset rolling update complete 5 pods at revision kafka-7d9b8c4f5...
```

### Automated Partition Rollout Script

```bash
#!/bin/bash
# statefulset-canary-rollout.sh
# Usage: ./statefulset-canary-rollout.sh <namespace> <statefulset-name> <new-image>

set -euo pipefail

NAMESPACE="$1"
STS_NAME="$2"
NEW_IMAGE="$3"
VALIDATION_SCRIPT="${4:-}"  # Optional validation script to run between phases

# Get current replica count
REPLICAS=$(kubectl get statefulset "$STS_NAME" -n "$NAMESPACE" \
  -o jsonpath='{.spec.replicas}')

echo "StatefulSet: $STS_NAME"
echo "Replicas: $REPLICAS"
echo "New Image: $NEW_IMAGE"

# Set partition to replicas count (effectively freeze the rollout)
echo "Freezing rollout (partition=$REPLICAS)..."
kubectl patch statefulset "$STS_NAME" -n "$NAMESPACE" \
  --type='json' \
  -p="[{\"op\":\"replace\",\"path\":\"/spec/updateStrategy/rollingUpdate/partition\",\"value\":$REPLICAS}]"

# Update the image
echo "Updating image to $NEW_IMAGE..."
kubectl set image "statefulset/$STS_NAME" "*=$NEW_IMAGE" -n "$NAMESPACE"

wait_for_pod_ready() {
    local pod_name="$1"
    local timeout=300
    echo "Waiting for $pod_name to be ready..."
    kubectl wait pod "$pod_name" -n "$NAMESPACE" \
      --for=condition=Ready \
      --timeout="${timeout}s"
}

validate() {
    local ordinal="$1"
    if [ -n "$VALIDATION_SCRIPT" ]; then
        echo "Running validation after updating ordinal $ordinal..."
        if ! bash "$VALIDATION_SCRIPT" "$NAMESPACE" "$STS_NAME" "$ordinal"; then
            echo "Validation FAILED at ordinal $ordinal"
            return 1
        fi
        echo "Validation passed for ordinal $ordinal"
    fi
}

# Progressive rollout: update one pod at a time, validating after each
for (( i=REPLICAS-1; i>=0; i-- )); do
    echo ""
    echo "=== Updating pod ordinal $i (partition=$i) ==="

    kubectl patch statefulset "$STS_NAME" -n "$NAMESPACE" \
      --type='json' \
      -p="[{\"op\":\"replace\",\"path\":\"/spec/updateStrategy/rollingUpdate/partition\",\"value\":$i}]"

    wait_for_pod_ready "${STS_NAME}-${i}"

    if ! validate "$i"; then
        echo "Rolling back: setting partition back to $((i+1))"
        kubectl patch statefulset "$STS_NAME" -n "$NAMESPACE" \
          --type='json' \
          -p="[{\"op\":\"replace\",\"path\":\"/spec/updateStrategy/rollingUpdate/partition\",\"value\":$((i+1))}]"
        echo "Rollout ABORTED at ordinal $i"
        exit 1
    fi

    echo "Ordinal $i updated and validated successfully"
done

echo ""
echo "=== Rollout COMPLETE ==="
kubectl get pods -n "$NAMESPACE" -l "app=$STS_NAME" \
  -o custom-columns='NAME:.metadata.name,IMAGE:.spec.containers[0].image,STATUS:.status.phase'
```

## maxUnavailable for Parallel Updates

Available since Kubernetes 1.24, `maxUnavailable` allows updating multiple pods simultaneously, which is critical for large StatefulSets where sequential updates would take hours.

```yaml
spec:
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      partition: 0
      maxUnavailable: 3  # Update 3 pods in parallel
```

### When to Use maxUnavailable

```yaml
# Replicated database (e.g., 9-node etcd cluster)
# Quorum = floor(9/2)+1 = 5, so maxUnavailable should be <= 4
spec:
  replicas: 9
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 2  # Conservative: keep 7/9 available
      partition: 0

# Kafka cluster: brokers are independent, but leadership affects availability
# Update non-leaders first (requires coordination with Kafka)
spec:
  replicas: 6
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 2

# Redis Cluster: 3 masters + 3 replicas
# Never update a master and its replica simultaneously
# Use partition to control which nodes update first
```

### Ordering with maxUnavailable

With `maxUnavailable > 1`, Kubernetes still respects the reverse ordinal order conceptually, but does not wait for each pod individually:

```bash
# With replicas=6, maxUnavailable=2:
# Step 1: Delete pods 5 and 4 simultaneously
# Step 2: Wait until both are Running and Ready
# Step 3: Delete pods 3 and 2 simultaneously
# Step 4: Wait until both are Running and Ready
# Step 5: Delete pods 1 and 0 simultaneously
```

Monitor parallel updates:

```bash
# Watch update progress with events
kubectl get pods -n production -l app=my-sts -w &
kubectl describe statefulset my-sts -n production | \
  grep -A 10 "Events:"
```

## OnDelete Strategy for Operator-Coordinated Updates

```yaml
spec:
  updateStrategy:
    type: OnDelete
```

With `OnDelete`, the StatefulSet controller updates `.spec.template` but does not restart pods. Updates only occur when you manually delete a pod:

```bash
# Use case: Cassandra cluster (ring topology)
# Must decommission a node before updating it

# Step 1: Decommission node before deletion
kubectl exec cassandra-4 -n production -- \
  nodetool decommission

# Wait for decommission to complete
until kubectl exec cassandra-4 -n production -- \
    nodetool netstats 2>&1 | grep -q "Mode: NORMAL"; do
  echo "Waiting for decommission..."
  sleep 10
done

# Step 2: Delete the pod (triggers recreation with new spec)
kubectl delete pod cassandra-4 -n production

# Step 3: Wait for the new pod to join the ring
kubectl wait pod cassandra-4 -n production \
  --for=condition=Ready --timeout=300s

# Step 4: Verify cluster state
kubectl exec cassandra-0 -n production -- nodetool status

# Repeat for each node
```

### OnDelete with a Controller Loop

```go
// Cassandra operator: OnDelete update coordination
func (r *CassandraReconciler) reconcileUpdate(
    ctx context.Context, sts *appsv1.StatefulSet,
) error {
    // Find pods that need updating
    pods, err := r.listPodsForSts(ctx, sts)
    if err != nil {
        return err
    }

    currentRevision := sts.Status.CurrentRevision
    updateRevision := sts.Status.UpdateRevision

    if currentRevision == updateRevision {
        return nil // Already up to date
    }

    for _, pod := range pods {
        podRevision := pod.Labels["controller-revision-hash"]
        if podRevision == updateRevision {
            continue // Already updated
        }

        // Check if cluster is healthy enough to update this node
        healthy, err := r.isCassandraClusterHealthy(ctx, sts, &pod)
        if err != nil || !healthy {
            r.recorder.Event(sts, v1.EventTypeWarning,
                "UpdateDeferred",
                fmt.Sprintf("Deferring update of %s: cluster not healthy", pod.Name))
            return nil
        }

        // Decommission, delete, wait
        if err := r.decommissionNode(ctx, &pod); err != nil {
            return err
        }
        if err := r.client.Delete(ctx, &pod); err != nil {
            return err
        }
        // Controller will re-queue; next reconcile will wait for Ready
        return nil
    }
    return nil
}
```

## Persistent Volume Handling During Updates

PVCs are not deleted or recreated during StatefulSet updates. The pod is replaced, but attaches to the same PVC.

### Understanding VolumeClaimTemplates

```yaml
spec:
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: [ReadWriteOnce]
      storageClassName: premium-rwo
      resources:
        requests:
          storage: 100Gi
```

When pod `my-db-3` is terminated during a rolling update:
1. The pod is deleted
2. The PVC `data-my-db-3` remains (`WaitForFirstConsumer` binding is preserved)
3. A new pod `my-db-3` is created
4. The new pod attaches to the existing PVC `data-my-db-3`

### PVC Expansion During Updates

If you need to resize PVCs as part of an update:

```bash
# PVC expansion is independent of StatefulSet updates
# Resize the PVC directly (storage class must support expansion)

# Option 1: Patch individual PVCs
for i in $(seq 0 4); do
  kubectl patch pvc "data-my-db-$i" -n production \
    --type='json' \
    -p='[{"op":"replace","path":"/spec/resources/requests/storage","value":"200Gi"}]'
done

# Wait for expansion to complete
kubectl get pvc -n production -l app=my-db -w

# Option 2: Update the VolumeClaimTemplate (affects FUTURE pods only, not existing PVCs)
# Note: Kubernetes does not automatically resize existing PVCs when template changes
```

### StorageClass Migration

Changing the storage class requires careful manual intervention:

```bash
#!/bin/bash
# Migrate StatefulSet pod from gp2 to gp3 storage class (AWS)

NAMESPACE="production"
STS_NAME="my-db"
POD_ORDINAL=4
OLD_PVC="data-my-db-$POD_ORDINAL"
SNAP_NAME="data-my-db-$POD_ORDINAL-migration-snap"

# 1. Create a VolumeSnapshot of the existing PVC
cat <<EOF | kubectl apply -f -
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: $SNAP_NAME
  namespace: $NAMESPACE
spec:
  volumeSnapshotClassName: ebs-vsc
  source:
    persistentVolumeClaimName: $OLD_PVC
EOF

# Wait for snapshot to be ready
kubectl wait volumesnapshot "$SNAP_NAME" -n "$NAMESPACE" \
  --for=jsonpath='{.status.readyToUse}'=true \
  --timeout=600s

# 2. Scale down the StatefulSet to ordinal (prevents pod recreation after PVC deletion)
kubectl patch statefulset "$STS_NAME" -n "$NAMESPACE" \
  --type='json' \
  -p='[{"op":"replace","path":"/spec/replicas","value":'"$POD_ORDINAL"'}]'

# Wait for pod to terminate
kubectl wait pod "my-db-$POD_ORDINAL" -n "$NAMESPACE" \
  --for=delete --timeout=120s

# 3. Delete the old PVC
kubectl delete pvc "$OLD_PVC" -n "$NAMESPACE"

# 4. Create new PVC from snapshot with new storage class
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: $OLD_PVC
  namespace: $NAMESPACE
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: gp3-encrypted
  resources:
    requests:
      storage: 200Gi
  dataSource:
    name: $SNAP_NAME
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
EOF

# 5. Scale back up
kubectl patch statefulset "$STS_NAME" -n "$NAMESPACE" \
  --type='json' \
  -p='[{"op":"replace","path":"/spec/replicas","value":'"$((POD_ORDINAL+1))"'}]'

kubectl wait pod "my-db-$POD_ORDINAL" -n "$NAMESPACE" \
  --for=condition=Ready --timeout=300s
```

## Rollback Procedures

### Check Rollout History

```bash
# StatefulSets track controller revisions (not the Deployment-style revision history)
kubectl get controllerrevisions -n production -l app=my-db \
  --sort-by='.metadata.creationTimestamp'
# NAME                       CONTROLLER      REVISION   AGE
# my-db-5d4c8b9f4           statefulset/my-db   1     24h
# my-db-7d9b8c4f5           statefulset/my-db   2     1h
# my-db-6a1d7e8f3           statefulset/my-db   3     5m

# Compare revisions
kubectl diff -f <(kubectl get controllerrevision my-db-5d4c8b9f4 \
  -n production -o jsonpath='{.data}' | python3 -m json.tool)
```

### Rollback via kubectl rollout

```bash
# Roll back to previous revision
kubectl rollout undo statefulset/my-db -n production

# Roll back to specific revision
kubectl rollout undo statefulset/my-db -n production --to-revision=1

# Watch rollback progress
kubectl rollout status statefulset/my-db -n production
```

### Manual Rollback via Partition

If the rollout is partially complete, use partition to control which pods roll back:

```bash
# Scenario: kafka-4 and kafka-3 are on new (bad) version
# kafka-0, kafka-1, kafka-2 are still on old version

# 1. Restore the old image
kubectl set image statefulset/kafka kafka=confluentinc/cp-kafka:7.7.0 -n production

# 2. Set partition to 3 (only update ordinals >= 3)
kubectl patch statefulset kafka -n production \
  --type='json' \
  -p='[{"op":"replace","path":"/spec/updateStrategy/rollingUpdate/partition","value":3}]'

# This will downgrade kafka-4 and kafka-3 back to 7.7.0
kubectl rollout status statefulset/kafka -n production

# 3. Verify all pods are on old version
kubectl get pods -n production -l app=kafka \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[0].image}{"\n"}{end}'
```

### Emergency: Force Rollback

When graceful rollback is not possible (e.g., the new version corrupted data at startup):

```bash
# Force delete stuck pod (bypasses finalizers — use with care)
kubectl delete pod my-db-4 -n production --force --grace-period=0

# If pod won't start due to Init container failure in new version:
# Temporarily override the image with --dry-run to verify YAML, then apply
kubectl patch pod my-db-4 -n production \
  --type='json' \
  -p='[{"op":"replace","path":"/spec/initContainers/0/image","value":"myapp:v1.2-init"}]'
# Note: This only affects the running pod, not the StatefulSet spec

# Proper fix: update the StatefulSet spec then delete the pod
kubectl set image statefulset/my-db "init-container=myapp:v1.2-init" -n production
kubectl delete pod my-db-4 -n production
```

## Health Check Configuration for Safe Updates

Readiness probes are the gate that controls rollout progression. They must accurately reflect application health:

```yaml
spec:
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
              # PostgreSQL: check replication lag for standbys
              if [ "$(psql -U postgres -tAc 'SELECT pg_is_in_recovery()')" = "t" ]; then
                # Standby: check replication lag < 10MB
                LAG=$(psql -U postgres -tAc "SELECT COALESCE(EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())), 0)::int")
                if [ "$LAG" -gt 30 ]; then exit 1; fi
              else
                # Primary: check WAL writer is running
                psql -U postgres -c '\q' || exit 1
              fi
          initialDelaySeconds: 15
          periodSeconds: 10
          failureThreshold: 3
          successThreshold: 1
          timeoutSeconds: 5
        livenessProbe:
          exec:
            command: ["pg_isready", "-U", "postgres"]
          initialDelaySeconds: 30
          periodSeconds: 30
          failureThreshold: 5
          timeoutSeconds: 5
        # Startup probe: longer grace period for large databases
        startupProbe:
          exec:
            command: ["pg_isready", "-U", "postgres"]
          initialDelaySeconds: 15
          periodSeconds: 10
          failureThreshold: 30  # up to 300s for startup
          timeoutSeconds: 5
```

## PodManagementPolicy

```yaml
spec:
  podManagementPolicy: Parallel  # vs OrderedReady (default)
```

`Parallel`: Pods are created/deleted in parallel during scale operations, but updates still respect `maxUnavailable`. Use for stateless pods in a StatefulSet (e.g., ZooKeeper ensemble with external coordination).

`OrderedReady` (default): Pods start and terminate in ordinal order. Required for databases where node bootstrap depends on existing cluster members.

## Troubleshooting Update Failures

```bash
# StatefulSet stuck in rollout
kubectl rollout status statefulset/my-db -n production
# Waiting for 1 pods to be ready...
# (stuck for > 10 minutes)

# Diagnose the stuck pod
kubectl describe pod my-db-3 -n production
# Events:
#   Warning  Unhealthy  5m  kubelet  Readiness probe failed: ...

# Check pod logs
kubectl logs my-db-3 -n production --previous

# Check if PVC is bound
kubectl get pvc data-my-db-3 -n production
# NAME           STATUS    VOLUME   CAPACITY   ACCESS MODES   STORAGECLASS
# data-my-db-3   Pending   ...                               premium-rwo

# PVC pending: check PV provisioner
kubectl describe pvc data-my-db-3 -n production
kubectl get events -n production --field-selector reason=FailedBinding

# Force unstick: if pod will never become ready, increase partition temporarily
kubectl patch statefulset my-db -n production \
  --type='json' \
  -p='[{"op":"replace","path":"/spec/updateStrategy/rollingUpdate/partition","value":4}]'
# This allows ordinals 0-3 to proceed while we fix ordinal 4

# Check update revision
kubectl get statefulset my-db -n production \
  -o jsonpath='{.status.updateRevision} {.status.currentRevision}'
```

## Production Checklist

Before updating a StatefulSet in production:

```bash
# 1. Backup data
kubectl exec my-db-0 -n production -- pg_dump -U postgres mydb | \
  gzip > backup-$(date +%Y%m%d).sql.gz

# 2. Verify cluster health
kubectl exec my-db-0 -n production -- psql -U postgres \
  -c "SELECT client_addr, state, sent_lsn, write_lsn, flush_lsn, replay_lsn FROM pg_stat_replication"

# 3. Check PDB allows the update
kubectl get pdb -n production
# NAME          MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS   AGE
# my-db-pdb     2               N/A               1                     30d

# 4. Set maxUnavailable consistent with PDB
# If PDB allows 1 disruption, maxUnavailable should be 1

# 5. Freeze rollout with high partition
kubectl patch statefulset my-db -n production \
  --type='json' \
  -p='[{"op":"replace","path":"/spec/updateStrategy/rollingUpdate/partition","value":5}]'

# 6. Update image
kubectl set image statefulset/my-db postgres=postgres:16.4 -n production

# 7. Test on last pod first
kubectl patch statefulset my-db -n production \
  --type='json' \
  -p='[{"op":"replace","path":"/spec/updateStrategy/rollingUpdate/partition","value":4}]'

# 8. Validate, then proceed
```

StatefulSet updates require a different mindset than Deployment updates. The ordered semantics exist to protect data integrity; working with them rather than against them is the key to safe zero-downtime upgrades of stateful workloads.
