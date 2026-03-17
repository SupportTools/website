---
title: "Kubernetes Multi-Cloud Disaster Recovery: Cross-Region Cluster Failover, DNS-Based Routing, and Data Synchronization"
date: 2031-12-24T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Disaster Recovery", "Multi-Cloud", "DNS", "Failover", "Velero", "Backup", "High Availability", "Cross-Region"]
categories:
- Kubernetes
- Disaster Recovery
- Architecture
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to Kubernetes multi-cloud disaster recovery architecture covering cross-region cluster failover runbooks, DNS-based traffic routing with Route53 and Cloud DNS, Velero backup synchronization, database replication strategies, and automated DR testing."
more_link: "yes"
url: "/kubernetes-multi-cloud-disaster-recovery-cross-region-failover-dns-data-sync/"
---

A Kubernetes cluster failure or a cloud region outage without a tested disaster recovery plan is a career-defining moment for the wrong reasons. Multi-cloud DR architecture protects against cloud provider regional outages, account-level incidents, and configuration mistakes that render an entire cluster unusable. The engineering investment to build and maintain a DR capability is substantial, but the alternative — an untested recovery that takes days and loses data — is substantially worse.

This guide covers the complete multi-cloud DR stack: architecture design, cross-region cluster configuration, DNS-based traffic failover with weighted routing policies, Velero-based workload backup and restore, database replication synchronization, and automated DR testing procedures that validate recovery objectives before an actual outage.

<!--more-->

# Kubernetes Multi-Cloud Disaster Recovery: Cross-Region Failover, DNS Routing, and Data Synchronization

## Section 1: DR Architecture Design

### 1.1 Recovery Objectives

Before architecting, define measurable objectives:

- **RTO (Recovery Time Objective)**: Maximum acceptable downtime from incident declaration to full service restoration
- **RPO (Recovery Point Objective)**: Maximum acceptable data loss measured in time

| Tier | RTO | RPO | Architecture |
|------|-----|-----|-------------|
| Tier 0 (critical) | < 5 min | ~0 | Active-active multi-region |
| Tier 1 (business-critical) | < 30 min | < 5 min | Active-passive, hot standby |
| Tier 2 (important) | < 4 hours | < 1 hour | Warm standby |
| Tier 3 (standard) | < 24 hours | < 24 hours | Backup + restore |

### 1.2 Cluster Topology

```
Primary: AWS us-east-1 (EKS)
├── Workloads: active
├── Databases: read-write primary
├── Storage: EBS (cross-region replicated)
└── Traffic: 100% (normal operation)

Secondary: GCP us-central1 (GKE)
├── Workloads: standby / scaled-down
├── Databases: read replicas
├── Storage: GCS (replicated from S3)
└── Traffic: 0% (normal), 100% (failover)

Tertiary: Azure eastus (AKS)
├── Workloads: backup restore target
├── Databases: point-in-time restore
├── Storage: Azure Blob (backup target)
└── Traffic: 0% (manual failover only)
```

### 1.3 Shared Infrastructure

```
Global DNS: Route53 (primary) with Cloud DNS failover delegation
Global CDN: CloudFront with GCP Cloud CDN as origin
Certificate Management: cert-manager with ACME, pre-provisioned in both regions
Secret Distribution: External Secrets Operator + multi-region Vault
Configuration Distribution: ArgoCD ApplicationSet targeting both clusters
```

## Section 2: Cluster Configuration for DR

### 2.1 Infrastructure-as-Code for Both Clusters

```hcl
# terraform/aws-primary/eks.tf
module "eks_primary" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = "production-us-east-1"
  cluster_version = "1.29"
  vpc_id          = module.vpc.vpc_id
  subnet_ids      = module.vpc.private_subnets

  eks_managed_node_groups = {
    general = {
      min_size     = 3
      max_size     = 20
      desired_size = 5

      instance_types = ["m6i.4xlarge"]
      capacity_type  = "ON_DEMAND"

      k8s_labels = {
        role = "general"
        dr-region = "us-east-1"
        dr-tier = "primary"
      }
    }
  }

  # Enable cross-region backup via EBS snapshots
  enable_cluster_creator_admin_permissions = true
  cluster_addons = {
    aws-ebs-csi-driver = {
      most_recent = true
    }
  }
}

# terraform/gcp-secondary/gke.tf
resource "google_container_cluster" "secondary" {
  name     = "production-us-central1"
  location = "us-central1"

  release_channel {
    channel = "STABLE"
  }

  node_config {
    machine_type = "n2-standard-16"
    labels = {
      dr-region = "us-central1"
      dr-tier   = "secondary"
    }
  }

  addons_config {
    gcp_filestore_csi_driver_config { enabled = true }
  }
}
```

### 2.2 Application Configuration Parity via ArgoCD ApplicationSet

```yaml
# applicationset-multicloud.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: production-multicloud
  namespace: argocd
spec:
  generators:
    - list:
        elements:
          - cluster: production-us-east-1
            url: https://eks-endpoint.us-east-1.eks.amazonaws.com
            region: us-east-1
            cloudProvider: aws
            tier: primary
            replicas: "3"
          - cluster: production-us-central1
            url: https://container.googleapis.com/v1/projects/myproject/locations/us-central1/clusters/production-us-central1
            region: us-central1
            cloudProvider: gcp
            tier: secondary
            replicas: "1"  # Scaled down in standby

  template:
    metadata:
      name: "{{cluster}}-{{metadata.labels.app}}"
    spec:
      project: production-multicloud
      source:
        repoURL: https://github.com/example-org/production-apps.git
        targetRevision: main
        path: apps/order-service
        helm:
          valueFiles:
            - values.yaml
            - values-{{cloudProvider}}.yaml
          parameters:
            - name: replicaCount
              value: "{{replicas}}"
            - name: region
              value: "{{region}}"
            - name: drTier
              value: "{{tier}}"
      destination:
        server: "{{url}}"
        namespace: production
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        retry:
          limit: 5
```

## Section 3: DNS-Based Traffic Routing

### 3.1 AWS Route53 Health-Checked Failover

```hcl
# terraform/dns/route53.tf

# Health check for primary endpoint
resource "aws_route53_health_check" "primary" {
  fqdn              = "api-primary.example.com"
  port              = 443
  type              = "HTTPS"
  resource_path     = "/healthz"
  failure_threshold = 3
  request_interval  = 10  # seconds

  tags = {
    Name = "primary-cluster-health"
  }
}

# Health check for secondary endpoint
resource "aws_route53_health_check" "secondary" {
  fqdn              = "api-secondary.example.com"
  port              = 443
  type              = "HTTPS"
  resource_path     = "/healthz"
  failure_threshold = 3
  request_interval  = 10
}

# Primary record (US East 1 - AWS EKS)
resource "aws_route53_record" "api_primary" {
  zone_id         = data.aws_route53_zone.main.zone_id
  name            = "api.example.com"
  type            = "A"
  set_identifier  = "primary"
  health_check_id = aws_route53_health_check.primary.id

  failover_routing_policy {
    type = "PRIMARY"
  }

  alias {
    name                   = data.aws_lb.primary.dns_name
    zone_id                = data.aws_lb.primary.zone_id
    evaluate_target_health = true
  }
}

# Secondary record (US Central 1 - GCP GKE)
resource "aws_route53_record" "api_secondary" {
  zone_id         = data.aws_route53_zone.main.zone_id
  name            = "api.example.com"
  type            = "A"
  set_identifier  = "secondary"
  health_check_id = aws_route53_health_check.secondary.id

  failover_routing_policy {
    type = "SECONDARY"
  }

  ttl = 30  # Low TTL for fast failover propagation

  records = [data.google_compute_global_address.secondary_lb.address]
}
```

### 3.2 Weighted Routing for Gradual Traffic Migration

```hcl
# Weighted routing for blue-green failover testing
resource "aws_route53_record" "api_weighted_primary" {
  zone_id        = data.aws_route53_zone.main.zone_id
  name           = "api-canary.example.com"
  type           = "A"
  set_identifier = "primary-weight"

  weighted_routing_policy {
    weight = var.primary_weight  # 100 normally, 0 during DR test
  }

  alias {
    name                   = data.aws_lb.primary.dns_name
    zone_id                = data.aws_lb.primary.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "api_weighted_secondary" {
  zone_id        = data.aws_route53_zone.main.zone_id
  name           = "api-canary.example.com"
  type           = "A"
  set_identifier = "secondary-weight"

  weighted_routing_policy {
    weight = var.secondary_weight  # 0 normally, 100 during DR test
  }

  ttl     = 30
  records = [data.google_compute_global_address.secondary_lb.address]
}
```

### 3.3 Automated Failover Script

```bash
#!/bin/bash
# failover.sh - Trigger DNS failover from primary to secondary

set -euo pipefail

HOSTED_ZONE_ID="${HOSTED_ZONE_ID:?Required}"
PRIMARY_RECORD_NAME="api.example.com"
SECONDARY_IP="${SECONDARY_IP:?Required}"
AWS_PROFILE="${AWS_PROFILE:-default}"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }

# Verify secondary cluster is healthy before failover
check_secondary() {
    log "Checking secondary cluster health..."
    for i in {1..10}; do
        if curl -sSf --max-time 5 "https://${SECONDARY_IP}/healthz" >/dev/null 2>&1; then
            log "Secondary cluster is healthy"
            return 0
        fi
        log "Attempt $i/10: secondary not ready, waiting 10s..."
        sleep 10
    done
    log "ERROR: Secondary cluster failed health checks"
    return 1
}

# Scale up secondary workloads to full capacity
scale_up_secondary() {
    log "Scaling up secondary cluster workloads..."
    kubectl --context=gke_myproject_us-central1_production-us-central1 \
        scale deployment --all --replicas=3 -n production

    # Wait for rollout
    kubectl --context=gke_myproject_us-central1_production-us-central1 \
        rollout status deployment --all -n production --timeout=5m
    log "Secondary workloads scaled up"
}

# Update Route53 to point to secondary
update_dns() {
    log "Updating Route53 to point to secondary..."

    # Lower TTL first (let current TTL expire before switching)
    aws route53 change-resource-record-sets \
        --hosted-zone-id "${HOSTED_ZONE_ID}" \
        --change-batch '{
          "Changes": [{
            "Action": "UPSERT",
            "ResourceRecordSet": {
              "Name": "'"${PRIMARY_RECORD_NAME}"'",
              "Type": "A",
              "TTL": 30,
              "ResourceRecords": [{"Value": "'"${SECONDARY_IP}"'"}]
            }
          }]
        }'

    log "DNS updated. New record TTL=30s pointing to ${SECONDARY_IP}"
    log "Current DNS will expire in $(get_current_ttl)s"
}

get_current_ttl() {
    dig +nocmd +noall +answer "${PRIMARY_RECORD_NAME}" | awk '{print $2}' | head -1
}

# Send incident notification
notify() {
    local msg="$1"
    local severity="${2:-info}"
    log "NOTIFICATION [$severity]: $msg"
    # curl -X POST "<slack-webhook-url-placeholder>" \
    #   -H 'Content-type: application/json' \
    #   --data "{\"text\":\"[$severity] DR Failover: $msg\"}"
}

main() {
    notify "Starting DR failover to secondary region (us-central1)" "warning"

    check_secondary || { notify "ABORT: Secondary not healthy" "critical"; exit 1; }
    scale_up_secondary
    update_dns

    # Wait for DNS propagation
    log "Waiting 120s for DNS propagation..."
    sleep 120

    # Verify traffic is hitting secondary
    RESOLVED_IP=$(dig +short "${PRIMARY_RECORD_NAME}" | head -1)
    if [ "${RESOLVED_IP}" == "${SECONDARY_IP}" ]; then
        notify "DNS failover complete. Traffic routing to secondary (${SECONDARY_IP})" "info"
    else
        notify "DNS propagation may be incomplete. Resolved: ${RESOLVED_IP}, Expected: ${SECONDARY_IP}" "warning"
    fi

    log "Failover complete. Monitor secondary cluster for stability."
    log "Run ./rollback.sh to revert when primary is recovered."
}

main
```

## Section 4: Data Synchronization

### 4.1 Velero Multi-Cloud Backup Configuration

```yaml
# velero-backup-schedule.yaml
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: full-cluster-backup
  namespace: velero
spec:
  schedule: "*/15 * * * *"  # Every 15 minutes
  template:
    includedNamespaces:
      - production
      - staging
      - production-db
    excludedResources:
      - events
      - events.events.k8s.io
    includeClusterResources: true
    snapshotVolumes: true
    storageLocation: aws-primary
    volumeSnapshotLocations:
      - aws-ebs
    ttl: 168h  # Keep 7 days of backups
    hooks:
      resources:
        - name: postgres-backup-hook
          includedNamespaces:
            - production-db
          labelSelector:
            matchLabels:
              app: postgresql
          pre:
            - exec:
                container: postgresql
                command:
                  - /bin/bash
                  - -c
                  - |
                    PGPASSWORD="$POSTGRES_PASSWORD" \
                    pg_dumpall -U postgres | \
                    gzip > /backup/full-dump-$(date +%Y%m%d%H%M%S).sql.gz
                onError: Fail
                timeout: 10m

---
# BackupStorageLocation for AWS (primary)
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: aws-primary
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: velero-backups-us-east-1
    prefix: primary-cluster
  config:
    region: us-east-1
    s3ForcePathStyle: "false"

---
# BackupStorageLocation for GCP (secondary)
# Velero on the secondary cluster reads from this location
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: gcp-secondary
  namespace: velero
spec:
  provider: gcp
  objectStorage:
    bucket: velero-backups-us-central1
    prefix: primary-cluster-mirror
  config:
    serviceAccount: velero@myproject.iam.gserviceaccount.com
```

### 4.2 Cross-Cloud Object Storage Synchronization

```yaml
# rclone-sync-job.yaml - Sync S3 backups to GCS for cross-cloud availability
apiVersion: batch/v1
kind: CronJob
metadata:
  name: backup-sync-s3-to-gcs
  namespace: velero
spec:
  schedule: "*/30 * * * *"  # Every 30 minutes
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: backup-syncer
          restartPolicy: OnFailure
          containers:
            - name: rclone-sync
              image: rclone/rclone:1.66
              command:
                - rclone
                - sync
                - s3:velero-backups-us-east-1/primary-cluster
                - gcs:velero-backups-us-central1/primary-cluster-mirror
                - --progress
                - --transfers=10
                - --checkers=20
                - --log-level=INFO
              env:
                - name: AWS_ACCESS_KEY_ID
                  valueFrom:
                    secretKeyRef:
                      name: backup-sync-credentials
                      key: aws-access-key-id
                - name: AWS_SECRET_ACCESS_KEY
                  valueFrom:
                    secretKeyRef:
                      name: backup-sync-credentials
                      key: aws-secret-access-key
              volumeMounts:
                - name: rclone-config
                  mountPath: /config/rclone
          volumes:
            - name: rclone-config
              configMap:
                name: rclone-config
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: rclone-config
  namespace: velero
data:
  rclone.conf: |
    [s3]
    type = s3
    provider = AWS
    region = us-east-1
    env_auth = true

    [gcs]
    type = google cloud storage
    project_number = <gcp-project-number-placeholder>
    service_account_file = /secrets/gcs-sa-key.json
```

### 4.3 PostgreSQL Cross-Region Streaming Replication

```yaml
# postgres-primary-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: postgresql-primary-config
  namespace: production-db
data:
  postgresql.conf: |
    # Streaming replication settings
    wal_level = replica
    max_wal_senders = 5
    wal_keep_size = 1GB
    max_replication_slots = 5

    # Synchronous replication for near-zero RPO
    # Comment out for async (better performance, some data loss risk)
    synchronous_standby_names = 'ANY 1 (standby_gcp_uscentral1)'
    synchronous_commit = remote_apply

    # Archive WAL to S3 for point-in-time recovery
    archive_mode = on
    archive_command = 'aws s3 cp %p s3://wal-archive-us-east-1/pg_wal/%f'

  pg_hba.conf: |
    # Allow replication from secondary cluster (GCP pod CIDR)
    host replication replicator 10.100.0.0/16 md5

---
# postgres-standby-on-secondary.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgresql-standby
  namespace: production-db
spec:
  serviceName: postgresql-standby
  replicas: 1
  selector:
    matchLabels:
      app: postgresql-standby
  template:
    spec:
      initContainers:
        - name: pg-basebackup
          image: postgres:16
          command:
            - /bin/bash
            - -c
            - |
              if [ ! -f /var/lib/postgresql/data/PG_VERSION ]; then
                PGPASSWORD="${REPLICATION_PASSWORD}" \
                pg_basebackup \
                  -h "${PRIMARY_HOST}" \
                  -p 5432 \
                  -U replicator \
                  -D /var/lib/postgresql/data \
                  -P -Xs -R
                echo "Base backup complete"
              else
                echo "Data directory already initialized, skipping basebackup"
              fi
          env:
            - name: REPLICATION_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: postgres-replication-creds
                  key: password
            - name: PRIMARY_HOST
              value: "postgresql.production-db.svc.cluster.local"
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
      containers:
        - name: postgresql
          image: postgres:16
          env:
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: postgres-secret
                  key: password
            - name: PGDATA
              value: /var/lib/postgresql/data
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ReadWriteOnce]
        storageClassName: standard-ssd
        resources:
          requests:
            storage: 500Gi
```

### 4.4 Redis Cross-Region Replication

```yaml
# redis-replica-secondary.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis-replica
  namespace: production
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: redis
          image: redis:7.2-alpine
          command:
            - redis-server
            - "--replicaof"
            - "$(REDIS_PRIMARY_HOST)"
            - "6379"
            - "--replica-read-only"
            - "yes"
            - "--replica-serve-stale-data"
            - "yes"
            - "--replica-lazy-flush"
            - "yes"
          env:
            - name: REDIS_PRIMARY_HOST
              value: "redis-primary.production.svc.cluster.local"
          ports:
            - containerPort: 6379
```

## Section 5: Workload Restore Procedures

### 5.1 Velero Restore Runbook

```bash
#!/bin/bash
# dr-restore.sh - Restore workloads on secondary cluster

set -euo pipefail

VELERO_BACKUP_NAME="${1:-$(velero backup get --output json | \
    jq -r '.items | sort_by(.status.completionTimestamp) | last | .metadata.name')}"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }

log "Starting DR restore from backup: ${VELERO_BACKUP_NAME}"

# Verify backup exists and is complete
BACKUP_STATUS=$(velero backup get "${VELERO_BACKUP_NAME}" -o json | \
    jq -r '.status.phase')
if [ "${BACKUP_STATUS}" != "Completed" ]; then
    log "ERROR: Backup ${VELERO_BACKUP_NAME} status is ${BACKUP_STATUS}, not Completed"
    exit 1
fi

# Get backup timestamp for RPO calculation
BACKUP_TIME=$(velero backup get "${VELERO_BACKUP_NAME}" -o json | \
    jq -r '.status.completionTimestamp')
log "Backup completed at: ${BACKUP_TIME}"
log "RPO: $(date -d "${BACKUP_TIME}" +%s | \
    xargs -I{} bash -c 'echo $(( $(date +%s) - {} ))') seconds of data loss"

# Create restore
velero restore create \
    --from-backup "${VELERO_BACKUP_NAME}" \
    --restore-volumes true \
    --wait

RESTORE_NAME=$(velero restore get --output json | \
    jq -r '.items | last | .metadata.name')

log "Waiting for restore ${RESTORE_NAME} to complete..."
velero restore wait "${RESTORE_NAME}"

RESTORE_STATUS=$(velero restore get "${RESTORE_NAME}" -o json | \
    jq -r '.status.phase')
if [ "${RESTORE_STATUS}" != "Completed" ]; then
    log "ERROR: Restore failed with status ${RESTORE_STATUS}"
    velero restore describe "${RESTORE_NAME}"
    exit 1
fi

log "Restore completed. Verifying workloads..."

# Verify deployments are running
FAILED_DEPS=0
for ns in production staging; do
    kubectl get deployments -n "${ns}" -o json | \
        jq -r '.items[] | select(.status.availableReplicas < .spec.replicas) | .metadata.name' | \
        while read -r dep; do
            log "WARNING: Deployment ${ns}/${dep} not fully available"
            FAILED_DEPS=$((FAILED_DEPS + 1))
        done
done

if [ "${FAILED_DEPS}" -gt 0 ]; then
    log "WARNING: ${FAILED_DEPS} deployments not healthy after restore"
else
    log "All deployments healthy"
fi

log "DR restore complete. Proceed with DNS failover."
```

### 5.2 Database Promotion (PostgreSQL Standby to Primary)

```bash
#!/bin/bash
# promote-postgres.sh - Promote standby to primary during DR

set -euo pipefail

STANDBY_POD="postgresql-standby-0"
NAMESPACE="production-db"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }

# Verify we're not promoting while primary is still running
# (prevents split-brain)
PRIMARY_REACHABLE=$(kubectl run check-primary --rm --restart=Never --image=postgres:16 \
    --command -- \
    psql -h postgresql.production-db.svc.cluster.local -U postgres -c "\conninfo" \
    2>&1 || echo "unreachable")

if echo "${PRIMARY_REACHABLE}" | grep -q "server closed"; then
    log "Primary is unreachable, safe to promote standby"
elif echo "${PRIMARY_REACHABLE}" | grep -q "unreachable"; then
    log "Primary confirmed unreachable"
else
    log "ERROR: Primary may still be reachable. Manual verification required."
    log "Output: ${PRIMARY_REACHABLE}"
    exit 1
fi

log "Promoting PostgreSQL standby to primary..."
kubectl exec -n "${NAMESPACE}" "${STANDBY_POD}" -- \
    pg_ctl promote -D /var/lib/postgresql/data

# Wait for promotion to complete
for i in {1..30}; do
    STATUS=$(kubectl exec -n "${NAMESPACE}" "${STANDBY_POD}" -- \
        pg_controldata /var/lib/postgresql/data | \
        grep "Database cluster state" | \
        awk '{print $NF}')
    if echo "${STATUS}" | grep -q "in production"; then
        log "Promotion complete. PostgreSQL is now primary."
        break
    fi
    log "Waiting for promotion... status: ${STATUS}"
    sleep 5
done

# Update the service to point to the new primary
kubectl patch service postgresql -n "${NAMESPACE}" \
    --type='json' \
    -p='[{"op": "replace", "path": "/spec/selector/app", "value": "postgresql-standby"}]'

log "Service updated. New primary is ${STANDBY_POD}."
log "Remember to configure new replica when primary region recovers."
```

## Section 6: Automated DR Testing

### 6.1 DR Test Pipeline

```yaml
# .github/workflows/dr-test.yaml
name: Disaster Recovery Test

on:
  schedule:
    - cron: '0 2 * * 0'  # Weekly on Sunday at 2am UTC
  workflow_dispatch:
    inputs:
      test_type:
        description: 'Test type: smoke | full'
        default: smoke

jobs:
  dr-smoke-test:
    runs-on: ubuntu-latest
    environment: dr-test
    steps:
      - uses: actions/checkout@v4

      - name: Configure kubectl
        run: |
          mkdir -p ~/.kube
          echo "${{ secrets.SECONDARY_KUBECONFIG }}" > ~/.kube/config

      - name: Get latest backup
        id: backup
        run: |
          BACKUP=$(velero backup get --output json | \
            jq -r '.items | sort_by(.status.completionTimestamp) | last | .metadata.name')
          echo "backup_name=$BACKUP" >> $GITHUB_OUTPUT
          echo "Latest backup: $BACKUP"

      - name: Create test namespace
        run: |
          kubectl create namespace dr-test --dry-run=client -o yaml | kubectl apply -f -
          kubectl label namespace dr-test dr-test=true --overwrite

      - name: Restore to test namespace
        run: |
          velero restore create dr-test-$(date +%Y%m%d%H%M%S) \
            --from-backup "${{ steps.backup.outputs.backup_name }}" \
            --namespace-mappings production:dr-test \
            --restore-volumes=false \
            --wait

      - name: Run smoke tests against DR environment
        run: |
          # Wait for pods to be running
          kubectl wait --for=condition=Available deployment --all \
            -n dr-test --timeout=5m

          # Run application smoke tests
          DR_ENDPOINT=$(kubectl get service api-gateway -n dr-test \
            -o jsonpath='{.status.loadBalancer.ingress[0].ip}')

          # Basic health check
          curl -sf "http://${DR_ENDPOINT}/healthz" || exit 1

          # API functional test
          RESPONSE=$(curl -sf "http://${DR_ENDPOINT}/api/v1/orders" \
            -H "Authorization: Bearer ${{ secrets.DR_TEST_TOKEN }}")
          echo "$RESPONSE" | jq '.status == "ok"' | grep true || exit 1

      - name: Record test results
        run: |
          echo "DR_TEST_PASSED=true" >> $GITHUB_ENV
          echo "DR_TEST_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> $GITHUB_ENV

      - name: Cleanup test namespace
        if: always()
        run: kubectl delete namespace dr-test --ignore-not-found

      - name: Report results
        if: always()
        run: |
          STATUS="${{ job.status }}"
          echo "DR Test Status: $STATUS"
          # Send to metrics system / Slack
```

### 6.2 RTO Measurement

```bash
#!/bin/bash
# measure-rto.sh - Time the complete failover process

START_TIME=$(date +%s%3N)  # milliseconds

log_step() {
    local step="$1"
    local step_time=$(date +%s%3N)
    local elapsed=$(( (step_time - START_TIME) / 1000 ))
    echo "STEP [${elapsed}s]: ${step}"
}

# Step 1: Detect outage (already declared at START_TIME)
log_step "Outage declared"

# Step 2: Scale up secondary
kubectl --context=secondary scale deployment --all --replicas=3 -n production
kubectl --context=secondary rollout status deployment --all -n production --timeout=10m
log_step "Secondary scaled up"

# Step 3: Verify secondary health
until curl -sf https://api-secondary.example.com/healthz; do
    echo "Waiting for secondary..."
    sleep 5
done
log_step "Secondary health verified"

# Step 4: Update DNS
./failover.sh
log_step "DNS updated"

# Step 5: Wait for DNS propagation
sleep 120
log_step "DNS propagated (120s)"

# Step 6: Verify production traffic on secondary
RESPONSE=$(curl -sf https://api.example.com/healthz)
log_step "Traffic verified on secondary"

END_TIME=$(date +%s%3N)
TOTAL_RTO=$(( (END_TIME - START_TIME) / 1000 ))
echo ""
echo "==================================="
echo "Total RTO: ${TOTAL_RTO} seconds"
echo "==================================="

if [ "${TOTAL_RTO}" -le 1800 ]; then
    echo "RTO TARGET MET: ${TOTAL_RTO}s <= 1800s (30 min)"
else
    echo "RTO TARGET MISSED: ${TOTAL_RTO}s > 1800s (30 min)"
    exit 1
fi
```

## Section 7: Monitoring and Alerting for DR Readiness

### 7.1 DR Readiness Metrics

```yaml
# prometheus-dr-rules.yaml
groups:
  - name: dr-readiness
    rules:
      # Alert if replication lag is too high
      - alert: PostgreSQLReplicationLagHigh
        expr: |
          pg_replication_lag_seconds > 60
        for: 2m
        labels:
          severity: warning
          runbook: "https://runbooks.example.com/postgresql-replication-lag"
        annotations:
          summary: "PostgreSQL replication lag {{ $value }}s"
          description: "High replication lag threatens RPO objectives"

      # Alert if backup is stale
      - alert: BackupStaleness
        expr: |
          (time() - velero_backup_last_successful_timestamp{schedule="full-cluster-backup"}) > 3600
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Velero backup is stale"
          description: "Last successful backup was over 1 hour ago"

      # Alert if secondary cluster is unreachable
      - alert: SecondaryClusterUnreachable
        expr: |
          up{job="kubernetes-secondary", cluster="production-us-central1"} == 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Secondary DR cluster unreachable"
          description: "The secondary Kubernetes cluster for DR is not responding to metrics scrapes"

      # Alert if DR namespace workloads are not ready
      - alert: SecondaryWorkloadsNotReady
        expr: |
          kube_deployment_status_replicas_available{cluster="production-us-central1",namespace="production"} /
          kube_deployment_spec_replicas{cluster="production-us-central1",namespace="production"} < 0.5
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Secondary cluster workloads below capacity"
          description: "Secondary cluster may not handle failover traffic"

      # Track DNS TTL health (low TTL needed for fast failover)
      - alert: DNSTTLTooHigh
        expr: |
          dns_record_ttl{name="api.example.com"} > 300
        labels:
          severity: warning
        annotations:
          summary: "DNS TTL too high for fast failover"
          description: "DNS TTL {{ $value }}s > 300s. Failover propagation will be slow"
```

### 7.2 DR Runbook Automation

```yaml
# dr-runbook-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: dr-runbooks
  namespace: monitoring
data:
  failover-procedure.md: |
    # Disaster Recovery Failover Procedure

    ## Prerequisites
    - [ ] Incident bridge open (PagerDuty incident #____)
    - [ ] Incident commander identified
    - [ ] Communication channel active (#incident-YYYYMMDD-DR)
    - [ ] AWS and GCP console access verified

    ## Phase 1: Assessment (target: T+0 to T+5 min)
    - [ ] Confirm primary cluster unreachable: `kubectl --context=primary get nodes`
    - [ ] Check AWS Service Health Dashboard
    - [ ] Check Route53 health check status
    - [ ] Verify this is not a connectivity issue from operations system

    ## Phase 2: Secondary Preparation (target: T+5 to T+15 min)
    - [ ] Scale up secondary: `./failover.sh --scale-up-only`
    - [ ] Verify secondary health: `curl https://api-secondary.example.com/healthz`
    - [ ] Promote PostgreSQL standby: `./promote-postgres.sh`
    - [ ] Verify database read-write: `kubectl exec -n production-db postgresql-standby-0 -- psql -c "SELECT pg_is_in_recovery()"`

    ## Phase 3: Traffic Failover (target: T+15 to T+20 min)
    - [ ] Execute DNS failover: `./failover.sh`
    - [ ] Update external status page: https://status.example.com
    - [ ] Notify customers via status page and email

    ## Phase 4: Verification (target: T+20 to T+30 min)
    - [ ] Verify traffic on secondary: `./verify-traffic.sh`
    - [ ] Run smoke tests: `./smoke-tests.sh --environment=secondary`
    - [ ] Monitor error rates for 10 minutes

    ## Phase 5: Stabilization
    - [ ] Document what happened and when
    - [ ] Continue monitoring secondary cluster
    - [ ] Begin planning primary recovery
```

## Section 8: Post-Recovery Procedures

### 8.1 Failing Back to Primary

```bash
#!/bin/bash
# failback.sh - Reverse failover back to primary after recovery

set -euo pipefail

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }

# Step 1: Verify primary is recovered
log "Verifying primary cluster health..."
kubectl --context=primary get nodes --no-headers | \
    awk '{print $2}' | \
    grep -v "Ready" | \
    wc -l | \
    xargs -I{} test {} -eq 0 || {
        log "ERROR: Primary cluster has unhealthy nodes"
        exit 1
    }
log "Primary cluster is healthy"

# Step 2: Sync data from secondary to primary
# For PostgreSQL: set up replication in reverse
# (beyond scope of this script — requires manual coordination)
log "WARNING: Manual data sync from secondary to primary is required"
log "Verify PostgreSQL data is current before proceeding"
read -p "Has data been synchronized? (yes/no): " CONFIRMED
if [ "${CONFIRMED}" != "yes" ]; then
    log "Failback aborted by operator"
    exit 1
fi

# Step 3: Gradually shift traffic back
log "Gradually shifting traffic to primary (10% increments)..."
for weight in 10 25 50 75 100; do
    log "Setting primary weight to ${weight}%..."
    aws route53 change-resource-record-sets \
        --hosted-zone-id "${HOSTED_ZONE_ID}" \
        --change-batch "$(jq -n \
            --arg primary_weight "$weight" \
            --arg secondary_weight "$((100 - weight))" \
            '[{
                "Action": "UPSERT",
                "ResourceRecordSet": {
                    "Name": "api.example.com",
                    "Type": "A",
                    "SetIdentifier": "primary-weight",
                    "Weight": ($primary_weight | tonumber)
                }
            }]' | \
            jq '{Changes: .}')"

    log "Monitoring error rates for 2 minutes at ${weight}% primary traffic..."
    sleep 120

    ERROR_RATE=$(kubectl --context=primary exec -n monitoring \
        deploy/prometheus -- \
        promtool query instant http://localhost:9090 \
        'rate(http_requests_total{status=~"5.."}[1m]) / rate(http_requests_total[1m])' | \
        awk 'NR==2 {print $2}')

    if [ "$(echo "${ERROR_RATE} > 0.01" | bc)" = "1" ]; then
        log "ERROR RATE ${ERROR_RATE} exceeds 1%, pausing failback"
        break
    fi
    log "Error rate ${ERROR_RATE} acceptable, continuing..."
done

log "Failback complete. Primary is receiving traffic."
```

## Summary

Multi-cloud Kubernetes disaster recovery requires systematic engineering across every layer of the stack. The key components of a production DR architecture:

- **Active-passive topology** with automated scaling — secondary cluster runs scaled-down workloads in warm standby, allowing sub-30-minute RTO without the cost of active-active
- **DNS-based failover with health checks** — Route53 failover routing policies provide automatic failover detection; weighted routing enables gradual traffic migration and DR testing without downtime
- **Velero with cross-cloud storage sync** — 15-minute backup schedule with rclone S3-to-GCS synchronization achieves sub-30-minute RPO for stateless workloads
- **PostgreSQL streaming replication** with synchronous commit achieves near-zero RPO for critical databases; asynchronous replication with WAL archiving provides 5-15 minute RPO
- **Automated DR testing** via weekly GitHub Actions pipelines validates RTO and RPO objectives before an actual disaster; without regular testing, DR plans are fiction
- **Runbook automation** that measures elapsed time at each step provides accountability and continuous RTO optimization

The discipline of treating DR as a recurring engineering practice rather than a one-time architecture effort is what separates teams that meet their recovery objectives from those that discover their plan doesn't work during the outage itself.
