---
title: "Kubernetes StatefulSet Patterns for Database Workloads: Production Best Practices"
date: 2027-05-12T00:00:00-05:00
draft: false
tags: ["Kubernetes", "StatefulSet", "Database", "PostgreSQL", "MySQL", "Redis"]
categories: ["Kubernetes", "Database"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide for running databases on Kubernetes StatefulSets, covering ordered deployment, headless services, pod identity, init containers, sidecar patterns, PodDisruptionBudgets, zero-downtime upgrades, and anti-affinity rules."
more_link: "yes"
url: "/kubernetes-statefulset-database-patterns-guide/"
---

Running databases on Kubernetes StatefulSets requires a fundamentally different mindset than deploying stateless applications. StatefulSets provide ordered deployment, stable network identities, and persistent storage guarantees that databases depend on, but configuring them correctly for production requires understanding the underlying Kubernetes primitives and the specific requirements of each database engine. This guide covers proven patterns for PostgreSQL, MySQL, and Redis deployments on Kubernetes at production scale.

<!--more-->

## StatefulSet Fundamentals for Database Workloads

StatefulSets differ from Deployments in three critical ways that matter for databases:

**Stable pod identity**: Each pod gets a predictable hostname following the pattern `<statefulset-name>-<ordinal>`. Pod `postgres-0` always has the hostname `postgres-0.postgres-headless.namespace.svc.cluster.local`. This hostname persists across restarts and rescheduling.

**Ordered operations**: Pods are created, scaled, and deleted in a defined order. Pod N is not started until pod N-1 is Running and Ready. This enables primary-first startup patterns required by replication-based databases.

**Persistent volume identity**: Each pod's PVC is tied to its ordinal, not its node. When pod `postgres-1` is rescheduled to a different node, it will remount `data-postgres-1`—the same volume—not a new one.

### Headless Service Configuration

Every database StatefulSet requires a headless service (with `clusterIP: None`) to enable DNS-based pod discovery:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: postgres-headless
  namespace: production
  labels:
    app: postgres
spec:
  clusterIP: None
  selector:
    app: postgres
  ports:
  - name: postgres
    port: 5432
    targetPort: 5432
---
# Standard service for read traffic (points to any ready pod)
apiVersion: v1
kind: Service
metadata:
  name: postgres
  namespace: production
  labels:
    app: postgres
spec:
  selector:
    app: postgres
  ports:
  - name: postgres
    port: 5432
    targetPort: 5432
```

With a headless service, each pod is individually addressable:
- `postgres-0.postgres-headless.production.svc.cluster.local`
- `postgres-1.postgres-headless.production.svc.cluster.local`
- `postgres-2.postgres-headless.production.svc.cluster.local`

## PostgreSQL Production StatefulSet

### Full Production Configuration

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: production
  labels:
    app: postgres
    version: "16"
spec:
  serviceName: postgres-headless
  replicas: 3
  podManagementPolicy: OrderedReady
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      partition: 0
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
        version: "16"
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9187"
    spec:
      serviceAccountName: postgres-sa
      terminationGracePeriodSeconds: 120
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchExpressions:
              - key: app
                operator: In
                values:
                - postgres
            topologyKey: kubernetes.io/hostname
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchExpressions:
                - key: app
                  operator: In
                  values:
                  - postgres
              topologyKey: topology.kubernetes.io/zone
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: postgres
      securityContext:
        fsGroup: 999
        runAsUser: 999
        runAsGroup: 999
        runAsNonRoot: true
      initContainers:
      - name: postgres-init
        image: postgres:16
        command:
        - /bin/bash
        - -c
        - |
          set -e
          # Initialize data directory if empty
          if [ -z "$(ls -A /var/lib/postgresql/data)" ]; then
            echo "Initializing PostgreSQL data directory"
            chown -R postgres:postgres /var/lib/postgresql/data
            chmod 700 /var/lib/postgresql/data
          fi
          # Copy configuration files
          cp /config/*.conf /etc/postgresql/
          echo "Init container complete"
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
        - name: postgres-config
          mountPath: /config
        - name: postgres-etc
          mountPath: /etc/postgresql
        securityContext:
          runAsUser: 0
          allowPrivilegeEscalation: false
      - name: wait-for-primary
        image: postgres:16
        command:
        - /bin/bash
        - -c
        - |
          set -e
          # For replica pods (ordinal > 0), wait for primary to be ready
          POD_ORDINAL="${HOSTNAME##*-}"
          if [ "$POD_ORDINAL" -gt 0 ]; then
            echo "Waiting for primary postgres-0 to be ready..."
            until pg_isready -h postgres-0.postgres-headless.${POD_NAMESPACE}.svc.cluster.local -U postgres; do
              echo "Primary not ready, waiting..."
              sleep 5
            done
            echo "Primary is ready"
          fi
        env:
        - name: POD_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace
      containers:
      - name: postgres
        image: postgres:16
        ports:
        - containerPort: 5432
          name: postgres
        env:
        - name: POSTGRES_DB
          value: myapp
        - name: POSTGRES_USER
          valueFrom:
            secretKeyRef:
              name: postgres-credentials
              key: username
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-credentials
              key: password
        - name: PGDATA
          value: /var/lib/postgresql/data/pgdata
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
            cpu: "2"
            memory: "8Gi"
          limits:
            cpu: "8"
            memory: "32Gi"
        livenessProbe:
          exec:
            command:
            - pg_isready
            - -U
            - postgres
            - -d
            - myapp
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 6
        readinessProbe:
          exec:
            command:
            - /bin/bash
            - -c
            - pg_isready -U postgres -d myapp
          initialDelaySeconds: 5
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 3
        startupProbe:
          exec:
            command:
            - pg_isready
            - -U
            - postgres
          failureThreshold: 30
          periodSeconds: 10
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
        - name: postgres-etc
          mountPath: /etc/postgresql
        - name: wal-archive
          mountPath: /var/lib/postgresql/archive
        lifecycle:
          preStop:
            exec:
              command:
              - /bin/bash
              - -c
              - |
                echo "Initiating graceful shutdown"
                # Checkpoint before shutdown
                psql -U postgres -c "CHECKPOINT;"
                # Allow 60s for connections to drain
                sleep 10
      - name: postgres-exporter
        image: prometheuscommunity/postgres-exporter:v0.15.0
        ports:
        - containerPort: 9187
          name: metrics
        env:
        - name: DATA_SOURCE_NAME
          valueFrom:
            secretKeyRef:
              name: postgres-exporter-secret
              key: datasource
        resources:
          requests:
            cpu: "100m"
            memory: "128Mi"
          limits:
            cpu: "500m"
            memory: "256Mi"
        livenessProbe:
          httpGet:
            path: /
            port: 9187
          initialDelaySeconds: 30
          periodSeconds: 30
      volumes:
      - name: postgres-config
        configMap:
          name: postgres-config
      - name: postgres-etc
        emptyDir: {}
  volumeClaimTemplates:
  - metadata:
      name: data
      labels:
        app: postgres
    spec:
      accessModes:
        - ReadWriteOnce
      storageClassName: io2-high-iops
      resources:
        requests:
          storage: 500Gi
  - metadata:
      name: wal-archive
      labels:
        app: postgres
    spec:
      accessModes:
        - ReadWriteOnce
      storageClassName: gp3
      resources:
        requests:
          storage: 200Gi
```

### PostgreSQL ConfigMap for Tuning

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: postgres-config
  namespace: production
data:
  postgresql.conf: |
    # Connection settings
    max_connections = 200

    # Memory settings (for 32Gi container limit)
    shared_buffers = 8GB
    effective_cache_size = 24GB
    maintenance_work_mem = 2GB
    work_mem = 41943kB

    # WAL settings
    wal_level = replica
    max_wal_senders = 10
    wal_keep_size = 1GB
    max_replication_slots = 10

    # Checkpoint settings
    checkpoint_timeout = 15min
    max_wal_size = 4GB
    min_wal_size = 1GB

    # Query planner
    random_page_cost = 1.1
    effective_io_concurrency = 200

    # Parallel query
    max_parallel_workers_per_gather = 4
    max_parallel_workers = 8

    # Logging
    log_min_duration_statement = 1000
    log_checkpoints = on
    log_connections = off
    log_lock_waits = on
    log_temp_files = 10MB

    # Autovacuum
    autovacuum_max_workers = 4
    autovacuum_vacuum_cost_delay = 2ms

    # Archive settings
    archive_mode = on
    archive_command = 'test ! -f /var/lib/postgresql/archive/%f && cp %p /var/lib/postgresql/archive/%f'

  pg_hba.conf: |
    # TYPE  DATABASE        USER            ADDRESS                 METHOD
    local   all             postgres                                peer
    local   all             all                                     md5
    host    all             all             127.0.0.1/32            md5
    host    all             all             ::1/128                 md5
    host    all             all             10.0.0.0/8              scram-sha-256
    host    replication     all             10.0.0.0/8              scram-sha-256
```

## MySQL Production StatefulSet

### MySQL InnoDB Cluster Configuration

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mysql
  namespace: production
spec:
  serviceName: mysql-headless
  replicas: 3
  selector:
    matchLabels:
      app: mysql
  podManagementPolicy: OrderedReady
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      partition: 0
  template:
    metadata:
      labels:
        app: mysql
    spec:
      terminationGracePeriodSeconds: 120
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchExpressions:
              - key: app
                operator: In
                values:
                - mysql
            topologyKey: kubernetes.io/hostname
      initContainers:
      - name: init-mysql
        image: mysql:8.0
        command:
        - /bin/bash
        - -c
        - |
          set -ex
          # Generate MySQL server-id from pod ordinal index
          [[ $(hostname) =~ -([0-9]+)$ ]] || exit 1
          ordinal=${BASH_REMATCH[1]}
          echo [mysqld] > /mnt/conf.d/server-id.cnf
          echo server-id=$((100 + $ordinal)) >> /mnt/conf.d/server-id.cnf

          # Copy appropriate config based on pod role
          if [[ $ordinal -eq 0 ]]; then
            cp /mnt/config-map/primary.cnf /mnt/conf.d/
          else
            cp /mnt/config-map/replica.cnf /mnt/conf.d/
          fi
        volumeMounts:
        - name: conf
          mountPath: /mnt/conf.d
        - name: config-map
          mountPath: /mnt/config-map
      - name: clone-mysql
        image: gcr.io/google-samples/xtrabackup:1.0
        command:
        - /bin/bash
        - -c
        - |
          set -ex
          # Skip cloning on primary
          [[ $(hostname) =~ -([0-9]+)$ ]] || exit 1
          ordinal=${BASH_REMATCH[1]}
          [[ $ordinal -eq 0 ]] && exit 0

          # Skip if data directory already has data
          [[ -d /var/lib/mysql/mysql ]] && exit 0

          # Clone from previous pod
          ncat --recv-only mysql-$(($ordinal-1)).mysql-headless.$(cat /var/run/secrets/kubernetes.io/serviceaccount/namespace).svc.cluster.local 3307 | xbstream -x -C /var/lib/mysql
          # Prepare the backup.
          xtrabackup --prepare --target-dir=/var/lib/mysql
        volumeMounts:
        - name: data
          mountPath: /var/lib/mysql
          subPath: mysql
        - name: conf
          mountPath: /etc/mysql/conf.d
      containers:
      - name: mysql
        image: mysql:8.0
        env:
        - name: MYSQL_ROOT_PASSWORD
          valueFrom:
            secretKeyRef:
              name: mysql-credentials
              key: root-password
        - name: MYSQL_DATABASE
          value: myapp
        - name: MYSQL_USER
          valueFrom:
            secretKeyRef:
              name: mysql-credentials
              key: username
        - name: MYSQL_PASSWORD
          valueFrom:
            secretKeyRef:
              name: mysql-credentials
              key: password
        ports:
        - containerPort: 3306
          name: mysql
        resources:
          requests:
            cpu: "2"
            memory: "8Gi"
          limits:
            cpu: "8"
            memory: "32Gi"
        livenessProbe:
          exec:
            command:
            - mysqladmin
            - ping
            - -u
            - root
            - -p$(MYSQL_ROOT_PASSWORD)
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
        readinessProbe:
          exec:
            command:
            - mysql
            - -h
            - 127.0.0.1
            - -u
            - root
            - -p$(MYSQL_ROOT_PASSWORD)
            - -e
            - SELECT 1
          initialDelaySeconds: 5
          periodSeconds: 2
          timeoutSeconds: 1
        volumeMounts:
        - name: data
          mountPath: /var/lib/mysql
          subPath: mysql
        - name: conf
          mountPath: /etc/mysql/conf.d
      - name: xtrabackup
        image: gcr.io/google-samples/xtrabackup:1.0
        ports:
        - containerPort: 3307
          name: xtrabackup
        command:
        - /bin/bash
        - -c
        - |
          set -ex
          cd /var/lib/mysql
          # Determine binlog position from cloned data, if any.
          if [[ -f xtrabackup_slave_info && "x$(cat xtrabackup_slave_info)" != "x" ]]; then
            cat xtrabackup_slave_info | sed -E 's/;$//g' > change_master_to.sql.in
            rm -f xtrabackup_slave_info xtrabackup_binlog_info
          elif [[ -f xtrabackup_binlog_info ]]; then
            [[ $(cat xtrabackup_binlog_info) =~ ^(.*?)[[:space:]]+(.*?)$ ]] || exit 1
            rm -f xtrabackup_binlog_info
            echo "CHANGE MASTER TO MASTER_LOG_FILE='${BASH_REMATCH[1]}',\
                  MASTER_LOG_POS=${BASH_REMATCH[2]}" > change_master_to.sql.in
          fi
          # Check if we need to complete a clone by starting replication.
          if [[ -f change_master_to.sql.in ]]; then
            echo "Waiting for mysqld to be ready (accepting connections)"
            until mysql -h 127.0.0.1 -uroot -p${MYSQL_ROOT_PASSWORD} -e "SELECT 1"; do sleep 1; done
            echo "Initializing replication from clone position"
            mysql -h 127.0.0.1 -uroot -p${MYSQL_ROOT_PASSWORD} \
                  -e "$(<change_master_to.sql.in), \
                          MASTER_HOST='mysql-0.mysql-headless', \
                          MASTER_USER='root', \
                          MASTER_PASSWORD='${MYSQL_ROOT_PASSWORD}', \
                          MASTER_CONNECT_RETRY=10; \
                        START SLAVE;" || exit 1
            mv change_master_to.sql.in change_master_to.sql.orig
          fi
          # Start a server to send backups when requested by peers.
          exec ncat --listen --keep-open --send-only --max-conns=1 3307 -c \
            "xtrabackup --backup --slave-info --stream=xbstream --host=127.0.0.1 --user=root --password=${MYSQL_ROOT_PASSWORD}"
        env:
        - name: MYSQL_ROOT_PASSWORD
          valueFrom:
            secretKeyRef:
              name: mysql-credentials
              key: root-password
        volumeMounts:
        - name: data
          mountPath: /var/lib/mysql
          subPath: mysql
        - name: conf
          mountPath: /etc/mysql/conf.d
        resources:
          requests:
            cpu: "100m"
            memory: "100Mi"
          limits:
            cpu: "1"
            memory: "512Mi"
      volumes:
      - name: conf
        emptyDir: {}
      - name: config-map
        configMap:
          name: mysql-config
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: [ReadWriteOnce]
      storageClassName: io2-high-iops
      resources:
        requests:
          storage: 500Gi
```

### MySQL ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: mysql-config
  namespace: production
data:
  primary.cnf: |
    [mysqld]
    log-bin
    log_bin_trust_function_creators = 1

  replica.cnf: |
    [mysqld]
    super-read-only

  my.cnf: |
    [mysqld]
    # Basic settings
    default-authentication-plugin = mysql_native_password
    skip-host-cache
    skip-name-resolve

    # InnoDB settings
    innodb_buffer_pool_size = 16G
    innodb_buffer_pool_instances = 8
    innodb_log_file_size = 2G
    innodb_log_buffer_size = 64M
    innodb_flush_log_at_trx_commit = 1
    innodb_flush_method = O_DIRECT
    innodb_io_capacity = 4000
    innodb_io_capacity_max = 8000

    # Connection settings
    max_connections = 500
    max_connect_errors = 1000000

    # Query cache (disabled in MySQL 8.0)
    # query_cache_type = 0

    # Replication
    gtid_mode = ON
    enforce_gtid_consistency = ON
    relay_log_recovery = ON

    # Performance Schema
    performance_schema = ON
```

## Redis Production StatefulSet

### Redis Sentinel Configuration

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis
  namespace: production
spec:
  serviceName: redis-headless
  replicas: 3
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9121"
    spec:
      terminationGracePeriodSeconds: 60
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchExpressions:
              - key: app
                operator: In
                values:
                - redis
            topologyKey: kubernetes.io/hostname
      securityContext:
        fsGroup: 1001
        runAsUser: 1001
        runAsNonRoot: true
      initContainers:
      - name: redis-init
        image: redis:7.2
        command:
        - /bin/bash
        - -c
        - |
          set -e
          POD_ORDINAL="${HOSTNAME##*-}"

          if [ "$POD_ORDINAL" = "0" ]; then
            # Primary configuration
            cat > /redis-config/redis.conf <<EOF
          bind 0.0.0.0
          protected-mode no
          port 6379
          loglevel notice
          appendonly yes
          appendfsync everysec
          no-appendfsync-on-rewrite yes
          auto-aof-rewrite-percentage 100
          auto-aof-rewrite-min-size 64mb
          maxmemory 6gb
          maxmemory-policy allkeys-lru
          save 900 1
          save 300 10
          save 60 10000
          requirepass ${REDIS_PASSWORD}
          masterauth ${REDIS_PASSWORD}
          EOF
          else
            # Replica configuration
            MASTER="redis-0.redis-headless.${POD_NAMESPACE}.svc.cluster.local"
            cat > /redis-config/redis.conf <<EOF
          bind 0.0.0.0
          protected-mode no
          port 6379
          loglevel notice
          appendonly yes
          appendfsync everysec
          no-appendfsync-on-rewrite yes
          maxmemory 6gb
          maxmemory-policy allkeys-lru
          replicaof ${MASTER} 6379
          requirepass ${REDIS_PASSWORD}
          masterauth ${REDIS_PASSWORD}
          replica-read-only yes
          EOF
          fi

          echo "Redis configuration generated for ordinal $POD_ORDINAL"
        env:
        - name: POD_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace
        - name: REDIS_PASSWORD
          valueFrom:
            secretKeyRef:
              name: redis-credentials
              key: password
        volumeMounts:
        - name: redis-config
          mountPath: /redis-config
      containers:
      - name: redis
        image: redis:7.2
        command:
        - redis-server
        - /redis-config/redis.conf
        ports:
        - containerPort: 6379
          name: redis
        env:
        - name: REDIS_PASSWORD
          valueFrom:
            secretKeyRef:
              name: redis-credentials
              key: password
        resources:
          requests:
            cpu: "500m"
            memory: "7Gi"
          limits:
            cpu: "4"
            memory: "8Gi"
        livenessProbe:
          exec:
            command:
            - redis-cli
            - -a
            - $(REDIS_PASSWORD)
            - ping
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 5
        readinessProbe:
          exec:
            command:
            - redis-cli
            - -a
            - $(REDIS_PASSWORD)
            - ping
          initialDelaySeconds: 5
          periodSeconds: 5
          timeoutSeconds: 1
          failureThreshold: 3
        volumeMounts:
        - name: data
          mountPath: /data
        - name: redis-config
          mountPath: /redis-config
      - name: redis-exporter
        image: oliver006/redis_exporter:v1.58.0
        ports:
        - containerPort: 9121
          name: metrics
        env:
        - name: REDIS_ADDR
          value: redis://localhost:6379
        - name: REDIS_PASSWORD
          valueFrom:
            secretKeyRef:
              name: redis-credentials
              key: password
        resources:
          requests:
            cpu: "100m"
            memory: "128Mi"
          limits:
            cpu: "500m"
            memory: "256Mi"
      volumes:
      - name: redis-config
        emptyDir: {}
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: [ReadWriteOnce]
      storageClassName: gp3
      resources:
        requests:
          storage: 50Gi
```

## PodDisruptionBudgets for Database High Availability

PodDisruptionBudgets (PDBs) prevent voluntary disruptions from taking down too many database pods simultaneously. This is critical for maintaining quorum in replicated databases.

### PostgreSQL PDB

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: postgres-pdb
  namespace: production
spec:
  # Always keep at least 2 pods running (requires 3+ replicas)
  minAvailable: 2
  selector:
    matchLabels:
      app: postgres
```

### MySQL PDB

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: mysql-pdb
  namespace: production
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: mysql
```

### Redis PDB (with quorum protection)

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: redis-pdb
  namespace: production
spec:
  # For 3-replica Sentinel, maintain quorum (2 of 3)
  minAvailable: 2
  selector:
    matchLabels:
      app: redis
---
# Sentinel PDB
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: redis-sentinel-pdb
  namespace: production
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: redis-sentinel
```

### Testing PDB Enforcement

```bash
# Verify PDB is enforced
kubectl get pdb -n production

# Simulate a node drain (should be blocked if it would violate PDB)
kubectl drain node-01 --delete-emptydir-data --ignore-daemonsets --dry-run

# Check PDB status
kubectl describe pdb postgres-pdb -n production
# Look for: "Allowed disruptions: 1"
```

## Zero-Downtime Upgrades

### Partitioned Rolling Updates

The `rollingUpdate.partition` field allows staged rollouts where only pods with ordinal >= partition are updated:

```bash
# Update only the last replica first (ordinal 2)
kubectl patch statefulset postgres \
  -p '{"spec":{"updateStrategy":{"rollingUpdate":{"partition":2}}}}'

# Apply the new image
kubectl set image statefulset/postgres postgres=postgres:16.2

# Wait for pod-2 to update
kubectl rollout status statefulset/postgres

# Verify the updated pod is healthy
kubectl exec postgres-2 -- psql -U postgres -c "SELECT version();"

# If healthy, update pod-1
kubectl patch statefulset postgres \
  -p '{"spec":{"updateStrategy":{"rollingUpdate":{"partition":1}}}}'
kubectl rollout status statefulset/postgres

# Finally update pod-0 (primary)
kubectl patch statefulset postgres \
  -p '{"spec":{"updateStrategy":{"rollingUpdate":{"partition":0}}}}'
kubectl rollout status statefulset/postgres
```

### Blue-Green StatefulSet Upgrade

For major version upgrades requiring data migration:

```bash
#!/bin/bash
# blue-green-statefulset-upgrade.sh

NAMESPACE="production"
BLUE_STS="postgres"    # Current version
GREEN_STS="postgres-v2"  # New version

echo "=== Blue-Green PostgreSQL Upgrade ==="

# Step 1: Scale down green (ensure it's at 0)
kubectl scale statefulset "$GREEN_STS" -n "$NAMESPACE" --replicas=0

# Step 2: Create snapshot of primary data volume
kubectl apply -f - <<EOF
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: postgres-upgrade-snapshot
  namespace: $NAMESPACE
spec:
  volumeSnapshotClassName: ebs-vsc
  source:
    persistentVolumeClaimName: data-${BLUE_STS}-0
EOF

# Step 3: Wait for snapshot
kubectl wait volumesnapshot postgres-upgrade-snapshot \
  -n "$NAMESPACE" --for=condition=ReadyToUse --timeout=600s

# Step 4: Scale up green (will restore from snapshot via volumeClaimTemplate dataSource)
kubectl scale statefulset "$GREEN_STS" -n "$NAMESPACE" --replicas=3
kubectl rollout status statefulset/"$GREEN_STS" -n "$NAMESPACE"

# Step 5: Verify green is healthy
kubectl exec -n "$NAMESPACE" "${GREEN_STS}-0" -- pg_isready -U postgres

# Step 6: Switch service selector
kubectl patch service postgres -n "$NAMESPACE" \
  -p "{\"spec\":{\"selector\":{\"app\":\"${GREEN_STS}\"}}}"

echo "Upgrade complete. Blue StatefulSet still running for rollback."
echo "To complete: kubectl scale statefulset $BLUE_STS -n $NAMESPACE --replicas=0"
```

## Backup Sidecar Pattern

### pgBackRest Sidecar for PostgreSQL

```yaml
# Add to the containers section of the PostgreSQL StatefulSet
- name: pgbackrest
  image: pgbackrest/pgbackrest:2.49
  command:
  - /bin/bash
  - -c
  - |
    # Configure pgbackrest
    cat > /etc/pgbackrest/pgbackrest.conf <<EOF
    [global]
    repo1-type=s3
    repo1-s3-bucket=my-pg-backups
    repo1-s3-region=us-east-1
    repo1-path=/pgbackrest/$(hostname)

    [main]
    pg1-path=/var/lib/postgresql/data/pgdata
    pg1-host=localhost
    pg1-host-user=postgres
    EOF

    # Keep alive - the CronJob handles actual backups
    while true; do sleep 3600; done
  env:
  - name: PGPASSWORD
    valueFrom:
      secretKeyRef:
        name: postgres-credentials
        key: password
  volumeMounts:
  - name: data
    mountPath: /var/lib/postgresql/data
  - name: pgbackrest-config
    mountPath: /etc/pgbackrest
  resources:
    requests:
      cpu: "100m"
      memory: "256Mi"
    limits:
      cpu: "2"
      memory: "2Gi"
  securityContext:
    runAsUser: 999
    allowPrivilegeEscalation: false
```

### Backup CronJob

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: postgres-backup
  namespace: production
spec:
  schedule: "0 2 * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 7
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 2
      template:
        spec:
          restartPolicy: OnFailure
          serviceAccountName: postgres-backup-sa
          containers:
          - name: backup
            image: pgbackrest/pgbackrest:2.49
            command:
            - /bin/bash
            - -c
            - |
              set -e
              echo "Starting full backup at $(date)"
              pgbackrest --stanza=main \
                --config=/etc/pgbackrest/pgbackrest.conf \
                backup --type=full
              echo "Backup completed at $(date)"

              # Verify backup
              pgbackrest --stanza=main info
            env:
            - name: PGHOST
              value: postgres-0.postgres-headless.production.svc.cluster.local
            - name: PGUSER
              valueFrom:
                secretKeyRef:
                  name: postgres-credentials
                  key: username
            - name: PGPASSWORD
              valueFrom:
                secretKeyRef:
                  name: postgres-credentials
                  key: password
            volumeMounts:
            - name: pgbackrest-config
              mountPath: /etc/pgbackrest
            resources:
              requests:
                cpu: "500m"
                memory: "512Mi"
              limits:
                cpu: "4"
                memory: "4Gi"
          volumes:
          - name: pgbackrest-config
            configMap:
              name: pgbackrest-config
```

## Readiness Gates for Database Replication

Readiness gates allow pods to report custom conditions before being considered Ready:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
spec:
  template:
    spec:
      readinessGates:
      - conditionType: "postgres.database.io/replication-ready"
      containers:
      - name: postgres-replication-checker
        image: postgres:16
        command:
        - /bin/bash
        - -c
        - |
          while true; do
            POD_ORDINAL="${HOSTNAME##*-}"

            if [ "$POD_ORDINAL" = "0" ]; then
              # Primary: check if accepting writes
              if psql -U postgres -c "SELECT 1" > /dev/null 2>&1; then
                CONDITION='{"type":"postgres.database.io/replication-ready","status":"True"}'
              else
                CONDITION='{"type":"postgres.database.io/replication-ready","status":"False"}'
              fi
            else
              # Replica: check replication lag
              LAG=$(psql -U postgres -t -c \
                "SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::INT" \
                2>/dev/null | tr -d ' ')

              if [[ -n "$LAG" && "$LAG" -lt 60 ]]; then
                CONDITION='{"type":"postgres.database.io/replication-ready","status":"True"}'
              else
                CONDITION='{"type":"postgres.database.io/replication-ready","status":"False"}'
              fi
            fi

            # Update pod condition via Kubernetes API
            # (requires appropriate RBAC and implementation)
            sleep 30
          done
```

## Anti-Affinity Rules for High Availability

### Hard Anti-Affinity (different nodes mandatory)

```yaml
affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
    - labelSelector:
        matchExpressions:
        - key: app
          operator: In
          values:
          - postgres
      topologyKey: kubernetes.io/hostname
```

### Soft Anti-Affinity with Zone Spreading

```yaml
affinity:
  podAntiAffinity:
    # Hard: different nodes
    requiredDuringSchedulingIgnoredDuringExecution:
    - labelSelector:
        matchExpressions:
        - key: app
          operator: In
          values:
          - postgres
      topologyKey: kubernetes.io/hostname
    # Soft: prefer different zones
    preferredDuringSchedulingIgnoredDuringExecution:
    - weight: 100
      podAffinityTerm:
        labelSelector:
          matchExpressions:
          - key: app
            operator: In
            values:
            - postgres
        topologyKey: topology.kubernetes.io/zone
```

### TopologySpreadConstraints (preferred over pod anti-affinity)

```yaml
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

## Monitoring Database StatefulSets

### ServiceMonitor for Prometheus

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: postgres-metrics
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: postgres
  namespaceSelector:
    matchNames:
    - production
  endpoints:
  - port: metrics
    interval: 30s
    path: /metrics
    relabelings:
    - sourceLabels: [__meta_kubernetes_pod_name]
      targetLabel: pod
    - sourceLabels: [__meta_kubernetes_namespace]
      targetLabel: namespace
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: database-alerts
  namespace: monitoring
spec:
  groups:
  - name: postgres
    interval: 30s
    rules:
    - alert: PostgresDown
      expr: pg_up == 0
      for: 1m
      labels:
        severity: critical
      annotations:
        summary: "PostgreSQL pod {{ $labels.pod }} is down"

    - alert: PostgresReplicationLag
      expr: |
        pg_replication_lag > 60
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "PostgreSQL replication lag {{ $value }}s on {{ $labels.pod }}"

    - alert: PostgresHighConnections
      expr: |
        pg_stat_database_numbackends / pg_settings_max_connections > 0.8
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "PostgreSQL connections at {{ $value | humanizePercentage }} capacity"
```

## StatefulSet Operational Runbook

### Scaling Down Safely

```bash
#!/bin/bash
# scale-down-statefulset.sh
NAMESPACE="production"
STS_NAME="postgres"
TARGET_REPLICAS=$1

CURRENT=$(kubectl get statefulset "$STS_NAME" -n "$NAMESPACE" \
  -o jsonpath='{.spec.replicas}')

echo "Current replicas: $CURRENT"
echo "Target replicas: $TARGET_REPLICAS"

if [ "$TARGET_REPLICAS" -ge "$CURRENT" ]; then
  echo "Target >= current, use scale-up procedure"
  exit 1
fi

# Check PDB allows the reduction
PDB=$(kubectl get pdb -n "$NAMESPACE" -o json | \
  jq -r ".items[] | select(.spec.selector.matchLabels.app == \"$STS_NAME\") | .metadata.name")

if [ -n "$PDB" ]; then
  ALLOWED=$(kubectl get pdb "$PDB" -n "$NAMESPACE" \
    -o jsonpath='{.status.disruptionsAllowed}')
  REDUCTION=$((CURRENT - TARGET_REPLICAS))

  if [ "$REDUCTION" -gt "$ALLOWED" ]; then
    echo "ERROR: PDB allows only $ALLOWED disruptions but scaling requires $REDUCTION"
    echo "Consider updating PDB minAvailable before scaling"
    exit 1
  fi
fi

# Scale down one at a time
PODS_TO_REMOVE=$((CURRENT - TARGET_REPLICAS))
for i in $(seq 1 $PODS_TO_REMOVE); do
  NEW_REPLICAS=$((CURRENT - i))
  echo "Scaling to $NEW_REPLICAS replicas..."
  kubectl scale statefulset "$STS_NAME" -n "$NAMESPACE" --replicas="$NEW_REPLICAS"
  kubectl rollout status statefulset/"$STS_NAME" -n "$NAMESPACE"

  # Verify data integrity after each scale-down
  REMAINING_POD="${STS_NAME}-0"
  kubectl exec -n "$NAMESPACE" "$REMAINING_POD" -- pg_isready -U postgres || {
    echo "ERROR: Remaining pod not healthy after scale-down"
    exit 1
  }
done

echo "Scale-down complete. Remember to verify PVC cleanup per retention policy."
```

StatefulSets provide the foundation for running databases reliably on Kubernetes. The patterns covered here—ordered initialization, headless service DNS, sidecar backup agents, PodDisruptionBudgets, and topology-aware scheduling—collectively address the operational challenges that make database containerization viable in production. The key insight is that Kubernetes does not manage replication or failover; it manages pod scheduling and lifecycle. The database software is still responsible for its own consistency guarantees, and Kubernetes infrastructure must be configured to support those guarantees rather than work against them.
