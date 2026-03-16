---
title: "StatefulSet Orchestration for Distributed Databases: Enterprise Production Patterns"
date: 2026-09-10T00:00:00-05:00
draft: false
tags: ["Kubernetes", "StatefulSet", "Database", "Distributed Systems", "PostgreSQL", "MongoDB", "Cassandra"]
categories: ["Kubernetes", "Database Management", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to deploying and managing distributed databases using Kubernetes StatefulSets with production-ready patterns, failure recovery, and scaling strategies."
more_link: "yes"
url: "/kubernetes-statefulset-orchestration-distributed-databases/"
---

Deploying distributed databases on Kubernetes requires careful orchestration to maintain data consistency, ensure proper ordering of operations, and provide stable network identities. StatefulSets are the cornerstone of running stateful workloads in Kubernetes, offering guarantees that Deployments cannot provide. This comprehensive guide explores production-ready patterns for orchestrating distributed databases using StatefulSets.

<!--more-->

## Understanding StatefulSet Fundamentals

StatefulSets provide three critical guarantees for stateful applications:

1. **Stable Network Identity**: Each Pod receives a persistent hostname based on the StatefulSet name and ordinal index
2. **Ordered Deployment and Scaling**: Pods are created, deleted, and scaled in a predictable order
3. **Stable Storage**: PersistentVolumeClaims are created for each Pod and persist across rescheduling

These guarantees make StatefulSets ideal for distributed databases where node identity and ordering matter.

## Production PostgreSQL Cluster with StatefulSet

Let's start with a production-grade PostgreSQL cluster using StatefulSets with streaming replication.

### PostgreSQL StatefulSet Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: postgres-config
  namespace: database
data:
  POSTGRES_DB: production
  POSTGRES_REPLICATION_USER: replicator
  # PostgreSQL configuration for replication
  postgresql.conf: |
    listen_addresses = '*'
    max_connections = 200
    shared_buffers = 256MB
    effective_cache_size = 1GB
    maintenance_work_mem = 64MB
    checkpoint_completion_target = 0.9
    wal_buffers = 16MB
    default_statistics_target = 100
    random_page_cost = 1.1
    effective_io_concurrency = 200
    work_mem = 2621kB
    min_wal_size = 1GB
    max_wal_size = 4GB
    max_worker_processes = 4
    max_parallel_workers_per_gather = 2
    max_parallel_workers = 4
    max_parallel_maintenance_workers = 2

    # Replication settings
    wal_level = replica
    hot_standby = on
    max_wal_senders = 10
    max_replication_slots = 10
    hot_standby_feedback = on
    wal_keep_size = 1GB

  pg_hba.conf: |
    local   all             all                                     trust
    host    all             all             127.0.0.1/32            trust
    host    all             all             ::1/128                 trust
    host    all             all             0.0.0.0/0               md5
    host    replication     replicator      0.0.0.0/0               md5
---
apiVersion: v1
kind: Secret
metadata:
  name: postgres-secret
  namespace: database
type: Opaque
stringData:
  POSTGRES_PASSWORD: "ChangeMe123!"
  REPLICATION_PASSWORD: "ReplicaPass456!"
---
apiVersion: v1
kind: Service
metadata:
  name: postgres
  namespace: database
  labels:
    app: postgres
spec:
  ports:
  - port: 5432
    name: postgres
  clusterIP: None
  selector:
    app: postgres
---
apiVersion: v1
kind: Service
metadata:
  name: postgres-read
  namespace: database
  labels:
    app: postgres
spec:
  ports:
  - port: 5432
    name: postgres
  selector:
    app: postgres
    role: replica
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: database
spec:
  serviceName: postgres
  replicas: 3
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      initContainers:
      - name: init-postgres
        image: postgres:15-alpine
        command:
        - bash
        - "-c"
        - |
          set -ex
          # Generate postgres server id from pod ordinal index
          [[ `hostname` =~ -([0-9]+)$ ]] || exit 1
          ordinal=${BASH_REMATCH[1]}

          # Copy configuration files
          if [[ -d /var/lib/postgresql/data/pgdata ]]; then
            echo "Database already initialized, skipping init"
            exit 0
          fi

          if [[ $ordinal -eq 0 ]]; then
            echo "Initializing primary database"
            # Primary initialization will happen via postgres entrypoint
          else
            echo "Initializing replica from primary"
            until pg_isready -h postgres-0.postgres -U postgres; do
              echo "Waiting for primary to be ready..."
              sleep 2
            done

            # Perform base backup from primary
            PGPASSWORD=$REPLICATION_PASSWORD pg_basebackup \
              -h postgres-0.postgres \
              -D /var/lib/postgresql/data/pgdata \
              -U replicator \
              -v -P -W -R
          fi
        env:
        - name: PGDATA
          value: /var/lib/postgresql/data/pgdata
        - name: REPLICATION_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-secret
              key: REPLICATION_PASSWORD
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
      containers:
      - name: postgres
        image: postgres:15-alpine
        ports:
        - containerPort: 5432
          name: postgres
        env:
        - name: POSTGRES_DB
          valueFrom:
            configMapKeyRef:
              name: postgres-config
              key: POSTGRES_DB
        - name: POSTGRES_USER
          value: postgres
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-secret
              key: POSTGRES_PASSWORD
        - name: PGDATA
          value: /var/lib/postgresql/data/pgdata
        - name: POD_IP
          valueFrom:
            fieldRef:
              fieldPath: status.podIP
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
        - name: config
          mountPath: /etc/postgresql
        livenessProbe:
          exec:
            command:
            - /bin/sh
            - -c
            - pg_isready -U postgres
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
        readinessProbe:
          exec:
            command:
            - /bin/sh
            - -c
            - pg_isready -U postgres
          initialDelaySeconds: 5
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 3
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "2Gi"
            cpu: "2000m"
      volumes:
      - name: config
        configMap:
          name: postgres-config
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: [ "ReadWriteOnce" ]
      storageClassName: fast-ssd
      resources:
        requests:
          storage: 100Gi
```

### PostgreSQL Replication Setup Script

```bash
#!/bin/bash
# setup-postgres-replication.sh

set -e

NAMESPACE="database"
PRIMARY_POD="postgres-0"

echo "Waiting for primary PostgreSQL to be ready..."
kubectl wait --for=condition=ready pod/${PRIMARY_POD} -n ${NAMESPACE} --timeout=300s

echo "Creating replication user on primary..."
kubectl exec -n ${NAMESPACE} ${PRIMARY_POD} -- psql -U postgres -c "
CREATE USER replicator WITH REPLICATION ENCRYPTED PASSWORD '$(kubectl get secret postgres-secret -n ${NAMESPACE} -o jsonpath='{.data.REPLICATION_PASSWORD}' | base64 -d)';
"

echo "Creating replication slot for each replica..."
for i in 1 2; do
  SLOT_NAME="replica_${i}_slot"
  kubectl exec -n ${NAMESPACE} ${PRIMARY_POD} -- psql -U postgres -c "
  SELECT * FROM pg_create_physical_replication_slot('${SLOT_NAME}');
  " || echo "Slot ${SLOT_NAME} may already exist"
done

echo "Verifying replication status..."
kubectl exec -n ${NAMESPACE} ${PRIMARY_POD} -- psql -U postgres -c "
SELECT * FROM pg_stat_replication;
"

echo "PostgreSQL replication setup complete!"
```

## MongoDB Replica Set with StatefulSet

MongoDB replica sets require careful orchestration for proper initialization and member management.

### MongoDB StatefulSet Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: mongodb-config
  namespace: database
data:
  mongod.conf: |
    storage:
      dbPath: /data/db
      journal:
        enabled: true
    systemLog:
      destination: file
      logAppend: true
      path: /var/log/mongodb/mongod.log
    net:
      port: 27017
      bindIp: 0.0.0.0
    replication:
      replSetName: rs0
    security:
      authorization: enabled
      keyFile: /etc/mongodb-keyfile/keyfile
---
apiVersion: v1
kind: Secret
metadata:
  name: mongodb-secret
  namespace: database
type: Opaque
stringData:
  mongodb-root-password: "RootPass123!"
  mongodb-replica-set-key: "ReplicaSetKey456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789"
---
apiVersion: v1
kind: Service
metadata:
  name: mongodb
  namespace: database
  labels:
    app: mongodb
spec:
  ports:
  - port: 27017
    name: mongodb
  clusterIP: None
  selector:
    app: mongodb
---
apiVersion: v1
kind: Service
metadata:
  name: mongodb-read
  namespace: database
  labels:
    app: mongodb
spec:
  ports:
  - port: 27017
    name: mongodb
  selector:
    app: mongodb
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mongodb
  namespace: database
spec:
  serviceName: mongodb
  replicas: 3
  selector:
    matchLabels:
      app: mongodb
  template:
    metadata:
      labels:
        app: mongodb
    spec:
      terminationGracePeriodSeconds: 30
      initContainers:
      - name: install
        image: busybox:1.35
        command:
        - sh
        - "-c"
        - |
          set -ex
          echo "Setting up MongoDB keyfile..."
          cp /tmp/keyfile/keyfile /etc/mongodb-keyfile/keyfile
          chmod 400 /etc/mongodb-keyfile/keyfile
          chown 999:999 /etc/mongodb-keyfile/keyfile
        volumeMounts:
        - name: keyfile
          mountPath: /tmp/keyfile
          readOnly: true
        - name: mongodb-keyfile
          mountPath: /etc/mongodb-keyfile
      containers:
      - name: mongodb
        image: mongo:7.0
        command:
        - mongod
        - "--config=/etc/mongodb/mongod.conf"
        ports:
        - containerPort: 27017
          name: mongodb
        env:
        - name: MONGO_INITDB_ROOT_USERNAME
          value: admin
        - name: MONGO_INITDB_ROOT_PASSWORD
          valueFrom:
            secretKeyRef:
              name: mongodb-secret
              key: mongodb-root-password
        volumeMounts:
        - name: data
          mountPath: /data/db
        - name: config
          mountPath: /etc/mongodb
        - name: mongodb-keyfile
          mountPath: /etc/mongodb-keyfile
        - name: logs
          mountPath: /var/log/mongodb
        livenessProbe:
          exec:
            command:
            - mongo
            - --eval
            - "db.adminCommand('ping')"
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
        readinessProbe:
          exec:
            command:
            - mongo
            - --eval
            - "db.adminCommand('ping')"
          initialDelaySeconds: 5
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 3
        resources:
          requests:
            memory: "1Gi"
            cpu: "500m"
          limits:
            memory: "4Gi"
            cpu: "2000m"
      - name: mongodb-sidecar
        image: cvallance/mongo-k8s-sidecar:latest
        env:
        - name: MONGO_SIDECAR_POD_LABELS
          value: "app=mongodb"
        - name: KUBERNETES_MONGO_SERVICE_NAME
          value: mongodb
        - name: MONGODB_USERNAME
          value: admin
        - name: MONGODB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: mongodb-secret
              key: mongodb-root-password
        - name: MONGODB_DATABASE
          value: admin
        resources:
          requests:
            memory: "50Mi"
            cpu: "50m"
          limits:
            memory: "100Mi"
            cpu: "100m"
      volumes:
      - name: config
        configMap:
          name: mongodb-config
      - name: keyfile
        secret:
          secretName: mongodb-secret
          items:
          - key: mongodb-replica-set-key
            path: keyfile
          defaultMode: 0400
      - name: mongodb-keyfile
        emptyDir: {}
      - name: logs
        emptyDir: {}
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: [ "ReadWriteOnce" ]
      storageClassName: fast-ssd
      resources:
        requests:
          storage: 100Gi
```

### MongoDB Replica Set Initialization

```bash
#!/bin/bash
# init-mongodb-replicaset.sh

set -e

NAMESPACE="database"
PRIMARY_POD="mongodb-0"

echo "Waiting for MongoDB pods to be ready..."
kubectl wait --for=condition=ready pod/${PRIMARY_POD} -n ${NAMESPACE} --timeout=300s

echo "Waiting for all MongoDB pods..."
for i in 0 1 2; do
  kubectl wait --for=condition=ready pod/mongodb-${i} -n ${NAMESPACE} --timeout=300s
done

echo "Initializing MongoDB replica set..."
kubectl exec -n ${NAMESPACE} ${PRIMARY_POD} -- mongo admin -u admin -p $(kubectl get secret mongodb-secret -n ${NAMESPACE} -o jsonpath='{.data.mongodb-root-password}' | base64 -d) --eval "
rs.initiate({
  _id: 'rs0',
  members: [
    { _id: 0, host: 'mongodb-0.mongodb.database.svc.cluster.local:27017', priority: 2 },
    { _id: 1, host: 'mongodb-1.mongodb.database.svc.cluster.local:27017', priority: 1 },
    { _id: 2, host: 'mongodb-2.mongodb.database.svc.cluster.local:27017', priority: 1 }
  ]
})
"

echo "Waiting for replica set to stabilize..."
sleep 10

echo "Checking replica set status..."
kubectl exec -n ${NAMESPACE} ${PRIMARY_POD} -- mongo admin -u admin -p $(kubectl get secret mongodb-secret -n ${NAMESPACE} -o jsonpath='{.data.mongodb-root-password}' | base64 -d) --eval "rs.status()"

echo "MongoDB replica set initialization complete!"
```

## Cassandra Cluster with StatefulSet

Apache Cassandra requires careful rack and datacenter configuration for optimal data distribution.

### Cassandra StatefulSet Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cassandra-config
  namespace: database
data:
  cassandra.yaml: |
    cluster_name: 'Production Cluster'
    num_tokens: 256
    hinted_handoff_enabled: true
    max_hint_window_in_ms: 10800000
    hinted_handoff_throttle_in_kb: 1024
    max_hints_delivery_threads: 2
    hints_flush_period_in_ms: 10000
    max_hints_file_size_in_mb: 128
    batchlog_replay_throttle_in_kb: 1024
    authenticator: PasswordAuthenticator
    authorizer: CassandraAuthorizer
    role_manager: CassandraRoleManager
    roles_validity_in_ms: 2000
    permissions_validity_in_ms: 2000
    credentials_validity_in_ms: 2000
    partitioner: org.apache.cassandra.dht.Murmur3Partitioner
    data_file_directories:
      - /var/lib/cassandra/data
    commitlog_directory: /var/lib/cassandra/commitlog
    saved_caches_directory: /var/lib/cassandra/saved_caches
    seed_provider:
      - class_name: org.apache.cassandra.locator.SimpleSeedProvider
        parameters:
          - seeds: "cassandra-0.cassandra.database.svc.cluster.local,cassandra-1.cassandra.database.svc.cluster.local"
    concurrent_reads: 32
    concurrent_writes: 32
    concurrent_counter_writes: 32
    memtable_allocation_type: heap_buffers
    index_summary_capacity_in_mb: 100
    index_summary_resize_interval_in_minutes: 60
    trickle_fsync: false
    trickle_fsync_interval_in_kb: 10240
    storage_port: 7000
    ssl_storage_port: 7001
    listen_address: ${POD_IP}
    start_native_transport: true
    native_transport_port: 9042
    start_rpc: false
    rpc_address: ${POD_IP}
    rpc_port: 9160
    broadcast_rpc_address: ${POD_IP}
    rpc_keepalive: true
    incremental_backups: false
    snapshot_before_compaction: false
    auto_snapshot: true
    column_index_size_in_kb: 64
    compaction_throughput_mb_per_sec: 16
    sstable_preemptive_open_interval_in_mb: 50
    read_request_timeout_in_ms: 5000
    range_request_timeout_in_ms: 10000
    write_request_timeout_in_ms: 2000
    counter_write_request_timeout_in_ms: 5000
    cas_contention_timeout_in_ms: 1000
    truncate_request_timeout_in_ms: 60000
    request_timeout_in_ms: 10000
    endpoint_snitch: GossipingPropertyFileSnitch
    dynamic_snitch_update_interval_in_ms: 100
    dynamic_snitch_reset_interval_in_ms: 600000
    dynamic_snitch_badness_threshold: 0.1
    request_scheduler: org.apache.cassandra.scheduler.NoScheduler
    internode_compression: dc
    inter_dc_tcp_nodelay: false
    tracetype_query_ttl: 86400
    tracetype_repair_ttl: 604800
    gc_warn_threshold_in_ms: 1000
    tombstone_warn_threshold: 1000
    tombstone_failure_threshold: 100000
    batch_size_warn_threshold_in_kb: 5
    batch_size_fail_threshold_in_kb: 50
    unlogged_batch_across_partitions_warn_threshold: 10
    enable_user_defined_functions: false
    enable_scripted_user_defined_functions: false
    windows_timer_interval: 1
---
apiVersion: v1
kind: Service
metadata:
  name: cassandra
  namespace: database
  labels:
    app: cassandra
spec:
  ports:
  - port: 9042
    name: cql
  - port: 7000
    name: intra-node
  - port: 7001
    name: tls-intra-node
  - port: 7199
    name: jmx
  clusterIP: None
  selector:
    app: cassandra
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: cassandra
  namespace: database
spec:
  serviceName: cassandra
  replicas: 3
  selector:
    matchLabels:
      app: cassandra
  template:
    metadata:
      labels:
        app: cassandra
    spec:
      terminationGracePeriodSeconds: 1800
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
        env:
        - name: CASSANDRA_SEEDS
          value: "cassandra-0.cassandra.database.svc.cluster.local,cassandra-1.cassandra.database.svc.cluster.local"
        - name: MAX_HEAP_SIZE
          value: "2G"
        - name: HEAP_NEWSIZE
          value: "400M"
        - name: CASSANDRA_CLUSTER_NAME
          value: "Production Cluster"
        - name: CASSANDRA_DC
          value: "DC1"
        - name: CASSANDRA_RACK
          value: "Rack1"
        - name: POD_IP
          valueFrom:
            fieldRef:
              fieldPath: status.podIP
        volumeMounts:
        - name: data
          mountPath: /var/lib/cassandra
        - name: config
          mountPath: /etc/cassandra
        livenessProbe:
          exec:
            command:
            - /bin/bash
            - -c
            - nodetool status
          initialDelaySeconds: 90
          periodSeconds: 30
          timeoutSeconds: 10
          failureThreshold: 3
        readinessProbe:
          exec:
            command:
            - /bin/bash
            - -c
            - nodetool status | grep -E "^UN\s+${POD_IP}"
          initialDelaySeconds: 60
          periodSeconds: 10
          timeoutSeconds: 10
          failureThreshold: 3
        resources:
          requests:
            memory: "4Gi"
            cpu: "1000m"
          limits:
            memory: "8Gi"
            cpu: "4000m"
      volumes:
      - name: config
        configMap:
          name: cassandra-config
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: [ "ReadWriteOnce" ]
      storageClassName: fast-ssd
      resources:
        requests:
          storage: 200Gi
```

## Advanced StatefulSet Patterns

### Ordered Pod Management with Parallel Mode

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: parallel-database
  namespace: database
spec:
  serviceName: parallel-database
  replicas: 5
  # Parallel pod management for faster scaling
  podManagementPolicy: Parallel
  selector:
    matchLabels:
      app: parallel-database
  template:
    metadata:
      labels:
        app: parallel-database
    spec:
      containers:
      - name: database
        image: postgres:15-alpine
        # Container spec here
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: [ "ReadWriteOnce" ]
      resources:
        requests:
          storage: 100Gi
```

### StatefulSet Rolling Update Strategy

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: database-rolling
  namespace: database
spec:
  serviceName: database-rolling
  replicas: 3
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      partition: 0  # Update all pods when changed
  selector:
    matchLabels:
      app: database
  template:
    metadata:
      labels:
        app: database
    spec:
      containers:
      - name: database
        image: postgres:15-alpine
        # Container spec here
```

### StatefulSet with Multiple Volume Claims

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: multi-volume-db
  namespace: database
spec:
  serviceName: multi-volume-db
  replicas: 3
  selector:
    matchLabels:
      app: multi-volume-db
  template:
    metadata:
      labels:
        app: multi-volume-db
    spec:
      containers:
      - name: database
        image: postgres:15-alpine
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
        - name: wal
          mountPath: /var/lib/postgresql/wal
        - name: backups
          mountPath: /var/lib/postgresql/backups
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: [ "ReadWriteOnce" ]
      storageClassName: fast-ssd
      resources:
        requests:
          storage: 100Gi
  - metadata:
      name: wal
    spec:
      accessModes: [ "ReadWriteOnce" ]
      storageClassName: ultra-fast-ssd
      resources:
        requests:
          storage: 50Gi
  - metadata:
      name: backups
    spec:
      accessModes: [ "ReadWriteOnce" ]
      storageClassName: standard
      resources:
        requests:
          storage: 500Gi
```

## StatefulSet Scaling Operations

### Safe Scaling Script

```bash
#!/bin/bash
# scale-statefulset.sh

set -e

NAMESPACE=${1:-database}
STATEFULSET=${2:-postgres}
TARGET_REPLICAS=${3}

if [ -z "$TARGET_REPLICAS" ]; then
  echo "Usage: $0 <namespace> <statefulset> <target-replicas>"
  exit 1
fi

CURRENT_REPLICAS=$(kubectl get statefulset ${STATEFULSET} -n ${NAMESPACE} -o jsonpath='{.spec.replicas}')

echo "Current replicas: ${CURRENT_REPLICAS}"
echo "Target replicas: ${TARGET_REPLICAS}"

if [ ${TARGET_REPLICAS} -gt ${CURRENT_REPLICAS} ]; then
  echo "Scaling up from ${CURRENT_REPLICAS} to ${TARGET_REPLICAS}..."

  # Scale up one pod at a time for databases
  for i in $(seq ${CURRENT_REPLICAS} $((${TARGET_REPLICAS}-1))); do
    NEXT_REPLICA=$((i+1))
    echo "Scaling to ${NEXT_REPLICA} replicas..."
    kubectl scale statefulset ${STATEFULSET} -n ${NAMESPACE} --replicas=${NEXT_REPLICA}

    # Wait for new pod to be ready
    POD_NAME="${STATEFULSET}-${i}"
    echo "Waiting for pod ${POD_NAME} to be ready..."
    kubectl wait --for=condition=ready pod/${POD_NAME} -n ${NAMESPACE} --timeout=300s

    # Verify database replication
    echo "Verifying database connectivity..."
    sleep 10
  done

elif [ ${TARGET_REPLICAS} -lt ${CURRENT_REPLICAS} ]; then
  echo "Scaling down from ${CURRENT_REPLICAS} to ${TARGET_REPLICAS}..."

  # Verify it's safe to scale down
  echo "WARNING: Scaling down a database can lead to data loss if not done carefully!"
  read -p "Are you sure you want to proceed? (yes/no): " confirm

  if [ "$confirm" != "yes" ]; then
    echo "Scaling cancelled."
    exit 0
  fi

  # Scale down one pod at a time
  for i in $(seq $((${CURRENT_REPLICAS}-1)) -1 ${TARGET_REPLICAS}); do
    POD_NAME="${STATEFULSET}-${i}"

    # Check if pod is primary/master
    echo "Checking if ${POD_NAME} is primary..."
    # Add database-specific checks here

    echo "Scaling to ${i} replicas..."
    kubectl scale statefulset ${STATEFULSET} -n ${NAMESPACE} --replicas=${i}

    # Wait for pod to be terminated
    kubectl wait --for=delete pod/${POD_NAME} -n ${NAMESPACE} --timeout=300s

    echo "Pod ${POD_NAME} terminated successfully."
    sleep 10
  done
else
  echo "StatefulSet is already at target replica count."
fi

echo "Scaling operation complete!"
```

## StatefulSet Failure Recovery

### Automated Failure Detection and Recovery

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: statefulset-recovery
  namespace: database
data:
  recovery.sh: |
    #!/bin/bash
    # StatefulSet pod recovery script

    set -e

    NAMESPACE=${NAMESPACE:-database}
    STATEFULSET=${STATEFULSET:-postgres}
    POD_INDEX=${POD_INDEX}

    echo "Starting recovery for ${STATEFULSET}-${POD_INDEX}..."

    # Check if PVC exists and is healthy
    PVC_NAME="data-${STATEFULSET}-${POD_INDEX}"
    PVC_STATUS=$(kubectl get pvc ${PVC_NAME} -n ${NAMESPACE} -o jsonpath='{.status.phase}')

    if [ "$PVC_STATUS" != "Bound" ]; then
      echo "ERROR: PVC ${PVC_NAME} is not bound. Status: ${PVC_STATUS}"
      exit 1
    fi

    # Check pod status
    POD_NAME="${STATEFULSET}-${POD_INDEX}"
    POD_STATUS=$(kubectl get pod ${POD_NAME} -n ${NAMESPACE} -o jsonpath='{.status.phase}' 2>/dev/null || echo "NotFound")

    if [ "$POD_STATUS" == "NotFound" ]; then
      echo "Pod does not exist. It will be recreated by StatefulSet controller."
      exit 0
    fi

    if [ "$POD_STATUS" != "Running" ]; then
      echo "Pod is not running. Current status: ${POD_STATUS}"

      # Check for common issues
      RESTART_COUNT=$(kubectl get pod ${POD_NAME} -n ${NAMESPACE} -o jsonpath='{.status.containerStatuses[0].restartCount}')

      if [ ${RESTART_COUNT} -gt 5 ]; then
        echo "WARNING: Pod has restarted ${RESTART_COUNT} times. Investigating..."

        # Get recent logs
        echo "Recent logs:"
        kubectl logs ${POD_NAME} -n ${NAMESPACE} --tail=50

        # Check for disk space issues
        echo "Checking PVC usage..."
        # This requires debug container or exec access
      fi

      # Force delete and recreate if stuck
      POD_AGE=$(kubectl get pod ${POD_NAME} -n ${NAMESPACE} -o jsonpath='{.metadata.creationTimestamp}')
      AGE_SECONDS=$(( $(date +%s) - $(date -d ${POD_AGE} +%s) ))

      if [ ${AGE_SECONDS} -gt 600 ]; then
        echo "Pod has been in unhealthy state for over 10 minutes. Force deleting..."
        kubectl delete pod ${POD_NAME} -n ${NAMESPACE} --force --grace-period=0
      fi
    fi

    echo "Recovery check complete."
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: statefulset-health-check
  namespace: database
spec:
  schedule: "*/5 * * * *"  # Every 5 minutes
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: statefulset-recovery
          containers:
          - name: health-check
            image: bitnami/kubectl:latest
            command:
            - /bin/bash
            - -c
            - |
              for i in 0 1 2; do
                export POD_INDEX=$i
                bash /scripts/recovery.sh
              done
            env:
            - name: NAMESPACE
              value: database
            - name: STATEFULSET
              value: postgres
            volumeMounts:
            - name: scripts
              mountPath: /scripts
          volumes:
          - name: scripts
            configMap:
              name: statefulset-recovery
              defaultMode: 0755
          restartPolicy: OnFailure
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: statefulset-recovery
  namespace: database
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: statefulset-recovery
  namespace: database
rules:
- apiGroups: [""]
  resources: ["pods", "persistentvolumeclaims"]
  verbs: ["get", "list", "delete"]
- apiGroups: [""]
  resources: ["pods/log"]
  verbs: ["get"]
- apiGroups: ["apps"]
  resources: ["statefulsets"]
  verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: statefulset-recovery
  namespace: database
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: statefulset-recovery
subjects:
- kind: ServiceAccount
  name: statefulset-recovery
  namespace: database
```

## Monitoring StatefulSets with Prometheus

### StatefulSet Metrics Collection

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: statefulset-exporter
  namespace: database
data:
  statefulset-metrics.sh: |
    #!/bin/bash
    # Custom metrics exporter for StatefulSet health

    while true; do
      NAMESPACE=${NAMESPACE:-database}
      STATEFULSET=${STATEFULSET:-postgres}

      # Get StatefulSet status
      DESIRED=$(kubectl get statefulset ${STATEFULSET} -n ${NAMESPACE} -o jsonpath='{.spec.replicas}')
      READY=$(kubectl get statefulset ${STATEFULSET} -n ${NAMESPACE} -o jsonpath='{.status.readyReplicas}')
      CURRENT=$(kubectl get statefulset ${STATEFULSET} -n ${NAMESPACE} -o jsonpath='{.status.currentReplicas}')
      UPDATED=$(kubectl get statefulset ${STATEFULSET} -n ${NAMESPACE} -o jsonpath='{.status.updatedReplicas}')

      # Write metrics in Prometheus format
      cat <<EOF > /tmp/metrics.prom
# HELP statefulset_replicas_desired Number of desired replicas
# TYPE statefulset_replicas_desired gauge
statefulset_replicas_desired{namespace="${NAMESPACE}",statefulset="${STATEFULSET}"} ${DESIRED:-0}

# HELP statefulset_replicas_ready Number of ready replicas
# TYPE statefulset_replicas_ready gauge
statefulset_replicas_ready{namespace="${NAMESPACE}",statefulset="${STATEFULSET}"} ${READY:-0}

# HELP statefulset_replicas_current Number of current replicas
# TYPE statefulset_replicas_current gauge
statefulset_replicas_current{namespace="${NAMESPACE}",statefulset="${STATEFULSET}"} ${CURRENT:-0}

# HELP statefulset_replicas_updated Number of updated replicas
# TYPE statefulset_replicas_updated gauge
statefulset_replicas_updated{namespace="${NAMESPACE}",statefulset="${STATEFULSET}"} ${UPDATED:-0}

# HELP statefulset_health StatefulSet health status (1 = healthy, 0 = unhealthy)
# TYPE statefulset_health gauge
EOF

      if [ "${READY}" == "${DESIRED}" ]; then
        echo "statefulset_health{namespace=\"${NAMESPACE}\",statefulset=\"${STATEFULSET}\"} 1" >> /tmp/metrics.prom
      else
        echo "statefulset_health{namespace=\"${NAMESPACE}\",statefulset=\"${STATEFULSET}\"} 0" >> /tmp/metrics.prom
      fi

      # Check individual pod health
      for i in $(seq 0 $((${DESIRED}-1))); do
        POD_NAME="${STATEFULSET}-${i}"
        POD_STATUS=$(kubectl get pod ${POD_NAME} -n ${NAMESPACE} -o jsonpath='{.status.phase}' 2>/dev/null || echo "Unknown")
        RESTART_COUNT=$(kubectl get pod ${POD_NAME} -n ${NAMESPACE} -o jsonpath='{.status.containerStatuses[0].restartCount}' 2>/dev/null || echo "0")

        POD_READY=0
        if [ "$POD_STATUS" == "Running" ]; then
          POD_READY=1
        fi

        cat <<EOF >> /tmp/metrics.prom
statefulset_pod_ready{namespace="${NAMESPACE}",statefulset="${STATEFULSET}",pod="${POD_NAME}",index="${i}"} ${POD_READY}
statefulset_pod_restarts{namespace="${NAMESPACE}",statefulset="${STATEFULSET}",pod="${POD_NAME}",index="${i}"} ${RESTART_COUNT}
EOF
      done

      # Serve metrics on port 9090
      cp /tmp/metrics.prom /metrics/metrics.prom

      sleep 30
    done
```

### Prometheus ServiceMonitor

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: statefulset-monitor
  namespace: database
  labels:
    app: statefulset-monitor
spec:
  selector:
    matchLabels:
      app: postgres
  endpoints:
  - port: metrics
    interval: 30s
    path: /metrics
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: statefulset-alerts
  namespace: database
spec:
  groups:
  - name: statefulset
    interval: 30s
    rules:
    - alert: StatefulSetReplicasMismatch
      expr: |
        statefulset_replicas_ready != statefulset_replicas_desired
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "StatefulSet {{ $labels.statefulset }} has mismatched replicas"
        description: "StatefulSet {{ $labels.namespace }}/{{ $labels.statefulset }} has {{ $value }} ready replicas but {{ $labels.desired }} desired replicas for more than 5 minutes."

    - alert: StatefulSetPodRestartingTooOften
      expr: |
        rate(statefulset_pod_restarts[15m]) > 0.1
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "StatefulSet pod {{ $labels.pod }} is restarting frequently"
        description: "Pod {{ $labels.namespace }}/{{ $labels.pod }} has restarted {{ $value }} times in the last 15 minutes."

    - alert: StatefulSetDown
      expr: |
        statefulset_health == 0
      for: 10m
      labels:
        severity: critical
      annotations:
        summary: "StatefulSet {{ $labels.statefulset }} is unhealthy"
        description: "StatefulSet {{ $labels.namespace }}/{{ $labels.statefulset }} has been unhealthy for more than 10 minutes."
```

## Best Practices and Production Considerations

### 1. Storage Class Selection

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-ssd-retain
provisioner: kubernetes.io/aws-ebs
parameters:
  type: io2
  iopsPerGB: "50"
  fsType: ext4
reclaimPolicy: Retain  # Critical for databases
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
```

### 2. Pod Disruption Budgets

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: postgres-pdb
  namespace: database
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: postgres
```

### 3. Resource Quotas and Limits

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: database-quota
  namespace: database
spec:
  hard:
    requests.cpu: "20"
    requests.memory: 40Gi
    requests.storage: 2Ti
    persistentvolumeclaims: "20"
```

### 4. Network Policies

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: postgres-network-policy
  namespace: database
spec:
  podSelector:
    matchLabels:
      app: postgres
  policyTypes:
  - Ingress
  - Egress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          name: application
    - podSelector:
        matchLabels:
          role: backend
    ports:
    - protocol: TCP
      port: 5432
  egress:
  - to:
    - podSelector:
        matchLabels:
          app: postgres
    ports:
    - protocol: TCP
      port: 5432
  - to:
    - namespaceSelector: {}
    ports:
    - protocol: TCP
      port: 53
    - protocol: UDP
      port: 53
```

## Troubleshooting Common Issues

### 1. Pod Stuck in Pending State

```bash
# Check PVC status
kubectl get pvc -n database

# Describe the pending pod
kubectl describe pod postgres-0 -n database

# Check storage class
kubectl get storageclass

# Check node capacity
kubectl top nodes
```

### 2. Split Brain Detection

```bash
#!/bin/bash
# detect-split-brain.sh

NAMESPACE="database"
STATEFULSET="postgres"

echo "Checking for split-brain condition..."

PRIMARY_COUNT=0
for i in 0 1 2; do
  POD="$STATEFULSET-$i"
  IS_PRIMARY=$(kubectl exec -n $NAMESPACE $POD -- psql -U postgres -t -c "SELECT pg_is_in_recovery();" 2>/dev/null | tr -d '[:space:]')

  if [ "$IS_PRIMARY" == "f" ]; then
    echo "Pod $POD is PRIMARY"
    PRIMARY_COUNT=$((PRIMARY_COUNT + 1))
  else
    echo "Pod $POD is REPLICA"
  fi
done

if [ $PRIMARY_COUNT -gt 1 ]; then
  echo "ERROR: Split-brain detected! Multiple primaries found: $PRIMARY_COUNT"
  exit 1
elif [ $PRIMARY_COUNT -eq 0 ]; then
  echo "WARNING: No primary found!"
  exit 1
else
  echo "OK: Single primary detected"
fi
```

### 3. Data Corruption Recovery

```bash
#!/bin/bash
# recover-corrupted-pod.sh

NAMESPACE="database"
STATEFULSET="postgres"
POD_INDEX=$1

if [ -z "$POD_INDEX" ]; then
  echo "Usage: $0 <pod-index>"
  exit 1
fi

POD_NAME="${STATEFULSET}-${POD_INDEX}"
PVC_NAME="data-${STATEFULSET}-${POD_INDEX}"

echo "Starting recovery for $POD_NAME..."

# 1. Scale down to remove the pod
echo "Deleting pod..."
kubectl delete pod $POD_NAME -n $NAMESPACE

# 2. Backup existing PVC data
echo "Creating backup job..."
kubectl apply -f - <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: backup-${POD_NAME}-$(date +%s)
  namespace: $NAMESPACE
spec:
  template:
    spec:
      containers:
      - name: backup
        image: postgres:15-alpine
        command:
        - sh
        - -c
        - |
          mkdir -p /backup
          cp -r /data/* /backup/ || true
          echo "Backup complete"
        volumeMounts:
        - name: data
          mountPath: /data
        - name: backup
          mountPath: /backup
      restartPolicy: Never
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: $PVC_NAME
      - name: backup
        persistentVolumeClaim:
          claimName: backup-pvc
EOF

# Wait for backup to complete
kubectl wait --for=condition=complete job/backup-${POD_NAME} -n $NAMESPACE --timeout=600s

# 3. Delete PVC to start fresh
echo "Deleting PVC..."
kubectl delete pvc $PVC_NAME -n $NAMESPACE

# 4. Let StatefulSet recreate pod
echo "Pod will be recreated automatically by StatefulSet controller"
echo "New pod will perform base backup from primary"

echo "Recovery initiated. Monitor with: kubectl get pod $POD_NAME -n $NAMESPACE -w"
```

## Conclusion

StatefulSets are essential for running distributed databases on Kubernetes, providing the stability and ordering guarantees required for data consistency. This guide covered production-ready implementations for PostgreSQL, MongoDB, and Cassandra, along with advanced patterns for scaling, failure recovery, and monitoring.

Key takeaways:
- Use appropriate storage classes with retention policies
- Implement comprehensive health checks and monitoring
- Plan for failure scenarios with automated recovery
- Use pod disruption budgets to prevent data loss
- Monitor replication lag and cluster health continuously
- Test scaling and failure scenarios in non-production environments

By following these patterns and best practices, you can confidently run mission-critical distributed databases on Kubernetes with high availability and reliability.