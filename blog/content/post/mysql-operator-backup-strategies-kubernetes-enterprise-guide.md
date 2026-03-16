---
title: "MySQL Operator Backup Strategies on Kubernetes: Enterprise Production Guide"
date: 2026-10-02T00:00:00-05:00
draft: false
tags: ["MySQL", "Kubernetes", "Backup", "Database", "Operators", "Disaster Recovery", "Percona"]
categories: ["Database", "Kubernetes", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing robust backup and recovery strategies for MySQL on Kubernetes using operators, with automated backup scheduling, point-in-time recovery, and disaster recovery procedures."
more_link: "yes"
url: "/mysql-operator-backup-strategies-kubernetes-enterprise-guide/"
---

Implementing comprehensive backup strategies for MySQL on Kubernetes is critical for data protection and business continuity. This guide covers enterprise-grade backup implementations using MySQL operators, including automated scheduling, incremental backups, and point-in-time recovery.

We'll explore production-ready configurations for Percona XtraDB Cluster Operator, Oracle MySQL Operator, and Vitess, with detailed examples of backup automation, encryption, compression, and disaster recovery testing.

<!--more-->

# MySQL Operator Backup Strategies on Kubernetes

## Understanding MySQL Backup Architecture

### Backup Types and Strategies

**1. Physical vs Logical Backups**
```yaml
# Physical backup configuration (faster, binary)
apiVersion: v1
kind: ConfigMap
metadata:
  name: mysql-backup-config
  namespace: database
data:
  physical-backup.sh: |
    #!/bin/bash
    # XtraBackup physical backup script
    set -e

    BACKUP_DIR="/backup/$(date +%Y%m%d_%H%M%S)"
    MYSQL_HOST="mysql-cluster-0"
    MYSQL_PORT="3306"
    MYSQL_USER="backup"

    echo "Starting physical backup to: $BACKUP_DIR"

    xtrabackup --backup \
      --host=$MYSQL_HOST \
      --port=$MYSQL_PORT \
      --user=$MYSQL_USER \
      --password=$MYSQL_PASSWORD \
      --target-dir=$BACKUP_DIR \
      --compress \
      --compress-threads=4 \
      --parallel=4 \
      --stream=xbstream | \
      aws s3 cp - s3://mysql-backups/physical/backup-$(date +%Y%m%d_%H%M%S).xbstream

    echo "Physical backup completed"

  logical-backup.sh: |
    #!/bin/bash
    # mysqldump logical backup script
    set -e

    BACKUP_FILE="backup-$(date +%Y%m%d_%H%M%S).sql.gz"
    MYSQL_HOST="mysql-cluster-0"
    MYSQL_PORT="3306"
    MYSQL_USER="backup"

    echo "Starting logical backup: $BACKUP_FILE"

    mysqldump \
      --host=$MYSQL_HOST \
      --port=$MYSQL_PORT \
      --user=$MYSQL_USER \
      --password=$MYSQL_PASSWORD \
      --all-databases \
      --single-transaction \
      --quick \
      --lock-tables=false \
      --routines \
      --triggers \
      --events \
      --set-gtid-purged=AUTO | \
      gzip | \
      aws s3 cp - s3://mysql-backups/logical/$BACKUP_FILE

    echo "Logical backup completed"
```

## Percona XtraDB Cluster Operator Backup

### Operator Installation and Configuration

**1. Install Percona XtraDB Cluster Operator**
```bash
# Add Percona helm repository
helm repo add percona https://percona.github.io/percona-helm-charts/
helm repo update

# Install operator
helm install pxc-operator percona/pxc-operator \
  --namespace pxc-operator \
  --create-namespace \
  --set watchNamespace="*"
```

**2. Deploy PXC Cluster with Backup Configuration**
```yaml
apiVersion: pxc.percona.com/v1
kind: PerconaXtraDBCluster
metadata:
  name: production-cluster
  namespace: database
spec:
  crVersion: 1.13.0
  secretsName: production-cluster-secrets

  pxc:
    size: 3
    image: percona/percona-xtradb-cluster:8.0.33-25.1

    resources:
      requests:
        memory: 8Gi
        cpu: "2"
      limits:
        memory: 16Gi
        cpu: "4"

    volumeSpec:
      persistentVolumeClaim:
        storageClassName: fast-ssd
        accessModes:
          - ReadWriteOnce
        resources:
          requests:
            storage: 100Gi

    affinity:
      antiAffinityTopologyKey: "kubernetes.io/hostname"

    podDisruptionBudget:
      maxUnavailable: 1

    configuration: |
      [mysqld]
      # InnoDB settings
      innodb_buffer_pool_size=8G
      innodb_log_file_size=512M
      innodb_flush_log_at_trx_commit=2
      innodb_flush_method=O_DIRECT
      innodb_file_per_table=1
      innodb_io_capacity=2000
      innodb_io_capacity_max=4000
      innodb_read_io_threads=8
      innodb_write_io_threads=8
      innodb_buffer_pool_instances=8

      # Replication settings
      gtid_mode=ON
      enforce_gtid_consistency=ON
      binlog_format=ROW
      log_bin=mysql-bin
      log_slave_updates=ON
      binlog_expire_logs_seconds=259200
      sync_binlog=1

      # Performance tuning
      max_connections=500
      thread_cache_size=50
      table_open_cache=4000
      sort_buffer_size=2M
      read_buffer_size=2M
      read_rnd_buffer_size=2M
      join_buffer_size=2M

      # Query cache (disabled for 8.0+)
      # Using performance_schema instead
      performance_schema=ON

      # Logging
      slow_query_log=1
      slow_query_log_file=/var/log/mysql/slow-query.log
      long_query_time=2
      log_queries_not_using_indexes=1

      # Character set
      character-set-server=utf8mb4
      collation-server=utf8mb4_unicode_ci

  haproxy:
    enabled: true
    size: 3
    image: percona/percona-xtradb-cluster-operator:1.13.0-haproxy

    resources:
      requests:
        memory: 512Mi
        cpu: "500m"
      limits:
        memory: 1Gi
        cpu: "1"

  proxysql:
    enabled: true
    size: 3
    image: percona/percona-xtradb-cluster-operator:1.13.0-proxysql

    resources:
      requests:
        memory: 1Gi
        cpu: "500m"
      limits:
        memory: 2Gi
        cpu: "1"

    configuration: |
      datadir="/var/lib/proxysql"

      admin_variables=
      {
        admin_credentials="admin:admin"
        mysql_ifaces="0.0.0.0:6032"
        refresh_interval=2000
      }

      mysql_variables=
      {
        threads=4
        max_connections=2048
        default_query_delay=0
        default_query_timeout=36000000
        have_compress=true
        poll_timeout=2000
        interfaces="0.0.0.0:3306"
        default_schema="information_schema"
        stacksize=1048576
        server_version="8.0.33"
        connect_timeout_server=10000
        monitor_username="monitor"
        monitor_password="monitor"
        monitor_history=60000
        monitor_connect_interval=20000
        monitor_ping_interval=10000
        ping_timeout_server=200
        commands_stats=true
        sessions_sort=true
        monitor_galera_healthcheck_interval=2000
        monitor_galera_healthcheck_timeout=800
      }

  backup:
    image: percona/percona-xtradb-cluster-operator:1.13.0-pxc8.0-backup

    storages:
      s3-storage:
        type: s3
        s3:
          bucket: mysql-backups
          region: us-east-1
          credentialsSecret: aws-s3-credentials
          endpointUrl: https://s3.amazonaws.com

      azure-storage:
        type: azure
        azure:
          container: mysql-backups
          credentialsSecret: azure-credentials
          endpointUrl: https://mystorageaccount.blob.core.windows.net

      gcs-storage:
        type: gcs
        gcs:
          bucket: mysql-backups
          credentialsSecret: gcs-credentials

    schedule:
      - name: daily-full-backup
        schedule: "0 3 * * *"
        keep: 7
        storageName: s3-storage

      - name: hourly-incremental-backup
        schedule: "0 * * * *"
        keep: 24
        storageName: s3-storage

      - name: weekly-backup-to-azure
        schedule: "0 4 * * 0"
        keep: 4
        storageName: azure-storage

    resources:
      requests:
        memory: 1Gi
        cpu: "500m"
      limits:
        memory: 2Gi
        cpu: "1"

  pmm:
    enabled: true
    image: percona/pmm-client:2.39.0
    serverHost: pmm-server
    serverUser: admin
    resources:
      requests:
        memory: 512Mi
        cpu: "250m"
      limits:
        memory: 1Gi
        cpu: "500m"
---
apiVersion: v1
kind: Secret
metadata:
  name: production-cluster-secrets
  namespace: database
type: Opaque
stringData:
  root: $(openssl rand -base64 32)
  xtrabackup: $(openssl rand -base64 32)
  monitor: $(openssl rand -base64 32)
  clustercheck: $(openssl rand -base64 32)
  proxyadmin: $(openssl rand -base64 32)
  pmmserver: $(openssl rand -base64 32)
  operator: $(openssl rand -base64 32)
```

### Automated Backup Scheduling

**1. CronJob-based Backup Configuration**
```yaml
apiVersion: pxc.percona.com/v1
kind: PerconaXtraDBClusterBackup
metadata:
  name: manual-full-backup
  namespace: database
spec:
  pxcCluster: production-cluster
  storageName: s3-storage
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: pxc-incremental-backup
  namespace: database
spec:
  schedule: "0 */6 * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 5
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: percona-xtradb-cluster-operator
          containers:
            - name: xtrabackup
              image: percona/percona-xtradb-cluster-operator:1.13.0-pxc8.0-backup
              command:
                - /bin/bash
                - -c
                - |
                  set -e

                  BACKUP_NAME="incremental-$(date +%Y%m%d-%H%M%S)"

                  cat <<EOF | kubectl apply -f -
                  apiVersion: pxc.percona.com/v1
                  kind: PerconaXtraDBClusterBackup
                  metadata:
                    name: $BACKUP_NAME
                    namespace: database
                  spec:
                    pxcCluster: production-cluster
                    storageName: s3-storage
                  EOF

                  # Wait for backup to complete
                  kubectl wait --for=condition=Complete \
                    --timeout=3600s \
                    -n database \
                    pxcbackup/$BACKUP_NAME

                  echo "Backup $BACKUP_NAME completed successfully"
              env:
                - name: AWS_ACCESS_KEY_ID
                  valueFrom:
                    secretKeyRef:
                      name: aws-s3-credentials
                      key: AWS_ACCESS_KEY_ID
                - name: AWS_SECRET_ACCESS_KEY
                  valueFrom:
                    secretKeyRef:
                      name: aws-s3-credentials
                      key: AWS_SECRET_ACCESS_KEY
          restartPolicy: OnFailure
```

**2. Backup Management Script**
```bash
#!/bin/bash
# backup-manager.sh - Comprehensive backup management

set -e

NAMESPACE="database"
CLUSTER_NAME="production-cluster"
S3_BUCKET="s3://mysql-backups"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1"
}

error() {
    echo -e "${RED}[$(date +'%Y-%m-%d %H:%M:%S')] ERROR:${NC} $1"
}

warn() {
    echo -e "${YELLOW}[$(date +'%Y-%m-%d %H:%M:%S')] WARNING:${NC} $1"
}

# Create on-demand backup
create_backup() {
    local backup_type=${1:-full}
    local backup_name="${backup_type}-backup-$(date +%Y%m%d-%H%M%S)"

    log "Creating $backup_type backup: $backup_name"

    cat <<EOF | kubectl apply -f -
apiVersion: pxc.percona.com/v1
kind: PerconaXtraDBClusterBackup
metadata:
  name: $backup_name
  namespace: $NAMESPACE
spec:
  pxcCluster: $CLUSTER_NAME
  storageName: s3-storage
EOF

    log "Waiting for backup to complete..."
    kubectl wait --for=condition=Complete \
        --timeout=7200s \
        -n $NAMESPACE \
        pxcbackup/$backup_name || {
        error "Backup failed"
        return 1
    }

    log "Backup $backup_name completed successfully"
}

# List available backups
list_backups() {
    log "Available backups:"
    kubectl get pxcbackup -n $NAMESPACE -o custom-columns=\
NAME:.metadata.name,\
STATUS:.status.state,\
SIZE:.status.s3.latestRestorableTime,\
COMPLETED:.status.completed

    log "\nBackups in S3:"
    aws s3 ls $S3_BUCKET/ --recursive --human-readable --summarize
}

# Restore from backup
restore_backup() {
    local backup_name=$1
    local target_cluster=${2:-"${CLUSTER_NAME}-restored"}

    if [ -z "$backup_name" ]; then
        error "Backup name required"
        return 1
    fi

    log "Restoring from backup: $backup_name to cluster: $target_cluster"

    cat <<EOF | kubectl apply -f -
apiVersion: pxc.percona.com/v1
kind: PerconaXtraDBClusterRestore
metadata:
  name: restore-$(date +%Y%m%d-%H%M%S)
  namespace: $NAMESPACE
spec:
  pxcCluster: $target_cluster
  backupName: $backup_name
EOF

    log "Restore initiated. Monitor with: kubectl get pxc-restore -n $NAMESPACE"
}

# Verify backup integrity
verify_backup() {
    local backup_name=$1

    if [ -z "$backup_name" ]; then
        error "Backup name required"
        return 1
    fi

    log "Verifying backup: $backup_name"

    # Get backup details
    kubectl get pxcbackup -n $NAMESPACE $backup_name -o yaml

    # Verify S3 backup exists
    local s3_path=$(kubectl get pxcbackup -n $NAMESPACE $backup_name \
        -o jsonpath='{.status.s3.destination}')

    if aws s3 ls "$s3_path" &>/dev/null; then
        log "Backup exists in S3: $s3_path"
    else
        error "Backup not found in S3: $s3_path"
        return 1
    fi

    # Check backup size
    local backup_size=$(aws s3 ls "$s3_path" --summarize | grep "Total Size" | awk '{print $3}')
    log "Backup size: $(numfmt --to=iec-i --suffix=B $backup_size)"
}

# Clean old backups
cleanup_old_backups() {
    local retention_days=${1:-30}

    log "Cleaning backups older than $retention_days days"

    # List old backup CRs
    kubectl get pxcbackup -n $NAMESPACE \
        -o json | \
        jq -r ".items[] | select(.status.completed < \"$(date -d "$retention_days days ago" -Iseconds)\") | .metadata.name" | \
        while read backup; do
            warn "Deleting old backup: $backup"
            kubectl delete pxcbackup -n $NAMESPACE $backup
        done

    # Clean S3 backups
    log "Cleaning S3 backups older than $retention_days days"
    aws s3 ls $S3_BUCKET/ --recursive | \
        awk '{print $4}' | \
        while read file; do
            file_date=$(echo $file | grep -oP '\d{8}' | head -1)
            if [ -n "$file_date" ]; then
                file_epoch=$(date -d "$file_date" +%s)
                cutoff_epoch=$(date -d "$retention_days days ago" +%s)

                if [ $file_epoch -lt $cutoff_epoch ]; then
                    warn "Deleting old S3 file: $file"
                    aws s3 rm "$S3_BUCKET/$file"
                fi
            fi
        done
}

# Monitor backup jobs
monitor_backups() {
    log "Monitoring active backups..."

    watch -n 5 "kubectl get pxcbackup -n $NAMESPACE && echo && kubectl get jobs -n $NAMESPACE | grep backup"
}

# Export backup metadata
export_metadata() {
    local output_file="backup-metadata-$(date +%Y%m%d).json"

    log "Exporting backup metadata to: $output_file"

    kubectl get pxcbackup -n $NAMESPACE -o json > "$output_file"

    log "Metadata exported successfully"
}

# Main menu
show_menu() {
    cat <<EOF

MySQL Backup Manager
====================
1. Create full backup
2. List backups
3. Restore from backup
4. Verify backup
5. Clean old backups
6. Monitor backups
7. Export metadata
8. Exit

EOF
}

main() {
    while true; do
        show_menu
        read -p "Select option: " choice

        case $choice in
            1)
                create_backup "full"
                ;;
            2)
                list_backups
                ;;
            3)
                read -p "Enter backup name: " backup_name
                read -p "Enter target cluster (default: ${CLUSTER_NAME}-restored): " target
                restore_backup "$backup_name" "$target"
                ;;
            4)
                read -p "Enter backup name: " backup_name
                verify_backup "$backup_name"
                ;;
            5)
                read -p "Enter retention days (default: 30): " days
                cleanup_old_backups "${days:-30}"
                ;;
            6)
                monitor_backups
                ;;
            7)
                export_metadata
                ;;
            8)
                log "Exiting..."
                exit 0
                ;;
            *)
                error "Invalid option"
                ;;
        esac

        read -p "Press Enter to continue..."
    done
}

# Handle command line arguments
case "${1:-menu}" in
    create)
        create_backup "${2:-full}"
        ;;
    list)
        list_backups
        ;;
    restore)
        restore_backup "$2" "$3"
        ;;
    verify)
        verify_backup "$2"
        ;;
    cleanup)
        cleanup_old_backups "${2:-30}"
        ;;
    monitor)
        monitor_backups
        ;;
    export)
        export_metadata
        ;;
    menu)
        main
        ;;
    *)
        echo "Usage: $0 {create|list|restore|verify|cleanup|monitor|export|menu}"
        exit 1
        ;;
esac
```

## Point-in-Time Recovery (PITR)

### Binary Log Configuration

**1. Enable Binary Logging for PITR**
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: mysql-pitr-config
  namespace: database
data:
  my.cnf: |
    [mysqld]
    # Binary logging for PITR
    log_bin=mysql-bin
    binlog_format=ROW
    binlog_row_image=FULL
    binlog_expire_logs_seconds=604800  # 7 days
    max_binlog_size=1G
    sync_binlog=1

    # GTID for consistent replication
    gtid_mode=ON
    enforce_gtid_consistency=ON
    log_slave_updates=ON

    # Binary log retention
    binlog_transaction_dependency_tracking=WRITESET
    transaction_write_set_extraction=XXHASH64
```

**2. Binary Log Archiving**
```bash
#!/bin/bash
# binlog-archive.sh - Archive binary logs to S3

set -e

MYSQL_HOST="production-cluster-0.production-cluster"
MYSQL_PORT="3306"
MYSQL_USER="backup"
BINLOG_DIR="/var/lib/mysql"
S3_BUCKET="s3://mysql-binlogs/production-cluster"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1"
}

# Get list of binary logs
get_binlogs() {
    mysql -h $MYSQL_HOST -P $MYSQL_PORT -u $MYSQL_USER -p$MYSQL_PASSWORD \
        -e "SHOW BINARY LOGS;" -s -N | awk '{print $1}'
}

# Get current binary log
get_current_binlog() {
    mysql -h $MYSQL_HOST -P $MYSQL_PORT -u $MYSQL_USER -p$MYSQL_PASSWORD \
        -e "SHOW MASTER STATUS;" -s -N | awk '{print $1}'
}

# Archive binary log
archive_binlog() {
    local binlog=$1
    local current_binlog=$(get_current_binlog)

    # Don't archive current binary log
    if [ "$binlog" == "$current_binlog" ]; then
        log "Skipping current binary log: $binlog"
        return 0
    fi

    log "Archiving binary log: $binlog"

    # Check if already archived
    if aws s3 ls "$S3_BUCKET/$binlog" &>/dev/null; then
        log "Binary log already archived: $binlog"
        return 0
    fi

    # Copy to S3
    kubectl exec -n database production-cluster-0 -- \
        cat "$BINLOG_DIR/$binlog" | \
        gzip | \
        aws s3 cp - "$S3_BUCKET/${binlog}.gz"

    log "Archived: $binlog"
}

# Main loop
main() {
    log "Starting binary log archiving"

    get_binlogs | while read binlog; do
        archive_binlog "$binlog"
    done

    log "Binary log archiving completed"
}

main "$@"
```

**3. Point-in-Time Recovery Script**
```bash
#!/bin/bash
# pitr-restore.sh - Perform point-in-time recovery

set -e

NAMESPACE="database"
CLUSTER_NAME="production-cluster"
S3_BACKUP_BUCKET="s3://mysql-backups"
S3_BINLOG_BUCKET="s3://mysql-binlogs/production-cluster"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1"
}

error() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $1" >&2
    exit 1
}

# Parse target time
parse_target_time() {
    local target=$1

    if [ -z "$target" ]; then
        error "Target time required (format: YYYY-MM-DD HH:MM:SS)"
    fi

    # Convert to timestamp
    date -d "$target" +%s || error "Invalid date format"
}

# Find appropriate base backup
find_base_backup() {
    local target_time=$1

    log "Finding base backup before: $(date -d @$target_time)"

    # List backups and find the most recent before target time
    kubectl get pxcbackup -n $NAMESPACE -o json | \
        jq -r ".items[] | select(.status.completed < \"$(date -d @$target_time -Iseconds)\") | .metadata.name" | \
        tail -1
}

# Download and apply binary logs
apply_binlogs() {
    local target_time=$1
    local pod_name=$2

    log "Applying binary logs up to: $(date -d @$target_time)"

    # Download binary logs from S3
    local temp_dir=$(mktemp -d)
    aws s3 sync $S3_BINLOG_BUCKET $temp_dir/

    # Apply binary logs
    for binlog in $(ls $temp_dir/*.gz | sort); do
        log "Processing: $(basename $binlog)"

        # Extract and apply
        gunzip -c $binlog | \
        kubectl exec -i -n $NAMESPACE $pod_name -- \
            mysqlbinlog \
                --stop-datetime="$(date -d @$target_time '+%Y-%m-%d %H:%M:%S')" \
                - | \
        kubectl exec -i -n $NAMESPACE $pod_name -- \
            mysql -u root -p$MYSQL_ROOT_PASSWORD
    done

    rm -rf $temp_dir
    log "Binary log application completed"
}

# Perform PITR
perform_pitr() {
    local target_datetime=$1
    local target_cluster=${2:-"${CLUSTER_NAME}-pitr"}

    log "Starting point-in-time recovery"
    log "Target datetime: $target_datetime"
    log "Target cluster: $target_cluster"

    # Parse and validate target time
    local target_timestamp=$(parse_target_time "$target_datetime")

    # Find appropriate base backup
    local base_backup=$(find_base_backup $target_timestamp)

    if [ -z "$base_backup" ]; then
        error "No suitable base backup found"
    fi

    log "Using base backup: $base_backup"

    # Restore base backup
    log "Restoring base backup..."
    cat <<EOF | kubectl apply -f -
apiVersion: pxc.percona.com/v1
kind: PerconaXtraDBClusterRestore
metadata:
  name: pitr-restore-$(date +%Y%m%d-%H%M%S)
  namespace: $NAMESPACE
spec:
  pxcCluster: $target_cluster
  backupName: $base_backup
EOF

    # Wait for restore to complete
    sleep 30
    kubectl wait --for=condition=Ready \
        --timeout=3600s \
        -n $NAMESPACE \
        pod/${target_cluster}-pxc-0

    log "Base backup restored"

    # Apply binary logs
    apply_binlogs $target_timestamp "${target_cluster}-pxc-0"

    log "Point-in-time recovery completed"
    log "New cluster available at: ${target_cluster}"
}

# Usage
if [ $# -lt 1 ]; then
    echo "Usage: $0 'YYYY-MM-DD HH:MM:SS' [target-cluster-name]"
    echo "Example: $0 '2025-12-30 14:30:00' production-cluster-pitr"
    exit 1
fi

perform_pitr "$1" "$2"
```

## Oracle MySQL Operator Backup

### Operator Configuration

**1. Install Oracle MySQL Operator**
```bash
kubectl apply -f https://raw.githubusercontent.com/mysql/mysql-operator/trunk/deploy/deploy-crds.yaml
kubectl apply -f https://raw.githubusercontent.com/mysql/mysql-operator/trunk/deploy/deploy-operator.yaml
```

**2. MySQL InnoDB Cluster with Backup**
```yaml
apiVersion: mysql.oracle.com/v2
kind: InnoDBCluster
metadata:
  name: production-mysql
  namespace: database
spec:
  secretName: production-mysql-secret
  tlsUseSelfSigned: true
  instances: 3
  router:
    instances: 3

  datadirVolumeClaimTemplate:
    storageClassName: fast-ssd
    accessModes:
      - ReadWriteOnce
    resources:
      requests:
        storage: 100Gi

  mycnf: |
    [mysqld]
    innodb_buffer_pool_size=8G
    innodb_log_file_size=512M
    max_connections=500

    # Binary logging
    log_bin=mysql-bin
    binlog_format=ROW
    binlog_expire_logs_seconds=604800
    sync_binlog=1

    # GTID
    gtid_mode=ON
    enforce_gtid_consistency=ON

    # Performance
    innodb_flush_log_at_trx_commit=2
    innodb_flush_method=O_DIRECT
    innodb_io_capacity=2000

  backupProfiles:
    - name: daily-backup
      dumpInstance:
        storage:
          s3:
            bucketName: mysql-backups
            prefix: production-mysql
            config: s3-config
            profile: default
            endpoint: s3.amazonaws.com

      schedule:
        schedule: "0 3 * * *"
        backupProfileName: daily-backup
        enabled: true
        deleteBackupData: false

  backupSchedules:
    - name: hourly-incremental
      schedule: "0 * * * *"
      backupProfileName: daily-backup
      enabled: true
      deleteBackupData: false
---
apiVersion: v1
kind: Secret
metadata:
  name: production-mysql-secret
  namespace: database
type: Opaque
stringData:
  rootPassword: $(openssl rand -base64 32)
  rootHost: "%"
---
apiVersion: v1
kind: Secret
metadata:
  name: s3-config
  namespace: database
type: Opaque
stringData:
  config: |
    [default]
    aws_access_key_id = YOUR_ACCESS_KEY
    aws_secret_access_key = YOUR_SECRET_KEY
```

## Backup Encryption and Compression

### Encrypted Backup Implementation

**1. Encryption Configuration**
```bash
#!/bin/bash
# encrypted-backup.sh - Create encrypted MySQL backup

set -e

BACKUP_DIR="/backup"
ENCRYPTION_KEY_FILE="/etc/mysql-backup/encryption.key"
S3_BUCKET="s3://mysql-backups-encrypted"
BACKUP_NAME="encrypted-backup-$(date +%Y%m%d-%H%M%S)"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1"
}

# Generate encryption key if not exists
if [ ! -f "$ENCRYPTION_KEY_FILE" ]; then
    log "Generating encryption key"
    openssl rand -base64 32 > "$ENCRYPTION_KEY_FILE"
    chmod 400 "$ENCRYPTION_KEY_FILE"
fi

# Create encrypted backup
log "Creating encrypted backup: $BACKUP_NAME"

xtrabackup --backup \
    --host=production-cluster-0 \
    --user=backup \
    --password=$MYSQL_BACKUP_PASSWORD \
    --stream=xbstream \
    --parallel=4 \
    --compress \
    --compress-threads=4 | \
openssl enc -aes-256-cbc -salt -pbkdf2 \
    -pass file:$ENCRYPTION_KEY_FILE | \
aws s3 cp - "$S3_BUCKET/${BACKUP_NAME}.xbstream.enc"

# Upload encryption key to secrets manager
log "Storing encryption key in secrets manager"
aws secretsmanager create-secret \
    --name "mysql-backup-encryption-${BACKUP_NAME}" \
    --secret-string file://$ENCRYPTION_KEY_FILE \
    --region us-east-1

# Create backup metadata
cat > "${BACKUP_DIR}/${BACKUP_NAME}.meta" <<EOF
{
  "backup_name": "$BACKUP_NAME",
  "timestamp": "$(date -Iseconds)",
  "encrypted": true,
  "compression": "qpress",
  "encryption_algorithm": "aes-256-cbc",
  "encryption_key_id": "mysql-backup-encryption-${BACKUP_NAME}",
  "s3_location": "$S3_BUCKET/${BACKUP_NAME}.xbstream.enc"
}
EOF

aws s3 cp "${BACKUP_DIR}/${BACKUP_NAME}.meta" \
    "$S3_BUCKET/${BACKUP_NAME}.meta"

log "Encrypted backup completed: $BACKUP_NAME"
```

**2. Encrypted Restore Script**
```bash
#!/bin/bash
# encrypted-restore.sh - Restore from encrypted backup

set -e

BACKUP_NAME=$1
S3_BUCKET="s3://mysql-backups-encrypted"
RESTORE_DIR="/var/lib/mysql-restore"
ENCRYPTION_KEY_ID="mysql-backup-encryption-${BACKUP_NAME}"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1"
}

if [ -z "$BACKUP_NAME" ]; then
    echo "Usage: $0 <backup-name>"
    exit 1
fi

log "Restoring encrypted backup: $BACKUP_NAME"

# Retrieve encryption key from secrets manager
log "Retrieving encryption key"
aws secretsmanager get-secret-value \
    --secret-id "$ENCRYPTION_KEY_ID" \
    --query SecretString \
    --output text > /tmp/encryption.key

# Download and decrypt backup
log "Downloading and decrypting backup"
mkdir -p "$RESTORE_DIR"

aws s3 cp "$S3_BUCKET/${BACKUP_NAME}.xbstream.enc" - | \
openssl enc -d -aes-256-cbc -pbkdf2 \
    -pass file:/tmp/encryption.key | \
xbstream -x -C "$RESTORE_DIR" --parallel=4

# Decompress backup
log "Decompressing backup files"
xtrabackup --decompress \
    --target-dir="$RESTORE_DIR" \
    --parallel=4

# Prepare backup
log "Preparing backup"
xtrabackup --prepare \
    --target-dir="$RESTORE_DIR"

log "Encrypted restore completed to: $RESTORE_DIR"
log "Apply the restored data with: rsync -avrP $RESTORE_DIR/ /var/lib/mysql/"

# Cleanup
rm -f /tmp/encryption.key
```

## Disaster Recovery Testing

### Automated DR Testing Framework

**1. DR Test Script**
```bash
#!/bin/bash
# dr-test.sh - Automated disaster recovery testing

set -e

NAMESPACE="database"
SOURCE_CLUSTER="production-cluster"
DR_CLUSTER="${SOURCE_CLUSTER}-dr-test-$(date +%s)"
TEST_RESULTS_FILE="dr-test-results-$(date +%Y%m%d-%H%M%S).json"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1"
}

error() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $1" >&2
}

# Initialize test results
init_results() {
    cat > "$TEST_RESULTS_FILE" <<EOF
{
  "test_date": "$(date -Iseconds)",
  "source_cluster": "$SOURCE_CLUSTER",
  "dr_cluster": "$DR_CLUSTER",
  "tests": []
}
EOF
}

# Add test result
add_result() {
    local test_name=$1
    local status=$2
    local duration=$3
    local details=$4

    local temp_file=$(mktemp)
    jq ".tests += [{
        \"name\": \"$test_name\",
        \"status\": \"$status\",
        \"duration_seconds\": $duration,
        \"details\": \"$details\"
    }]" "$TEST_RESULTS_FILE" > "$temp_file"
    mv "$temp_file" "$TEST_RESULTS_FILE"
}

# Test 1: Backup Creation
test_backup_creation() {
    log "Test 1: Backup Creation"
    local start_time=$(date +%s)

    local backup_name="dr-test-backup-$(date +%s)"

    kubectl apply -f - <<EOF
apiVersion: pxc.percona.com/v1
kind: PerconaXtraDBClusterBackup
metadata:
  name: $backup_name
  namespace: $NAMESPACE
spec:
  pxcCluster: $SOURCE_CLUSTER
  storageName: s3-storage
EOF

    if kubectl wait --for=condition=Complete \
        --timeout=3600s \
        -n $NAMESPACE \
        pxcbackup/$backup_name; then
        local end_time=$(date +%s)
        local duration=$((end_time - start_time))
        add_result "backup_creation" "PASS" "$duration" "Backup created successfully"
        log "✓ Test 1 PASSED (${duration}s)"
        echo "$backup_name"
    else
        local end_time=$(date +%s)
        local duration=$((end_time - start_time))
        add_result "backup_creation" "FAIL" "$duration" "Backup creation failed"
        error "✗ Test 1 FAILED"
        return 1
    fi
}

# Test 2: Cluster Restoration
test_cluster_restoration() {
    local backup_name=$1
    log "Test 2: Cluster Restoration"
    local start_time=$(date +%s)

    kubectl apply -f - <<EOF
apiVersion: pxc.percona.com/v1
kind: PerconaXtraDBClusterRestore
metadata:
  name: dr-test-restore-$(date +%s)
  namespace: $NAMESPACE
spec:
  pxcCluster: $DR_CLUSTER
  backupName: $backup_name
EOF

    sleep 60

    if kubectl wait --for=condition=Ready \
        --timeout=1800s \
        -n $NAMESPACE \
        pod/${DR_CLUSTER}-pxc-0; then
        local end_time=$(date +%s)
        local duration=$((end_time - start_time))
        add_result "cluster_restoration" "PASS" "$duration" "Cluster restored successfully"
        log "✓ Test 2 PASSED (${duration}s)"
    else
        local end_time=$(date +%s)
        local duration=$((end_time - start_time))
        add_result "cluster_restoration" "FAIL" "$duration" "Cluster restoration failed"
        error "✗ Test 2 FAILED"
        return 1
    fi
}

# Test 3: Data Integrity Verification
test_data_integrity() {
    log "Test 3: Data Integrity Verification"
    local start_time=$(date +%s)

    # Get row count from source
    local source_count=$(kubectl exec -n $NAMESPACE ${SOURCE_CLUSTER}-pxc-0 -- \
        mysql -u root -p$MYSQL_ROOT_PASSWORD -e \
        "SELECT COUNT(*) FROM test_db.test_table;" -s -N 2>/dev/null || echo "0")

    # Get row count from DR
    local dr_count=$(kubectl exec -n $NAMESPACE ${DR_CLUSTER}-pxc-0 -- \
        mysql -u root -p$MYSQL_ROOT_PASSWORD -e \
        "SELECT COUNT(*) FROM test_db.test_table;" -s -N 2>/dev/null || echo "0")

    local end_time=$(date +%s)
    local duration=$((end_time - start_time))

    if [ "$source_count" == "$dr_count" ]; then
        add_result "data_integrity" "PASS" "$duration" "Row counts match: $source_count"
        log "✓ Test 3 PASSED - Row counts match: $source_count"
    else
        add_result "data_integrity" "FAIL" "$duration" "Row count mismatch: source=$source_count, dr=$dr_count"
        error "✗ Test 3 FAILED - Row count mismatch"
        return 1
    fi
}

# Test 4: Replication Lag
test_replication_lag() {
    log "Test 4: Replication Lag Check"
    local start_time=$(date +%s)

    local lag=$(kubectl exec -n $NAMESPACE ${DR_CLUSTER}-pxc-1 -- \
        mysql -u root -p$MYSQL_ROOT_PASSWORD -e \
        "SHOW SLAVE STATUS\G" 2>/dev/null | \
        grep "Seconds_Behind_Master" | awk '{print $2}')

    local end_time=$(date +%s)
    local duration=$((end_time - start_time))

    if [ "$lag" -lt 10 ]; then
        add_result "replication_lag" "PASS" "$duration" "Replication lag: ${lag}s"
        log "✓ Test 4 PASSED - Replication lag: ${lag}s"
    else
        add_result "replication_lag" "FAIL" "$duration" "High replication lag: ${lag}s"
        error "✗ Test 4 FAILED - High replication lag"
        return 1
    fi
}

# Test 5: Failover Simulation
test_failover() {
    log "Test 5: Failover Simulation"
    local start_time=$(date +%s)

    # Delete primary pod
    kubectl delete pod -n $NAMESPACE ${DR_CLUSTER}-pxc-0

    # Wait for new primary
    sleep 30

    # Check cluster status
    if kubectl exec -n $NAMESPACE ${DR_CLUSTER}-pxc-1 -- \
        mysql -u root -p$MYSQL_ROOT_PASSWORD -e "SELECT 1;" &>/dev/null; then
        local end_time=$(date +%s)
        local duration=$((end_time - start_time))
        add_result "failover_simulation" "PASS" "$duration" "Failover successful"
        log "✓ Test 5 PASSED - Failover completed"
    else
        local end_time=$(date +%s)
        local duration=$((end_time - start_time))
        add_result "failover_simulation" "FAIL" "$duration" "Failover failed"
        error "✗ Test 5 FAILED"
        return 1
    fi
}

# Cleanup DR cluster
cleanup() {
    log "Cleaning up DR test cluster"
    kubectl delete pxc -n $NAMESPACE $DR_CLUSTER --wait=false
}

# Generate report
generate_report() {
    log "Generating DR test report"

    local total_tests=$(jq '.tests | length' "$TEST_RESULTS_FILE")
    local passed_tests=$(jq '[.tests[] | select(.status=="PASS")] | length' "$TEST_RESULTS_FILE")
    local failed_tests=$(jq '[.tests[] | select(.status=="FAIL")] | length' "$TEST_RESULTS_FILE")
    local total_duration=$(jq '[.tests[].duration_seconds] | add' "$TEST_RESULTS_FILE")

    cat <<EOF | tee -a "$TEST_RESULTS_FILE"

=================================
DR Test Summary
=================================
Total Tests: $total_tests
Passed: $passed_tests
Failed: $failed_tests
Total Duration: ${total_duration}s
Success Rate: $(awk "BEGIN {printf \"%.2f\", ($passed_tests/$total_tests)*100}")%

Results saved to: $TEST_RESULTS_FILE
EOF
}

# Main execution
main() {
    log "Starting Disaster Recovery Test"

    init_results

    # Run tests
    backup_name=$(test_backup_creation) || exit 1
    test_cluster_restoration "$backup_name" || exit 1
    test_data_integrity || exit 1
    test_replication_lag || exit 1
    test_failover || exit 1

    # Generate report
    generate_report

    # Cleanup
    read -p "Delete DR test cluster? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        cleanup
    fi

    log "DR test completed"
}

main "$@"
```

## Conclusion

Implementing comprehensive MySQL backup strategies on Kubernetes requires:

1. **Multiple Backup Types**: Combine full and incremental backups
2. **Automation**: Use operators and CronJobs for scheduled backups
3. **Encryption**: Protect sensitive data with encryption at rest
4. **PITR Capability**: Enable point-in-time recovery with binary log archiving
5. **Regular Testing**: Automate disaster recovery testing
6. **Monitoring**: Track backup success and storage usage
7. **Retention Policies**: Implement automated cleanup of old backups

These configurations provide enterprise-grade MySQL backup and recovery capabilities on Kubernetes with comprehensive automation and monitoring.