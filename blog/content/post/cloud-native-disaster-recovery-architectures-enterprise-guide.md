---
title: "Cloud-Native Disaster Recovery Architectures: Enterprise Implementation Guide"
date: 2026-05-13T00:00:00-05:00
draft: false
tags: ["Disaster Recovery", "Cloud Native", "Kubernetes", "Business Continuity", "High Availability", "Backup", "DR"]
categories: ["Cloud Architecture", "Disaster Recovery", "Kubernetes"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing cloud-native disaster recovery architectures with Kubernetes, including RTO/RPO strategies, backup automation, cross-region replication, and business continuity patterns for enterprise environments."
more_link: "yes"
url: "/cloud-native-disaster-recovery-architectures-enterprise-guide/"
---

Disaster recovery (DR) in cloud-native environments requires fundamentally different approaches compared to traditional infrastructure. With Kubernetes orchestrating containerized workloads across distributed systems, organizations must implement sophisticated DR strategies that account for application state, persistent data, configuration, and infrastructure-as-code. This comprehensive guide covers enterprise-grade disaster recovery architectures, automation patterns, and operational procedures for cloud-native environments.

<!--more-->

# Disaster Recovery Fundamentals

## RTO and RPO Definition

Understanding Recovery Time Objective (RTO) and Recovery Point Objective (RPO) is critical for designing appropriate DR strategies:

```yaml
# DR tier classification with RTO/RPO requirements
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: dr-tier-definitions
  namespace: dr-system
data:
  tiers.yaml: |
    # Tier 1: Mission Critical (Highest priority)
    tier1:
      rto: "< 15 minutes"
      rpo: "< 5 minutes"
      replication: "synchronous"
      backup_frequency: "continuous"
      testing_frequency: "monthly"
      cost_multiplier: 5x
      examples:
        - payment-processing
        - authentication-services
        - core-api-services

    # Tier 2: Business Critical
    tier2:
      rto: "< 1 hour"
      rpo: "< 15 minutes"
      replication: "asynchronous"
      backup_frequency: "every-15-min"
      testing_frequency: "quarterly"
      cost_multiplier: 3x
      examples:
        - customer-portal
        - order-management
        - inventory-system

    # Tier 3: Business Important
    tier3:
      rto: "< 4 hours"
      rpo: "< 1 hour"
      replication: "scheduled"
      backup_frequency: "hourly"
      testing_frequency: "biannually"
      cost_multiplier: 2x
      examples:
        - reporting-services
        - analytics-platform
        - admin-tools

    # Tier 4: Business Operational
    tier4:
      rto: "< 24 hours"
      rpo: "< 4 hours"
      replication: "daily"
      backup_frequency: "every-4-hours"
      testing_frequency: "annually"
      cost_multiplier: 1.5x
      examples:
        - internal-tools
        - development-environments
        - test-systems
---
# Application DR tier labeling
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-processor
  namespace: production
  labels:
    app: payment-processor
    dr-tier: tier1
    criticality: mission-critical
  annotations:
    dr.policy/rto: "15m"
    dr.policy/rpo: "5m"
    dr.policy/backup-frequency: "continuous"
    dr.policy/replication: "synchronous"
spec:
  replicas: 10
  selector:
    matchLabels:
      app: payment-processor
  template:
    metadata:
      labels:
        app: payment-processor
        dr-tier: tier1
    spec:
      containers:
      - name: processor
        image: payment-processor:v2.5.1
        resources:
          requests:
            memory: "2Gi"
            cpu: "1000m"
```

## DR Architecture Patterns

```yaml
# Active-Active Multi-Region Architecture
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: dr-active-active-config
  namespace: dr-system
data:
  architecture.yaml: |
    pattern: active-active
    description: "Traffic distributed across multiple active regions"

    regions:
      - name: us-east-1
        role: primary
        traffic_percentage: 40
        capacity: 100%
        data_replication: bidirectional

      - name: us-west-2
        role: primary
        traffic_percentage: 35
        capacity: 100%
        data_replication: bidirectional

      - name: eu-west-1
        role: primary
        traffic_percentage: 25
        capacity: 100%
        data_replication: bidirectional

    failover:
      type: automatic
      detection_window: 30s
      traffic_shift_duration: 60s
      data_consistency: eventual

    benefits:
      - Zero RTO for regional failures
      - Improved performance through geographic distribution
      - Load distribution across regions
      - No idle capacity

    challenges:
      - Data consistency complexity
      - Higher operational cost
      - Complex conflict resolution
      - Increased network traffic
---
# Active-Passive Architecture
apiVersion: v1
kind: ConfigMap
metadata:
  name: dr-active-passive-config
  namespace: dr-system
data:
  architecture.yaml: |
    pattern: active-passive
    description: "Primary region active, standby region ready for failover"

    regions:
      - name: us-east-1
        role: primary
        traffic_percentage: 100
        capacity: 100%
        data_replication: source

      - name: us-west-2
        role: standby
        traffic_percentage: 0
        capacity: 30%  # Warm standby
        data_replication: destination

    failover:
      type: manual-with-automation
      detection_window: 2m
      approval_required: true
      traffic_shift_duration: 5m
      capacity_scale_duration: 10m

    benefits:
      - Lower operational cost
      - Simpler data consistency
      - Clear primary/secondary roles
      - Reduced complexity

    challenges:
      - Higher RTO (5-15 minutes)
      - Idle standby capacity cost
      - Requires failover procedure
      - Data replication lag
```

# Kubernetes Backup Strategies

## Velero for Cluster Backup

```yaml
# Velero installation with multi-region support
---
apiVersion: v1
kind: Namespace
metadata:
  name: velero
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: velero
  namespace: velero
---
# AWS credentials for S3 backup storage
apiVersion: v1
kind: Secret
metadata:
  name: cloud-credentials
  namespace: velero
type: Opaque
stringData:
  cloud: |
    [default]
    aws_access_key_id=${AWS_ACCESS_KEY_ID}
    aws_secret_access_key=${AWS_SECRET_ACCESS_KEY}
---
# Velero BackupStorageLocation for primary region
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: primary-s3
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: velero-backups-us-east-1
    prefix: production
  config:
    region: us-east-1
    s3ForcePathStyle: "false"
    s3Url: https://s3.us-east-1.amazonaws.com
---
# DR region backup storage
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: dr-s3
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: velero-backups-us-west-2
    prefix: production
  config:
    region: us-west-2
    s3ForcePathStyle: "false"
    s3Url: https://s3.us-west-2.amazonaws.com
---
# Volume snapshot location
apiVersion: velero.io/v1
kind: VolumeSnapshotLocation
metadata:
  name: aws-snapshots
  namespace: velero
spec:
  provider: aws
  config:
    region: us-east-1
---
# Scheduled backup for Tier 1 applications
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: tier1-backup
  namespace: velero
spec:
  schedule: "*/5 * * * *"  # Every 5 minutes
  template:
    includedNamespaces:
    - production
    - payment-system
    includedResources:
    - '*'
    labelSelector:
      matchLabels:
        dr-tier: tier1
    snapshotVolumes: true
    storageLocation: primary-s3
    volumeSnapshotLocations:
    - aws-snapshots
    ttl: 168h  # 7 days retention
    hooks:
      resources:
      - name: postgres-backup-hook
        includedNamespaces:
        - production
        labelSelector:
          matchLabels:
            app: postgres
        pre:
        - exec:
            container: postgres
            command:
            - /bin/bash
            - -c
            - pg_dump -U $POSTGRES_USER $POSTGRES_DB > /tmp/backup.sql
            onError: Fail
            timeout: 10m
        post:
        - exec:
            container: postgres
            command:
            - /bin/bash
            - -c
            - rm -f /tmp/backup.sql
---
# Tier 2 backup schedule
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: tier2-backup
  namespace: velero
spec:
  schedule: "*/15 * * * *"  # Every 15 minutes
  template:
    includedNamespaces:
    - production
    labelSelector:
      matchLabels:
        dr-tier: tier2
    snapshotVolumes: true
    storageLocation: primary-s3
    ttl: 336h  # 14 days retention
---
# Daily full cluster backup
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: full-cluster-backup
  namespace: velero
spec:
  schedule: "0 2 * * *"  # 2 AM daily
  template:
    includedNamespaces:
    - '*'
    includedResources:
    - '*'
    snapshotVolumes: true
    storageLocation: primary-s3
    volumeSnapshotLocations:
    - aws-snapshots
    ttl: 720h  # 30 days retention
```

## Application-Aware Backup Hooks

```yaml
# MySQL backup with consistent snapshots
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: mysql-backup-hooks
  namespace: production
data:
  pre-backup.sh: |
    #!/bin/bash
    set -e
    echo "Starting MySQL pre-backup hook"

    # Flush tables and acquire read lock
    mysql -u root -p${MYSQL_ROOT_PASSWORD} <<EOF
    FLUSH TABLES WITH READ LOCK;
    SYSTEM /backup/create-marker.sh;
    EOF

    echo "MySQL pre-backup hook completed"

  post-backup.sh: |
    #!/bin/bash
    set -e
    echo "Starting MySQL post-backup hook"

    # Release read lock
    mysql -u root -p${MYSQL_ROOT_PASSWORD} <<EOF
    UNLOCK TABLES;
    EOF

    echo "MySQL post-backup hook completed"
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mysql
  namespace: production
  labels:
    app: mysql
    dr-tier: tier1
  annotations:
    backup.velero.io/backup-volumes: data
    pre.hook.backup.velero.io/container: mysql
    pre.hook.backup.velero.io/command: '["/bin/bash", "/backup/pre-backup.sh"]'
    pre.hook.backup.velero.io/on-error: Fail
    post.hook.backup.velero.io/container: mysql
    post.hook.backup.velero.io/command: '["/bin/bash", "/backup/post-backup.sh"]'
spec:
  serviceName: mysql
  replicas: 3
  selector:
    matchLabels:
      app: mysql
  template:
    metadata:
      labels:
        app: mysql
    spec:
      containers:
      - name: mysql
        image: mysql:8.0
        env:
        - name: MYSQL_ROOT_PASSWORD
          valueFrom:
            secretKeyRef:
              name: mysql-secret
              key: root-password
        volumeMounts:
        - name: data
          mountPath: /var/lib/mysql
        - name: backup-hooks
          mountPath: /backup
      volumes:
      - name: backup-hooks
        configMap:
          name: mysql-backup-hooks
          defaultMode: 0755
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

# Cross-Region Data Replication

## PostgreSQL Streaming Replication

```yaml
# PostgreSQL with cross-region replication
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: postgres-primary-config
  namespace: database
data:
  postgresql.conf: |
    # Connection settings
    listen_addresses = '*'
    max_connections = 500
    superuser_reserved_connections = 10

    # Memory settings
    shared_buffers = 4GB
    effective_cache_size = 12GB
    maintenance_work_mem = 1GB
    work_mem = 20MB

    # WAL settings for replication
    wal_level = replica
    max_wal_senders = 10
    max_replication_slots = 10
    wal_keep_size = 1GB
    hot_standby = on
    hot_standby_feedback = on

    # Checkpoint settings
    checkpoint_completion_target = 0.9
    checkpoint_timeout = 15min
    max_wal_size = 4GB
    min_wal_size = 1GB

    # Replication settings
    synchronous_commit = remote_apply  # For synchronous replication
    synchronous_standby_names = 'standby1,standby2'

    # Archive settings
    archive_mode = on
    archive_command = 'aws s3 cp %p s3://postgres-wal-archive/%f --region us-east-1'
    restore_command = 'aws s3 cp s3://postgres-wal-archive/%f %p --region us-east-1'

  pg_hba.conf: |
    local   all             all                                     trust
    host    all             all             127.0.0.1/32            trust
    host    all             all             ::1/128                 trust
    host    replication     replicator      0.0.0.0/0               md5
    host    all             all             0.0.0.0/0               md5
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres-primary
  namespace: database
  labels:
    app: postgres
    role: primary
    region: us-east-1
    dr-tier: tier1
spec:
  serviceName: postgres-primary
  replicas: 1
  selector:
    matchLabels:
      app: postgres
      role: primary
  template:
    metadata:
      labels:
        app: postgres
        role: primary
    spec:
      containers:
      - name: postgres
        image: postgres:15.3
        ports:
        - containerPort: 5432
          name: postgres
        env:
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-secret
              key: password
        - name: POSTGRES_USER
          value: "admin"
        - name: POSTGRES_DB
          value: "production"
        - name: PGDATA
          value: "/var/lib/postgresql/data/pgdata"
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
        - name: config
          mountPath: /etc/postgresql
        - name: wal-archive
          mountPath: /wal-archive
        livenessProbe:
          exec:
            command:
            - /bin/sh
            - -c
            - pg_isready -U admin
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          exec:
            command:
            - /bin/sh
            - -c
            - pg_isready -U admin
          initialDelaySeconds: 10
          periodSeconds: 5
        resources:
          requests:
            memory: "8Gi"
            cpu: "4000m"
          limits:
            memory: "16Gi"
            cpu: "8000m"
      volumes:
      - name: config
        configMap:
          name: postgres-primary-config
      - name: wal-archive
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
---
# PostgreSQL standby replica in DR region
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres-standby
  namespace: database
  labels:
    app: postgres
    role: standby
    region: us-west-2
spec:
  serviceName: postgres-standby
  replicas: 2
  selector:
    matchLabels:
      app: postgres
      role: standby
  template:
    metadata:
      labels:
        app: postgres
        role: standby
    spec:
      initContainers:
      - name: setup-replication
        image: postgres:15.3
        command:
        - bash
        - -c
        - |
          set -e
          if [ ! -f /var/lib/postgresql/data/pgdata/PG_VERSION ]; then
            echo "Setting up streaming replication..."

            # Create base backup from primary
            PGPASSWORD=$REPLICATION_PASSWORD pg_basebackup \
              -h postgres-primary.database.svc.cluster.local \
              -D /var/lib/postgresql/data/pgdata \
              -U replicator \
              -X stream \
              -c fast \
              -P \
              -R

            # Configure standby settings
            cat >> /var/lib/postgresql/data/pgdata/postgresql.auto.conf <<EOF
          primary_conninfo = 'host=postgres-primary.database.svc.cluster.local port=5432 user=replicator password=$REPLICATION_PASSWORD application_name=standby1'
          primary_slot_name = 'standby1_slot'
          restore_command = 'aws s3 cp s3://postgres-wal-archive/%f %p --region us-east-1'
          EOF

            echo "Replication setup complete"
          else
            echo "Database already initialized"
          fi
        env:
        - name: REPLICATION_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-secret
              key: replication-password
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
      containers:
      - name: postgres
        image: postgres:15.3
        ports:
        - containerPort: 5432
          name: postgres
        env:
        - name: PGDATA
          value: "/var/lib/postgresql/data/pgdata"
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
        resources:
          requests:
            memory: "8Gi"
            cpu: "4000m"
          limits:
            memory: "16Gi"
            cpu: "8000m"
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: fast-ssd
      resources:
        requests:
          storage: 500Gi
```

## Redis Cross-Region Replication

```yaml
# Redis with active-passive replication
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: redis-primary-config
  namespace: cache
data:
  redis.conf: |
    bind 0.0.0.0
    protected-mode yes
    requirepass ${REDIS_PASSWORD}
    port 6379
    tcp-backlog 511
    timeout 0
    tcp-keepalive 300

    # Persistence
    save 900 1
    save 300 10
    save 60 10000
    stop-writes-on-bgsave-error yes
    rdbcompression yes
    rdbchecksum yes
    dbfilename dump.rdb
    dir /data

    # Replication
    min-replicas-to-write 1
    min-replicas-max-lag 10
    replica-serve-stale-data no
    replica-priority 100

    # AOF persistence
    appendonly yes
    appendfilename "appendonly.aof"
    appendfsync everysec
    no-appendfsync-on-rewrite no
    auto-aof-rewrite-percentage 100
    auto-aof-rewrite-min-size 64mb

    # Memory management
    maxmemory 8gb
    maxmemory-policy allkeys-lru
    lazyfree-lazy-eviction yes
    lazyfree-lazy-expire yes
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis-primary
  namespace: cache
  labels:
    app: redis
    role: primary
    region: us-east-1
    dr-tier: tier1
spec:
  serviceName: redis-primary
  replicas: 1
  selector:
    matchLabels:
      app: redis
      role: primary
  template:
    metadata:
      labels:
        app: redis
        role: primary
      annotations:
        backup.velero.io/backup-volumes: data
    spec:
      containers:
      - name: redis
        image: redis:7.2
        command:
        - redis-server
        - /conf/redis.conf
        ports:
        - containerPort: 6379
          name: redis
        env:
        - name: REDIS_PASSWORD
          valueFrom:
            secretKeyRef:
              name: redis-secret
              key: password
        volumeMounts:
        - name: config
          mountPath: /conf
        - name: data
          mountPath: /data
        livenessProbe:
          exec:
            command:
            - redis-cli
            - --raw
            - incr
            - ping
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          exec:
            command:
            - redis-cli
            - --raw
            - incr
            - ping
          initialDelaySeconds: 10
          periodSeconds: 5
        resources:
          requests:
            memory: "8Gi"
            cpu: "2000m"
          limits:
            memory: "16Gi"
            cpu: "4000m"
      volumes:
      - name: config
        configMap:
          name: redis-primary-config
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: fast-ssd
      resources:
        requests:
          storage: 100Gi
---
# Redis replica in DR region
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis-replica
  namespace: cache
  labels:
    app: redis
    role: replica
    region: us-west-2
spec:
  serviceName: redis-replica
  replicas: 2
  selector:
    matchLabels:
      app: redis
      role: replica
  template:
    metadata:
      labels:
        app: redis
        role: replica
    spec:
      containers:
      - name: redis
        image: redis:7.2
        command:
        - redis-server
        - --replicaof
        - redis-primary.cache.svc.cluster.local
        - "6379"
        - --masterauth
        - $(REDIS_PASSWORD)
        - --requirepass
        - $(REDIS_PASSWORD)
        ports:
        - containerPort: 6379
          name: redis
        env:
        - name: REDIS_PASSWORD
          valueFrom:
            secretKeyRef:
              name: redis-secret
              key: password
        volumeMounts:
        - name: data
          mountPath: /data
        resources:
          requests:
            memory: "8Gi"
            cpu: "2000m"
          limits:
            memory: "16Gi"
            cpu: "4000m"
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

# Automated DR Testing and Validation

## DR Test Orchestration

```python
#!/usr/bin/env python3
"""
Automated disaster recovery testing framework
"""

import time
import logging
from datetime import datetime
from kubernetes import client, config
import boto3
from typing import Dict, List

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class DRTestOrchestrator:
    def __init__(self, primary_region: str, dr_region: str):
        self.primary_region = primary_region
        self.dr_region = dr_region
        self.test_results = []

    def run_dr_test(self, test_type: str = "full"):
        """Execute DR test scenario"""
        logger.info(f"Starting DR test: {test_type}")
        test_start = datetime.now()

        try:
            # Phase 1: Pre-test validation
            logger.info("Phase 1: Pre-test validation")
            self.validate_primary_cluster()
            self.validate_dr_cluster()
            self.validate_backups()

            # Phase 2: Simulate failure
            logger.info("Phase 2: Simulating primary region failure")
            self.simulate_primary_failure()

            # Phase 3: Initiate failover
            logger.info("Phase 3: Initiating failover to DR region")
            failover_start = datetime.now()
            self.perform_failover()
            failover_duration = (datetime.now() - failover_start).total_seconds()

            # Phase 4: Validate DR environment
            logger.info("Phase 4: Validating DR environment")
            self.validate_dr_services()
            self.validate_data_integrity()
            self.run_smoke_tests()

            # Phase 5: Measure RTO/RPO
            logger.info("Phase 5: Measuring RTO/RPO")
            rto = failover_duration / 60  # minutes
            rpo = self.measure_data_loss()  # minutes

            # Phase 6: Failback to primary
            logger.info("Phase 6: Failing back to primary region")
            self.perform_failback()

            # Phase 7: Post-test validation
            logger.info("Phase 7: Post-test validation")
            self.validate_primary_cluster()

            test_duration = (datetime.now() - test_start).total_seconds()

            # Record results
            result = {
                'test_type': test_type,
                'start_time': test_start.isoformat(),
                'duration_seconds': test_duration,
                'rto_minutes': rto,
                'rpo_minutes': rpo,
                'status': 'passed',
                'phases_completed': 7
            }

            self.test_results.append(result)
            logger.info(f"DR test completed successfully: RTO={rto:.2f}m, RPO={rpo:.2f}m")

            return result

        except Exception as e:
            logger.error(f"DR test failed: {str(e)}")
            result = {
                'test_type': test_type,
                'start_time': test_start.isoformat(),
                'status': 'failed',
                'error': str(e)
            }
            self.test_results.append(result)
            raise

    def validate_primary_cluster(self):
        """Validate primary cluster health"""
        config.load_kube_config(context=f"eks-{self.primary_region}")
        v1 = client.CoreV1Api()

        # Check node status
        nodes = v1.list_node()
        ready_nodes = sum(1 for node in nodes.items
                         if any(c.type == "Ready" and c.status == "True"
                               for c in node.status.conditions))

        if ready_nodes < len(nodes.items) * 0.9:
            raise Exception(f"Primary cluster unhealthy: {ready_nodes}/{len(nodes.items)} nodes ready")

        logger.info(f"Primary cluster healthy: {ready_nodes} nodes ready")

    def validate_dr_cluster(self):
        """Validate DR cluster readiness"""
        config.load_kube_config(context=f"eks-{self.dr_region}")
        v1 = client.CoreV1Api()

        # Check DR deployments are scaled to minimum
        apps_v1 = client.AppsV1Api()
        deployments = apps_v1.list_deployment_for_all_namespaces(
            label_selector="dr-role=passive"
        )

        for deployment in deployments.items:
            if deployment.status.available_replicas < deployment.spec.replicas:
                raise Exception(f"DR deployment {deployment.metadata.name} not ready")

        logger.info("DR cluster ready for failover")

    def validate_backups(self):
        """Validate backup availability and integrity"""
        # Check Velero backups
        config.load_kube_config(context=f"eks-{self.primary_region}")
        custom_api = client.CustomObjectsApi()

        backups = custom_api.list_namespaced_custom_object(
            group="velero.io",
            version="v1",
            namespace="velero",
            plural="backups",
            label_selector="dr-tier=tier1"
        )

        recent_backups = [b for b in backups['items']
                         if (datetime.now() - datetime.fromisoformat(
                             b['status']['startTimestamp'].replace('Z', '+00:00'))
                            ).total_seconds() < 600]  # Last 10 minutes

        if not recent_backups:
            raise Exception("No recent backups found for tier1 applications")

        logger.info(f"Found {len(recent_backups)} recent backups")

    def simulate_primary_failure(self):
        """Simulate primary region failure"""
        # In test mode, just update DNS weights to simulate failure
        # In production, this would be an actual failure scenario
        logger.info("Simulating primary region failure (test mode)")
        time.sleep(5)

    def perform_failover(self):
        """Perform failover to DR region"""
        config.load_kube_config(context=f"eks-{self.dr_region}")
        apps_v1 = client.AppsV1Api()

        # Scale up DR deployments
        deployments = apps_v1.list_deployment_for_all_namespaces(
            label_selector="dr-role=passive"
        )

        for deployment in deployments.items:
            target_replicas = int(
                deployment.metadata.annotations.get('dr-target-replicas', '10')
            )

            deployment.spec.replicas = target_replicas

            apps_v1.patch_namespaced_deployment(
                name=deployment.metadata.name,
                namespace=deployment.metadata.namespace,
                body=deployment
            )

            logger.info(f"Scaled {deployment.metadata.name} to {target_replicas} replicas")

        # Wait for deployments to be ready
        time.sleep(60)

        # Update DNS to point to DR region
        self.update_dns_to_dr()

    def update_dns_to_dr(self):
        """Update DNS to DR region"""
        route53 = boto3.client('route53')

        # Update Route53 weighted routing
        route53.change_resource_record_sets(
            HostedZoneId='Z1234567890ABC',
            ChangeBatch={
                'Changes': [
                    {
                        'Action': 'UPSERT',
                        'ResourceRecordSet': {
                            'Name': 'api.example.com',
                            'Type': 'CNAME',
                            'SetIdentifier': self.dr_region,
                            'Weight': 100,
                            'TTL': 60,
                            'ResourceRecords': [
                                {'Value': f'lb-{self.dr_region}.example.com'}
                            ]
                        }
                    }
                ]
            }
        )

        logger.info("Updated DNS to DR region")

    def validate_dr_services(self):
        """Validate services running in DR region"""
        config.load_kube_config(context=f"eks-{self.dr_region}")
        apps_v1 = client.AppsV1Api()

        deployments = apps_v1.list_deployment_for_all_namespaces(
            label_selector="dr-tier=tier1"
        )

        for deployment in deployments.items:
            if deployment.status.available_replicas < deployment.spec.replicas * 0.9:
                raise Exception(f"Deployment {deployment.metadata.name} not healthy in DR")

        logger.info("All critical services healthy in DR region")

    def validate_data_integrity(self):
        """Validate data integrity after failover"""
        # Check database replication lag
        # Verify data consistency
        # Compare checksums
        logger.info("Data integrity validated")

    def run_smoke_tests(self):
        """Run smoke tests against DR environment"""
        import requests

        # Test critical endpoints
        endpoints = [
            'https://api.example.com/health',
            'https://api.example.com/api/v1/status',
        ]

        for endpoint in endpoints:
            response = requests.get(endpoint, timeout=10)
            if response.status_code != 200:
                raise Exception(f"Smoke test failed for {endpoint}: {response.status_code}")

        logger.info("Smoke tests passed")

    def measure_data_loss(self) -> float:
        """Measure data loss (RPO) in minutes"""
        # Compare last transaction in primary vs DR
        # Calculate time difference
        # Return in minutes
        return 3.5  # Example: 3.5 minutes of data loss

    def perform_failback(self):
        """Failback to primary region"""
        # Restore primary cluster
        # Sync data from DR to primary
        # Update DNS back to primary
        # Scale down DR deployments
        logger.info("Failback to primary region completed")

    def generate_report(self) -> str:
        """Generate DR test report"""
        report = []
        report.append("=" * 80)
        report.append("DISASTER RECOVERY TEST REPORT")
        report.append("=" * 80)
        report.append("")

        for result in self.test_results:
            report.append(f"Test Type: {result['test_type']}")
            report.append(f"Start Time: {result['start_time']}")
            report.append(f"Status: {result['status']}")

            if result['status'] == 'passed':
                report.append(f"Duration: {result['duration_seconds']:.2f} seconds")
                report.append(f"RTO Achieved: {result['rto_minutes']:.2f} minutes")
                report.append(f"RPO Measured: {result['rpo_minutes']:.2f} minutes")
                report.append(f"Phases Completed: {result['phases_completed']}/7")
            else:
                report.append(f"Error: {result.get('error', 'Unknown error')}")

            report.append("")

        return "\n".join(report)

if __name__ == '__main__':
    orchestrator = DRTestOrchestrator(
        primary_region='us-east-1',
        dr_region='us-west-2'
    )

    # Run monthly DR test
    result = orchestrator.run_dr_test(test_type='full')

    # Generate and save report
    report = orchestrator.generate_report()
    print(report)

    with open(f"dr-test-{datetime.now().strftime('%Y%m%d')}.txt", 'w') as f:
        f.write(report)
```

# DR Runbook and Procedures

## Failover Runbook

```bash
#!/bin/bash
# Disaster Recovery Failover Runbook
# Execute this script to failover to DR region

set -e

PRIMARY_REGION="us-east-1"
DR_REGION="us-west-2"
PRIMARY_CLUSTER="prod-us-east"
DR_CLUSTER="prod-us-west"

echo "========================================="
echo "DISASTER RECOVERY FAILOVER PROCEDURE"
echo "========================================="
echo ""
echo "Primary Region: $PRIMARY_REGION"
echo "DR Region: $DR_REGION"
echo ""
read -p "Are you sure you want to proceed with failover? (yes/no): " confirm

if [ "$confirm" != "yes" ]; then
    echo "Failover cancelled"
    exit 0
fi

echo ""
echo "Step 1: Verify DR cluster health"
kubectl config use-context $DR_CLUSTER
kubectl get nodes
kubectl get pods --all-namespaces | grep -v Running || true

read -p "DR cluster appears healthy. Continue? (yes/no): " confirm
if [ "$confirm" != "yes" ]; then exit 1; fi

echo ""
echo "Step 2: Scale up DR deployments"
kubectl config use-context $DR_CLUSTER

# Scale tier1 applications
for ns in $(kubectl get ns -l dr-tier=tier1 -o jsonpath='{.items[*].metadata.name}'); do
    echo "Scaling deployments in namespace: $ns"
    for deploy in $(kubectl get deploy -n $ns -l dr-role=passive -o jsonpath='{.items[*].metadata.name}'); do
        target=$(kubectl get deploy $deploy -n $ns -o jsonpath='{.metadata.annotations.dr-target-replicas}')
        echo "  Scaling $deploy to $target replicas"
        kubectl scale deploy $deploy -n $ns --replicas=$target
    done
done

echo ""
echo "Step 3: Wait for deployments to be ready (5 minutes)"
sleep 300

kubectl get deployments --all-namespaces -l dr-tier=tier1

read -p "All deployments ready? (yes/no): " confirm
if [ "$confirm" != "yes" ]; then exit 1; fi

echo ""
echo "Step 4: Update DNS to DR region"
python3 << 'EOF'
import boto3

route53 = boto3.client('route53')

# Update weighted routing to send all traffic to DR
route53.change_resource_record_sets(
    HostedZoneId='Z1234567890ABC',
    ChangeBatch={
        'Comment': 'DR Failover',
        'Changes': [
            {
                'Action': 'UPSERT',
                'ResourceRecordSet': {
                    'Name': 'api.example.com',
                    'Type': 'CNAME',
                    'SetIdentifier': 'us-east-1',
                    'Weight': 0,
                    'TTL': 60,
                    'ResourceRecords': [{'Value': 'lb-us-east-1.example.com'}]
                }
            },
            {
                'Action': 'UPSERT',
                'ResourceRecordSet': {
                    'Name': 'api.example.com',
                    'Type': 'CNAME',
                    'SetIdentifier': 'us-west-2',
                    'Weight': 100,
                    'TTL': 60,
                    'ResourceRecords': [{'Value': 'lb-us-west-2.example.com'}]
                }
            }
        ]
    }
)

print("DNS updated to DR region")
EOF

echo ""
echo "Step 5: Verify application availability"
sleep 60  # Wait for DNS propagation

for endpoint in "https://api.example.com/health" "https://app.example.com/health"; do
    echo "Testing $endpoint"
    curl -f $endpoint || echo "WARNING: Endpoint not responding"
done

echo ""
echo "========================================="
echo "FAILOVER COMPLETE"
echo "========================================="
echo ""
echo "Next steps:"
echo "1. Monitor application performance in DR region"
echo "2. Investigate primary region failure"
echo "3. Plan failback procedure when primary is restored"
echo ""
echo "Failover time: $(date)"
```

# Conclusion

Cloud-native disaster recovery requires comprehensive planning, automated tooling, and regular testing to ensure business continuity. By implementing tiered DR strategies, automated backup and replication, cross-region failover capabilities, and validated recovery procedures, organizations can achieve their RTO and RPO objectives while maintaining operational excellence.

Key implementation principles:

- **Tiered Approach**: Classify applications by criticality and set appropriate RTO/RPO targets
- **Automated Backup**: Implement continuous backup with Velero and application-aware hooks
- **Data Replication**: Configure synchronous or asynchronous replication based on DR tier
- **Automated Failover**: Deploy monitoring and automated failover for mission-critical workloads
- **Regular Testing**: Conduct DR tests monthly/quarterly to validate procedures
- **Documentation**: Maintain detailed runbooks and automate where possible

By treating disaster recovery as a first-class concern in your cloud-native architecture, you can build resilient systems that withstand failures while minimizing business impact.