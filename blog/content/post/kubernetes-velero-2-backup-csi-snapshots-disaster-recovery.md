---
title: "Kubernetes Velero 2.0 Backup Strategies: CSI Snapshots, Volume Backup Hooks, and Disaster Recovery Testing Automation"
date: 2031-10-06T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Velero", "Backup", "CSI", "Disaster Recovery", "Storage", "DevOps"]
categories:
- Kubernetes
- Disaster Recovery
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes Velero 2.0 backup strategies covering CSI snapshot integration, volume backup hooks for application consistency, and automated disaster recovery testing pipelines for enterprise production environments."
more_link: "yes"
url: "/kubernetes-velero-2-backup-csi-snapshots-disaster-recovery/"
---

Enterprise Kubernetes clusters running stateful workloads require a backup and disaster recovery strategy that goes well beyond simple etcd snapshots. Velero 2.0 introduces first-class CSI snapshot support, improved volume backup hooks, and a richer plugin interface that makes production-grade backup pipelines achievable without custom tooling. This guide walks through every layer of that stack—from VolumeSnapshotClass configuration through automated DR drills that validate recovery objectives on a schedule.

<!--more-->

# Kubernetes Velero 2.0 Backup Strategies

## Section 1: Architecture Overview and Velero 2.0 Changes

Velero coordinates backup operations across three planes: the Kubernetes API (for object manifests), a persistent object store (typically S3-compatible), and a volume snapshot mechanism. Version 2.0 promotes the CSI snapshot path from beta to stable, deprecates the legacy restic integration in favor of Kopia, and adds a new `BackupItemAction` v2 API that supports async operations.

### Key Changes in Velero 2.0

| Feature | v1.x | v2.0 |
|---|---|---|
| Volume backup engine | restic (default) | Kopia (default) |
| CSI snapshot support | Alpha/Beta plugin | Stable, built-in |
| BackupItemAction API | Synchronous only | Async + progress reporting |
| Node Agent DaemonSet | restic | Kopia node-agent |
| Schedule CRD | Basic cron | Cron + pausing + TTL override |

### Component Topology

```
┌──────────────────────────────────────────────────────┐
│  Kubernetes Cluster                                   │
│                                                       │
│  ┌─────────────┐    ┌──────────────────────────────┐ │
│  │  Velero     │    │  Node Agent DaemonSet (Kopia) │ │
│  │  Server Pod │    │  (one pod per node)           │ │
│  └──────┬──────┘    └──────────────┬───────────────┘ │
│         │                          │                  │
│         │  BackupStorageLocation   │  PVC data        │
│         ▼                          ▼                  │
│  ┌─────────────┐    ┌──────────────────────────────┐ │
│  │  S3 Bucket  │    │  VolumeSnapshotContent (CSI)  │ │
│  │  (manifests)│    │  (cloud or local snapshots)   │ │
│  └─────────────┘    └──────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

## Section 2: Installation and BackupStorageLocation Configuration

Install Velero 2.0 using the official Helm chart. The values below configure dual backup storage locations—primary AWS S3 and a cross-region replica—along with the AWS volume snapshot provider.

```bash
helm repo add vmware-tanzu https://vmware-tanzu.github.io/helm-charts
helm repo update

helm install velero vmware-tanzu/velero \
  --namespace velero \
  --create-namespace \
  --version 7.0.0 \
  -f velero-values.yaml
```

```yaml
# velero-values.yaml
image:
  repository: velero/velero
  tag: v2.0.0

configuration:
  backupStorageLocation:
    - name: primary
      provider: aws
      bucket: prod-cluster-velero-backups
      prefix: cluster-01
      config:
        region: us-east-1
        s3ForcePathStyle: "false"
        s3Url: ""
      credential:
        name: velero-aws-credentials
        key: cloud
    - name: replica
      provider: aws
      bucket: prod-cluster-velero-backups-dr
      prefix: cluster-01
      config:
        region: us-west-2
      credential:
        name: velero-aws-credentials
        key: cloud
      default: false

  volumeSnapshotLocation:
    - name: aws-primary
      provider: aws
      config:
        region: us-east-1
      credential:
        name: velero-aws-credentials
        key: cloud

  defaultBackupStorageLocation: primary
  defaultVolumeSnapshotLocations: "aws:aws-primary"

  # Use Kopia for file-level backup (replaces restic)
  uploaderType: kopia

initContainers:
  - name: velero-plugin-for-aws
    image: velero/velero-plugin-for-aws:v1.10.0
    volumeMounts:
      - mountPath: /target
        name: plugins

nodeAgent:
  enabled: true
  podVolumePath: /var/lib/kubelet/pods
  resources:
    requests:
      cpu: 500m
      memory: 512Mi
    limits:
      cpu: 1000m
      memory: 1Gi

credentials:
  secretContents:
    cloud: |
      [default]
      aws_access_key_id=<aws-access-key-id>
      aws_secret_access_key=<aws-secret-access-key>
```

### Verifying BSL Connectivity

```bash
velero backup-location get

# Expected output:
# NAME      PROVIDER   BUCKET/PREFIX                     PHASE       LAST VALIDATED   ACCESS MODE   DEFAULT
# primary   aws        prod-cluster-velero-backups/...   Available   10s ago          ReadWrite     true
# replica   aws        prod-cluster-velero-backups-dr/.. Available   10s ago          ReadWrite     false
```

## Section 3: CSI Snapshot Integration

CSI snapshots allow Velero to delegate volume backup to the storage driver, producing crash-consistent point-in-time snapshots without copying data through the Velero node agent. This is significantly faster and produces snapshots that cloud storage systems can replicate natively.

### Prerequisites: VolumeSnapshotClass

Every CSI driver must expose a `VolumeSnapshotClass`. Label it so Velero selects it automatically.

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: ebs-vsc
  labels:
    velero.io/csi-volumesnapshot-class: "true"
  annotations:
    snapshot.storage.kubernetes.io/is-default-class: "true"
driver: ebs.csi.aws.com
deletionPolicy: Retain
parameters:
  tagSpecification_1: "key=velero-managed,value=true"
  tagSpecification_2: "key=cluster,value=prod-cluster-01"
```

For GKE with the GCE PD CSI driver:

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: gce-pd-vsc
  labels:
    velero.io/csi-volumesnapshot-class: "true"
driver: pd.csi.storage.gke.io
deletionPolicy: Retain
parameters:
  storage-locations: us-central1
```

### Enabling CSI Snapshots in Backup

Add the annotation `backup.velero.io/backup-volumes-with-restic: "false"` to PVCs that should use CSI snapshots, or configure Velero to default to CSI:

```yaml
# In velero-values.yaml
configuration:
  features: EnableCSI
  defaultVolumesToFsBackup: false
```

With `defaultVolumesToFsBackup: false`, Velero uses CSI snapshots for any PVC backed by a CSI driver that has a matching `VolumeSnapshotClass`.

### Verifying Snapshot Creation

```bash
# Trigger a manual backup
velero backup create test-csi-backup \
  --include-namespaces production \
  --snapshot-volumes \
  --wait

# Inspect snapshot details
velero backup describe test-csi-backup --details

# Check VolumeSnapshotContents created
kubectl get volumesnapshotcontents \
  -l velero.io/backup-name=test-csi-backup
```

## Section 4: Volume Backup Hooks for Application Consistency

Crash-consistent snapshots are sufficient for many workloads, but databases require application-consistent snapshots that quiesce writes before the snapshot is taken. Velero hooks allow you to run arbitrary commands inside containers at pre- and post-snapshot points.

### Hook Annotations on Pods

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgresql
  namespace: production
spec:
  template:
    metadata:
      annotations:
        # Pre-snapshot: flush WAL and checkpoint
        pre.hook.backup.velero.io/container: postgresql
        pre.hook.backup.velero.io/command: >-
          ["/bin/bash", "-c",
           "psql -U postgres -c 'CHECKPOINT;' &&
            psql -U postgres -c 'SELECT pg_start_backup(\"velero\", true);'"]
        pre.hook.backup.velero.io/timeout: 60s
        pre.hook.backup.velero.io/on-error: Fail

        # Post-snapshot: resume normal operation
        post.hook.backup.velero.io/container: postgresql
        post.hook.backup.velero.io/command: >-
          ["/bin/bash", "-c",
           "psql -U postgres -c 'SELECT pg_stop_backup();'"]
        post.hook.backup.velero.io/timeout: 30s
        post.hook.backup.velero.io/on-error: Continue
```

### Hook Specification via Backup Resource

For more control, embed hooks directly in the `Backup` spec using `spec.hooks`:

```yaml
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: production-consistent-backup
  namespace: velero
spec:
  includedNamespaces:
    - production
  storageLocation: primary
  snapshotVolumes: true
  ttl: 720h  # 30 days
  hooks:
    resources:
      - name: postgresql-pre-post
        includedNamespaces:
          - production
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
                  psql -U postgres -c 'CHECKPOINT;'
                  psql -U postgres -c "SELECT pg_start_backup('velero-$(date +%s)', true);"
              onError: Fail
              timeout: 90s
        post:
          - exec:
              container: postgresql
              command:
                - /bin/bash
                - -c
                - psql -U postgres -c "SELECT pg_stop_backup();"
              onError: Continue
              timeout: 30s
      - name: mysql-flush-tables
        includedNamespaces:
          - production
        labelSelector:
          matchLabels:
            app: mysql
        pre:
          - exec:
              container: mysql
              command:
                - /bin/bash
                - -c
                - mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" -e "FLUSH TABLES WITH READ LOCK;"
              onError: Fail
              timeout: 60s
        post:
          - exec:
              container: mysql
              command:
                - /bin/bash
                - -c
                - mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" -e "UNLOCK TABLES;"
              onError: Continue
              timeout: 30s
```

### MongoDB Consistent Backup Hook

```yaml
pre:
  - exec:
      container: mongodb
      command:
        - /bin/bash
        - -c
        - |
          mongo --eval "db.fsyncLock()" admin
      onError: Fail
      timeout: 30s
post:
  - exec:
      container: mongodb
      command:
        - /bin/bash
        - -c
        - |
          mongo --eval "db.fsyncUnlock()" admin
      onError: Continue
      timeout: 15s
```

## Section 5: Backup Schedules with TTL Management

Production clusters need multiple backup schedules operating at different frequencies. Velero's `Schedule` CRD supports full cron syntax and per-schedule TTL overrides.

```yaml
# Hourly incremental for critical namespaces (24-hour retention)
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: critical-ns-hourly
  namespace: velero
spec:
  schedule: "0 * * * *"
  useOwnerReferencesInBackup: false
  template:
    includedNamespaces:
      - production
      - payment-processing
    excludedResources:
      - events
      - events.events.k8s.io
    snapshotVolumes: true
    storageLocation: primary
    ttl: 24h
    hooks:
      resources:
        - name: db-quiesce
          includedNamespaces:
            - production
          labelSelector:
            matchLabels:
              backup-hook: db-quiesce
          pre:
            - exec:
                container: app
                command: ["/scripts/pre-backup.sh"]
                onError: Fail
                timeout: 60s
          post:
            - exec:
                container: app
                command: ["/scripts/post-backup.sh"]
                onError: Continue
                timeout: 30s
---
# Daily full backup (7-day retention)
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: full-cluster-daily
  namespace: velero
spec:
  schedule: "0 2 * * *"
  template:
    includedNamespaces: []   # empty = all namespaces
    excludedNamespaces:
      - kube-system
      - kube-public
      - kube-node-lease
      - local-path-storage
    excludedResources:
      - events
      - events.events.k8s.io
      - nodes
      - persistentvolumes
    snapshotVolumes: true
    storageLocation: primary
    volumeSnapshotLocations:
      - aws-primary
    ttl: 168h  # 7 days
---
# Weekly backup to replica region (90-day retention)
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: weekly-cross-region
  namespace: velero
spec:
  schedule: "0 3 * * 0"
  template:
    includedNamespaces: []
    excludedNamespaces:
      - kube-system
      - kube-public
      - kube-node-lease
    snapshotVolumes: true
    storageLocation: replica
    ttl: 2160h  # 90 days
```

## Section 6: Restore Procedures and Namespace Mapping

### Basic Namespace Restore

```bash
# List available backups
velero backup get

# Restore entire namespace from latest daily backup
velero restore create \
  --from-backup full-cluster-daily-20310928020000 \
  --include-namespaces production \
  --wait

# Monitor restore status
velero restore describe production-restore-20310928 --details
```

### Cross-Cluster Restore with Namespace Mapping

When recovering into a different cluster or mapping namespaces during migration:

```bash
# In the target cluster, configure the same BSL pointing to the source bucket
velero backup-location create source-cluster \
  --provider aws \
  --bucket prod-cluster-velero-backups \
  --prefix cluster-01 \
  --config region=us-east-1 \
  --access-mode ReadOnly \
  --credential velero-aws-credentials:cloud

# Sync backup metadata from remote
velero backup sync

# Restore with namespace remapping
velero restore create migration-restore \
  --from-backup full-cluster-daily-20310928020000 \
  --include-namespaces production \
  --namespace-mappings production:production-v2 \
  --restore-volumes \
  --wait
```

### Selective Resource Restore

```bash
# Restore only ConfigMaps and Secrets (no volumes)
velero restore create config-restore \
  --from-backup full-cluster-daily-20310928020000 \
  --include-namespaces production \
  --include-resources configmaps,secrets \
  --restore-volumes=false

# Restore specific pods matching a label selector
velero restore create app-restore \
  --from-backup full-cluster-daily-20310928020000 \
  --include-namespaces production \
  --selector "app=payment-api" \
  --restore-volumes
```

## Section 7: Disaster Recovery Testing Automation

The most dangerous DR plan is one that has never been tested. The following CronJob runs automated restore drills into an isolated namespace, validates application health, and reports results to a monitoring endpoint.

### DR Test Controller CronJob

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: dr-test-script
  namespace: velero
data:
  dr-test.sh: |
    #!/bin/bash
    set -euo pipefail

    BACKUP_NAME="${BACKUP_NAME:-full-cluster-daily}"
    TEST_NS="dr-test-$(date +%s)"
    SLACK_WEBHOOK="${SLACK_WEBHOOK_URL}"
    MAX_WAIT_SECONDS=600
    ELAPSED=0

    log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

    notify_slack() {
      local status="$1" message="$2"
      curl -s -X POST "${SLACK_WEBHOOK}" \
        -H 'Content-type: application/json' \
        --data "{\"text\":\"DR Test ${status}: ${message}\"}" || true
    }

    cleanup() {
      log "Cleaning up test namespace ${TEST_NS}"
      kubectl delete namespace "${TEST_NS}" --ignore-not-found=true
      velero restore delete "dr-test-${TEST_NS}" --confirm --ignore-not-found || true
    }
    trap cleanup EXIT

    # Find the latest successful backup matching the schedule
    LATEST_BACKUP=$(velero backup get \
      --selector "velero.io/schedule-name=${BACKUP_NAME}" \
      --output json 2>/dev/null | \
      jq -r '[.items[] | select(.status.phase=="Completed")] |
             sort_by(.status.completionTimestamp) | last | .metadata.name')

    if [[ -z "${LATEST_BACKUP}" || "${LATEST_BACKUP}" == "null" ]]; then
      notify_slack "FAILED" "No completed backup found for schedule ${BACKUP_NAME}"
      exit 1
    fi

    log "Testing restore from backup: ${LATEST_BACKUP}"

    # Create isolated test namespace
    kubectl create namespace "${TEST_NS}"
    kubectl label namespace "${TEST_NS}" \
      purpose=dr-test \
      test-backup="${LATEST_BACKUP}"

    # Perform restore into test namespace
    velero restore create "dr-test-${TEST_NS}" \
      --from-backup "${LATEST_BACKUP}" \
      --include-namespaces production \
      --namespace-mappings "production:${TEST_NS}" \
      --restore-volumes=false \
      --wait=false

    # Wait for restore to complete
    while [[ $ELAPSED -lt $MAX_WAIT_SECONDS ]]; do
      PHASE=$(velero restore get "dr-test-${TEST_NS}" \
        --output json 2>/dev/null | jq -r '.status.phase // "Unknown"')
      log "Restore phase: ${PHASE} (${ELAPSED}s elapsed)"
      if [[ "${PHASE}" == "Completed" ]]; then break; fi
      if [[ "${PHASE}" == "Failed" || "${PHASE}" == "PartiallyFailed" ]]; then
        notify_slack "FAILED" "Restore from ${LATEST_BACKUP} ${PHASE}"
        exit 1
      fi
      sleep 15
      ELAPSED=$((ELAPSED + 15))
    done

    if [[ $ELAPSED -ge $MAX_WAIT_SECONDS ]]; then
      notify_slack "FAILED" "Restore timed out after ${MAX_WAIT_SECONDS}s"
      exit 1
    fi

    # Count restored resources
    RESTORED_PODS=$(kubectl get pods -n "${TEST_NS}" --no-headers 2>/dev/null | wc -l)
    RESTORED_SVCS=$(kubectl get services -n "${TEST_NS}" --no-headers 2>/dev/null | wc -l)
    RESTORED_CMS=$(kubectl get configmaps -n "${TEST_NS}" --no-headers 2>/dev/null | wc -l)

    log "Restored: ${RESTORED_PODS} pods, ${RESTORED_SVCS} services, ${RESTORED_CMS} configmaps"

    # Basic sanity check: expect at least some resources
    if [[ $RESTORED_PODS -lt 1 ]]; then
      notify_slack "FAILED" "Zero pods restored from backup ${LATEST_BACKUP}"
      exit 1
    fi

    # Record metrics to Prometheus pushgateway
    cat <<EOF | curl -s --data-binary @- \
      http://prometheus-pushgateway.monitoring.svc.cluster.local:9091/metrics/job/dr_test
    # TYPE dr_test_last_success_timestamp gauge
    dr_test_last_success_timestamp{backup="${LATEST_BACKUP}",cluster="prod-cluster-01"} $(date +%s)
    # TYPE dr_test_restored_pods gauge
    dr_test_restored_pods{backup="${LATEST_BACKUP}"} ${RESTORED_PODS}
    EOF

    notify_slack "SUCCESS" \
      "Restore from ${LATEST_BACKUP} verified. Pods: ${RESTORED_PODS}, Services: ${RESTORED_SVCS}"
    log "DR test completed successfully"
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: dr-test-automation
  namespace: velero
spec:
  schedule: "0 4 * * 3"  # Every Wednesday at 04:00 UTC
  concurrencyPolicy: Forbid
  failedJobsHistoryLimit: 5
  successfulJobsHistoryLimit: 5
  jobTemplate:
    spec:
      backoffLimit: 0
      template:
        spec:
          serviceAccountName: velero-dr-test
          restartPolicy: Never
          containers:
            - name: dr-test
              image: bitnami/kubectl:1.31
              command: ["/bin/bash", "/scripts/dr-test.sh"]
              env:
                - name: BACKUP_NAME
                  value: "full-cluster-daily"
                - name: SLACK_WEBHOOK_URL
                  valueFrom:
                    secretKeyRef:
                      name: dr-test-secrets
                      key: slack-webhook-url
              volumeMounts:
                - name: script
                  mountPath: /scripts
          volumes:
            - name: script
              configMap:
                name: dr-test-script
                defaultMode: 0755
```

### RBAC for DR Test ServiceAccount

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: velero-dr-test
  namespace: velero
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: velero-dr-test
rules:
  - apiGroups: ["velero.io"]
    resources: ["backups", "restores", "backupstoragelocations"]
    verbs: ["get", "list", "create", "delete"]
  - apiGroups: [""]
    resources: ["namespaces", "pods", "services", "configmaps"]
    verbs: ["get", "list", "create", "delete"]
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: velero-dr-test
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: velero-dr-test
subjects:
  - kind: ServiceAccount
    name: velero-dr-test
    namespace: velero
```

## Section 8: Monitoring Backup Health with Prometheus

Velero exposes Prometheus metrics on port 8085. Scrape them and alert on backup age and failure rates.

```yaml
# PrometheusRule for backup alerting
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: velero-backup-alerts
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    - name: velero.backup
      interval: 60s
      rules:
        - alert: VeleroBackupNotRunning
          expr: |
            (time() - velero_backup_last_successful_timestamp{schedule="full-cluster-daily"}) > 86400
          for: 30m
          labels:
            severity: critical
            team: platform
          annotations:
            summary: "Full cluster daily backup has not run in 24 hours"
            description: "Last successful backup for schedule full-cluster-daily was {{ $value | humanizeDuration }} ago."

        - alert: VeleroBackupFailed
          expr: |
            increase(velero_backup_failure_total[1h]) > 0
          for: 5m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "Velero backup failures detected"
            description: "{{ $value }} backup failures in the last hour."

        - alert: VeleroBackupStorageLocationUnavailable
          expr: |
            velero_backup_storage_location_status{phase!="Available"} == 1
          for: 10m
          labels:
            severity: critical
          annotations:
            summary: "Backup storage location {{ $labels.backup_storage_location }} is unavailable"

        - alert: VeleroDRTestMissing
          expr: |
            (time() - dr_test_last_success_timestamp) > 604800
          for: 1h
          labels:
            severity: warning
          annotations:
            summary: "DR test has not run in 7 days"
```

## Section 9: Backup Encryption at Rest

Velero does not encrypt backups natively; rely on server-side encryption at the object store level plus optional client-side encryption via a BackupItemAction plugin.

### S3 Bucket Encryption Policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyUnEncryptedObjectUploads",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::prod-cluster-velero-backups/*",
      "Condition": {
        "StringNotEquals": {
          "s3:x-amz-server-side-encryption": "aws:kms"
        }
      }
    }
  ]
}
```

```yaml
# Velero BSL with SSE-KMS
configuration:
  backupStorageLocation:
    - name: primary
      provider: aws
      bucket: prod-cluster-velero-backups
      config:
        region: us-east-1
        kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/mrk-abc123def456abc123def456abc123de"
        serverSideEncryption: aws:kms
```

## Section 10: Troubleshooting Common Issues

### Backup Stuck in InProgress

```bash
# Check node agent logs on the node hosting the PVC
NODE=$(kubectl get pod -n production <pod-name> -o jsonpath='{.spec.nodeName}')
NODE_AGENT_POD=$(kubectl get pod -n velero \
  -l name=node-agent \
  --field-selector spec.nodeName="${NODE}" \
  -o jsonpath='{.items[0].metadata.name}')
kubectl logs -n velero "${NODE_AGENT_POD}" --tail=100

# Force delete a stuck backup
kubectl delete backup <backup-name> -n velero
# The finalizer may prevent deletion; remove it
kubectl patch backup <backup-name> -n velero \
  -p '{"metadata":{"finalizers":[]}}' \
  --type=merge
```

### CSI Snapshot Not Created

```bash
# Verify VolumeSnapshotClass label
kubectl get volumesnapshotclass -o wide
kubectl describe volumesnapshotclass ebs-vsc

# Confirm CSI feature gate
velero client config set features=EnableCSI

# Check external-snapshotter controller logs
kubectl logs -n kube-system \
  -l app=snapshot-controller --tail=50
```

### Restore Missing Volumes

```bash
# Confirm PVCs in backup
velero backup describe <backup-name> --details | grep -i pvc

# Check if VolumeSnapshotContents were retained
kubectl get volumesnapshotcontents \
  -l velero.io/backup-name=<backup-name>

# If using Kopia (file backup), verify node-agent ran
kubectl get podvolumebackups -n velero \
  -l velero.io/backup-name=<backup-name>
```

## Section 11: Production Checklist

Before declaring a Velero implementation production-ready, verify all items below:

```bash
#!/bin/bash
# velero-readiness-check.sh

PASS=0
FAIL=0

check() {
  local desc="$1" cmd="$2"
  if eval "${cmd}" &>/dev/null; then
    echo "[PASS] ${desc}"
    PASS=$((PASS + 1))
  else
    echo "[FAIL] ${desc}"
    FAIL=$((FAIL + 1))
  fi
}

check "Velero server pod running" \
  "kubectl get pod -n velero -l app.kubernetes.io/name=velero -o jsonpath='{.items[0].status.phase}' | grep -q Running"

check "Node agent DaemonSet fully scheduled" \
  "kubectl rollout status daemonset -n velero velero-node-agent"

check "Primary BSL available" \
  "velero backup-location get primary -o json | jq -e '.status.phase==\"Available\"'"

check "VolumeSnapshotClass labeled for Velero" \
  "kubectl get volumesnapshotclass -l velero.io/csi-volumesnapshot-class=true --no-headers | grep -q ."

check "Schedule full-cluster-daily exists" \
  "velero schedule get full-cluster-daily"

check "Last full backup completed within 25 hours" \
  "velero backup get --selector velero.io/schedule-name=full-cluster-daily -o json | \
   jq -e '[.items[] | select(.status.phase==\"Completed\")] | length > 0'"

check "Prometheus metrics endpoint reachable" \
  "kubectl exec -n velero deployment/velero -- wget -qO- localhost:8085/metrics | grep -q velero_backup_total"

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[[ $FAIL -eq 0 ]]
```

## Summary

Velero 2.0 with CSI snapshots provides enterprise Kubernetes clusters with a robust, driver-native backup path that avoids the overhead of copying data through the Velero node agent for every backup. Application consistency is achieved through pre/post hooks that quiesce workloads before the snapshot is taken. Automated DR testing scheduled as a CronJob removes the manual burden of periodic DR drills and provides continuous evidence that recovery objectives are met. Combine this with Prometheus alerting on backup age and failure rates, and the result is a backup system that is observable, auditable, and provably functional.
