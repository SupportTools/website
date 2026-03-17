---
title: "Kubernetes StatefulSet Patterns for Distributed Databases: Ordering, Identity, and Stable Storage"
date: 2031-09-22T00:00:00-05:00
draft: false
tags: ["Kubernetes", "StatefulSet", "Databases", "Distributed Systems", "Storage", "PostgreSQL"]
categories:
- Kubernetes
- Databases
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep-dive into Kubernetes StatefulSet patterns for running distributed databases: pod identity, ordered startup, stable network identities, persistent volume management, and production operational patterns."
more_link: "yes"
url: "/kubernetes-statefulset-patterns-distributed-databases/"
---

Running stateful workloads on Kubernetes was once considered inadvisable. That view has shifted substantially. The StatefulSet controller, combined with dynamic PVC provisioning, headless services, and pod disruption budgets, provides the primitives needed to run production-grade distributed databases on Kubernetes. What remains challenging is not the mechanics but the patterns: understanding what StatefulSet guarantees, what it does not, and how to build reliable databases on top of those guarantees.

This post examines StatefulSet behavior in depth — stable identity, ordered operations, volume management, and upgrade strategies — then builds production patterns for three common distributed database topologies: primary/replica replication (PostgreSQL), quorum-based consensus (etcd), and ring-based distribution (Cassandra).

<!--more-->

# Kubernetes StatefulSet Patterns for Distributed Databases

## StatefulSet Core Guarantees

StatefulSet provides four guarantees that distinguish it from a Deployment:

**1. Stable, unique pod identities** — Each pod gets an ordinal index (`db-0`, `db-1`, `db-2`) that persists across pod restarts, rescheduling, and node failures. The pod name is deterministic.

**2. Stable network identity** — Combined with a headless service, each pod gets a stable DNS name: `db-0.db-service.namespace.svc.cluster.local`. This DNS entry resolves to the pod's current IP regardless of rescheduling.

**3. Ordered, graceful deployment and scaling** — By default, pods are created in order (0, 1, 2, ...) and each must be running and ready before the next starts. Scaling down happens in reverse order.

**4. Stable storage** — Each pod gets its own PVC created from a `volumeClaimTemplate`. This PVC persists across pod restarts and rescheduling. Deleting the pod does not delete its PVC.

What StatefulSet does **not** provide:
- Automatic failover or leader election
- Application-layer health of the database
- Cross-pod synchronization (replication is the application's responsibility)
- Protection against data loss from PVC deletion

## Headless Service and DNS

Every StatefulSet requires a headless service (ClusterIP: None) for DNS-based pod discovery:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: postgres
  namespace: production
  labels:
    app: postgres
spec:
  clusterIP: None   # headless
  selector:
    app: postgres
  ports:
    - port: 5432
      name: postgres
---
# Additional service for client access (routes to primary only)
apiVersion: v1
kind: Service
metadata:
  name: postgres-primary
  namespace: production
spec:
  selector:
    app: postgres
    role: primary  # set by the pod's init logic
  ports:
    - port: 5432
      name: postgres
---
# Read-only service for replicas
apiVersion: v1
kind: Service
metadata:
  name: postgres-replica
  namespace: production
spec:
  selector:
    app: postgres
    role: replica
  ports:
    - port: 5432
      name: postgres
```

With the headless service, you can reach any pod by DNS:

```
postgres-0.postgres.production.svc.cluster.local
postgres-1.postgres.production.svc.cluster.local
postgres-2.postgres.production.svc.cluster.local
```

The service also creates an A record that resolves to all pod IPs, useful for topology-aware client connections.

## PostgreSQL Primary/Replica StatefulSet

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: production
spec:
  serviceName: postgres
  replicas: 3
  podManagementPolicy: OrderedReady   # ensures primary (index 0) starts first
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      terminationGracePeriodSeconds: 120

      initContainers:
        # Determine role based on pod ordinal and cluster state
        - name: init-role
          image: postgres:16
          command:
            - /bin/bash
            - -c
            - |
              set -e
              ORDINAL=${HOSTNAME##*-}
              CLUSTER_NAME="postgres"

              # Pod 0 is always the initial primary
              # Subsequent pods check if they should be replicas
              if [ "$ORDINAL" = "0" ]; then
                echo "primary" > /etc/postgres-role/role
                echo "POD 0: starting as primary"
              else
                # Check if primary is already running
                PRIMARY="postgres-0.postgres.production.svc.cluster.local"
                if pg_isready -h "$PRIMARY" -p 5432 -U postgres 2>/dev/null; then
                  echo "replica" > /etc/postgres-role/role
                  echo "PRIMARY found at $PRIMARY, starting as replica"
                else
                  echo "primary" > /etc/postgres-role/role
                  echo "PRIMARY not found, starting as primary"
                fi
              fi
          volumeMounts:
            - name: role-dir
              mountPath: /etc/postgres-role

      containers:
        - name: postgres
          image: postgres:16
          command:
            - /bin/bash
            - -c
            - |
              ROLE=$(cat /etc/postgres-role/role)
              ORDINAL=${HOSTNAME##*-}
              PGDATA=/var/lib/postgresql/data/pgdata

              if [ "$ROLE" = "primary" ]; then
                # Initialize if not already done
                if [ ! -f "$PGDATA/PG_VERSION" ]; then
                  initdb -D "$PGDATA" \
                    --auth-local=peer \
                    --auth-host=scram-sha-256
                  cat >> "$PGDATA/postgresql.conf" <<EOF
              listen_addresses = '*'
              wal_level = replica
              max_wal_senders = 10
              max_replication_slots = 10
              hot_standby = on
              synchronous_standby_names = ''
              EOF
                  cat >> "$PGDATA/pg_hba.conf" <<EOF
              host replication replicator all scram-sha-256
              EOF
                  pg_ctl start -D "$PGDATA" -w
                  psql -c "CREATE ROLE replicator WITH LOGIN REPLICATION ENCRYPTED PASSWORD '$REPLICATION_PASSWORD';"
                  pg_ctl stop -D "$PGDATA" -w
                fi
                exec postgres -D "$PGDATA"

              else
                # Replica: clone from primary if data directory is empty
                PRIMARY="postgres-0.postgres.production.svc.cluster.local"
                if [ ! -f "$PGDATA/PG_VERSION" ]; then
                  pg_basebackup \
                    -h "$PRIMARY" \
                    -U replicator \
                    -D "$PGDATA" \
                    -P -R -X stream
                fi
                exec postgres -D "$PGDATA"
              fi
          env:
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: postgres-credentials
                  key: postgres-password
            - name: REPLICATION_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: postgres-credentials
                  key: replication-password
          ports:
            - containerPort: 5432
          resources:
            requests:
              cpu: "500m"
              memory: "1Gi"
            limits:
              cpu: "4000m"
              memory: "8Gi"
          readinessProbe:
            exec:
              command:
                - pg_isready
                - -U
                - postgres
            initialDelaySeconds: 15
            periodSeconds: 10
            failureThreshold: 6
          livenessProbe:
            exec:
              command:
                - pg_isready
                - -U
                - postgres
            initialDelaySeconds: 45
            periodSeconds: 30
            failureThreshold: 3
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
            - name: role-dir
              mountPath: /etc/postgres-role

        # Sidecar: exports Prometheus metrics
        - name: postgres-exporter
          image: prometheuscommunity/postgres-exporter:latest
          env:
            - name: DATA_SOURCE_NAME
              value: "postgresql://postgres:$(POSTGRES_PASSWORD)@localhost:5432/postgres?sslmode=disable"
          ports:
            - containerPort: 9187
              name: metrics

      volumes:
        - name: role-dir
          emptyDir: {}

  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 100Gi
```

## PodManagementPolicy: Parallel vs OrderedReady

The `podManagementPolicy` field controls how pods are created during scale-up:

```yaml
# OrderedReady (default): Start pod 0, wait for Ready, then start pod 1, etc.
# Required for databases that need the primary to exist before replicas initialize
podManagementPolicy: OrderedReady

# Parallel: Start all pods simultaneously
# Suitable for databases that use consensus for initialization (etcd, Cassandra)
podManagementPolicy: Parallel
```

For etcd and Cassandra, Parallel mode is preferred because initialization is peer-to-peer — no single node needs to be "first":

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: etcd
  namespace: platform
spec:
  serviceName: etcd
  replicas: 3
  podManagementPolicy: Parallel
```

## etcd StatefulSet

etcd's bootstrap requires each member to know the initial cluster topology:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: etcd
  namespace: platform
spec:
  serviceName: etcd
  replicas: 3
  podManagementPolicy: Parallel
  selector:
    matchLabels:
      app: etcd
  template:
    metadata:
      labels:
        app: etcd
    spec:
      containers:
        - name: etcd
          image: quay.io/coreos/etcd:v3.5.15
          command:
            - /bin/sh
            - -ec
            - |
              HOSTNAME=$(hostname)
              CLUSTER_SIZE=3
              SVC_NAME=etcd
              NAMESPACE=platform
              DOMAIN="${SVC_NAME}.${NAMESPACE}.svc.cluster.local"

              # Build initial-cluster string
              INITIAL_CLUSTER=""
              for i in $(seq 0 $((CLUSTER_SIZE - 1))); do
                if [ -n "$INITIAL_CLUSTER" ]; then
                  INITIAL_CLUSTER="${INITIAL_CLUSTER},"
                fi
                INITIAL_CLUSTER="${INITIAL_CLUSTER}etcd-${i}=http://etcd-${i}.${DOMAIN}:2380"
              done

              exec etcd \
                --name="${HOSTNAME}" \
                --data-dir=/var/etcd/data \
                --listen-client-urls=http://0.0.0.0:2379 \
                --advertise-client-urls=http://${HOSTNAME}.${DOMAIN}:2379 \
                --listen-peer-urls=http://0.0.0.0:2380 \
                --initial-advertise-peer-urls=http://${HOSTNAME}.${DOMAIN}:2380 \
                --initial-cluster="${INITIAL_CLUSTER}" \
                --initial-cluster-token=etcd-cluster-token \
                --initial-cluster-state=new \
                --heartbeat-interval=250 \
                --election-timeout=1250 \
                --snapshot-count=10000 \
                --auto-compaction-mode=revision \
                --auto-compaction-retention=1000
          ports:
            - containerPort: 2379
              name: client
            - containerPort: 2380
              name: peer
          resources:
            requests:
              cpu: "200m"
              memory: "512Mi"
            limits:
              cpu: "2000m"
              memory: "4Gi"
          readinessProbe:
            exec:
              command:
                - /bin/sh
                - -ec
                - ETCDCTL_API=3 etcdctl endpoint health
            initialDelaySeconds: 10
            periodSeconds: 10
          livenessProbe:
            exec:
              command:
                - /bin/sh
                - -ec
                - ETCDCTL_API=3 etcdctl endpoint health
            initialDelaySeconds: 30
            periodSeconds: 20
          volumeMounts:
            - name: data
              mountPath: /var/etcd/data

  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 20Gi
```

## Update Strategies

StatefulSet supports two update strategies:

### RollingUpdate (default)

Pods are updated in reverse ordinal order (highest index first):

```yaml
spec:
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      # Update one pod at a time, starting from the highest ordinal
      maxUnavailable: 1
      # Partition: only update pods with ordinal >= partition
      # Useful for canary rollouts: update replicas first, then promote
      partition: 0
```

Canary update workflow for a 3-replica cluster:

```bash
# Step 1: Update only replicas (leave primary at ordinal 0 untouched)
kubectl patch statefulset postgres -p '{"spec":{"updateStrategy":{"rollingUpdate":{"partition":1}}}}'
kubectl set image statefulset/postgres postgres=postgres:16.1

# Verify replicas are healthy
kubectl get pods -l app=postgres
# postgres-2 and postgres-1 update, postgres-0 remains on old version

# Step 2: Promote: update the primary after replicas are healthy
kubectl patch statefulset postgres -p '{"spec":{"updateStrategy":{"rollingUpdate":{"partition":0}}}}'
```

### OnDelete

The StatefulSet controller only creates replacement pods when old pods are manually deleted. Useful when you need precise control over the update order:

```yaml
spec:
  updateStrategy:
    type: OnDelete
```

```bash
# Manual rolling update for PostgreSQL with controlled failover
# 1. Update config in the StatefulSet spec
kubectl apply -f postgres-statefulset-v2.yaml

# 2. Delete replica pods first (manually, with verification)
kubectl delete pod postgres-2
kubectl wait --for=condition=ready pod/postgres-2

kubectl delete pod postgres-1
kubectl wait --for=condition=ready pod/postgres-1

# 3. Perform planned failover to replica before updating primary
# (application-specific: promote postgres-1 to primary first)
kubectl delete pod postgres-0
kubectl wait --for=condition=ready pod/postgres-0
```

## Pod Disruption Budgets

A PDB is essential for safe node drains:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: postgres-pdb
  namespace: production
spec:
  minAvailable: 2   # always keep at least 2 of 3 pods running
  selector:
    matchLabels:
      app: postgres
---
# For etcd: must maintain quorum
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: etcd-pdb
  namespace: platform
spec:
  minAvailable: 2   # quorum of 3-node cluster requires 2 nodes
  selector:
    matchLabels:
      app: etcd
```

## PVC Lifecycle Management

PVCs are NOT deleted when a StatefulSet is deleted. This is a safety feature. Managing PVCs requires explicit commands:

```bash
# List PVCs for a StatefulSet
kubectl get pvc -n production -l app=postgres

# Delete StatefulSet WITHOUT deleting PVCs (safe, data preserved)
kubectl delete statefulset postgres

# Re-create the StatefulSet - it will claim the existing PVCs
kubectl apply -f postgres-statefulset.yaml

# To fully delete including data (DESTRUCTIVE)
kubectl delete statefulset postgres
kubectl delete pvc -l app=postgres
```

For automated PVC cleanup on scale-down (Kubernetes 1.27+), use `persistentVolumeClaimRetentionPolicy`:

```yaml
spec:
  persistentVolumeClaimRetentionPolicy:
    whenDeleted: Delete   # delete PVCs when StatefulSet is deleted
    whenScaled: Retain    # keep PVCs when scaling down (prevents data loss)
```

## Cassandra Ring StatefulSet

Cassandra's ring topology requires seed nodes for cluster bootstrap:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: cassandra
  namespace: production
spec:
  serviceName: cassandra
  replicas: 6
  podManagementPolicy: Parallel
  selector:
    matchLabels:
      app: cassandra
  template:
    metadata:
      labels:
        app: cassandra
    spec:
      terminationGracePeriodSeconds: 300
      containers:
        - name: cassandra
          image: cassandra:4.1
          ports:
            - containerPort: 7000
              name: intra-node
            - containerPort: 7001
              name: tls-intra-node
            - containerPort: 7199
              name: jmx
            - containerPort: 9042
              name: cql
          resources:
            requests:
              cpu: "2000m"
              memory: "8Gi"
            limits:
              cpu: "4000m"
              memory: "16Gi"
          env:
            - name: MAX_HEAP_SIZE
              value: "4G"
            - name: HEAP_NEWSIZE
              value: "800M"
            - name: CASSANDRA_SEEDS
              # Seeds: first 2 pods in the StatefulSet
              value: "cassandra-0.cassandra.production.svc.cluster.local,cassandra-1.cassandra.production.svc.cluster.local"
            - name: CASSANDRA_CLUSTER_NAME
              value: "production-cluster"
            - name: CASSANDRA_DC
              value: "dc1"
            - name: CASSANDRA_RACK
              value: "rack1"
            - name: CASSANDRA_AUTO_BOOTSTRAP
              value: "false"
            - name: POD_IP
              valueFrom:
                fieldRef:
                  fieldPath: status.podIP
            - name: CASSANDRA_LISTEN_ADDRESS
              valueFrom:
                fieldRef:
                  fieldPath: status.podIP
          readinessProbe:
            exec:
              command:
                - /bin/bash
                - -c
                - nodetool status | grep -E "^UN\s+${POD_IP}"
            initialDelaySeconds: 90
            periodSeconds: 30
            failureThreshold: 5
          lifecycle:
            preStop:
              exec:
                command:
                  - /bin/sh
                  - -c
                  - nodetool drain && sleep 30
          volumeMounts:
            - name: data
              mountPath: /var/lib/cassandra/data
            - name: commitlog
              mountPath: /var/lib/cassandra/commitlog

  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 500Gi
    - metadata:
        name: commitlog
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 50Gi
```

## Anti-Affinity for Fault Domain Spreading

Spreading database pods across failure domains is critical:

```yaml
spec:
  template:
    spec:
      affinity:
        podAntiAffinity:
          # Hard: never place two pods on the same node
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: postgres
              topologyKey: kubernetes.io/hostname

        # Soft: prefer spreading across availability zones
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    app: postgres
                topologyKey: topology.kubernetes.io/zone
```

For large clusters, use topology spread constraints:

```yaml
spec:
  template:
    spec:
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: postgres
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: postgres
```

## Operator Pattern vs Raw StatefulSet

For production databases, consider the tradeoffs:

| Aspect | Raw StatefulSet | Operator |
|--------|----------------|----------|
| Failover | Manual | Automated (Patroni, Stolon) |
| Backup | Manual/CronJob | Integrated |
| Schema migrations | Manual | Integrated (some operators) |
| Scaling complexity | High | Reduced |
| Operational visibility | Limited | Rich status/events |
| Learning curve | Lower | Higher |
| Customization | Full | Within operator API |

Popular operators:

- **PostgreSQL**: CloudNativePG, Zalando Postgres Operator, Crunchy PGO
- **MySQL**: Oracle MySQL Operator, Percona Operator
- **Cassandra**: K8ssandra
- **etcd**: etcd-operator (various forks)
- **Redis**: Redis Operator, Spotahome Redis Operator

## Monitoring StatefulSet Health

```yaml
# Prometheus alerts for StatefulSet databases
groups:
  - name: statefulset-databases
    rules:
      - alert: StatefulSetReplicasMismatch
        expr: |
          kube_statefulset_status_replicas_ready{
            namespace=~"production|platform"
          } < kube_statefulset_status_replicas{
            namespace=~"production|platform"
          }
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "StatefulSet {{ $labels.statefulset }} has {{ $value }} ready replicas"

      - alert: StatefulSetUpdateStuck
        expr: |
          kube_statefulset_status_current_revision{
            namespace=~"production|platform"
          } != kube_statefulset_status_update_revision{
            namespace=~"production|platform"
          }
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "StatefulSet {{ $labels.statefulset }} update is stuck"

      - alert: PersistentVolumeFillingUp
        expr: |
          kubelet_volume_stats_available_bytes{
            persistentvolumeclaim=~"data-postgres.*|data-cassandra.*"
          } / kubelet_volume_stats_capacity_bytes < 0.15
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "PVC {{ $labels.persistentvolumeclaim }} is {{ printf \"%.0f\" (100 - $value * 100) }}% full"
```

## Summary

StatefulSet provides the correct abstractions for running distributed databases on Kubernetes: stable pod identity enables database-level peer awareness, stable storage ensures data durability across pod restarts, and headless service DNS provides predictable network addresses. The critical patterns are: OrderedReady for primary/replica databases that require sequential initialization, Parallel for consensus-based databases, careful PDB configuration to maintain quorum, anti-affinity rules for fault domain distribution, and partition-based rolling updates for safe schema changes. While operators add operational sophistication on top of these primitives, a thorough understanding of raw StatefulSet mechanics is essential for debugging issues that inevitably surface in production.
