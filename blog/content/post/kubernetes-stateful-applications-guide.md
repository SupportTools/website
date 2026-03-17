---
title: "Running Stateful Applications on Kubernetes: Patterns and Anti-Patterns"
date: 2027-11-28T00:00:00-05:00
draft: false
tags: ["Kubernetes", "StatefulSets", "Storage", "Databases", "Operators"]
categories:
- Kubernetes
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to running stateful workloads on Kubernetes, covering StatefulSet ordered deployment, headless services, PVC retention, leader election, database operators, backup integration, and the anti-patterns that cause data loss."
more_link: "yes"
url: "/kubernetes-stateful-applications-guide/"
---

Stateful applications on Kubernetes require more careful design than stateless workloads. The automatic scheduling, replacement, and scaling that make Kubernetes powerful for stateless services become risks when applied naively to databases, queues, and other stateful systems. This guide covers the patterns that work at production scale and the anti-patterns that lead to data corruption and outages.

<!--more-->

# Running Stateful Applications on Kubernetes: Patterns and Anti-Patterns

## Why Stateful Applications Require Different Treatment

A stateless pod is fungible. Kubernetes can terminate it, reschedule it on a different node, and restart it without consequence. The application picks up where it left off because state lives elsewhere.

Stateful applications break this model in several ways:

- **Identity matters**: A database replica has a specific role (primary or standby). Replacing pod-0 with a new pod-0 on a different node requires the new pod to rejoin the cluster and potentially resync gigabytes of data.
- **Storage affinity**: A pod writing to a local volume cannot be rescheduled to a node without that volume.
- **Ordered operations**: Scaling a database cluster from 3 to 5 nodes requires careful orchestration—each new node must join the cluster before the next is started.
- **Quorum sensitivity**: Scaling down a 3-node cluster requires removing nodes gracefully. Kubernetes scaling-down selects the highest-numbered pod first, which may violate cluster-specific requirements.

StatefulSets address these requirements through stable network identities, ordered operations, and persistent volume claims with stable bindings.

## Section 1: StatefulSet Fundamentals

### StatefulSet vs Deployment

| Feature | Deployment | StatefulSet |
|---|---|---|
| Pod naming | Random suffix (app-abc123) | Ordered index (app-0, app-1) |
| Pod deletion order | Arbitrary | Reverse ordinal (N-1 first) |
| Pod creation order | Parallel (default) | Sequential (default) |
| DNS names | Shared via Service | Unique per pod via Headless Service |
| Volume binding | Recreated on reschedule | Stable - follows pod identity |
| Rolling update | Parallelism configurable | One at a time, highest ordinal first |

### Basic StatefulSet Configuration

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgresql
  namespace: production
spec:
  serviceName: postgresql-headless
  replicas: 3
  selector:
    matchLabels:
      app: postgresql
  # Pod management policy controls parallel vs sequential operations
  podManagementPolicy: OrderedReady  # Default: sequential
  # For stateless-style parallel operations: Parallel

  # Update strategy
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      # Partition: only update pods with index >= partition
      # Use this for canary updates: set partition=2, verify pod-2, then partition=1, etc.
      partition: 0

  template:
    metadata:
      labels:
        app: postgresql
    spec:
      terminationGracePeriodSeconds: 60

      # Spread pods across availability zones
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: postgresql

      # Prevent multiple replicas on the same node
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: postgresql
            topologyKey: kubernetes.io/hostname

      initContainers:
      - name: init-permissions
        image: busybox:1.36
        command:
        - sh
        - -c
        - |
          chown -R 999:999 /var/lib/postgresql
          chmod 700 /var/lib/postgresql
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql

      containers:
      - name: postgresql
        image: postgres:16.1
        ports:
        - containerPort: 5432
          name: postgresql

        env:
        - name: POSTGRES_DB
          value: appdb
        - name: POSTGRES_USER
          valueFrom:
            secretKeyRef:
              name: postgresql-secret
              key: username
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgresql-secret
              key: password
        - name: PGDATA
          value: /var/lib/postgresql/data/pgdata
        # Use the pod's ordinal index for replica configuration
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        - name: POD_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace

        resources:
          requests:
            cpu: 500m
            memory: 1Gi
          limits:
            cpu: 2000m
            memory: 4Gi

        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql
        - name: config
          mountPath: /etc/postgresql/conf.d

        livenessProbe:
          exec:
            command:
            - pg_isready
            - -U
            - postgres
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 6

        readinessProbe:
          exec:
            command:
            - pg_isready
            - -U
            - postgres
          initialDelaySeconds: 5
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 3

      volumes:
      - name: config
        configMap:
          name: postgresql-config

  # PVC templates create one PVC per pod, named <template-name>-<pod-name>
  volumeClaimTemplates:
  - metadata:
      name: data
      annotations:
        # Retain PVCs when pod is deleted for safety
        helm.sh/resource-policy: keep
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: fast-ssd
      resources:
        requests:
          storage: 100Gi
```

### Headless Service

The headless service (clusterIP: None) enables DNS discovery of individual pod addresses:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: postgresql-headless
  namespace: production
  labels:
    app: postgresql
spec:
  # None = headless, no ClusterIP allocated
  clusterIP: None
  # publishNotReadyAddresses allows DNS resolution even for pods not yet ready
  # Important for bootstrapping: pods need to find each other during startup
  publishNotReadyAddresses: true
  selector:
    app: postgresql
  ports:
  - name: postgresql
    port: 5432
    targetPort: 5432
---
# Regular service for client connections (routes to primary only via labels)
apiVersion: v1
kind: Service
metadata:
  name: postgresql-primary
  namespace: production
spec:
  selector:
    app: postgresql
    role: primary
  ports:
  - name: postgresql
    port: 5432
    targetPort: 5432
---
# Read replica service
apiVersion: v1
kind: Service
metadata:
  name: postgresql-replica
  namespace: production
spec:
  selector:
    app: postgresql
    role: replica
  ports:
  - name: postgresql
    port: 5432
    targetPort: 5432
```

### DNS Names for StatefulSet Pods

```
# Individual pod DNS:
# <pod-name>.<service-name>.<namespace>.svc.cluster.local

# Examples for postgresql StatefulSet with headless service postgresql-headless:
postgresql-0.postgresql-headless.production.svc.cluster.local
postgresql-1.postgresql-headless.production.svc.cluster.local
postgresql-2.postgresql-headless.production.svc.cluster.local

# Use these stable DNS names in replication configuration
# They survive pod restarts and node failures
```

## Section 2: PVC Retention Policies

### StatefulSet PersistentVolumeClaimRetentionPolicy

Kubernetes 1.27 introduced the PVC retention policy to control what happens to PVCs when the StatefulSet is deleted or scaled down:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: elasticsearch
  namespace: logging
spec:
  serviceName: elasticsearch-headless
  replicas: 3
  selector:
    matchLabels:
      app: elasticsearch

  # Control PVC lifecycle
  persistentVolumeClaimRetentionPolicy:
    # When StatefulSet is deleted: Retain (default) or Delete
    whenDeleted: Retain
    # When StatefulSet is scaled down: Retain (default) or Delete
    whenScaled: Delete

  template:
    metadata:
      labels:
        app: elasticsearch
    spec:
      containers:
      - name: elasticsearch
        image: docker.elastic.co/elasticsearch/elasticsearch:8.11.1
        resources:
          requests:
            cpu: "1"
            memory: 4Gi
          limits:
            cpu: "2"
            memory: 8Gi
        volumeMounts:
        - name: data
          mountPath: /usr/share/elasticsearch/data

  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: fast-nvme
      resources:
        requests:
          storage: 500Gi
```

### Manual PVC Management

```bash
# List PVCs for a StatefulSet
kubectl get pvc -n production -l app=postgresql

# Check PVC status
kubectl describe pvc data-postgresql-0 -n production

# Expand a PVC (requires storage class with allowVolumeExpansion: true)
kubectl patch pvc data-postgresql-0 -n production \
  --type='merge' \
  -p '{"spec":{"resources":{"requests":{"storage":"200Gi"}}}}'

# Monitor expansion progress
kubectl get pvc data-postgresql-0 -n production -w

# Delete a PVC to force re-initialization of a pod (dangerous - understand the implications)
# First, delete the pod so it stops using the PVC
kubectl delete pod postgresql-0 -n production

# Then delete the PVC
kubectl delete pvc data-postgresql-0 -n production

# The StatefulSet will recreate both the PVC and the pod
# The pod will start fresh with an empty volume
```

## Section 3: Leader Election Patterns

Distributed stateful applications need leader election to coordinate actions that must only happen once: primary database writes, cron job execution, cache warming.

### Kubernetes Lease-Based Leader Election

```go
// leaderelection.go - Production leader election pattern
package main

import (
    "context"
    "fmt"
    "os"
    "time"

    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/rest"
    "k8s.io/client-go/tools/leaderelection"
    "k8s.io/client-go/tools/leaderelection/resourcelock"
)

func runWithLeaderElection(ctx context.Context, client kubernetes.Interface, id, namespace string, onStartLeading func(ctx context.Context), onStopLeading func()) {
    lock := &resourcelock.LeaseLock{
        LeaseMeta: metav1.ObjectMeta{
            Name:      "my-application-leader",
            Namespace: namespace,
        },
        Client: client.CoordinationV1(),
        LockConfig: resourcelock.ResourceLockConfig{
            Identity: id,
        },
    }

    leaderelection.RunOrDie(ctx, leaderelection.LeaderElectionConfig{
        Lock:            lock,
        ReleaseOnCancel: true,
        LeaseDuration:   15 * time.Second,
        RenewDeadline:   10 * time.Second,
        RetryPeriod:     2 * time.Second,
        Callbacks: leaderelection.LeaderCallbacks{
            OnStartedLeading: onStartLeading,
            OnStoppedLeading: onStopLeading,
            OnNewLeader: func(identity string) {
                if identity != id {
                    fmt.Printf("New leader elected: %s\n", identity)
                }
            },
        },
    })
}

func main() {
    config, _ := rest.InClusterConfig()
    client, _ := kubernetes.NewForConfig(config)

    id, _ := os.Hostname()
    namespace := os.Getenv("POD_NAMESPACE")

    runWithLeaderElection(
        context.Background(),
        client,
        id,
        namespace,
        func(ctx context.Context) {
            fmt.Printf("I am the leader: %s\n", id)
            // Run leader-only tasks here
            // This function runs until ctx is cancelled
        },
        func() {
            fmt.Println("Lost leader election, shutting down")
            os.Exit(0)
        },
    )
}
```

### RBAC for Leader Election

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-application
  namespace: production
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: leader-election
  namespace: production
rules:
- apiGroups: ["coordination.k8s.io"]
  resources: ["leases"]
  verbs: ["get", "create", "update", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: leader-election
  namespace: production
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: leader-election
subjects:
- kind: ServiceAccount
  name: my-application
  namespace: production
```

## Section 4: Operator-Managed Databases

Kubernetes operators encapsulate database operational knowledge—backup, restore, failover, scaling, upgrades—into controllers that run in the cluster.

### CloudNativePG for PostgreSQL

CloudNativePG is the CNCF-preferred PostgreSQL operator:

```yaml
# Install CloudNativePG operator
# kubectl apply -f https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.22/releases/cnpg-1.22.0.yaml

apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: payments-db
  namespace: production
spec:
  description: "Payments PostgreSQL cluster"
  imageName: ghcr.io/cloudnative-pg/postgresql:16.1

  # Number of instances (1 primary + N-1 standbys)
  instances: 3

  # Primary update strategy
  primaryUpdateStrategy: unsupervised
  primaryUpdateMethod: switchover

  # PostgreSQL configuration
  postgresql:
    parameters:
      max_connections: "200"
      shared_buffers: "512MB"
      effective_cache_size: "2GB"
      maintenance_work_mem: "128MB"
      checkpoint_completion_target: "0.9"
      wal_buffers: "16MB"
      default_statistics_target: "100"
      random_page_cost: "1.1"
      effective_io_concurrency: "200"
      work_mem: "6553kB"
      huge_pages: "off"
      min_wal_size: "1GB"
      max_wal_size: "4GB"
      max_worker_processes: "8"
      max_parallel_workers_per_gather: "4"
      max_parallel_workers: "8"
      max_parallel_maintenance_workers: "4"
      wal_level: replica
      hot_standby: "on"
      hot_standby_feedback: "on"
    pg_hba:
    - "host all all 10.244.0.0/16 scram-sha-256"

  # Bootstrap from backup or initdb
  bootstrap:
    initdb:
      database: appdb
      owner: appuser
      secret:
        name: payments-db-app-credentials
      postInitSQL:
      - "CREATE EXTENSION IF NOT EXISTS pg_stat_statements"
      - "CREATE EXTENSION IF NOT EXISTS pgcrypto"

  # Superuser credentials
  superuserSecret:
    name: payments-db-superuser

  # Storage configuration
  storage:
    storageClass: fast-nvme
    size: 200Gi

  # WAL storage on separate volume for better I/O
  walStorage:
    storageClass: fast-nvme
    size: 20Gi

  # Resources
  resources:
    requests:
      cpu: "2"
      memory: 4Gi
    limits:
      cpu: "4"
      memory: 8Gi

  # Affinity rules
  affinity:
    topologyKey: topology.kubernetes.io/zone
    podAntiAffinityType: required
    enablePodAntiAffinity: true

  # Monitoring
  monitoring:
    enablePodMonitor: true

  # Backup configuration
  backup:
    retentionPolicy: "30d"
    barmanObjectStore:
      destinationPath: "s3://acme-db-backups/payments-db"
      s3Credentials:
        accessKeyId:
          name: backup-s3-credentials
          key: ACCESS_KEY_ID
        secretAccessKey:
          name: backup-s3-credentials
          key: ACCESS_SECRET_KEY
      wal:
        compression: gzip
        maxParallel: 8
      data:
        compression: gzip
        immediateCheckpoint: false
        jobs: 2
```

### Scheduled Backups with CloudNativePG

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata:
  name: payments-db-daily
  namespace: production
spec:
  schedule: "0 2 * * *"  # Daily at 2 AM
  backupOwnerReference: self
  cluster:
    name: payments-db
  method: barmanObjectStore
  immediate: false
---
# Point-in-time recovery - restore to specific timestamp
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: payments-db-restore
  namespace: production
spec:
  instances: 1
  bootstrap:
    recovery:
      source: payments-db-backup
      recoveryTarget:
        targetTime: "2024-01-15 14:30:00"
  externalClusters:
  - name: payments-db-backup
    barmanObjectStore:
      destinationPath: "s3://acme-db-backups/payments-db"
      s3Credentials:
        accessKeyId:
          name: backup-s3-credentials
          key: ACCESS_KEY_ID
        secretAccessKey:
          name: backup-s3-credentials
          key: ACCESS_SECRET_KEY
  storage:
    size: 200Gi
    storageClass: fast-nvme
```

### MySQL Operator (Percona XtraDB Cluster)

```yaml
apiVersion: pxc.percona.com/v1
kind: PerconaXtraDBCluster
metadata:
  name: payments-mysql
  namespace: production
spec:
  crVersion: 1.14.0
  secretsName: payments-mysql-secrets
  vaultSecretName: ""
  sslSecretName: payments-mysql-ssl

  pxc:
    size: 3
    image: percona/percona-xtradb-cluster:8.0.32-24.2
    resources:
      requests:
        memory: 4G
        cpu: "1"
      limits:
        memory: 8G
        cpu: "4"
    affinity:
      antiAffinityTopologyKey: "kubernetes.io/hostname"
    podDisruptionBudget:
      maxUnavailable: 1
    gracePeriod: 600
    volumeSpec:
      persistentVolumeClaim:
        storageClassName: fast-ssd
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 200G
    configuration: |
      [mysqld]
      max_connections=500
      innodb_buffer_pool_size=4G
      innodb_log_file_size=512M
      innodb_flush_log_at_trx_commit=2
      sync_binlog=0

  haproxy:
    enabled: true
    size: 3
    image: percona/percona-xtradb-cluster-operator:1.14.0-haproxy
    resources:
      requests:
        memory: 1G
        cpu: 600m
      limits:
        memory: 2G
        cpu: 1000m

  backup:
    image: percona/percona-xtradb-cluster-operator:1.14.0-pxc8.0-backup
    storages:
      s3-us-east-1:
        type: s3
        s3:
          bucket: acme-mysql-backups
          credentialsSecret: aws-s3-backup-credentials
          region: us-east-1
    schedule:
    - name: daily-backup
      schedule: "0 3 * * *"
      keep: 7
      storageName: s3-us-east-1
```

### MongoDB Operator (Percona MongoDB)

```yaml
apiVersion: psmdb.percona.com/v1
kind: PerconaServerMongoDB
metadata:
  name: payments-mongodb
  namespace: production
spec:
  crVersion: 1.15.0
  image: percona/percona-server-mongodb:6.0.9-7
  imagePullPolicy: IfNotPresent

  secrets:
    users: payments-mongodb-secrets

  replsets:
  - name: rs0
    size: 3
    affinity:
      antiAffinityTopologyKey: "kubernetes.io/hostname"
    podDisruptionBudget:
      maxUnavailable: 1
    resources:
      limits:
        cpu: "4"
        memory: 8G
      requests:
        cpu: "1"
        memory: 4G
    volumeSpec:
      pvc:
        storageClassName: fast-nvme
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 200G
    nonvoting:
      enabled: false
    arbiter:
      enabled: false

  mongos:
    size: 3
    resources:
      limits:
        cpu: "2"
        memory: 2G
      requests:
        cpu: 500m
        memory: 1G

  sharding:
    enabled: false

  backup:
    enabled: true
    image: percona/percona-backup-mongodb:2.3.0
    storages:
      s3-backup:
        type: s3
        s3:
          bucket: acme-mongodb-backups
          region: us-east-1
          credentialsSecret: aws-s3-backup-credentials
    tasks:
    - name: daily
      enabled: true
      schedule: "0 4 * * *"
      keep: 7
      storageName: s3-backup
      compressionType: gzip
```

## Section 5: Backup Integration

### Velero for StatefulSet Backup

Velero provides application-consistent backups using pre and post hooks:

```yaml
# Backup with application quiescing hooks
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: payments-full-backup
  namespace: velero
spec:
  includedNamespaces:
  - production
  includedResources:
  - statefulsets
  - persistentvolumeclaims
  - persistentvolumes
  - configmaps
  - secrets
  - services
  labelSelector:
    matchLabels:
      backup: "true"

  hooks:
    resources:
    - name: postgresql-backup-hook
      includedNamespaces:
      - production
      labelSelector:
        matchLabels:
          app: postgresql
          role: primary
      pre:
      - exec:
          container: postgresql
          command:
          - /bin/sh
          - -c
          - "psql -U postgres -c 'CHECKPOINT; SELECT pg_start_backup(''velero'', true);'"
          onError: Fail
          timeout: 30s
      post:
      - exec:
          container: postgresql
          command:
          - /bin/sh
          - -c
          - "psql -U postgres -c \"SELECT pg_stop_backup();\""
          onError: Continue
          timeout: 30s

  storageLocation: aws-primary
  volumeSnapshotLocations:
  - aws-primary

  # Retention
  ttl: 720h  # 30 days
```

### Scheduled Backups

```yaml
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: production-daily
  namespace: velero
spec:
  schedule: "0 1 * * *"  # 1 AM daily
  useOwnerReferencesInBackup: false
  template:
    includedNamespaces:
    - production
    storageLocation: aws-primary
    volumeSnapshotLocations:
    - aws-primary
    ttl: 168h  # 7 days for daily backups
---
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: production-weekly
  namespace: velero
spec:
  schedule: "0 2 * * 0"  # 2 AM Sunday
  template:
    includedNamespaces:
    - production
    storageLocation: aws-primary
    volumeSnapshotLocations:
    - aws-primary
    ttl: 2160h  # 90 days for weekly backups
```

## Section 6: Anti-Patterns to Avoid

### Anti-Pattern 1: Using Deployments for Stateful Applications

Deployments do not guarantee stable pod identity or ordered scaling. Using a Deployment for a database means:
- Multiple pods may have the same IP binding during rollouts
- PVCs are not automatically bound to specific pod identities
- Scale-down does not follow database cluster protocols

**Fix**: Use StatefulSets for any application that requires stable identity or persistent storage with pod affinity.

### Anti-Pattern 2: Using emptyDir for Database Storage

```yaml
# WRONG: emptyDir is ephemeral - data is lost when pod is terminated
volumes:
- name: data
  emptyDir: {}

# CORRECT: Use PersistentVolumeClaim
volumeClaimTemplates:
- metadata:
    name: data
  spec:
    storageClassName: fast-ssd
    accessModes: ["ReadWriteOnce"]
    resources:
      requests:
        storage: 100Gi
```

### Anti-Pattern 3: Storing Secrets in Environment Variables Directly

```yaml
# WRONG: Secret values visible in pod spec and env listings
env:
- name: DB_PASSWORD
  value: "plaintext-password-here"

# CORRECT: Reference from Secret
env:
- name: DB_PASSWORD
  valueFrom:
    secretKeyRef:
      name: database-secret
      key: password
```

### Anti-Pattern 4: Not Setting PodDisruptionBudgets

Without a PodDisruptionBudget, node drains during upgrades can take down all database replicas simultaneously:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: postgresql-pdb
  namespace: production
spec:
  selector:
    matchLabels:
      app: postgresql
  # At least 2 replicas must be available
  minAvailable: 2
  # Alternatively: maxUnavailable: 1
```

### Anti-Pattern 5: ReadWriteMany for Databases

Using ReadWriteMany (RWX) access mode for a database that does not support concurrent access will cause data corruption:

```yaml
# WRONG: RWX for a database that has no multi-writer support
volumeClaimTemplates:
- spec:
    accessModes: ["ReadWriteMany"]  # Multiple pods can write simultaneously - data corruption!

# CORRECT: RWO ensures only one pod writes at a time
volumeClaimTemplates:
- spec:
    accessModes: ["ReadWriteOnce"]  # Only one node can mount read-write
```

ReadWriteMany is appropriate for shared file systems (NFS, CephFS, GlusterFS) used by multiple read-write pods that coordinate their own access, such as distributed caches or shared configuration stores.

### Anti-Pattern 6: Ignoring Storage Class Performance

```yaml
# WRONG: Using default storage class without checking performance
volumeClaimTemplates:
- spec:
    # No storageClassName specified - uses cluster default
    # Default might be HDD or network storage with high latency
    resources:
      requests:
        storage: 100Gi

# CORRECT: Explicitly specify storage class matched to workload requirements
volumeClaimTemplates:
- spec:
    storageClassName: fast-nvme  # Specify the right storage tier
    resources:
      requests:
        storage: 100Gi
```

```yaml
# Example storage classes for different tiers
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-nvme
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  iops: "16000"
  throughput: "1000"
  encrypted: "true"
  kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/mrk-abc123"
reclaimPolicy: Retain
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer  # Wait until pod is scheduled to pick AZ
---
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: standard-ssd
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  iops: "3000"
  throughput: "125"
  encrypted: "true"
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
```

### Anti-Pattern 7: Not Testing Failover

A database cluster that has never been failed over will surprise you during a real incident. Regular chaos testing of failover is essential:

```bash
#!/bin/bash
# test-postgresql-failover.sh

NAMESPACE="production"

echo "Current primary pod:"
kubectl exec -n "$NAMESPACE" postgresql-0 -- \
  psql -U postgres -t -c "SELECT CASE WHEN pg_is_in_recovery() THEN 'REPLICA' ELSE 'PRIMARY' END"

# Verify we can write to primary
kubectl exec -n "$NAMESPACE" postgresql-0 -- \
  psql -U postgres appdb -c "CREATE TABLE IF NOT EXISTS failover_test (ts TIMESTAMP); INSERT INTO failover_test VALUES (NOW());"

echo "Deleting primary pod to trigger failover..."
kubectl delete pod postgresql-0 -n "$NAMESPACE"

# Wait for replica promotion (operator-dependent)
echo "Waiting for new primary election..."
sleep 30

# Check which pod is now primary
for i in 0 1 2; do
  ROLE=$(kubectl exec -n "$NAMESPACE" "postgresql-$i" -- \
    psql -U postgres -t -c "SELECT CASE WHEN pg_is_in_recovery() THEN 'REPLICA' ELSE 'PRIMARY' END" 2>/dev/null | tr -d ' \n')
  echo "postgresql-$i: $ROLE"
done

# Verify data is intact
kubectl exec -n "$NAMESPACE" postgresql-1 -- \
  psql -U postgres appdb -c "SELECT COUNT(*) FROM failover_test;"

echo "Failover test complete"
```

## Section 7: Storage Performance Tuning

### Benchmarking Storage for Databases

```bash
# Deploy fio benchmark pod on the storage class you plan to use
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: storage-benchmark
spec:
  containers:
  - name: fio
    image: ljishen/fio:latest
    command: ["sleep", "3600"]
    volumeMounts:
    - name: test-volume
      mountPath: /mnt/test
  volumes:
  - name: test-volume
    persistentVolumeClaim:
      claimName: benchmark-pvc
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: benchmark-pvc
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: fast-nvme
  resources:
    requests:
      storage: 10Gi
EOF

# Run sequential write benchmark (database WAL pattern)
kubectl exec storage-benchmark -- fio \
  --name=seq-write \
  --ioengine=libaio \
  --iodepth=1 \
  --rw=write \
  --bs=8k \
  --direct=1 \
  --size=1G \
  --numjobs=1 \
  --filename=/mnt/test/test.dat \
  --output-format=json

# Run random read/write benchmark (OLTP pattern)
kubectl exec storage-benchmark -- fio \
  --name=randrw \
  --ioengine=libaio \
  --iodepth=64 \
  --rw=randrw \
  --rwmixread=70 \
  --bs=4k \
  --direct=1 \
  --size=1G \
  --numjobs=4 \
  --filename=/mnt/test/test.dat \
  --output-format=json

# Check sync latency (critical for PostgreSQL performance)
kubectl exec storage-benchmark -- fio \
  --name=sync-latency \
  --ioengine=sync \
  --iodepth=1 \
  --rw=write \
  --bs=8k \
  --fsync=1 \
  --size=256M \
  --filename=/mnt/test/sync-test.dat \
  --output-format=json
```

## Summary

Running stateful applications on Kubernetes successfully requires:

1. Use StatefulSets, not Deployments, for applications that require stable identity or persistent storage
2. Configure headless services to enable stable DNS names for individual pods
3. Set appropriate PVC retention policies to prevent accidental data loss during scale-down operations
4. Implement PodDisruptionBudgets to prevent simultaneous loss of multiple database replicas during node maintenance
5. Use operators (CloudNativePG, Percona, etc.) that encode database operational knowledge rather than managing replication manually
6. Benchmark storage before deploying production databases and select storage classes that match workload requirements
7. Test failover regularly as part of a chaos engineering program
8. Implement application-consistent backup hooks with Velero to capture database state correctly

The anti-patterns described here represent the most common sources of data loss and outages for stateful Kubernetes workloads. Avoiding them requires upfront investment in proper configuration, but the alternative is discovering them during a production incident.
