---
title: "MongoDB Community Operator: Production Deployment on Kubernetes"
date: 2027-03-25T00:00:00-05:00
draft: false
tags: ["Kubernetes", "MongoDB", "Operator", "Database", "ReplicaSet"]
categories: ["Kubernetes", "Databases", "Operators"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to MongoDB Community Operator on Kubernetes covering MongoDBCommunity CRD deployment, replica set configuration, TLS/authentication, user management, Prometheus monitoring with mongodb-exporter, backup with Percona Backup for MongoDB, and operational procedures."
more_link: "yes"
url: "/mongodb-operator-kubernetes-production-guide/"
---

The MongoDB Community Operator brings declarative, Kubernetes-native lifecycle management to MongoDB replica sets. Rather than manually bootstrapping `rs.initiate()`, configuring authentication, managing TLS certificates, and scripting rolling upgrades, the operator reconciles a `MongoDBCommunity` custom resource against the running state of a StatefulSet-managed replica set. The operator handles initial cluster formation, replica set reconfiguration on scaling events, automated TLS certificate rotation, and user credential management through Kubernetes Secrets.

This guide covers the complete production deployment: operator installation, `MongoDBCommunity` CRD configuration with authentication and TLS, user management via the CRD spec, mongodb-exporter sidecar for Prometheus, backup with Percona Backup for MongoDB, PITR, operational commands via mongosh, and rolling upgrade procedures.

<!--more-->

## Section 1: Architecture Overview

### Replica Set Topology

```
┌─────────────────────────────────────────────────────────────┐
│  MongoDB Community Operator (Deployment)                    │
│  - Watches MongoDBCommunity CRDs                            │
│  - Manages StatefulSet, Services, ConfigMaps, Secrets       │
│  - Injects init containers for rs.initiate() and auth setup │
└─────────────────────────────────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          │               │               │
     ┌────▼────┐    ┌─────▼───┐    ┌─────▼───┐
     │ mongo-0 │    │ mongo-1 │    │ mongo-2 │
     │ PRIMARY │    │Secondary│    │Secondary│
     │ (OpLog) │    │(OpLog   │    │(OpLog   │
     │         │◄───│ stream) │    │ stream) │
     └────┬────┘    └─────────┘    └─────────┘
          │
     ┌────▼──────────────────────────────────────┐
     │  Services                                  │
     │  mongo-rs-svc          → all members       │
     │  mongo-rs-svc-0.svc    → Pod-0 directly    │
     │  (headless: mongo-rs-svc-headless)         │
     └────────────────────────────────────────────┘
```

### Key Operator Responsibilities

- StatefulSet creation and rolling update management
- Replica set initialization (`rs.initiate()`) via a one-time Job
- User and role creation via `db.createUser()` reconciliation
- TLS certificate injection via volume mounts
- SCRAM-SHA-256 credential generation from Kubernetes Secrets
- Version upgrades via ordered StatefulSet pod replacement

---

## Section 2: Operator Installation

### Install via Helm

```bash
helm repo add mongodb https://mongodb.github.io/helm-charts
helm repo update

helm upgrade --install community-operator \
  mongodb/community-operator \
  --namespace mongodb-operator \
  --create-namespace \
  --version 0.11.0 \
  --set operator.watchNamespace="*" \
  --wait
```

### Verify Installation

```bash
# Check operator Pod
kubectl get pods -n mongodb-operator

# Check CRDs
kubectl get crd | grep mongodb
# Expected:
# mongodbcommunity.mongodbcommunity.mongodb.com
# mongodbusers.mongodbcommunity.mongodb.com
```

---

## Section 3: MongoDBCommunity CRD — Basic Replica Set

### Namespace and Secrets

```bash
kubectl create namespace databases

# Admin user credentials
kubectl create secret generic mongodb-admin-credentials \
  --namespace databases \
  --from-literal=password='StrongAdminPassword2024!'

# Application user credentials
kubectl create secret generic mongodb-app-credentials \
  --namespace databases \
  --from-literal=password='StrongAppPassword2024!'
```

### MongoDBCommunity CRD

```yaml
# mongodb-production.yaml
apiVersion: mongodbcommunity.mongodb.com/v1
kind: MongoDBCommunity
metadata:
  name: mongo-production
  namespace: databases
spec:
  # Number of replica set members
  members: 3

  # MongoDB version
  type: ReplicaSet
  version: "7.0.8"

  # Security configuration
  security:
    authentication:
      modes:
        - SCRAM
        - SCRAM-SHA-256     # Preferred for all new connections

  # User definitions (operator reconciles these into the database)
  users:
    - name: admin
      db: admin
      passwordSecretRef:
        name: mongodb-admin-credentials
      roles:
        - name: clusterAdmin
          db: admin
        - name: userAdminAnyDatabase
          db: admin
        - name: readWriteAnyDatabase
          db: admin
        - name: dbAdminAnyDatabase
          db: admin
      scramCredentialsSecretName: mongodb-admin-scram

    - name: appuser
      db: appdb
      passwordSecretRef:
        name: mongodb-app-credentials
      roles:
        - name: readWrite
          db: appdb
        - name: dbAdmin
          db: appdb
      scramCredentialsSecretName: mongodb-app-scram

  # Custom MongoDB configuration
  additionalMongodConfig:
    storage.wiredTiger.engineConfig.journalCompressor: snappy
    storage.wiredTiger.collectionConfig.blockCompressor: snappy
    storage.wiredTiger.indexConfig.prefixCompression: true
    operationProfiling.slowOpThresholdMs: 100
    operationProfiling.mode: slowOp
    net.maxIncomingConnections: 1000

  # StatefulSet override for resource allocation
  statefulSet:
    spec:
      template:
        spec:
          containers:
            - name: mongod
              resources:
                requests:
                  cpu: "1"
                  memory: "2Gi"
                limits:
                  cpu: "4"
                  memory: "8Gi"
          affinity:
            podAntiAffinity:
              requiredDuringSchedulingIgnoredDuringExecution:
                - labelSelector:
                    matchExpressions:
                      - key: app
                        operator: In
                        values:
                          - mongo-production
                  topologyKey: kubernetes.io/hostname

      # PVC template for data storage
      volumeClaimTemplates:
        - metadata:
            name: data-volume
          spec:
            storageClassName: premium-rwo
            accessModes:
              - ReadWriteOnce
            resources:
              requests:
                storage: 100Gi
        - metadata:
            name: logs-volume
          spec:
            storageClassName: standard-rwo
            accessModes:
              - ReadWriteOnce
            resources:
              requests:
                storage: 10Gi
```

### Verify Cluster Status

```bash
# Watch operator reconcile the replica set
kubectl get mongodbcommunity -n databases -w

# Check StatefulSet rollout
kubectl rollout status statefulset mongo-production -n databases

# Connect to primary and check RS status
kubectl exec -n databases mongo-production-0 -- \
  mongosh admin \
    --username admin \
    --password 'StrongAdminPassword2024!' \
    --eval "rs.status()"
```

---

## Section 4: Arbiter Configuration

An arbiter participates in elections but holds no data. Use it in a two-data-node deployment to achieve an odd-number quorum without the cost of a third full member.

```yaml
# mongodb-with-arbiter.yaml (partial)
spec:
  members: 3   # 2 data members + 1 arbiter = 3 total

  # Mark the third member as an arbiter
  memberConfig:
    - votes: 1
      priority: 2       # Higher priority = preferred primary
    - votes: 1
      priority: 1
    - votes: 1
      priority: 0       # Arbiter: cannot become primary
      arbiter: true
```

---

## Section 5: TLS Configuration with cert-manager

### Create CA and Server Certificates

```yaml
# mongodb-tls.yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: mongodb-production-tls
  namespace: databases
spec:
  secretName: mongodb-production-tls-secret
  duration: 8760h
  renewBefore: 720h
  subject:
    organizations:
      - "company.internal"
  commonName: "mongo-production-svc"
  dnsNames:
    # Service DNS names
    - "mongo-production-svc.databases.svc.cluster.local"
    - "mongo-production-svc-headless.databases.svc.cluster.local"
    # Per-Pod DNS names (headless service)
    - "mongo-production-0.mongo-production-svc.databases.svc.cluster.local"
    - "mongo-production-1.mongo-production-svc.databases.svc.cluster.local"
    - "mongo-production-2.mongo-production-svc.databases.svc.cluster.local"
  issuerRef:
    name: company-internal-issuer
    kind: ClusterIssuer
```

### Enable TLS in MongoDBCommunity

```yaml
# mongodb-tls-enabled.yaml (partial)
spec:
  security:
    authentication:
      modes:
        - SCRAM-SHA-256
    tls:
      enabled: true
      certificateKeySecretRef:
        name: mongodb-production-tls-secret
      caConfigMapRef:
        name: mongodb-ca-configmap    # ConfigMap containing ca.crt
```

### Create CA ConfigMap

```bash
# Extract CA certificate from cert-manager secret and create ConfigMap
kubectl get secret mongodb-production-tls-secret \
  --namespace databases \
  -o jsonpath='{.data.ca\.crt}' \
  | base64 -d > /tmp/mongo-ca.crt

kubectl create configmap mongodb-ca-configmap \
  --namespace databases \
  --from-file=ca.crt=/tmp/mongo-ca.crt
```

### Test TLS Connection

```bash
# Connect with TLS verification
kubectl exec -n databases mongo-production-0 -- \
  mongosh \
    "mongodb://appuser:StrongAppPassword2024!@mongo-production-svc.databases.svc.cluster.local:27017/appdb?tls=true&tlsCAFile=/var/lib/tls/ca/ca.crt"
```

---

## Section 6: Connection String Format for Applications

### Standard Replica Set Connection String

```bash
# DNS seedlist format (recommended: automatically discovers all members)
# mongodb+srv requires a DNS SRV record — use standard format in Kubernetes
mongodb://appuser:StrongAppPassword2024!@mongo-production-0.mongo-production-svc.databases.svc.cluster.local:27017,mongo-production-1.mongo-production-svc.databases.svc.cluster.local:27017,mongo-production-2.mongo-production-svc.databases.svc.cluster.local:27017/appdb?replicaSet=mongo-production&authSource=appdb

# Simplified via service (driver uses hello/isMaster to discover members)
mongodb://appuser:StrongAppPassword2024!@mongo-production-svc.databases.svc.cluster.local:27017/appdb?replicaSet=mongo-production&authSource=appdb

# With TLS
mongodb://appuser:StrongAppPassword2024!@mongo-production-svc.databases.svc.cluster.local:27017/appdb?replicaSet=mongo-production&authSource=appdb&tls=true&tlsCAFile=/etc/ssl/mongo-ca.crt
```

### Read Preference for Analytics Workloads

```bash
# Route reads to secondary members (reduces primary load)
mongodb://appuser:StrongAppPassword2024!@mongo-production-svc.databases.svc.cluster.local:27017/appdb?replicaSet=mongo-production&readPreference=secondaryPreferred
```

---

## Section 7: mongodb-exporter for Prometheus

### Add Exporter Sidecar via StatefulSet Override

```yaml
# mongodb-with-exporter.yaml (partial)
spec:
  statefulSet:
    spec:
      template:
        spec:
          containers:
            - name: mongod
              resources:
                requests:
                  cpu: "1"
                  memory: "2Gi"
                limits:
                  cpu: "4"
                  memory: "8Gi"

            # mongodb-exporter sidecar
            - name: mongodb-exporter
              image: percona/mongodb_exporter:0.40.0
              args:
                - --mongodb.uri=mongodb://admin:$(MONGODB_ADMIN_PASSWORD)@localhost:27017/admin?authSource=admin
                - --collector.diagnosticdata
                - --collector.replicasetstatus
                - --collector.dbstats
                - --collector.collstats
                - --collector.topmetrics
                - --log.level=warn
              ports:
                - containerPort: 9216
                  name: metrics
                  protocol: TCP
              env:
                - name: MONGODB_ADMIN_PASSWORD
                  valueFrom:
                    secretKeyRef:
                      name: mongodb-admin-credentials
                      key: password
              resources:
                requests:
                  cpu: "50m"
                  memory: "64Mi"
                limits:
                  cpu: "250m"
                  memory: "128Mi"
              livenessProbe:
                httpGet:
                  path: /health
                  port: 9216
                initialDelaySeconds: 10
                periodSeconds: 30
```

### ServiceMonitor

```yaml
# mongodb-service-monitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: mongodb-production-metrics
  namespace: databases
  labels:
    release: kube-prometheus-stack
spec:
  selector:
    matchLabels:
      app: mongo-production
  namespaceSelector:
    matchNames:
      - databases
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
      relabelings:
        - sourceLabels: [__meta_kubernetes_pod_name]
          targetLabel: pod
        - sourceLabels: [__meta_kubernetes_pod_label_mongodb_dot_com_type]
          targetLabel: mongo_type
```

### Prometheus Alerting Rules

```yaml
# mongodb-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: mongodb-production-alerts
  namespace: databases
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: mongodb.replicaset
      interval: 30s
      rules:
        # Primary not available
        - alert: MongoDBPrimaryNotAvailable
          expr: |
            count(mongodb_replset_member_health{state="PRIMARY"}) == 0
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "MongoDB replica set has no primary"
            description: "No PRIMARY member found in the replica set for 2 minutes."

        # Replica lag > 30 seconds
        - alert: MongoDBReplicationLagHigh
          expr: |
            mongodb_replset_member_replication_lag > 30
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "MongoDB replication lag on {{ $labels.set }}"
            description: "Member {{ $labels.name }} is {{ $value }}s behind the primary."

        # Connections near limit
        - alert: MongoDBConnectionExhaustion
          expr: |
            mongodb_connections{state="current"} / mongodb_connections{state="available"} > 0.85
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "MongoDB connection near limit on {{ $labels.pod }}"
            description: "{{ $value | humanizePercentage }} of available connections in use."

        # Queued operations (indicates slow queries or lock contention)
        - alert: MongoDBOperationsQueued
          expr: |
            mongodb_global_lock_current_queue_total > 50
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "MongoDB operations queued on {{ $labels.pod }}"
            description: "{{ $value }} operations currently queued waiting for lock."

        # WiredTiger cache fill > 95%
        - alert: MongoDBCachePressure
          expr: |
            mongodb_wiredtiger_cache_bytes{type="used"} /
            mongodb_wiredtiger_cache_max_bytes > 0.95
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "MongoDB WiredTiger cache under pressure on {{ $labels.pod }}"
            description: "WiredTiger cache is {{ $value | humanizePercentage }} full."
```

---

## Section 8: Backup with Percona Backup for MongoDB (PBM)

Percona Backup for MongoDB provides logical and physical consistent backups across all replica set members, with point-in-time recovery via oplog replay.

### PBM Installation

```bash
# Deploy PBM agent as a DaemonSet alongside MongoDB Pods
# or as sidecar containers. The recommended approach is a separate DaemonSet
# that shares the MongoDB data volume via hostPath or PVC.
helm repo add percona https://percona.github.io/percona-helm-charts/
helm repo update

# Install PBM in the databases namespace
helm upgrade --install pbm-agent percona/pbm-agent \
  --namespace databases \
  --set mongodbURI="mongodb://admin:StrongAdminPassword2024!@mongo-production-svc.databases.svc.cluster.local:27017/admin?authSource=admin&replicaSet=mongo-production" \
  --set storage.type=s3 \
  --set storage.s3.bucket=company-mongodb-backups \
  --set storage.s3.prefix=mongo-production \
  --set storage.s3.region=us-east-1 \
  --set storage.s3.credentials.accessKeyID=EXAMPLE_AWS_ACCESS_KEY_REPLACE_ME \
  --set storage.s3.credentials.secretAccessKey=EXAMPLE_S3_SECRET_REPLACE_ME
```

### PBM Configuration Secret

```yaml
# pbm-config.yaml
apiVersion: v1
kind: Secret
metadata:
  name: pbm-config
  namespace: databases
type: Opaque
stringData:
  pbm-config.yaml: |
    storage:
      type: s3
      s3:
        region: us-east-1
        bucket: company-mongodb-backups
        prefix: mongo-production
        endpointUrl: ""            # Leave empty for AWS; set for MinIO
        credentials:
          access-key-id: EXAMPLE_AWS_ACCESS_KEY_REPLACE_ME
          secret-access-key: EXAMPLE_S3_SECRET_REPLACE_ME
        storageClass: STANDARD
        maxUploadParts: 10000
        uploadPartSize: 10485760   # 10MB upload chunk size
        serverSideEncryption:
          sseAlgorithm: aws:kms
          kmsKeyID: ""             # Use default KMS key

    backup:
      priority:
        mongo-production-0.mongo-production-svc.databases.svc.cluster.local:27017: 1.0
        mongo-production-1.mongo-production-svc.databases.svc.cluster.local:27017: 0.8
        mongo-production-2.mongo-production-svc.databases.svc.cluster.local:27017: 0.8

    restore:
      batchSize: 500
      numInsertionWorkers: 10
```

### Taking an On-Demand Backup

```bash
# Apply PBM config
kubectl exec -n databases mongo-production-0 -- \
  pbm config --file /etc/pbm/pbm-config.yaml

# Start a logical backup
kubectl exec -n databases mongo-production-0 -- \
  pbm backup --type logical

# Monitor backup progress
kubectl exec -n databases mongo-production-0 -- \
  pbm status

# List completed backups
kubectl exec -n databases mongo-production-0 -- \
  pbm list
```

### Scheduled Backups

```yaml
# pbm-backup-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: mongodb-daily-backup
  namespace: databases
spec:
  schedule: "0 2 * * *"           # Daily at 02:00 UTC
  successfulJobsHistoryLimit: 7
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          serviceAccountName: pbm-backup-sa
          containers:
            - name: pbm-backup
              image: percona/percona-backup-mongodb:2.4.0
              command:
                - pbm
                - backup
                - --type=logical
                - --compression=s2   # Snappy compression
              env:
                - name: PBM_MONGODB_URI
                  valueFrom:
                    secretKeyRef:
                      name: pbm-mongodb-uri
                      key: uri
```

---

## Section 9: Point-in-Time Recovery

PBM supports PITR by continuously archiving oplogs to S3 alongside periodic snapshots.

### Enable PITR

```bash
# Enable continuous oplog archiving (PITR mode)
kubectl exec -n databases mongo-production-0 -- \
  pbm config --set pitr.enabled=true \
            --set pitr.oplogSpanMin=10     # Upload oplog every 10 minutes
```

### Restore to Specific Time

```bash
# List available PITR ranges
kubectl exec -n databases mongo-production-0 -- \
  pbm list --full

# Restore to a specific time (format: YYYY-MM-DDTHH:MM:SS)
# This operation stops the replica set — perform on a separate restore cluster
kubectl exec -n databases mongo-production-0 -- \
  pbm restore --time "2027-03-25T09:30:00" \
              --base-snapshot "2027-03-25T02:00:00.logicalBackup"

# Monitor restore progress
kubectl exec -n databases mongo-production-0 -- \
  pbm restore --progress
```

---

## Section 10: Operational Commands via mongosh

### Replica Set Administration

```bash
# Check replica set status
kubectl exec -n databases mongo-production-0 -- \
  mongosh admin \
    --username admin \
    --password 'StrongAdminPassword2024!' \
    --eval "rs.status()" \
    --quiet

# Check replica set configuration
kubectl exec -n databases mongo-production-0 -- \
  mongosh admin \
    --username admin \
    --password 'StrongAdminPassword2024!' \
    --eval "rs.conf()" \
    --quiet

# Force primary election (step down current primary)
kubectl exec -n databases mongo-production-0 -- \
  mongosh admin \
    --username admin \
    --password 'StrongAdminPassword2024!' \
    --eval "rs.stepDown(60)" \
    --quiet
```

### Database and Collection Statistics

```bash
# Database sizes
kubectl exec -n databases mongo-production-0 -- \
  mongosh admin \
    --username admin \
    --password 'StrongAdminPassword2024!' \
    --eval "
      db.adminCommand({ listDatabases: 1 }).databases.forEach(function(d) {
        var dbObj = db.getSiblingDB(d.name);
        var stats = dbObj.stats(1024 * 1024);
        print(d.name + ': ' + stats.dataSize + 'MB data, ' + stats.storageSize + 'MB storage');
      });
    " \
    --quiet

# Current operations (identify long-running queries)
kubectl exec -n databases mongo-production-0 -- \
  mongosh admin \
    --username admin \
    --password 'StrongAdminPassword2024!' \
    --eval "
      db.currentOp({ 'active': true, 'secs_running': { '\$gte': 5 } })
    " \
    --quiet

# Index usage statistics
kubectl exec -n databases mongo-production-0 -- \
  mongosh appdb \
    --username admin \
    --password 'StrongAdminPassword2024!' \
    --authenticationDatabase admin \
    --eval "
      db.getCollectionNames().forEach(function(coll) {
        db[coll].aggregate([{ \$indexStats: {} }]).forEach(function(idx) {
          if (idx.accesses.ops === 0) {
            print('Unused index: ' + coll + '.' + idx.name);
          }
        });
      });
    " \
    --quiet
```

### Kill a Long-Running Operation

```bash
# Get operation ID from currentOp output, then kill it
kubectl exec -n databases mongo-production-0 -- \
  mongosh admin \
    --username admin \
    --password 'StrongAdminPassword2024!' \
    --eval "db.killOp(12345)" \
    --quiet
```

---

## Section 11: Scaling Replica Set Members

### Scale from 3 to 5 Members

```bash
# Update the members count in the CRD
kubectl patch mongodbcommunity mongo-production \
  --namespace databases \
  --type merge \
  --patch '{"spec":{"members":5}}'

# The operator will:
# 1. Scale the StatefulSet to 5 replicas
# 2. Wait for new members to sync
# 3. Run rs.reconfig() to add them as SECONDARY members

# Monitor new member sync progress
kubectl exec -n databases mongo-production-0 -- \
  mongosh admin \
    --username admin \
    --password 'StrongAdminPassword2024!' \
    --eval "rs.status().members.forEach(function(m) { print(m.name, m.stateStr, m.optimeDate); })" \
    --quiet
```

### Scale Down from 5 to 3 Members

```bash
# Scale down — operator removes the last N members safely
kubectl patch mongodbcommunity mongo-production \
  --namespace databases \
  --type merge \
  --patch '{"spec":{"members":3}}'

# Verify PVCs are retained for manual cleanup
kubectl get pvc -n databases -l app=mongo-production
```

---

## Section 12: Version Upgrades

The MongoDB Community Operator performs rolling minor and major version upgrades by replacing Pods one at a time, starting from the least-preferred primary candidates (secondary members with lower priority).

### Minor Version Upgrade (7.0.8 to 7.0.12)

```bash
# Update the version in the CRD
kubectl patch mongodbcommunity mongo-production \
  --namespace databases \
  --type merge \
  --patch '{"spec":{"version":"7.0.12"}}'

# Monitor rolling upgrade
kubectl rollout status statefulset mongo-production -n databases

# Verify all members on new version
kubectl exec -n databases mongo-production-0 -- \
  mongosh admin \
    --username admin \
    --password 'StrongAdminPassword2024!' \
    --eval "
      rs.status().members.forEach(function(m) {
        print(m.name, m.stateStr);
      });
    " \
    --quiet
```

### Major Version Upgrade (6.0 to 7.0)

Major version upgrades must follow the MongoDB upgrade path: each major version must be reached in sequence (e.g., 5.0 → 6.0 → 7.0). The operator respects this by validating the upgrade path.

```bash
# Step 1: Ensure featureCompatibilityVersion matches current major version
kubectl exec -n databases mongo-production-0 -- \
  mongosh admin \
    --username admin \
    --password 'StrongAdminPassword2024!' \
    --eval "db.adminCommand({ getParameter: 1, featureCompatibilityVersion: 1 })" \
    --quiet

# Step 2: Set FCV to current version before upgrading
kubectl exec -n databases mongo-production-0 -- \
  mongosh admin \
    --username admin \
    --password 'StrongAdminPassword2024!' \
    --eval "db.adminCommand({ setFeatureCompatibilityVersion: '6.0' })" \
    --quiet

# Step 3: Update image to 7.0 target version
kubectl patch mongodbcommunity mongo-production \
  --namespace databases \
  --type merge \
  --patch '{"spec":{"version":"7.0.8"}}'

# Step 4: After upgrade completes, bump FCV to 7.0
kubectl exec -n databases mongo-production-0 -- \
  mongosh admin \
    --username admin \
    --password 'StrongAdminPassword2024!' \
    --eval "db.adminCommand({ setFeatureCompatibilityVersion: '7.0', confirm: true })" \
    --quiet
```

---

## Section 13: Index Management and Performance

### Create Indexes Without Blocking Production

```bash
# Rolling index build via background index creation (replicas then primary)
# In MongoDB 4.4+ all index builds are rolled automatically

# Build index on secondary first, then trigger primary step-down
kubectl exec -n databases mongo-production-0 -- \
  mongosh appdb \
    --username admin \
    --password 'StrongAdminPassword2024!' \
    --authenticationDatabase admin \
    --eval "
      db.orders.createIndex(
        { customer_id: 1, created_at: -1 },
        {
          name: 'idx_customer_created',
          background: false,    // In 4.4+ this flag is ignored; all builds are concurrent
          comment: 'Added for customer order history query performance'
        }
      )
    " \
    --quiet
```

### Identify Missing Indexes via Explain

```bash
# Explain a slow query and check for COLLSCAN (full collection scan)
kubectl exec -n databases mongo-production-0 -- \
  mongosh appdb \
    --username admin \
    --password 'StrongAdminPassword2024!' \
    --authenticationDatabase admin \
    --eval "
      db.orders.explain('executionStats').find(
        { customer_id: 'cust-42', status: 'pending' }
      ).sort({ created_at: -1 })
    " \
    --quiet
```

---

## Section 14: NetworkPolicy for MongoDB Isolation

```yaml
# mongodb-network-policy.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: mongodb-production-allow
  namespace: databases
spec:
  podSelector:
    matchLabels:
      app: mongo-production
  policyTypes:
    - Ingress
    - Egress
  ingress:
    # Allow application connections
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: application
      ports:
        - protocol: TCP
          port: 27017
    # Allow inter-member replication
    - from:
        - podSelector:
            matchLabels:
              app: mongo-production
      ports:
        - protocol: TCP
          port: 27017
    # Allow PBM agent connections
    - from:
        - podSelector:
            matchLabels:
              app: pbm-agent
      ports:
        - protocol: TCP
          port: 27017
    # Allow Prometheus metrics scraping
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
      ports:
        - protocol: TCP
          port: 9216
  egress:
    # Inter-member replication
    - to:
        - podSelector:
            matchLabels:
              app: mongo-production
      ports:
        - protocol: TCP
          port: 27017
    # S3 backup destination
    - to: []
      ports:
        - protocol: TCP
          port: 443
    # DNS
    - to: []
      ports:
        - protocol: UDP
          port: 53
```

---

## Section 15: Storage Expansion and Capacity Planning

### Expand PVC Storage

```bash
# Expand PVC for all StatefulSet members (requires storage class to support expansion)
# The operator does not patch PVCs directly — use kubectl to patch each PVC

for i in 0 1 2; do
  kubectl patch pvc data-volume-mongo-production-$i \
    --namespace databases \
    --type merge \
    --patch '{"spec":{"resources":{"requests":{"storage":"200Gi"}}}}'
done

# Wait for PVCs to show the new capacity
kubectl get pvc -n databases -l app=mongo-production
```

### Capacity Planning Reference

```
Workload         | Members | CPU/Pod  | Memory/Pod | Storage/Pod | Use Case
---------------- | ------- | -------- | ---------- | ----------- | --------
Development      | 1       | 0.5/1    | 512Mi/1Gi  | 10Gi        | Local dev
Small Prod       | 3       | 1/2      | 2Gi/4Gi    | 50Gi        | <10K docs/s
Medium Prod      | 3       | 2/4      | 4Gi/8Gi    | 200Gi       | 10-100K docs/s
Large Prod       | 5       | 4/8      | 8Gi/16Gi   | 500Gi       | >100K docs/s
Analytics+OLAP   | 5       | 4/8      | 16Gi/32Gi  | 2Ti         | Aggregation-heavy

WiredTiger cache sizing:
- Default: 50% of (RAM - 1GB), minimum 256MB
- For memory-mapped: set wiredTigerCacheSizeGB explicitly to 60% of Pod memory limit
- Monitor mongodb_wiredtiger_cache_bytes ratio; cache hit rate < 95% indicates need for more memory
```

The MongoDB Community Operator reduces the operational complexity of running production replica sets on Kubernetes by codifying initialization, user management, TLS rotation, and rolling upgrades into a single declarative resource. Combined with Percona Backup for MongoDB for consistent snapshots and oplog-based PITR, and mongodb-exporter for deep Prometheus observability, this stack provides the operational visibility and data protection guarantees required for production database deployments.
