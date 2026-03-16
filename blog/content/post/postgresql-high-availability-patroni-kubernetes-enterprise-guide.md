---
title: "PostgreSQL High Availability with Patroni and Kubernetes: Enterprise Production Guide"
date: 2026-10-23T00:00:00-05:00
draft: false
tags: ["PostgreSQL", "Patroni", "Kubernetes", "High Availability", "StatefulSets", "Database", "HA", "Enterprise", "Production"]
categories: ["Database Administration", "Kubernetes", "High Availability", "PostgreSQL"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive enterprise guide to implementing PostgreSQL high availability using Patroni on Kubernetes, including StatefulSets configuration, failover scenarios, persistent volumes, monitoring strategies, and performance tuning for production environments."
more_link: "yes"
url: "/postgresql-high-availability-patroni-kubernetes-enterprise-guide/"
---

## Executive Summary

PostgreSQL high availability (HA) is critical for enterprise applications requiring minimal downtime and data consistency. This comprehensive guide explores implementing production-grade PostgreSQL HA using Patroni on Kubernetes, providing automatic failover, seamless cluster management, and enterprise-level reliability.

### Key Architecture Components

**Patroni**: A template for PostgreSQL HA with ZooKeeper, etcd, or Consul for distributed configuration storage and leader election, providing automatic failover and cluster management capabilities.

**Kubernetes StatefulSets**: Ordered, stable network identities and persistent storage for PostgreSQL instances, ensuring data persistence and predictable pod management.

**Persistent Volumes**: Enterprise-grade storage solutions with appropriate performance characteristics for database workloads, supporting synchronous replication and point-in-time recovery.

**Monitoring Stack**: Comprehensive observability with Prometheus, Grafana, and custom alerting for proactive issue detection and performance optimization.

<!--more-->

## PostgreSQL HA Architecture Overview

### High Availability Components

```yaml
# patroni-architecture.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: patroni-architecture
  namespace: postgres-ha
data:
  architecture: |
    ┌─────────────────────────────────────────────────────────────┐
    │                    Kubernetes Cluster                        │
    ├─────────────────────────────────────────────────────────────┤
    │                                                              │
    │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
    │  │ PostgreSQL-0 │  │ PostgreSQL-1 │  │ PostgreSQL-2 │     │
    │  │   (Leader)   │  │  (Replica)   │  │  (Replica)   │     │
    │  │   Patroni    │  │   Patroni    │  │   Patroni    │     │
    │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘     │
    │         │                  │                  │              │
    │         └──────────────────┴──────────────────┘              │
    │                           │                                  │
    │                    ┌──────┴──────┐                          │
    │                    │    etcd     │                          │
    │                    │  Cluster    │                          │
    │                    └─────────────┘                          │
    │                                                              │
    │  ┌────────────────────────────────────────────────────┐    │
    │  │           Persistent Volume Claims                   │    │
    │  │  ┌──────────┐  ┌──────────┐  ┌──────────┐        │    │
    │  │  │  PVC-0   │  │  PVC-1   │  │  PVC-2   │        │    │
    │  │  └──────────┘  └──────────┘  └──────────┘        │    │
    │  └────────────────────────────────────────────────────┘    │
    │                                                              │
    │  ┌────────────────────────────────────────────────────┐    │
    │  │              Service Discovery                      │    │
    │  │  ┌──────────────┐        ┌────────────────┐      │    │
    │  │  │ Leader Service│        │Replica Service │      │    │
    │  │  └──────────────┘        └────────────────┘      │    │
    │  └────────────────────────────────────────────────────┘    │
    └─────────────────────────────────────────────────────────────┘
```

### Patroni Configuration

Implementing enterprise-grade Patroni configuration for production environments:

```yaml
# patroni-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: patroni-config
  namespace: postgres-ha
data:
  patroni.yml: |
    scope: postgres-cluster
    namespace: /db/
    name: "{POD_NAME}"

    restapi:
      listen: 0.0.0.0:8008
      connect_address: "{POD_IP}:8008"
      authentication:
        username: patroni
        password: "{PATRONI_PASSWORD}"
      https:
        certfile: /etc/patroni/certs/server.crt
        keyfile: /etc/patroni/certs/server.key
        cafile: /etc/patroni/certs/ca.crt

    etcd3:
      hosts:
        - etcd-0.etcd-headless.postgres-ha.svc.cluster.local:2379
        - etcd-1.etcd-headless.postgres-ha.svc.cluster.local:2379
        - etcd-2.etcd-headless.postgres-ha.svc.cluster.local:2379
      protocol: https
      cacert: /etc/patroni/etcd-certs/ca.crt
      cert: /etc/patroni/etcd-certs/client.crt
      key: /etc/patroni/etcd-certs/client.key

    bootstrap:
      dcs:
        ttl: 30
        loop_wait: 10
        retry_timeout: 10
        maximum_lag_on_failover: 33554432  # 32MB
        maximum_lag_on_syncnode: 33554432
        master_start_timeout: 300
        synchronous_mode: true
        synchronous_mode_strict: true
        postgresql:
          use_pg_rewind: true
          use_slots: true
          parameters:
            max_connections: 200
            shared_buffers: 2GB
            effective_cache_size: 6GB
            maintenance_work_mem: 512MB
            checkpoint_completion_target: 0.9
            wal_buffers: 16MB
            default_statistics_target: 100
            random_page_cost: 1.1
            effective_io_concurrency: 200
            work_mem: 10485kB
            min_wal_size: 1GB
            max_wal_size: 4GB
            max_worker_processes: 8
            max_parallel_workers_per_gather: 4
            max_parallel_workers: 8
            max_parallel_maintenance_workers: 4
            wal_level: replica
            hot_standby: "on"
            wal_log_hints: "on"
            max_wal_senders: 10
            max_replication_slots: 10
            hot_standby_feedback: "on"
            wal_compression: "on"
            shared_preload_libraries: 'pg_stat_statements,auto_explain'
            pg_stat_statements.max: 10000
            pg_stat_statements.track: all
            auto_explain.log_min_duration: '10s'
            auto_explain.log_analyze: true
            auto_explain.log_buffers: true
            log_line_prefix: '%t [%p] %u@%d '
            log_checkpoints: "on"
            log_connections: "on"
            log_disconnections: "on"
            log_lock_waits: "on"
            log_temp_files: 0
            log_autovacuum_min_duration: 0
            log_error_verbosity: default

      initdb:
        - encoding: UTF8
        - data-checksums
        - locale: en_US.UTF-8

      pg_hba:
        - local all all trust
        - host all all 127.0.0.1/32 trust
        - host all all ::1/128 trust
        - local replication replicator trust
        - host replication replicator 127.0.0.1/32 trust
        - host replication replicator ::1/128 trust
        - host replication replicator 10.0.0.0/8 md5
        - host all all 10.0.0.0/8 md5
        - hostssl all all 0.0.0.0/0 md5

      users:
        admin:
          password: "{ADMIN_PASSWORD}"
          options:
            - createrole
            - createdb
        replicator:
          password: "{REPLICATOR_PASSWORD}"
          options:
            - replication

    postgresql:
      listen: 0.0.0.0:5432
      connect_address: "{POD_IP}:5432"
      data_dir: /var/lib/postgresql/data/pgdata
      bin_dir: /usr/lib/postgresql/14/bin
      authentication:
        replication:
          username: replicator
          password: "{REPLICATOR_PASSWORD}"
        superuser:
          username: postgres
          password: "{POSTGRES_PASSWORD}"
        rewind:
          username: replicator
          password: "{REPLICATOR_PASSWORD}"
      
      callbacks:
        on_start: /scripts/on_start.sh
        on_stop: /scripts/on_stop.sh
        on_role_change: /scripts/on_role_change.sh

      create_replica_methods:
        - basebackup
        - pg_rewind
      
      basebackup:
        max_rate: 100M
        checkpoint: fast
        walmethod: stream

    watchdog:
      mode: automatic
      device: /dev/watchdog
      safety_margin: 5

    tags:
      nofailover: false
      noloadbalance: false
      clonefrom: false
      nosync: false
```

## Kubernetes StatefulSet Implementation

### StatefulSet Configuration

Implementing PostgreSQL with Patroni as a StatefulSet for ordered deployment and stable network identities:

```yaml
# postgres-statefulset.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres-patroni
  namespace: postgres-ha
  labels:
    app: postgres
    cluster-name: postgres-cluster
spec:
  serviceName: postgres-headless
  replicas: 3
  selector:
    matchLabels:
      app: postgres
      cluster-name: postgres-cluster
  template:
    metadata:
      labels:
        app: postgres
        cluster-name: postgres-cluster
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9187"
        prometheus.io/path: "/metrics"
    spec:
      serviceAccountName: postgres-sa
      securityContext:
        fsGroup: 999
        runAsUser: 999
        runAsNonRoot: true
      
      initContainers:
      - name: setup-scripts
        image: busybox:1.35
        command:
        - sh
        - -c
        - |
          cat > /scripts/on_start.sh << 'EOF'
          #!/bin/bash
          echo "$(date) - PostgreSQL instance starting" >> /var/log/patroni/callbacks.log
          EOF
          
          cat > /scripts/on_stop.sh << 'EOF'
          #!/bin/bash
          echo "$(date) - PostgreSQL instance stopping" >> /var/log/patroni/callbacks.log
          # Perform cleanup tasks
          pg_ctl stop -D $PGDATA -m fast -w
          EOF
          
          cat > /scripts/on_role_change.sh << 'EOF'
          #!/bin/bash
          echo "$(date) - Role changed to $1" >> /var/log/patroni/callbacks.log
          if [ "$1" == "master" ]; then
              # Promote to primary
              echo "Promoted to primary" >> /var/log/patroni/callbacks.log
              # Update monitoring labels
              curl -X PUT http://localhost:9187/metrics/role -d "primary"
          else
              # Demote to replica
              echo "Demoted to replica" >> /var/log/patroni/callbacks.log
              curl -X PUT http://localhost:9187/metrics/role -d "replica"
          fi
          EOF
          
          chmod +x /scripts/*.sh
        volumeMounts:
        - name: callback-scripts
          mountPath: /scripts
      
      containers:
      - name: postgres
        image: postgres:14-alpine
        imagePullPolicy: Always
        ports:
        - containerPort: 5432
          name: postgres
          protocol: TCP
        - containerPort: 8008
          name: patroni-api
          protocol: TCP
        env:
        - name: PGVERSION
          value: "14"
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-secrets
              key: superuser-password
        - name: PATRONI_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-secrets
              key: patroni-password
        - name: REPLICATOR_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-secrets
              key: replication-password
        - name: ADMIN_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-secrets
              key: admin-password
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        - name: POD_IP
          valueFrom:
            fieldRef:
              fieldPath: status.podIP
        - name: POD_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace
        
        command:
        - /bin/bash
        - -c
        - |
          # Install Patroni and dependencies
          apk add --no-cache python3 py3-pip py3-psycopg2 py3-yaml
          pip3 install patroni[etcd3] psycopg2-binary
          
          # Start Patroni
          exec patroni /etc/patroni/patroni.yml
        
        resources:
          requests:
            cpu: 1000m
            memory: 2Gi
          limits:
            cpu: 4000m
            memory: 8Gi
        
        livenessProbe:
          httpGet:
            path: /health
            port: 8008
            scheme: HTTPS
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
        
        readinessProbe:
          httpGet:
            path: /readiness
            port: 8008
            scheme: HTTPS
          initialDelaySeconds: 10
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
        
        volumeMounts:
        - name: postgres-data
          mountPath: /var/lib/postgresql/data
        - name: patroni-config
          mountPath: /etc/patroni
        - name: callback-scripts
          mountPath: /scripts
        - name: patroni-certs
          mountPath: /etc/patroni/certs
        - name: etcd-certs
          mountPath: /etc/patroni/etcd-certs
        - name: postgres-config
          mountPath: /etc/postgresql
        - name: patroni-logs
          mountPath: /var/log/patroni
      
      - name: postgres-exporter
        image: prometheuscommunity/postgres-exporter:v0.13.2
        ports:
        - containerPort: 9187
          name: metrics
          protocol: TCP
        env:
        - name: DATA_SOURCE_NAME
          value: "postgresql://postgres:$(POSTGRES_PASSWORD)@localhost:5432/postgres?sslmode=require"
        - name: PG_EXPORTER_DISABLE_DEFAULT_METRICS
          value: "false"
        - name: PG_EXPORTER_DISABLE_SETTINGS_METRICS
          value: "false"
        - name: PG_EXPORTER_AUTO_DISCOVER_DATABASES
          value: "true"
        - name: PG_EXPORTER_EXCLUDE_DATABASES
          value: "template0,template1"
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
      
      - name: log-collector
        image: fluent/fluent-bit:2.1
        volumeMounts:
        - name: patroni-logs
          mountPath: /var/log/patroni
        - name: fluentbit-config
          mountPath: /fluent-bit/etc
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
      
      volumes:
      - name: patroni-config
        configMap:
          name: patroni-config
      - name: callback-scripts
        emptyDir: {}
      - name: patroni-certs
        secret:
          secretName: patroni-tls
          defaultMode: 0400
      - name: etcd-certs
        secret:
          secretName: etcd-client-tls
          defaultMode: 0400
      - name: postgres-config
        configMap:
          name: postgres-config
      - name: patroni-logs
        emptyDir: {}
      - name: fluentbit-config
        configMap:
          name: fluentbit-config
      
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
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            preference:
              matchExpressions:
              - key: node-role.kubernetes.io/database
                operator: Exists
      
      tolerations:
      - key: "database"
        operator: "Equal"
        value: "postgres"
        effect: "NoSchedule"
  
  volumeClaimTemplates:
  - metadata:
      name: postgres-data
      labels:
        app: postgres
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: fast-ssd
      resources:
        requests:
          storage: 100Gi
```

## Persistent Volume Strategy

### Storage Class Configuration

Implementing high-performance storage for PostgreSQL workloads:

```yaml
# storage-class.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-ssd
  labels:
    app: postgres
provisioner: kubernetes.io/aws-ebs
parameters:
  type: io2
  iopsPerGB: "50"
  fsType: ext4
  encrypted: "true"
  kmsKeyId: "arn:aws:kms:region:account-id:key/key-id"
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Retain
mountOptions:
  - noatime
  - nodiratime
  - nobarrier

---
# Advanced NVMe Storage Class for Ultra-High Performance
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: nvme-local
  labels:
    app: postgres
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Delete

---
# Persistent Volume for Local NVMe
apiVersion: v1
kind: PersistentVolume
metadata:
  name: postgres-nvme-pv-0
  labels:
    app: postgres
    node: node-0
spec:
  capacity:
    storage: 1Ti
  volumeMode: Filesystem
  accessModes:
  - ReadWriteOnce
  persistentVolumeReclaimPolicy: Delete
  storageClassName: nvme-local
  local:
    path: /mnt/nvme0
  nodeAffinity:
    required:
      nodeSelectorTerms:
      - matchExpressions:
        - key: kubernetes.io/hostname
          operator: In
          values:
          - node-0
```

### Backup and Recovery Strategy

Implementing comprehensive backup and recovery with WAL archiving:

```yaml
# backup-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: postgres-backup
  namespace: postgres-ha
spec:
  schedule: "0 2 * * *"  # Daily at 2 AM
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        metadata:
          labels:
            app: postgres-backup
        spec:
          serviceAccountName: postgres-backup-sa
          containers:
          - name: backup
            image: postgres:14-alpine
            env:
            - name: PGHOST
              value: postgres-primary.postgres-ha.svc.cluster.local
            - name: PGPORT
              value: "5432"
            - name: PGUSER
              value: postgres
            - name: PGPASSWORD
              valueFrom:
                secretKeyRef:
                  name: postgres-secrets
                  key: superuser-password
            - name: S3_BUCKET
              value: postgres-backups
            - name: AWS_REGION
              value: us-east-1
            command:
            - /bin/bash
            - -c
            - |
              set -euo pipefail
              
              # Install required tools
              apk add --no-cache aws-cli pigz
              
              # Set backup timestamp
              TIMESTAMP=$(date +%Y%m%d_%H%M%S)
              BACKUP_NAME="postgres_backup_${TIMESTAMP}"
              
              # Perform backup
              echo "Starting backup: ${BACKUP_NAME}"
              
              # Create backup directory
              mkdir -p /backup/${BACKUP_NAME}
              
              # Backup globals
              pg_dumpall --globals-only > /backup/${BACKUP_NAME}/globals.sql
              
              # Get list of databases
              DATABASES=$(psql -t -c "SELECT datname FROM pg_database WHERE datistemplate = false AND datname != 'postgres';")
              
              # Backup each database
              for DB in $DATABASES; do
                echo "Backing up database: $DB"
                pg_dump -Fc -j 4 -d $DB -f /backup/${BACKUP_NAME}/${DB}.dump
              done
              
              # Backup WAL archives
              echo "Backing up WAL archives"
              pg_basebackup -D /backup/${BACKUP_NAME}/basebackup -Ft -z -P
              
              # Compress backup
              echo "Compressing backup"
              cd /backup
              tar -cf - ${BACKUP_NAME} | pigz -9 > ${BACKUP_NAME}.tar.gz
              
              # Upload to S3
              echo "Uploading to S3"
              aws s3 cp ${BACKUP_NAME}.tar.gz s3://${S3_BUCKET}/backups/${BACKUP_NAME}.tar.gz \
                --storage-class GLACIER_IR \
                --server-side-encryption AES256
              
              # Verify upload
              aws s3api head-object --bucket ${S3_BUCKET} --key backups/${BACKUP_NAME}.tar.gz
              
              # Cleanup local files
              rm -rf /backup/*
              
              echo "Backup completed successfully"
              
              # Update metrics
              curl -X POST http://prometheus-pushgateway:9091/metrics/job/postgres_backup \
                -d "postgres_backup_success{database=\"all\"} 1" \
                -d "postgres_backup_timestamp{database=\"all\"} $(date +%s)" \
                -d "postgres_backup_size_bytes{database=\"all\"} $(stat -c%s ${BACKUP_NAME}.tar.gz)"
            
            resources:
              requests:
                cpu: 500m
                memory: 1Gi
              limits:
                cpu: 2000m
                memory: 4Gi
            
            volumeMounts:
            - name: backup-storage
              mountPath: /backup
          
          volumes:
          - name: backup-storage
            emptyDir:
              sizeLimit: 100Gi
          
          restartPolicy: OnFailure
```

## Failover Scenarios and Testing

### Automated Failover Testing

Implementing chaos engineering for PostgreSQL HA validation:

```go
// failover-test.go
package main

import (
    "context"
    "database/sql"
    "fmt"
    "log"
    "time"
    
    _ "github.com/lib/pq"
    v1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/rest"
)

type FailoverTest struct {
    k8sClient   *kubernetes.Clientset
    db          *sql.DB
    namespace   string
    clusterName string
}

func NewFailoverTest(namespace, clusterName string) (*FailoverTest, error) {
    // Create k8s client
    config, err := rest.InClusterConfig()
    if err != nil {
        return nil, err
    }
    
    clientset, err := kubernetes.NewForConfig(config)
    if err != nil {
        return nil, err
    }
    
    // Connect to PostgreSQL
    connStr := fmt.Sprintf(
        "host=postgres-primary.%s.svc.cluster.local "+
        "port=5432 user=postgres password=%s dbname=postgres sslmode=require",
        namespace, getEnv("POSTGRES_PASSWORD", ""))
    
    db, err := sql.Open("postgres", connStr)
    if err != nil {
        return nil, err
    }
    
    return &FailoverTest{
        k8sClient:   clientset,
        db:          db,
        namespace:   namespace,
        clusterName: clusterName,
    }, nil
}

// TestPlannedFailover tests a planned failover scenario
func (ft *FailoverTest) TestPlannedFailover() error {
    log.Println("Starting planned failover test")
    
    // Get current primary
    primary, err := ft.getCurrentPrimary()
    if err != nil {
        return fmt.Errorf("failed to get current primary: %w", err)
    }
    log.Printf("Current primary: %s", primary)
    
    // Start write workload
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()
    
    writeErrors := make(chan error, 100)
    go ft.continuousWrites(ctx, writeErrors)
    
    // Wait for writes to stabilize
    time.Sleep(10 * time.Second)
    
    // Trigger failover via Patroni API
    if err := ft.triggerFailover(primary); err != nil {
        return fmt.Errorf("failed to trigger failover: %w", err)
    }
    
    // Monitor failover completion
    start := time.Now()
    newPrimary, err := ft.waitForNewPrimary(primary, 60*time.Second)
    if err != nil {
        return fmt.Errorf("failover did not complete: %w", err)
    }
    
    failoverTime := time.Since(start)
    log.Printf("Failover completed in %v. New primary: %s", failoverTime, newPrimary)
    
    // Check for write errors during failover
    cancel()
    close(writeErrors)
    
    errorCount := 0
    for err := range writeErrors {
        if err != nil {
            errorCount++
            log.Printf("Write error during failover: %v", err)
        }
    }
    
    log.Printf("Failover test completed. Total write errors: %d", errorCount)
    
    // Verify data consistency
    if err := ft.verifyDataConsistency(); err != nil {
        return fmt.Errorf("data consistency check failed: %w", err)
    }
    
    return nil
}

// TestUnplannedFailover simulates an unplanned primary failure
func (ft *FailoverTest) TestUnplannedFailover() error {
    log.Println("Starting unplanned failover test")
    
    // Get current primary
    primary, err := ft.getCurrentPrimary()
    if err != nil {
        return fmt.Errorf("failed to get current primary: %w", err)
    }
    log.Printf("Current primary: %s", primary)
    
    // Start write workload
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()
    
    writeErrors := make(chan error, 100)
    go ft.continuousWrites(ctx, writeErrors)
    
    // Wait for writes to stabilize
    time.Sleep(10 * time.Second)
    
    // Kill primary pod
    log.Printf("Killing primary pod: %s", primary)
    err = ft.k8sClient.CoreV1().Pods(ft.namespace).Delete(
        context.TODO(), primary, metav1.DeleteOptions{})
    if err != nil {
        return fmt.Errorf("failed to delete pod: %w", err)
    }
    
    // Monitor automatic failover
    start := time.Now()
    newPrimary, err := ft.waitForNewPrimary(primary, 120*time.Second)
    if err != nil {
        return fmt.Errorf("automatic failover did not complete: %w", err)
    }
    
    failoverTime := time.Since(start)
    log.Printf("Automatic failover completed in %v. New primary: %s", 
        failoverTime, newPrimary)
    
    // Analyze write errors
    cancel()
    close(writeErrors)
    
    errorCount := 0
    var firstErrorTime, lastErrorTime time.Time
    for err := range writeErrors {
        if err != nil {
            if errorCount == 0 {
                firstErrorTime = time.Now()
            }
            lastErrorTime = time.Now()
            errorCount++
        }
    }
    
    if errorCount > 0 {
        downtime := lastErrorTime.Sub(firstErrorTime)
        log.Printf("Application experienced %v downtime with %d errors", 
            downtime, errorCount)
    }
    
    return nil
}

// continuousWrites performs continuous write operations
func (ft *FailoverTest) continuousWrites(ctx context.Context, errors chan<- error) {
    ticker := time.NewTicker(100 * time.Millisecond)
    defer ticker.Stop()
    
    counter := 0
    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            counter++
            _, err := ft.db.Exec(
                "INSERT INTO failover_test (id, timestamp, data) VALUES ($1, $2, $3)",
                counter, time.Now(), fmt.Sprintf("test-data-%d", counter))
            
            if err != nil {
                errors <- err
                // Try to reconnect
                ft.reconnectDB()
            } else {
                errors <- nil
            }
        }
    }
}

// Network partition test
func (ft *FailoverTest) TestNetworkPartition() error {
    log.Println("Starting network partition test")
    
    // Get all PostgreSQL pods
    pods, err := ft.k8sClient.CoreV1().Pods(ft.namespace).List(
        context.TODO(), metav1.ListOptions{
            LabelSelector: "app=postgres",
        })
    if err != nil {
        return err
    }
    
    // Apply network policy to isolate primary
    primary, _ := ft.getCurrentPrimary()
    networkPolicy := &v1.NetworkPolicy{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "postgres-partition",
            Namespace: ft.namespace,
        },
        Spec: v1.NetworkPolicySpec{
            PodSelector: metav1.LabelSelector{
                MatchLabels: map[string]string{
                    "statefulset.kubernetes.io/pod-name": primary,
                },
            },
            PolicyTypes: []v1.PolicyType{
                v1.PolicyTypeIngress,
                v1.PolicyTypeEgress,
            },
            Ingress: []v1.NetworkPolicyIngressRule{},
            Egress:  []v1.NetworkPolicyEgressRule{},
        },
    }
    
    // Apply network partition
    _, err = ft.k8sClient.NetworkingV1().NetworkPolicies(ft.namespace).Create(
        context.TODO(), networkPolicy, metav1.CreateOptions{})
    if err != nil {
        return err
    }
    
    // Monitor split-brain prevention
    time.Sleep(30 * time.Second)
    
    // Remove network partition
    err = ft.k8sClient.NetworkingV1().NetworkPolicies(ft.namespace).Delete(
        context.TODO(), "postgres-partition", metav1.DeleteOptions{})
    if err != nil {
        return err
    }
    
    // Verify cluster state
    return ft.verifyClusterHealth()
}
```

## Monitoring and Alerting

### Prometheus Configuration

Comprehensive monitoring setup for PostgreSQL HA:

```yaml
# prometheus-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: postgres-ha-rules
  namespace: postgres-ha
spec:
  groups:
  - name: postgres.availability
    interval: 30s
    rules:
    - alert: PostgreSQLDown
      expr: up{job="postgres"} == 0
      for: 1m
      labels:
        severity: critical
        team: database
      annotations:
        summary: "PostgreSQL instance {{ $labels.instance }} is down"
        description: "PostgreSQL instance {{ $labels.instance }} has been down for more than 1 minute"
        
    - alert: PostgreSQLReplicationLag
      expr: pg_replication_lag > 10
      for: 5m
      labels:
        severity: warning
        team: database
      annotations:
        summary: "PostgreSQL replication lag is high"
        description: "PostgreSQL replica {{ $labels.instance }} has replication lag of {{ $value }} seconds"
        
    - alert: PostgreSQLReplicationBroken
      expr: pg_stat_replication_pg_wal_lsn_diff > 1073741824  # 1GB
      for: 5m
      labels:
        severity: critical
        team: database
      annotations:
        summary: "PostgreSQL replication is broken"
        description: "PostgreSQL replication for {{ $labels.application_name }} is {{ $value | humanize }}B behind"
        
    - alert: PostgreSQLHighConnections
      expr: sum(pg_stat_activity_count) by (instance) > 150
      for: 5m
      labels:
        severity: warning
        team: database
      annotations:
        summary: "PostgreSQL has high number of connections"
        description: "PostgreSQL instance {{ $labels.instance }} has {{ $value }} connections (threshold: 150)"
        
    - alert: PostgreSQLSlowQueries
      expr: rate(pg_stat_statements_mean_time_seconds[5m]) > 1
      for: 10m
      labels:
        severity: warning
        team: database
      annotations:
        summary: "PostgreSQL has slow queries"
        description: "PostgreSQL instance {{ $labels.instance }} has queries with average execution time > 1s"
        
    - alert: PostgreSQLDeadlocks
      expr: increase(pg_stat_database_deadlocks[1h]) > 5
      for: 0m
      labels:
        severity: warning
        team: database
      annotations:
        summary: "PostgreSQL has deadlocks"
        description: "PostgreSQL instance {{ $labels.instance }} has {{ $value }} deadlocks in the last hour"
        
    - alert: PostgreSQLHighRollbackRate
      expr: rate(pg_stat_database_xact_rollback[15m]) / rate(pg_stat_database_xact_commit[15m]) > 0.1
      for: 15m
      labels:
        severity: warning
        team: database
      annotations:
        summary: "PostgreSQL has high rollback rate"
        description: "PostgreSQL instance {{ $labels.instance }} has rollback ratio of {{ $value | humanizePercentage }}"
        
    - alert: PostgreSQLCacheHitRatio
      expr: pg_stat_database_blks_hit / (pg_stat_database_blks_hit + pg_stat_database_blks_read) < 0.9
      for: 15m
      labels:
        severity: warning
        team: database
      annotations:
        summary: "PostgreSQL cache hit ratio is low"
        description: "PostgreSQL instance {{ $labels.instance }} has cache hit ratio of {{ $value | humanizePercentage }}"
        
    - alert: PatroniClusterNotHealthy
      expr: patroni_cluster_unlocked == 1
      for: 1m
      labels:
        severity: critical
        team: database
      annotations:
        summary: "Patroni cluster is not healthy"
        description: "Patroni cluster {{ $labels.cluster }} is unlocked, indicating no leader"
        
    - alert: PatroniNodeNotRunning
      expr: patroni_postgres_running == 0
      for: 1m
      labels:
        severity: critical
        team: database
      annotations:
        summary: "Patroni node PostgreSQL is not running"
        description: "PostgreSQL on Patroni node {{ $labels.instance }} is not running"

  - name: postgres.performance
    interval: 60s
    rules:
    - alert: PostgreSQLHighIOWait
      expr: rate(pg_stat_bgwriter_checkpoint_sync_time[5m]) > 1000
      for: 10m
      labels:
        severity: warning
        team: database
      annotations:
        summary: "PostgreSQL has high IO wait"
        description: "PostgreSQL instance {{ $labels.instance }} checkpoint sync time is {{ $value }}ms"
        
    - alert: PostgreSQLTableBloat
      expr: pg_stat_user_tables_n_dead_tup / (pg_stat_user_tables_n_live_tup + pg_stat_user_tables_n_dead_tup) > 0.2
      for: 30m
      labels:
        severity: warning
        team: database
      annotations:
        summary: "PostgreSQL table has high bloat"
        description: "Table {{ $labels.schemaname }}.{{ $labels.tablename }} has {{ $value | humanizePercentage }} dead tuples"
        
    - alert: PostgreSQLVacuumNeeded
      expr: time() - pg_stat_user_tables_last_autovacuum > 604800  # 7 days
      for: 0m
      labels:
        severity: warning
        team: database
      annotations:
        summary: "PostgreSQL table needs vacuum"
        description: "Table {{ $labels.schemaname }}.{{ $labels.tablename }} hasn't been vacuumed in {{ $value | humanizeDuration }}"
```

### Grafana Dashboard Configuration

Creating comprehensive monitoring dashboards:

```json
{
  "dashboard": {
    "title": "PostgreSQL HA with Patroni",
    "panels": [
      {
        "title": "Cluster Status",
        "gridPos": {"h": 8, "w": 12, "x": 0, "y": 0},
        "targets": [
          {
            "expr": "patroni_postgres_running",
            "legendFormat": "{{ instance }} - Running"
          },
          {
            "expr": "patroni_master",
            "legendFormat": "{{ instance }} - Is Master"
          }
        ]
      },
      {
        "title": "Replication Lag",
        "gridPos": {"h": 8, "w": 12, "x": 12, "y": 0},
        "targets": [
          {
            "expr": "pg_replication_lag",
            "legendFormat": "{{ instance }} - Lag (seconds)"
          }
        ]
      },
      {
        "title": "Connection Pool",
        "gridPos": {"h": 8, "w": 12, "x": 0, "y": 8},
        "targets": [
          {
            "expr": "pg_stat_activity_count",
            "legendFormat": "{{ instance }} - {{ state }}"
          }
        ]
      },
      {
        "title": "Transaction Rate",
        "gridPos": {"h": 8, "w": 12, "x": 12, "y": 8},
        "targets": [
          {
            "expr": "rate(pg_stat_database_xact_commit[5m])",
            "legendFormat": "{{ instance }} - Commits/sec"
          },
          {
            "expr": "rate(pg_stat_database_xact_rollback[5m])",
            "legendFormat": "{{ instance }} - Rollbacks/sec"
          }
        ]
      },
      {
        "title": "Cache Hit Ratio",
        "gridPos": {"h": 8, "w": 12, "x": 0, "y": 16},
        "targets": [
          {
            "expr": "pg_stat_database_blks_hit / (pg_stat_database_blks_hit + pg_stat_database_blks_read)",
            "legendFormat": "{{ instance }} - {{ datname }}"
          }
        ]
      },
      {
        "title": "Disk I/O",
        "gridPos": {"h": 8, "w": 12, "x": 12, "y": 16},
        "targets": [
          {
            "expr": "rate(pg_stat_bgwriter_buffers_checkpoint[5m])",
            "legendFormat": "{{ instance }} - Checkpoint Buffers/sec"
          },
          {
            "expr": "rate(pg_stat_bgwriter_buffers_backend[5m])",
            "legendFormat": "{{ instance }} - Backend Buffers/sec"
          }
        ]
      }
    ]
  }
}
```

## Performance Tuning for HA Environments

### Connection Pooling with PgBouncer

Implementing connection pooling for improved performance:

```yaml
# pgbouncer-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pgbouncer
  namespace: postgres-ha
spec:
  replicas: 3
  selector:
    matchLabels:
      app: pgbouncer
  template:
    metadata:
      labels:
        app: pgbouncer
    spec:
      containers:
      - name: pgbouncer
        image: pgbouncer/pgbouncer:1.20.1
        ports:
        - containerPort: 6432
          name: pgbouncer
        env:
        - name: DATABASES_HOST
          value: postgres-primary.postgres-ha.svc.cluster.local
        - name: DATABASES_PORT
          value: "5432"
        - name: DATABASES_USER
          value: postgres
        - name: DATABASES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-secrets
              key: superuser-password
        - name: POOL_MODE
          value: transaction
        - name: MAX_CLIENT_CONN
          value: "1000"
        - name: DEFAULT_POOL_SIZE
          value: "25"
        - name: RESERVE_POOL_SIZE
          value: "5"
        - name: RESERVE_POOL_TIMEOUT
          value: "3"
        - name: SERVER_LIFETIME
          value: "3600"
        - name: SERVER_IDLE_TIMEOUT
          value: "600"
        
        volumeMounts:
        - name: pgbouncer-config
          mountPath: /etc/pgbouncer
        
        livenessProbe:
          tcpSocket:
            port: 6432
          initialDelaySeconds: 10
          periodSeconds: 10
        
        readinessProbe:
          tcpSocket:
            port: 6432
          initialDelaySeconds: 5
          periodSeconds: 5
        
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
      
      volumes:
      - name: pgbouncer-config
        configMap:
          name: pgbouncer-config

---
apiVersion: v1
kind: ConfigMap
metadata:
  name: pgbouncer-config
  namespace: postgres-ha
data:
  pgbouncer.ini: |
    [databases]
    * = host=postgres-primary.postgres-ha.svc.cluster.local port=5432 auth_user=pgbouncer
    
    [pgbouncer]
    listen_port = 6432
    listen_addr = *
    auth_type = md5
    auth_file = /etc/pgbouncer/userlist.txt
    auth_user = pgbouncer
    auth_query = SELECT usename, passwd FROM pg_shadow WHERE usename=$1
    
    pool_mode = transaction
    server_reset_query = DISCARD ALL
    server_check_query = SELECT 1
    server_check_delay = 30
    
    max_client_conn = 1000
    default_pool_size = 25
    min_pool_size = 5
    reserve_pool_size = 5
    reserve_pool_timeout = 3
    
    server_lifetime = 3600
    server_idle_timeout = 600
    server_connect_timeout = 15
    server_login_retry = 15
    
    client_login_timeout = 60
    client_idle_timeout = 0
    
    stats_period = 60
    stats_users = stats, postgres
    
    ignore_startup_parameters = extra_float_digits
    
    # Performance tuning
    pkt_buf = 4096
    max_packet_size = 2147483647
    listen_backlog = 256
    sbuf_loopcnt = 5
    suspend_timeout = 10
    tcp_defer_accept = 45
    tcp_socket_buffer = 0
    tcp_keepalive = 1
    tcp_keepcnt = 9
    tcp_keepidle = 7200
    tcp_keepintvl = 75
    
    # Logging
    log_connections = 1
    log_disconnections = 1
    log_pooler_errors = 1
    log_stats = 1
    verbose = 0
    admin_users = postgres
    
  userlist.txt: |
    "pgbouncer" "md5<hash>"
    "postgres" "md5<hash>"
    "stats" "md5<hash>"
```

### Query Performance Optimization

Implementing query performance monitoring and optimization:

```sql
-- performance-views.sql
-- Create performance monitoring views

-- Slow query tracking view
CREATE OR REPLACE VIEW v_slow_queries AS
SELECT 
    queryid,
    query,
    calls,
    total_exec_time,
    mean_exec_time,
    stddev_exec_time,
    rows,
    100.0 * shared_blks_hit / nullif(shared_blks_hit + shared_blks_read, 0) AS hit_percent,
    temp_blks_read + temp_blks_written AS temp_blocks,
    blk_read_time + blk_write_time AS io_time
FROM pg_stat_statements
WHERE mean_exec_time > 1000  -- queries slower than 1 second
ORDER BY mean_exec_time DESC
LIMIT 50;

-- Index usage statistics
CREATE OR REPLACE VIEW v_index_usage AS
SELECT 
    schemaname,
    tablename,
    indexname,
    idx_scan,
    idx_tup_read,
    idx_tup_fetch,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
    CASE 
        WHEN idx_scan = 0 THEN 'UNUSED'
        WHEN idx_scan < 100 THEN 'RARELY_USED'
        ELSE 'ACTIVE'
    END AS usage_status
FROM pg_stat_user_indexes
ORDER BY idx_scan;

-- Table bloat estimation
CREATE OR REPLACE VIEW v_table_bloat AS
SELECT
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS total_size,
    pg_size_pretty(pg_relation_size(schemaname||'.'||tablename)) AS table_size,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename) - pg_relation_size(schemaname||'.'||tablename)) AS indexes_size,
    round(100 * n_dead_tup / nullif(n_live_tup + n_dead_tup, 0), 2) AS dead_tuple_percent,
    n_dead_tup,
    n_live_tup,
    last_vacuum,
    last_autovacuum
FROM pg_stat_user_tables
WHERE n_dead_tup > 1000
ORDER BY n_dead_tup DESC;

-- Lock monitoring
CREATE OR REPLACE VIEW v_blocking_locks AS
SELECT
    blocked_locks.pid AS blocked_pid,
    blocked_activity.usename AS blocked_user,
    blocking_locks.pid AS blocking_pid,
    blocking_activity.usename AS blocking_user,
    blocked_activity.query AS blocked_statement,
    blocking_activity.query AS blocking_statement,
    blocked_activity.application_name AS blocked_application,
    blocking_activity.application_name AS blocking_application,
    now() - blocked_activity.query_start AS blocked_duration,
    now() - blocking_activity.query_start AS blocking_duration
FROM pg_catalog.pg_locks blocked_locks
JOIN pg_catalog.pg_stat_activity blocked_activity ON blocked_activity.pid = blocked_locks.pid
JOIN pg_catalog.pg_locks blocking_locks 
    ON blocking_locks.locktype = blocked_locks.locktype
    AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database
    AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
    AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page
    AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple
    AND blocking_locks.virtualxid IS NOT DISTINCT FROM blocked_locks.virtualxid
    AND blocking_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid
    AND blocking_locks.classid IS NOT DISTINCT FROM blocked_locks.classid
    AND blocking_locks.objid IS NOT DISTINCT FROM blocked_locks.objid
    AND blocking_locks.objsubid IS NOT DISTINCT FROM blocked_locks.objsubid
    AND blocking_locks.pid != blocked_locks.pid
JOIN pg_catalog.pg_stat_activity blocking_activity ON blocking_activity.pid = blocking_locks.pid
WHERE NOT blocked_locks.granted;

-- Connection pool efficiency
CREATE OR REPLACE VIEW v_connection_stats AS
SELECT
    datname,
    usename,
    application_name,
    client_addr,
    count(*) AS connection_count,
    count(*) FILTER (WHERE state = 'active') AS active_connections,
    count(*) FILTER (WHERE state = 'idle') AS idle_connections,
    count(*) FILTER (WHERE state = 'idle in transaction') AS idle_in_transaction,
    max(now() - state_change) FILTER (WHERE state = 'idle') AS max_idle_time,
    max(now() - query_start) FILTER (WHERE state = 'active') AS max_query_time
FROM pg_stat_activity
WHERE pid != pg_backend_pid()
GROUP BY datname, usename, application_name, client_addr
ORDER BY connection_count DESC;

-- Create performance tuning function
CREATE OR REPLACE FUNCTION tune_postgresql_settings()
RETURNS TABLE (
    setting_name text,
    current_value text,
    recommended_value text,
    recommendation_reason text
) AS $$
DECLARE
    total_ram bigint;
    cpu_count int;
    max_connections int;
BEGIN
    -- Get system information
    SELECT setting::bigint INTO total_ram FROM pg_settings WHERE name = 'shared_memory_size_in_huge_pages';
    SELECT setting::int INTO cpu_count FROM pg_settings WHERE name = 'max_worker_processes';
    SELECT setting::int INTO max_connections FROM pg_settings WHERE name = 'max_connections';
    
    -- If we can't get RAM from settings, estimate it
    IF total_ram IS NULL THEN
        total_ram := 8 * 1024 * 1024 * 1024; -- Default to 8GB
    END IF;
    
    RETURN QUERY
    SELECT 
        'shared_buffers'::text,
        current_setting('shared_buffers'),
        (total_ram / 4 / 1024 / 1024)::text || 'MB',
        'Set to 25% of total RAM for dedicated database server'
    UNION ALL
    SELECT 
        'effective_cache_size'::text,
        current_setting('effective_cache_size'),
        (total_ram * 3 / 4 / 1024 / 1024)::text || 'MB',
        'Set to 75% of total RAM for dedicated database server'
    UNION ALL
    SELECT 
        'work_mem'::text,
        current_setting('work_mem'),
        CASE 
            WHEN max_connections <= 100 THEN '64MB'
            WHEN max_connections <= 200 THEN '32MB'
            ELSE '16MB'
        END,
        'Balance between connection count and available memory'
    UNION ALL
    SELECT 
        'maintenance_work_mem'::text,
        current_setting('maintenance_work_mem'),
        (total_ram / 16 / 1024 / 1024)::text || 'MB',
        'Set to RAM/16 for maintenance operations'
    UNION ALL
    SELECT 
        'max_wal_size'::text,
        current_setting('max_wal_size'),
        '4GB',
        'Increase for write-heavy workloads'
    UNION ALL
    SELECT 
        'checkpoint_completion_target'::text,
        current_setting('checkpoint_completion_target'),
        '0.9',
        'Spread checkpoint I/O over longer period';
END;
$$ LANGUAGE plpgsql;
```

## Disaster Recovery Procedures

### Point-in-Time Recovery Setup

```yaml
# pitr-restore-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: postgres-pitr-restore
  namespace: postgres-ha
spec:
  template:
    spec:
      serviceAccountName: postgres-restore-sa
      containers:
      - name: restore
        image: postgres:14-alpine
        env:
        - name: S3_BUCKET
          value: postgres-backups
        - name: RESTORE_TARGET_TIME
          value: "2024-01-20 15:30:00"
        - name: RESTORE_TARGET_NAME
          value: "restore_point_1"
        command:
        - /bin/bash
        - -c
        - |
          set -euo pipefail
          
          # Install required tools
          apk add --no-cache aws-cli pigz
          
          echo "Starting Point-in-Time Recovery"
          echo "Target time: ${RESTORE_TARGET_TIME}"
          
          # Find the appropriate base backup
          LATEST_BACKUP=$(aws s3 ls s3://${S3_BUCKET}/backups/ | \
            grep basebackup | \
            sort -r | \
            head -1 | \
            awk '{print $4}')
          
          echo "Using base backup: ${LATEST_BACKUP}"
          
          # Download and extract base backup
          aws s3 cp s3://${S3_BUCKET}/backups/${LATEST_BACKUP} - | \
            pigz -d | \
            tar -xf - -C /var/lib/postgresql/data/
          
          # Create recovery configuration
          cat > /var/lib/postgresql/data/postgresql.auto.conf << EOF
          restore_command = 'aws s3 cp s3://${S3_BUCKET}/wal/%f %p'
          recovery_target_time = '${RESTORE_TARGET_TIME}'
          recovery_target_action = 'promote'
          recovery_target_timeline = 'latest'
          EOF
          
          # Create standby signal file
          touch /var/lib/postgresql/data/standby.signal
          
          # Start PostgreSQL for recovery
          postgres -D /var/lib/postgresql/data
          
        resources:
          requests:
            cpu: 2000m
            memory: 4Gi
          limits:
            cpu: 4000m
            memory: 8Gi
        
        volumeMounts:
        - name: restore-data
          mountPath: /var/lib/postgresql/data
      
      volumes:
      - name: restore-data
        persistentVolumeClaim:
          claimName: postgres-restore-pvc
      
      restartPolicy: Never
```

## Best Practices and Production Considerations

### Security Hardening

```yaml
# security-policies.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: postgres-security-config
  namespace: postgres-ha
data:
  pg_hba.conf: |
    # TYPE  DATABASE        USER            ADDRESS                 METHOD
    local   all             all                                     reject
    host    all             all             127.0.0.1/32            scram-sha-256
    host    all             all             ::1/128                 scram-sha-256
    hostssl all             all             10.0.0.0/8              scram-sha-256 clientcert=verify-full
    hostssl replication     replicator      10.0.0.0/8              scram-sha-256 clientcert=verify-full
    host    all             all             0.0.0.0/0               reject
    
  postgresql.conf: |
    # Security settings
    ssl = on
    ssl_cert_file = '/etc/postgresql/certs/server.crt'
    ssl_key_file = '/etc/postgresql/certs/server.key'
    ssl_ca_file = '/etc/postgresql/certs/ca.crt'
    ssl_crl_file = '/etc/postgresql/certs/root.crl'
    ssl_ciphers = 'HIGH:MEDIUM:+3DES:!aNULL'
    ssl_prefer_server_ciphers = on
    ssl_min_protocol_version = 'TLSv1.2'
    
    # Authentication
    password_encryption = scram-sha-256
    
    # Auditing
    log_connections = on
    log_disconnections = on
    log_statement = 'ddl'
    log_line_prefix = '%m [%p] %q%u@%d '
    
    # Row Level Security
    row_security = on
```

### Maintenance Automation

```go
// maintenance-controller.go
package main

import (
    "context"
    "database/sql"
    "fmt"
    "log"
    "time"
    
    _ "github.com/lib/pq"
)

type MaintenanceController struct {
    db                *sql.DB
    vacuumThreshold   float64
    analyzeThreshold  int64
    reindexThreshold  float64
}

func (mc *MaintenanceController) RunMaintenanceCycle() error {
    ctx := context.Background()
    
    // Check table bloat
    bloatedTables, err := mc.getTablesBloat(ctx)
    if err != nil {
        return err
    }
    
    for _, table := range bloatedTables {
        if table.BloatRatio > mc.vacuumThreshold {
            log.Printf("Running VACUUM FULL on %s.%s (bloat: %.2f%%)",
                table.Schema, table.Table, table.BloatRatio*100)
            
            if err := mc.vacuumTable(ctx, table); err != nil {
                log.Printf("Failed to vacuum %s.%s: %v", 
                    table.Schema, table.Table, err)
            }
        }
    }
    
    // Update statistics
    staleTables, err := mc.getStaleStatsTables(ctx)
    if err != nil {
        return err
    }
    
    for _, table := range staleTables {
        log.Printf("Running ANALYZE on %s.%s", table.Schema, table.Table)
        if err := mc.analyzeTable(ctx, table); err != nil {
            log.Printf("Failed to analyze %s.%s: %v",
                table.Schema, table.Table, err)
        }
    }
    
    // Reindex if needed
    bloatedIndexes, err := mc.getBloatedIndexes(ctx)
    if err != nil {
        return err
    }
    
    for _, index := range bloatedIndexes {
        if index.BloatRatio > mc.reindexThreshold {
            log.Printf("Running REINDEX on %s (bloat: %.2f%%)",
                index.IndexName, index.BloatRatio*100)
            
            if err := mc.reindexConcurrently(ctx, index); err != nil {
                log.Printf("Failed to reindex %s: %v", index.IndexName, err)
            }
        }
    }
    
    return nil
}

func (mc *MaintenanceController) reindexConcurrently(ctx context.Context, index IndexInfo) error {
    // Create new index concurrently
    newIndexName := fmt.Sprintf("%s_new_%d", index.IndexName, time.Now().Unix())
    
    _, err := mc.db.ExecContext(ctx, fmt.Sprintf(
        "CREATE INDEX CONCURRENTLY %s ON %s.%s USING %s (%s) WHERE %s",
        newIndexName, index.Schema, index.Table, index.IndexType,
        index.IndexDef, index.IndexPredicate))
    if err != nil {
        return err
    }
    
    // Swap indexes
    tx, err := mc.db.BeginTx(ctx, nil)
    if err != nil {
        return err
    }
    defer tx.Rollback()
    
    // Drop old index
    _, err = tx.ExecContext(ctx, fmt.Sprintf(
        "DROP INDEX %s.%s", index.Schema, index.IndexName))
    if err != nil {
        return err
    }
    
    // Rename new index
    _, err = tx.ExecContext(ctx, fmt.Sprintf(
        "ALTER INDEX %s.%s RENAME TO %s",
        index.Schema, newIndexName, index.IndexName))
    if err != nil {
        return err
    }
    
    return tx.Commit()
}
```

## Conclusion

Implementing PostgreSQL high availability with Patroni on Kubernetes provides a robust, automated solution for enterprise database requirements. This architecture ensures:

- **Automatic Failover**: Sub-minute failover times with minimal data loss
- **Scalability**: Horizontal scaling through read replicas
- **Monitoring**: Comprehensive observability and alerting
- **Security**: Enterprise-grade security with encryption and authentication
- **Disaster Recovery**: Point-in-time recovery and backup automation

The combination of Patroni's cluster management capabilities with Kubernetes' orchestration provides a production-ready PostgreSQL deployment that meets the demanding requirements of enterprise applications.