---
title: "Kubernetes StatefulSet Advanced Patterns: Pod Management, PVC Lifecycle, and Database Operations"
date: 2028-06-10T00:00:00-05:00
draft: false
tags: ["Kubernetes", "StatefulSet", "Databases", "Storage", "PVC", "Distributed Systems"]
categories: ["Kubernetes", "Storage", "Databases"]
author: "Matthew Mattox - mmattox@support.tools"
description: "An advanced guide to Kubernetes StatefulSet patterns: ordered vs parallel pod management, PVC lifecycle and retention policies, init containers for schema migrations, headless service DNS-based discovery, and production database cluster patterns."
more_link: "yes"
url: "/kubernetes-stateful-set-patterns/"
---

StatefulSets are one of the most powerful and most misunderstood Kubernetes primitives. Where Deployments treat pods as interchangeable cattle, StatefulSets provide identity: each pod gets a stable name, stable network identity, and stable persistent storage that follows it through rescheduling. This guide covers advanced production patterns: ordered vs. parallel pod management policies, PVC retention behavior, init container patterns for database schema migration, headless service DNS-based peer discovery, and the operational patterns required to run production database clusters on Kubernetes.

<!--more-->

## When to Use StatefulSets

StatefulSets are appropriate when pods require one or more of:

- **Stable persistent storage**: Each pod gets its own PersistentVolumeClaim that is reattached on rescheduling
- **Stable network identity**: Pod names are predictable (`mysql-0`, `mysql-1`, `mysql-2`)
- **Ordered deployment and scaling**: Pod `n+1` is not created until pod `n` is Running and Ready
- **Ordered termination**: Pods are deleted in reverse order during scale-down

Use StatefulSets for: databases (MySQL, PostgreSQL, Cassandra), distributed coordinators (ZooKeeper, etcd), message queues (Kafka), and any application that requires per-instance configuration or data isolation.

Do not use StatefulSets when a Deployment suffices. StatefulSets add operational complexity (PVC management, ordered operations) that is unnecessary for stateless services.

## Basic StatefulSet Structure

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: production
spec:
  serviceName: postgres-headless  # Must reference a Headless Service
  replicas: 3
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
          env:
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: postgres-credentials
                  key: password
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
          ports:
            - containerPort: 5432
              name: postgres
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
          resources:
            requests:
              cpu: "500m"
              memory: "1Gi"
            limits:
              cpu: "2"
              memory: "4Gi"
          readinessProbe:
            exec:
              command:
                - pg_isready
                - -U
                - postgres
            initialDelaySeconds: 10
            periodSeconds: 5
            failureThreshold: 3
          livenessProbe:
            exec:
              command:
                - pg_isready
                - -U
                - postgres
            initialDelaySeconds: 30
            periodSeconds: 10
            failureThreshold: 5
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

## Pod Management Policies

StatefulSets support two pod management policies that control how pods are created, deleted, and scaled.

### OrderedReady (Default)

```yaml
spec:
  podManagementPolicy: OrderedReady
```

Behavior:
- Scale up: pods are created in order (0, 1, 2...). Each pod must be Running and Ready before the next is created.
- Scale down: pods are deleted in reverse order (2, 1, 0). Each pod must be fully terminated before the previous is deleted.
- Deployment: pods are updated one at a time, waiting for readiness.

Use for: databases that require ordered initialization (primary-replica setup), distributed systems with quorum requirements (ZooKeeper, etcd).

### Parallel

```yaml
spec:
  podManagementPolicy: Parallel
```

Behavior:
- Scale up: all pods are created simultaneously without waiting for readiness.
- Scale down: all pods are deleted simultaneously.
- Deployment: rolling update proceeds without waiting for each pod.

Use for: stateless-ish workloads that need stable names/storage but not ordered startup (Kafka brokers after initial setup, Redis replicas).

### Choosing the Right Policy

```yaml
# MySQL primary-replica: requires OrderedReady
# mysql-0 must be healthy before mysql-1 starts to replicate from it
spec:
  podManagementPolicy: OrderedReady
  serviceName: mysql-headless
  replicas: 3

---
# Kafka: can start in Parallel after initial cluster formation
# Brokers discover each other via ZooKeeper, don't require ordered startup
spec:
  podManagementPolicy: Parallel
  serviceName: kafka-headless
  replicas: 6
```

## Headless Services for DNS-Based Discovery

StatefulSets require a Headless Service (`clusterIP: None`). This creates DNS records for each pod individually:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: postgres-headless
  namespace: production
  labels:
    app: postgres
spec:
  clusterIP: None  # Headless: no virtual IP, DNS returns individual pod IPs
  selector:
    app: postgres
  ports:
    - port: 5432
      name: postgres
      targetPort: 5432
```

### DNS Entries Created

With a StatefulSet named `postgres` in namespace `production` with serviceName `postgres-headless`:

```
# Per-pod DNS A records (stable across rescheduling)
postgres-0.postgres-headless.production.svc.cluster.local
postgres-1.postgres-headless.production.svc.cluster.local
postgres-2.postgres-headless.production.svc.cluster.local

# Service DNS (returns all pod IPs - not load-balanced)
postgres-headless.production.svc.cluster.local
```

Pods within the same namespace can use short names:
```
postgres-0.postgres-headless      # Within same namespace
postgres-0.postgres-headless.production  # Cross-namespace
```

### Service for Client Access

Alongside the headless service, create a regular service for client traffic:

```yaml
# Regular service for read-write (routes to primary only via label selector)
apiVersion: v1
kind: Service
metadata:
  name: postgres-primary
  namespace: production
spec:
  selector:
    app: postgres
    role: primary  # Only route to pods with role=primary
  ports:
    - port: 5432
      targetPort: 5432

---
# Service for read-only replicas
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
      targetPort: 5432
```

## Init Containers for Database Operations

Init containers run sequentially before the main container starts. For databases, they handle initialization, schema migration, and replica setup.

### Schema Migration Init Container

```yaml
spec:
  initContainers:
    # Run database migrations before the application starts
    - name: run-migrations
      image: ghcr.io/yourorg/app:v2.5.0
      command:
        - /app/migrate
        - --database
        - postgres://$(DB_USER):$(DB_PASSWORD)@postgres-primary.production.svc.cluster.local:5432/appdb
        - --direction
        - up
      env:
        - name: DB_USER
          valueFrom:
            secretKeyRef:
              name: app-db-credentials
              key: username
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: app-db-credentials
              key: password
      resources:
        requests:
          cpu: 100m
          memory: 128Mi
        limits:
          cpu: 500m
          memory: 256Mi
```

### MySQL Replica Initialization Init Container

```yaml
spec:
  initContainers:
    # Copy data from primary for new replicas
    - name: init-replica
      image: mysql:8.0
      command:
        - bash
        - -c
        - |
          # Determine this pod's ordinal index
          [[ $(hostname) =~ -([0-9]+)$ ]] || exit 1
          ORDINAL=${BASH_REMATCH[1]}

          # Pod 0 is the primary; skip initialization
          if [[ $ORDINAL -eq 0 ]]; then
            echo "Primary pod; skipping replica initialization"
            exit 0
          fi

          # Check if data directory already has data (pod restart case)
          if [[ -d /var/lib/mysql/mysql ]]; then
            echo "Data directory exists; skipping initialization"
            exit 0
          fi

          # Clone data from previous peer (n-1 → n)
          PREVIOUS_HOST="mysql-$((ORDINAL-1)).mysql-headless.production.svc.cluster.local"
          echo "Cloning from ${PREVIOUS_HOST}..."

          # Use xtrabackup for hot copy
          ncat --recv-only "${PREVIOUS_HOST}" 3307 | xbstream -x -C /var/lib/mysql

          # Apply backup logs
          xtrabackup --prepare --target-dir=/var/lib/mysql
      volumeMounts:
        - name: data
          mountPath: /var/lib/mysql

    # Configure MySQL replication settings
    - name: configure-replication
      image: mysql:8.0
      command:
        - bash
        - -c
        - |
          [[ $(hostname) =~ -([0-9]+)$ ]] || exit 1
          ORDINAL=${BASH_REMATCH[1]}

          # Set server-id based on ordinal (must be unique in replication group)
          cat > /mnt/conf.d/server-id.cnf << EOF
          [mysqld]
          server-id=$((100 + ORDINAL))
          EOF

          # Configure primary vs replica settings
          if [[ $ORDINAL -eq 0 ]]; then
            cat > /mnt/conf.d/primary.cnf << EOF
          [mysqld]
          log-bin
          EOF
          else
            cat > /mnt/conf.d/replica.cnf << EOF
          [mysqld]
          super-read-only
          EOF
          fi
      volumeMounts:
        - name: conf
          mountPath: /mnt/conf.d
```

### Wait-for-Database Init Container

```yaml
initContainers:
  # Wait for the database to be ready before starting the application
  - name: wait-for-db
    image: busybox:1.36
    command:
      - sh
      - -c
      - |
        until nc -z postgres-primary.production.svc.cluster.local 5432; do
          echo "Waiting for postgres..."
          sleep 2
        done
        echo "PostgreSQL is ready"
```

## PVC Lifecycle and Retention Policies

### PVC Naming Convention

PersistentVolumeClaims created by StatefulSet volumeClaimTemplates are named:
`<template-name>-<statefulset-name>-<ordinal>`

```
data-postgres-0    # PVC for postgres-0
data-postgres-1    # PVC for postgres-1
data-postgres-2    # PVC for postgres-2
```

### Persistent Volume Claim Retention Policy

By default, PVCs created by a StatefulSet are NOT deleted when:
- A pod is deleted
- The StatefulSet is scaled down
- The StatefulSet is deleted

This is intentional — data preservation is the primary feature of StatefulSets. Since Kubernetes 1.27, retention policies can be configured explicitly:

```yaml
spec:
  persistentVolumeClaimRetentionPolicy:
    # What happens when the StatefulSet is deleted
    whenDeleted: Retain  # Keep PVCs (default)
    # whenDeleted: Delete  # Delete PVCs with StatefulSet

    # What happens when the StatefulSet is scaled down
    whenScaled: Retain   # Keep PVCs for scaled-down pods (default)
    # whenScaled: Delete  # Delete PVCs for pods that are removed
```

### PVC Retention Use Cases

```yaml
# Production database: always retain data
persistentVolumeClaimRetentionPolicy:
  whenDeleted: Retain
  whenScaled: Retain

# Ephemeral staging environment: clean up automatically
persistentVolumeClaimRetentionPolicy:
  whenDeleted: Delete  # Delete PVCs when environment is torn down
  whenScaled: Delete   # Delete PVCs when scaling down

# CI/CD test database: keep between tests, clean up when job finishes
persistentVolumeClaimRetentionPolicy:
  whenDeleted: Delete  # Clean up after CI job
  whenScaled: Retain   # Keep data during scaling events within the job
```

### Manual PVC Management

```bash
# List PVCs for a StatefulSet
kubectl get pvc -n production \
  -l app=postgres \
  --sort-by='.metadata.name'

# Scale down StatefulSet (PVCs are retained)
kubectl scale statefulset postgres -n production --replicas=2
# PVC data-postgres-2 is retained but pod postgres-2 is deleted

# Re-attach retained PVC when scaling back up
kubectl scale statefulset postgres -n production --replicas=3
# postgres-2 recreates and reattaches to data-postgres-2

# Delete orphaned PVC manually (after ensuring data is backed up)
kubectl delete pvc data-postgres-2 -n production
```

## Rolling Updates for StatefulSets

```yaml
spec:
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      # Start updating from the highest ordinal pod
      # maxUnavailable: 1 (default)
      maxUnavailable: 1

      # Partition: only update pods with ordinal >= partition
      # Useful for staged rollouts (canary primary)
      partition: 0  # Update all pods (default)
```

### Partitioned Rolling Update (Canary)

```bash
# Update StatefulSet image with partition=2 (only update pod 2, leave 0 and 1 on old version)
kubectl patch statefulset postgres \
  -n production \
  --type='json' \
  -p='[{"op": "replace", "path": "/spec/updateStrategy/rollingUpdate/partition", "value": 2}]'

# Update the image
kubectl set image statefulset/postgres -n production postgres=postgres:16.3

# Verify only postgres-2 was updated
kubectl get pods -n production -l app=postgres \
  -o custom-columns='NAME:.metadata.name,IMAGE:.spec.containers[0].image'

# After validating postgres-2, update the rest
kubectl patch statefulset postgres \
  -n production \
  --type='json' \
  -p='[{"op": "replace", "path": "/spec/updateStrategy/rollingUpdate/partition", "value": 0}]'
```

## Production Database Pattern: MySQL InnoDB Cluster

A complete production MySQL cluster using StatefulSets with router and shell:

```yaml
# Headless service for pod-to-pod communication
apiVersion: v1
kind: Service
metadata:
  name: mysql-headless
  namespace: production
spec:
  clusterIP: None
  selector:
    app: mysql
  ports:
    - port: 3306
      name: mysql
    - port: 33060
      name: mysqlx
    - port: 3307
      name: xtrabackup

---
# Read-write service (primary)
apiVersion: v1
kind: Service
metadata:
  name: mysql-primary
  namespace: production
spec:
  selector:
    app: mysql
    mysql.oracle.com/cluster-role: primary
  ports:
    - port: 3306
      name: mysql

---
# Read-only service (replicas)
apiVersion: v1
kind: Service
metadata:
  name: mysql-replica
  namespace: production
spec:
  selector:
    app: mysql
    mysql.oracle.com/cluster-role: secondary
  ports:
    - port: 3306
      name: mysql

---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mysql
  namespace: production
spec:
  serviceName: mysql-headless
  replicas: 3
  podManagementPolicy: OrderedReady
  selector:
    matchLabels:
      app: mysql
  template:
    metadata:
      labels:
        app: mysql
    spec:
      affinity:
        # Spread pods across nodes for fault tolerance
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: mysql
              topologyKey: kubernetes.io/hostname

        # Spread across AZs (soft requirement)
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    app: mysql
                topologyKey: topology.kubernetes.io/zone

      initContainers:
        - name: init-mysql
          image: mysql:8.0.36
          command:
            - bash
            - -c
            - |
              set -ex
              [[ $(hostname) =~ -([0-9]+)$ ]] || exit 1
              ORDINAL=${BASH_REMATCH[1]}
              echo [mysqld] > /mnt/conf.d/server-id.cnf
              echo server-id=$((100 + ORDINAL)) >> /mnt/conf.d/server-id.cnf
          volumeMounts:
            - name: conf
              mountPath: /mnt/conf.d

      containers:
        - name: mysql
          image: mysql:8.0.36
          env:
            - name: MYSQL_ROOT_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: mysql-credentials
                  key: root-password
          ports:
            - containerPort: 3306
              name: mysql
            - containerPort: 33060
              name: mysqlx
          volumeMounts:
            - name: data
              mountPath: /var/lib/mysql
            - name: conf
              mountPath: /etc/mysql/conf.d
          resources:
            requests:
              cpu: "1"
              memory: "4Gi"
            limits:
              cpu: "4"
              memory: "16Gi"
          readinessProbe:
            exec:
              command:
                - mysql
                - -u
                - root
                - -p$(MYSQL_ROOT_PASSWORD)
                - -e
                - SELECT 1
            initialDelaySeconds: 30
            periodSeconds: 10

        # Xtrabackup sidecar for streaming backups to new replicas
        - name: xtrabackup
          image: percona/percona-xtrabackup:8.0.35
          command:
            - bash
            - -c
            - |
              # Start backup server that listens for clone requests
              cd /var/lib/mysql
              if [[ -f xtrabackup_slave_info && "x$(<xtrabackup_slave_info)" != "x" ]]; then
                cat xtrabackup_slave_info | sed -E 's/;.*$//' > change_master_to.sql.in
              fi

              # Listen for replication requests from new pods
              exec ncat --listen --keep-open --send-only --max-conns=1 3307 -c \
                "xtrabackup --backup --slave-info --stream=xbstream --host=127.0.0.1 --user=root"
          volumeMounts:
            - name: data
              mountPath: /var/lib/mysql

      volumes:
        - name: conf
          emptyDir: {}

  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 500Gi
  persistentVolumeClaimRetentionPolicy:
    whenDeleted: Retain
    whenScaled: Retain
```

## StatefulSet Operational Procedures

### Graceful Pod Restart

```bash
# Restart a single pod (pod is rescheduled with same PVC)
kubectl delete pod postgres-1 -n production

# Wait for it to come back
kubectl rollout status statefulset/postgres -n production

# Restart all pods in order (rolling restart)
kubectl rollout restart statefulset/postgres -n production
```

### Debugging PVC Attachment Issues

```bash
# Check if PVC is bound
kubectl get pvc -n production data-postgres-0

# If PVC is in Pending state
kubectl describe pvc data-postgres-0 -n production

# Check events for attachment issues
kubectl get events -n production \
  --field-selector involvedObject.name=data-postgres-0

# Check node for volume attachment state
kubectl get volumeattachments | grep postgres-0
```

### Force Delete a Stuck Pod

```bash
# Pod stuck in Terminating state (e.g., node is unreachable)
kubectl delete pod postgres-0 -n production --force --grace-period=0

# WARNING: This may cause data corruption if the pod is still writing
# Only use after confirming the node is truly offline and the pod has stopped
```

### StatefulSet Status Monitoring

```yaml
# PrometheusRule for StatefulSet health
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: statefulset-alerts
  namespace: monitoring
spec:
  groups:
    - name: statefulset
      rules:
        - alert: StatefulSetReplicasMismatch
          expr: |
            (
              kube_statefulset_status_replicas_ready
              != kube_statefulset_status_replicas_current
            ) and (
              changes(kube_statefulset_status_replicas_updated[10m]) == 0
            )
          for: 15m
          labels:
            severity: critical
          annotations:
            summary: "StatefulSet {{ $labels.statefulset }} has mismatched replicas"
            description: "{{ $labels.namespace }}/{{ $labels.statefulset }} has {{ $value }} ready replicas, expected {{ $labels.replicas_current }}"

        - alert: StatefulSetUpdateNotComplete
          expr: |
            kube_statefulset_status_replicas_updated
            != kube_statefulset_status_replicas
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "StatefulSet update is not completing"
```

StatefulSets are foundational infrastructure for running stateful workloads on Kubernetes. The patterns described here — from PVC retention policies to init container initialization chains to partitioned rolling updates — provide the operational control needed to run production databases safely and reliably on Kubernetes.
