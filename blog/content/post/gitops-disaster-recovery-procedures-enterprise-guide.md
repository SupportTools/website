---
title: "GitOps Disaster Recovery Procedures: Enterprise Production Guide"
date: 2026-07-13T00:00:00-05:00
draft: false
tags: ["GitOps", "Disaster Recovery", "Kubernetes", "ArgoCD", "Flux", "DevOps", "Business Continuity"]
categories: ["GitOps", "DevOps", "Disaster Recovery"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive GitOps disaster recovery strategies including backup procedures, recovery automation, multi-cluster failover, and production-ready business continuity planning for enterprise Kubernetes environments."
more_link: "yes"
url: "/gitops-disaster-recovery-procedures-enterprise-guide/"
---

Master GitOps disaster recovery with comprehensive backup strategies, automated recovery procedures, multi-cluster failover, state restoration, and production-ready business continuity planning for enterprise Kubernetes deployments.

<!--more-->

# GitOps Disaster Recovery Procedures: Enterprise Production Guide

## Executive Summary

Disaster recovery planning is critical for GitOps-managed Kubernetes environments. This comprehensive guide covers enterprise-grade disaster recovery strategies including Git repository backup, ArgoCD/Flux CD state preservation, multi-cluster failover procedures, automated recovery workflows, and complete business continuity planning that ensures rapid recovery from catastrophic failures.

## Table of Contents

1. [Disaster Recovery Strategy](#dr-strategy)
2. [Git Repository Backup](#git-backup)
3. [GitOps Operator State](#operator-state)
4. [Kubernetes Cluster Backup](#cluster-backup)
5. [Recovery Procedures](#recovery-procedures)
6. [Multi-Cluster Failover](#multi-cluster-failover)
7. [Automated Recovery Workflows](#automated-recovery)
8. [Testing and Validation](#testing-validation)
9. [Business Continuity Planning](#business-continuity)
10. [Runbooks and Documentation](#runbooks)

## Disaster Recovery Strategy {#dr-strategy}

### Recovery Objectives

```yaml
recovery_objectives:
  rpo_targets:
    git_repositories:
      target: "0 minutes"
      strategy: "Real-time replication"

    application_state:
      target: "5 minutes"
      strategy: "Continuous sync"

    persistent_data:
      target: "15 minutes"
      strategy: "Incremental backups"

    cluster_configuration:
      target: "0 minutes"
      strategy: "Infrastructure as Code"

  rto_targets:
    control_plane:
      target: "15 minutes"
      procedure: "Automated cluster provisioning"

    applications:
      target: "30 minutes"
      procedure: "GitOps automated sync"

    data_restoration:
      target: "1 hour"
      procedure: "Velero restore"

    full_environment:
      target: "2 hours"
      procedure: "Complete DR workflow"
```

### Disaster Scenarios

```yaml
disaster_scenarios:
  git_repository_loss:
    severity: critical
    impact: "Complete loss of source of truth"
    recovery_plan: "Restore from backup repositories"
    preventive_measures:
      - Multiple Git repository replicas
      - Regular backup verification
      - Git provider redundancy

  cluster_failure:
    severity: critical
    impact: "Complete application downtime"
    recovery_plan: "Failover to standby cluster"
    preventive_measures:
      - Multi-cluster deployment
      - Regular failover testing
      - Automated health monitoring

  gitops_operator_corruption:
    severity: high
    impact: "Loss of sync capability"
    recovery_plan: "Reinstall operator from backup"
    preventive_measures:
      - Operator configuration backup
      - Version control
      - Declarative configuration

  persistent_volume_loss:
    severity: high
    impact: "Data loss"
    recovery_plan: "Restore from Velero backup"
    preventive_measures:
      - Regular volume snapshots
      - Cross-region backups
      - Backup verification

  secrets_compromise:
    severity: critical
    impact: "Security breach"
    recovery_plan: "Rotate all secrets"
    preventive_measures:
      - Secret encryption
      - External secret management
      - Regular secret rotation

  network_partition:
    severity: medium
    impact: "Cluster isolation"
    recovery_plan: "Network restoration or failover"
    preventive_measures:
      - Multi-region deployment
      - Network redundancy
      - Circuit breaker patterns
```

## Git Repository Backup {#git-backup}

### Multi-Region Git Replication

```bash
#!/bin/bash
# git-backup-replication.sh - Multi-region Git repository replication

set -euo pipefail

export PRIMARY_REPO="git@github.com:myorg/gitops-config.git"
export BACKUP_REPOS=(
  "git@gitlab.com:myorg/gitops-config-backup.git"
  "git@bitbucket.org:myorg/gitops-config-backup.git"
  "git@git.internal.example.com:gitops/config-backup.git"
)

echo "=== Git Repository Replication ==="

# Clone primary repository
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

cd "$TEMP_DIR"
git clone --mirror "$PRIMARY_REPO" repo.git
cd repo.git

# Replicate to all backup repositories
for backup_repo in "${BACKUP_REPOS[@]}"; do
  echo "Replicating to $backup_repo..."

  if git remote | grep -q "backup-$(echo $backup_repo | md5sum | cut -d' ' -f1)"; then
    git remote remove "backup-$(echo $backup_repo | md5sum | cut -d' ' -f1)"
  fi

  git remote add "backup-$(echo $backup_repo | md5sum | cut -d' ' -f1)" "$backup_repo"
  git push --mirror "backup-$(echo $backup_repo | md5sum | cut -d' ' -f1)" --force

  echo "✓ Replicated to $backup_repo"
done

echo "✓ Repository replication complete"
```

### Automated Backup Verification

```bash
#!/bin/bash
# verify-git-backups.sh - Verify backup repository integrity

set -euo pipefail

export PRIMARY_REPO="git@github.com:myorg/gitops-config.git"
export BACKUP_REPOS=(
  "git@gitlab.com:myorg/gitops-config-backup.git"
  "git@bitbucket.org:myorg/gitops-config-backup.git"
)

echo "=== Git Backup Verification ==="

# Get primary repository state
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

cd "$TEMP_DIR"
git clone "$PRIMARY_REPO" primary
cd primary

PRIMARY_COMMIT=$(git rev-parse HEAD)
PRIMARY_BRANCHES=$(git branch -r | wc -l)
PRIMARY_TAGS=$(git tag | wc -l)

echo "Primary repository:"
echo "  Latest commit: $PRIMARY_COMMIT"
echo "  Branches: $PRIMARY_BRANCHES"
echo "  Tags: $PRIMARY_TAGS"

# Verify each backup
for backup_repo in "${BACKUP_REPOS[@]}"; do
  echo -e "\nVerifying $backup_repo..."

  cd "$TEMP_DIR"
  git clone "$backup_repo" "backup-$(echo $backup_repo | md5sum | cut -d' ' -f1)"
  cd "backup-$(echo $backup_repo | md5sum | cut -d' ' -f1)"

  BACKUP_COMMIT=$(git rev-parse HEAD)
  BACKUP_BRANCHES=$(git branch -r | wc -l)
  BACKUP_TAGS=$(git tag | wc -l)

  if [ "$PRIMARY_COMMIT" = "$BACKUP_COMMIT" ]; then
    echo "✓ Commit hash matches"
  else
    echo "✗ Commit hash mismatch"
    echo "  Primary: $PRIMARY_COMMIT"
    echo "  Backup: $BACKUP_COMMIT"
    exit 1
  fi

  if [ "$PRIMARY_BRANCHES" = "$BACKUP_BRANCHES" ]; then
    echo "✓ Branch count matches"
  else
    echo "⚠ Branch count mismatch (Primary: $PRIMARY_BRANCHES, Backup: $BACKUP_BRANCHES)"
  fi

  if [ "$PRIMARY_TAGS" = "$BACKUP_TAGS" ]; then
    echo "✓ Tag count matches"
  else
    echo "⚠ Tag count mismatch (Primary: $PRIMARY_TAGS, Backup: $BACKUP_TAGS)"
  fi
done

echo -e "\n✓ Backup verification complete"
```

### Git Repository Backup CronJob

```yaml
# git-backup-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: git-backup
  namespace: gitops-system
spec:
  schedule: "*/15 * * * *"  # Every 15 minutes
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  concurrencyPolicy: Forbid

  jobTemplate:
    spec:
      template:
        metadata:
          labels:
            app: git-backup
        spec:
          restartPolicy: OnFailure

          serviceAccountName: git-backup

          containers:
          - name: backup
            image: alpine/git:latest
            command:
            - sh
            - -c
            - |
              set -e

              # Configure Git
              git config --global user.name "GitOps Backup"
              git config --global user.email "gitops-backup@example.com"

              # Clone primary repository
              git clone --mirror ${PRIMARY_REPO} /tmp/repo.git
              cd /tmp/repo.git

              # Push to all backup repositories
              for backup in ${BACKUP_REPOS}; do
                echo "Backing up to $backup"
                git push --mirror $backup --force || echo "Failed to backup to $backup"
              done

              echo "Backup complete"

            env:
            - name: PRIMARY_REPO
              value: "https://github.com/myorg/gitops-config.git"
            - name: BACKUP_REPOS
              value: "https://gitlab.com/myorg/gitops-config-backup.git https://bitbucket.org/myorg/gitops-config-backup.git"
            - name: GIT_USERNAME
              valueFrom:
                secretKeyRef:
                  name: git-credentials
                  key: username
            - name: GIT_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: git-credentials
                  key: password

            volumeMounts:
            - name: git-config
              mountPath: /root/.gitconfig
              subPath: .gitconfig

          volumes:
          - name: git-config
            configMap:
              name: git-config
```

## GitOps Operator State {#operator-state}

### ArgoCD State Backup

```bash
#!/bin/bash
# backup-argocd-state.sh - Backup ArgoCD configuration and state

set -euo pipefail

export NAMESPACE="argocd"
export BACKUP_DIR="/backups/argocd/$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"

echo "=== ArgoCD State Backup ==="

# Backup ArgoCD CRDs
echo "Backing up ArgoCD CRDs..."
kubectl get crd -o yaml | grep "argoproj.io" > "$BACKUP_DIR/argocd-crds.yaml"

# Backup ArgoCD Applications
echo "Backing up Applications..."
kubectl get applications -n "$NAMESPACE" -o yaml > "$BACKUP_DIR/applications.yaml"

# Backup ArgoCD ApplicationSets
echo "Backing up ApplicationSets..."
kubectl get applicationsets -n "$NAMESPACE" -o yaml > "$BACKUP_DIR/applicationsets.yaml"

# Backup ArgoCD AppProjects
echo "Backing up AppProjects..."
kubectl get appprojects -n "$NAMESPACE" -o yaml > "$BACKUP_DIR/appprojects.yaml"

# Backup ArgoCD ConfigMaps
echo "Backing up ConfigMaps..."
kubectl get configmap -n "$NAMESPACE" -o yaml > "$BACKUP_DIR/configmaps.yaml"

# Backup ArgoCD Secrets (encrypted)
echo "Backing up Secrets..."
kubectl get secrets -n "$NAMESPACE" -o yaml > "$BACKUP_DIR/secrets.yaml"

# Encrypt secrets
echo "Encrypting secrets..."
sops --encrypt --in-place "$BACKUP_DIR/secrets.yaml"

# Backup ArgoCD settings
echo "Backing up ArgoCD settings..."
kubectl get configmap argocd-cm -n "$NAMESPACE" -o yaml > "$BACKUP_DIR/argocd-cm.yaml"
kubectl get configmap argocd-rbac-cm -n "$NAMESPACE" -o yaml > "$BACKUP_DIR/argocd-rbac-cm.yaml"
kubectl get configmap argocd-cmd-params-cm -n "$NAMESPACE" -o yaml > "$BACKUP_DIR/argocd-cmd-params-cm.yaml"

# Backup repository credentials
echo "Backing up repository credentials..."
argocd repocreds list --output json > "$BACKUP_DIR/repo-creds.json"

# Backup clusters
echo "Backing up cluster configurations..."
argocd cluster list --output json > "$BACKUP_DIR/clusters.json"

# Create tarball
echo "Creating backup archive..."
tar czf "$BACKUP_DIR.tar.gz" -C "$(dirname $BACKUP_DIR)" "$(basename $BACKUP_DIR)"

# Upload to S3
echo "Uploading to S3..."
aws s3 cp "$BACKUP_DIR.tar.gz" "s3://my-backups/argocd/"

# Cleanup old backups
echo "Cleaning up old backups..."
find /backups/argocd -type d -mtime +30 -exec rm -rf {} +

echo "✓ ArgoCD backup complete: $BACKUP_DIR.tar.gz"
```

### Flux CD State Backup

```bash
#!/bin/bash
# backup-flux-state.sh - Backup Flux CD configuration and state

set -euo pipefail

export NAMESPACE="flux-system"
export BACKUP_DIR="/backups/flux/$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"

echo "=== Flux CD State Backup ==="

# Backup Flux CRDs
echo "Backing up Flux CRDs..."
kubectl get crd -o yaml | grep "fluxcd.io" > "$BACKUP_DIR/flux-crds.yaml"

# Backup GitRepositories
echo "Backing up GitRepositories..."
kubectl get gitrepositories -A -o yaml > "$BACKUP_DIR/gitrepositories.yaml"

# Backup Kustomizations
echo "Backing up Kustomizations..."
kubectl get kustomizations -A -o yaml > "$BACKUP_DIR/kustomizations.yaml"

# Backup HelmRepositories
echo "Backing up HelmRepositories..."
kubectl get helmrepositories -A -o yaml > "$BACKUP_DIR/helmrepositories.yaml"

# Backup HelmReleases
echo "Backing up HelmReleases..."
kubectl get helmreleases -A -o yaml > "$BACKUP_DIR/helmreleases.yaml"

# Backup ImageRepositories
echo "Backing up ImageRepositories..."
kubectl get imagerepositories -A -o yaml > "$BACKUP_DIR/imagerepositories.yaml"

# Backup ImagePolicies
echo "Backing up ImagePolicies..."
kubectl get imagepolicies -A -o yaml > "$BACKUP_DIR/imagepolicies.yaml"

# Backup ImageUpdateAutomations
echo "Backing up ImageUpdateAutomations..."
kubectl get imageupdateautomations -A -o yaml > "$BACKUP_DIR/imageupdateautomations.yaml"

# Backup Flux system resources
echo "Backing up Flux system resources..."
kubectl get all -n "$NAMESPACE" -o yaml > "$BACKUP_DIR/flux-system.yaml"

# Backup ConfigMaps
echo "Backing up ConfigMaps..."
kubectl get configmap -n "$NAMESPACE" -o yaml > "$BACKUP_DIR/configmaps.yaml"

# Backup Secrets (encrypted)
echo "Backing up Secrets..."
kubectl get secrets -n "$NAMESPACE" -o yaml > "$BACKUP_DIR/secrets.yaml"

# Encrypt secrets
sops --encrypt --in-place "$BACKUP_DIR/secrets.yaml"

# Export Flux configuration
echo "Exporting Flux configuration..."
flux export source git --all --all-namespaces > "$BACKUP_DIR/flux-sources-git.yaml"
flux export source helm --all --all-namespaces > "$BACKUP_DIR/flux-sources-helm.yaml"
flux export kustomization --all --all-namespaces > "$BACKUP_DIR/flux-kustomizations.yaml"
flux export helmrelease --all --all-namespaces > "$BACKUP_DIR/flux-helmreleases.yaml"

# Create tarball
tar czf "$BACKUP_DIR.tar.gz" -C "$(dirname $BACKUP_DIR)" "$(basename $BACKUP_DIR)"

# Upload to S3
aws s3 cp "$BACKUP_DIR.tar.gz" "s3://my-backups/flux/"

echo "✓ Flux backup complete: $BACKUP_DIR.tar.gz"
```

## Kubernetes Cluster Backup {#cluster-backup}

### Velero Backup Configuration

```yaml
# velero-backup-schedule.yaml
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: full-cluster-backup
  namespace: velero
spec:
  schedule: "0 2 * * *"  # Daily at 2 AM
  template:
    ttl: 720h  # 30 days

    includedNamespaces:
    - "*"

    excludedNamespaces:
    - kube-system
    - kube-public
    - kube-node-lease

    includedResources:
    - "*"

    excludedResources:
    - events
    - events.events.k8s.io

    labelSelector:
      matchLabels:
        backup: "true"

    snapshotVolumes: true
    defaultVolumesToRestic: true

    hooks:
      resources:
      - name: backup-database
        includedNamespaces:
        - production
        labelSelector:
          matchLabels:
            app: database
        pre:
        - exec:
            container: postgresql
            command:
            - /bin/bash
            - -c
            - pg_dump -U postgres mydb > /tmp/backup.sql
            onError: Fail
            timeout: 5m
        post:
        - exec:
            container: postgresql
            command:
            - rm
            - /tmp/backup.sql
---
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: namespace-backup
  namespace: velero
spec:
  schedule: "0 */6 * * *"  # Every 6 hours
  template:
    ttl: 168h  # 7 days

    includedNamespaces:
    - production
    - staging

    snapshotVolumes: true
    defaultVolumesToRestic: true
---
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: application-backup
  namespace: velero
spec:
  schedule: "0 * * * *"  # Hourly
  template:
    ttl: 72h  # 3 days

    labelSelector:
      matchLabels:
        backup-frequency: hourly

    snapshotVolumes: true
    defaultVolumesToRestic: true
```

### Etcd Backup

```bash
#!/bin/bash
# etcd-backup.sh - Backup etcd database

set -euo pipefail

export ETCDCTL_API=3
export BACKUP_DIR="/backups/etcd/$(date +%Y%m%d-%H%M%S)"
export ETCD_ENDPOINTS="https://127.0.0.1:2379"
export ETCD_CACERT="/etc/kubernetes/pki/etcd/ca.crt"
export ETCD_CERT="/etc/kubernetes/pki/etcd/server.crt"
export ETCD_KEY="/etc/kubernetes/pki/etcd/server.key"

mkdir -p "$BACKUP_DIR"

echo "=== Etcd Backup ==="

# Create snapshot
echo "Creating etcd snapshot..."
etcdctl snapshot save "$BACKUP_DIR/snapshot.db" \
  --endpoints="$ETCD_ENDPOINTS" \
  --cacert="$ETCD_CACERT" \
  --cert="$ETCD_CERT" \
  --key="$ETCD_KEY"

# Verify snapshot
echo "Verifying snapshot..."
etcdctl snapshot status "$BACKUP_DIR/snapshot.db" -w table

# Backup etcd configuration
echo "Backing up etcd configuration..."
cp -r /etc/kubernetes/pki/etcd "$BACKUP_DIR/etcd-pki"
cp /etc/kubernetes/manifests/etcd.yaml "$BACKUP_DIR/etcd-manifest.yaml"

# Create tarball
tar czf "$BACKUP_DIR.tar.gz" -C "$(dirname $BACKUP_DIR)" "$(basename $BACKUP_DIR)"

# Upload to S3
aws s3 cp "$BACKUP_DIR.tar.gz" "s3://my-backups/etcd/"

# Cleanup old backups
find /backups/etcd -type d -mtime +7 -exec rm -rf {} +

echo "✓ Etcd backup complete: $BACKUP_DIR.tar.gz"
```

## Recovery Procedures {#recovery-procedures}

### GitOps Recovery Workflow

```bash
#!/bin/bash
# gitops-recovery.sh - Complete GitOps disaster recovery workflow

set -euo pipefail

export RECOVERY_MODE="${1:-full}"  # full, partial, app-only
export CLUSTER_NAME="${2:-recovery-cluster}"
export BACKUP_DATE="${3:-latest}"

echo "=== GitOps Disaster Recovery ==="
echo "Mode: $RECOVERY_MODE"
echo "Cluster: $CLUSTER_NAME"
echo "Backup Date: $BACKUP_DATE"

# Step 1: Provision new cluster
if [ "$RECOVERY_MODE" = "full" ]; then
  echo -e "\n--- Step 1: Provisioning new cluster ---"
  ./provision-cluster.sh "$CLUSTER_NAME"

  # Wait for cluster to be ready
  kubectl wait --for=condition=Ready nodes --all --timeout=600s
fi

# Step 2: Restore etcd (if full recovery)
if [ "$RECOVERY_MODE" = "full" ]; then
  echo -e "\n--- Step 2: Restoring etcd ---"
  ./restore-etcd.sh "$BACKUP_DATE"
fi

# Step 3: Install Velero
echo -e "\n--- Step 3: Installing Velero ---"
helm install velero vmware-tanzu/velero \
  --namespace velero \
  --create-namespace \
  --set configuration.provider=aws \
  --set configuration.backupStorageLocation.bucket=my-backups \
  --set configuration.backupStorageLocation.config.region=us-east-1 \
  --set configuration.volumeSnapshotLocation.config.region=us-east-1 \
  --set credentials.useSecret=true \
  --set credentials.existingSecret=velero-credentials \
  --wait

# Step 4: Restore Velero backup
echo -e "\n--- Step 4: Restoring from Velero backup ---"
BACKUP_NAME=$(velero backup get --output json | jq -r '.[0].metadata.name')

velero restore create --from-backup "$BACKUP_NAME" --wait

# Step 5: Install GitOps operator
echo -e "\n--- Step 5: Installing GitOps operator ---"
if [ -f "./backup/argocd-install.yaml" ]; then
  # Restore ArgoCD
  kubectl create namespace argocd
  kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

  # Wait for ArgoCD to be ready
  kubectl wait --for=condition=Available deployment/argocd-server -n argocd --timeout=600s

  # Restore ArgoCD configuration
  ./restore-argocd-state.sh "$BACKUP_DATE"
elif [ -f "./backup/flux-install.yaml" ]; then
  # Restore Flux
  flux install

  # Restore Flux configuration
  ./restore-flux-state.sh "$BACKUP_DATE"
fi

# Step 6: Restore Git repository access
echo -e "\n--- Step 6: Restoring Git repository access ---"
kubectl apply -f ./backup/git-credentials.yaml

# Step 7: Sync applications
echo -e "\n--- Step 7: Syncing applications ---"
if kubectl get ns argocd &>/dev/null; then
  # Sync all ArgoCD applications
  argocd app list -o name | xargs -I {} argocd app sync {}
elif kubectl get ns flux-system &>/dev/null; then
  # Reconcile all Flux kustomizations
  flux reconcile kustomization --all
fi

# Step 8: Verify recovery
echo -e "\n--- Step 8: Verifying recovery ---"
./verify-recovery.sh

echo -e "\n✓ GitOps recovery complete"
```

### ArgoCD State Restoration

```bash
#!/bin/bash
# restore-argocd-state.sh - Restore ArgoCD state from backup

set -euo pipefail

export BACKUP_DATE="${1:-latest}"
export BACKUP_DIR="/backups/argocd"
export NAMESPACE="argocd"

echo "=== ArgoCD State Restoration ==="

# Find backup
if [ "$BACKUP_DATE" = "latest" ]; then
  BACKUP_FILE=$(ls -t $BACKUP_DIR/*.tar.gz | head -1)
else
  BACKUP_FILE="$BACKUP_DIR/$BACKUP_DATE.tar.gz"
fi

echo "Restoring from: $BACKUP_FILE"

# Extract backup
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

tar xzf "$BACKUP_FILE" -C "$TEMP_DIR"
EXTRACT_DIR=$(ls -d $TEMP_DIR/*/)

# Restore CRDs
echo "Restoring CRDs..."
kubectl apply -f "$EXTRACT_DIR/argocd-crds.yaml"

# Decrypt secrets
echo "Decrypting secrets..."
sops --decrypt "$EXTRACT_DIR/secrets.yaml" | kubectl apply -n "$NAMESPACE" -f -

# Restore ConfigMaps
echo "Restoring ConfigMaps..."
kubectl apply -f "$EXTRACT_DIR/configmaps.yaml"

# Restore ArgoCD settings
echo "Restoring ArgoCD settings..."
kubectl apply -f "$EXTRACT_DIR/argocd-cm.yaml"
kubectl apply -f "$EXTRACT_DIR/argocd-rbac-cm.yaml"
kubectl apply -f "$EXTRACT_DIR/argocd-cmd-params-cm.yaml"

# Restore repository credentials
echo "Restoring repository credentials..."
while IFS= read -r repo; do
  argocd repocreds add "$(echo $repo | jq -r '.url')" \
    --username "$(echo $repo | jq -r '.username')" \
    --password "$(echo $repo | jq -r '.password')"
done < <(jq -c '.[]' "$EXTRACT_DIR/repo-creds.json")

# Restore cluster configurations
echo "Restoring cluster configurations..."
while IFS= read -r cluster; do
  SERVER=$(echo $cluster | jq -r '.server')
  if [ "$SERVER" != "https://kubernetes.default.svc" ]; then
    argocd cluster add "$(echo $cluster | jq -r '.name')" \
      --server "$SERVER" \
      --kubeconfig "$(echo $cluster | jq -r '.config')"
  fi
done < <(jq -c '.[]' "$EXTRACT_DIR/clusters.json")

# Restore AppProjects
echo "Restoring AppProjects..."
kubectl apply -f "$EXTRACT_DIR/appprojects.yaml"

# Restore Applications
echo "Restoring Applications..."
kubectl apply -f "$EXTRACT_DIR/applications.yaml"

# Restore ApplicationSets
echo "Restoring ApplicationSets..."
kubectl apply -f "$EXTRACT_DIR/applicationsets.yaml"

# Restart ArgoCD components
echo "Restarting ArgoCD components..."
kubectl rollout restart deployment -n "$NAMESPACE"

# Wait for ArgoCD to be ready
kubectl wait --for=condition=Available deployment/argocd-server -n "$NAMESPACE" --timeout=600s

echo "✓ ArgoCD state restoration complete"
```

## Multi-Cluster Failover {#multi-cluster-failover}

### Automated Failover Script

```bash
#!/bin/bash
# multi-cluster-failover.sh - Automated failover to backup cluster

set -euo pipefail

export PRIMARY_CLUSTER="production-us-east-1"
export BACKUP_CLUSTER="production-us-west-2"
export FAILOVER_THRESHOLD=3  # Number of health check failures

echo "=== Multi-Cluster Failover ==="

# Function to check cluster health
check_cluster_health() {
  local cluster=$1

  kubectl config use-context "$cluster"

  # Check control plane
  if ! kubectl cluster-info &>/dev/null; then
    return 1
  fi

  # Check critical namespaces
  for ns in kube-system argocd production; do
    if ! kubectl get ns "$ns" &>/dev/null; then
      return 1
    fi
  done

  # Check critical deployments
  critical_apps=(
    "argocd:argocd-server"
    "production:frontend"
    "production:backend"
    "production:database"
  )

  for app in "${critical_apps[@]}"; do
    ns=$(echo $app | cut -d: -f1)
    deployment=$(echo $app | cut -d: -f2)

    ready=$(kubectl get deployment "$deployment" -n "$ns" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
    desired=$(kubectl get deployment "$deployment" -n "$ns" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "1")

    if [ "$ready" != "$desired" ]; then
      return 1
    fi
  done

  return 0
}

# Function to perform failover
perform_failover() {
  echo "Initiating failover from $PRIMARY_CLUSTER to $BACKUP_CLUSTER..."

  # Update DNS records
  echo "Updating DNS records..."
  aws route53 change-resource-record-sets \
    --hosted-zone-id Z1234567890ABC \
    --change-batch '{
      "Changes": [{
        "Action": "UPSERT",
        "ResourceRecordSet": {
          "Name": "app.example.com",
          "Type": "A",
          "TTL": 60,
          "ResourceRecords": [{"Value": "'$(kubectl config use-context $BACKUP_CLUSTER && kubectl get svc -n production frontend-service -o jsonpath='{.status.loadBalancer.ingress[0].ip}')'"}]
        }
      }]
    }'

  # Update ArgoCD to point to backup cluster
  echo "Updating ArgoCD cluster configuration..."
  kubectl config use-context argocd-cluster
  argocd cluster set "$BACKUP_CLUSTER" --name production-cluster

  # Sync all applications to backup cluster
  echo "Syncing applications to backup cluster..."
  kubectl config use-context "$BACKUP_CLUSTER"
  argocd app list -o name | xargs -I {} argocd app sync {}

  # Send notifications
  echo "Sending failover notifications..."
  curl -X POST https://hooks.slack.com/services/YOUR/WEBHOOK/URL \
    -H 'Content-Type: application/json' \
    -d '{
      "text": "🚨 *Failover Alert*\nFailed over from '"$PRIMARY_CLUSTER"' to '"$BACKUP_CLUSTER"'\nTime: '"$(date)"'"
    }'

  echo "✓ Failover complete"
}

# Main monitoring loop
failure_count=0

while true; do
  if check_cluster_health "$PRIMARY_CLUSTER"; then
    echo "$(date): $PRIMARY_CLUSTER is healthy"
    failure_count=0
  else
    failure_count=$((failure_count + 1))
    echo "$(date): $PRIMARY_CLUSTER health check failed (count: $failure_count)"

    if [ $failure_count -ge $FAILOVER_THRESHOLD ]; then
      echo "$(date): Threshold reached, initiating failover"
      perform_failover
      break
    fi
  fi

  sleep 30
done
```

### Traffic Management During Failover

```yaml
# istio-traffic-failover.yaml
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: frontend
  namespace: production
spec:
  hosts:
  - frontend.example.com
  gateways:
  - frontend-gateway

  http:
  - match:
    - uri:
        prefix: "/"

    route:
    # Primary cluster (80% traffic)
    - destination:
        host: frontend-primary.production.svc.cluster.local
        port:
          number: 8080
      weight: 80

    # Backup cluster (20% traffic for testing)
    - destination:
        host: frontend-backup.production.svc.cluster.local
        port:
          number: 8080
      weight: 20

    retries:
      attempts: 3
      perTryTimeout: 2s
      retryOn: 5xx,reset,connect-failure,refused-stream

    timeout: 10s

    fault:
      abort:
        percentage:
          value: 0.1
        httpStatus: 503
---
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: frontend-primary
  namespace: production
spec:
  host: frontend-primary.production.svc.cluster.local

  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 100
      http:
        http1MaxPendingRequests: 50
        http2MaxRequests: 100
        maxRequestsPerConnection: 2

    outlierDetection:
      consecutive5xxErrors: 5
      interval: 30s
      baseEjectionTime: 30s
      maxEjectionPercent: 50
      minHealthPercent: 50
```

## Automated Recovery Workflows {#automated-recovery}

### Recovery Automation with Tekton

```yaml
# tekton-recovery-pipeline.yaml
apiVersion: tekton.dev/v1beta1
kind: Pipeline
metadata:
  name: disaster-recovery
  namespace: tekton-pipelines
spec:
  params:
  - name: recovery-mode
    type: string
    description: "Recovery mode: full, partial, or app-only"
    default: "full"

  - name: backup-date
    type: string
    description: "Backup date to restore from"
    default: "latest"

  - name: target-cluster
    type: string
    description: "Target cluster name"

  workspaces:
  - name: backup-data
  - name: kubeconfig

  tasks:
  - name: verify-backup
    taskRef:
      name: verify-backup
    params:
    - name: backup-date
      value: $(params.backup-date)
    workspaces:
    - name: backup-data
      workspace: backup-data

  - name: provision-cluster
    runAfter: [verify-backup]
    when:
    - input: "$(params.recovery-mode)"
      operator: in
      values: ["full"]
    taskRef:
      name: provision-kubernetes-cluster
    params:
    - name: cluster-name
      value: $(params.target-cluster)
    workspaces:
    - name: kubeconfig
      workspace: kubeconfig

  - name: restore-etcd
    runAfter: [provision-cluster]
    when:
    - input: "$(params.recovery-mode)"
      operator: in
      values: ["full"]
    taskRef:
      name: restore-etcd
    params:
    - name: backup-date
      value: $(params.backup-date)
    workspaces:
    - name: backup-data
      workspace: backup-data
    - name: kubeconfig
      workspace: kubeconfig

  - name: install-velero
    runAfter: [restore-etcd]
    taskRef:
      name: install-velero
    workspaces:
    - name: kubeconfig
      workspace: kubeconfig

  - name: restore-velero-backup
    runAfter: [install-velero]
    taskRef:
      name: restore-velero-backup
    params:
    - name: backup-date
      value: $(params.backup-date)
    workspaces:
    - name: kubeconfig
      workspace: kubeconfig

  - name: install-gitops-operator
    runAfter: [restore-velero-backup]
    taskRef:
      name: install-argocd
    workspaces:
    - name: kubeconfig
      workspace: kubeconfig

  - name: restore-gitops-state
    runAfter: [install-gitops-operator]
    taskRef:
      name: restore-argocd-state
    params:
    - name: backup-date
      value: $(params.backup-date)
    workspaces:
    - name: backup-data
      workspace: backup-data
    - name: kubeconfig
      workspace: kubeconfig

  - name: sync-applications
    runAfter: [restore-gitops-state]
    taskRef:
      name: sync-argocd-apps
    workspaces:
    - name: kubeconfig
      workspace: kubeconfig

  - name: verify-recovery
    runAfter: [sync-applications]
    taskRef:
      name: verify-recovery
    workspaces:
    - name: kubeconfig
      workspace: kubeconfig

  - name: notify-completion
    runAfter: [verify-recovery]
    taskRef:
      name: send-notification
    params:
    - name: message
      value: "Disaster recovery complete for $(params.target-cluster)"
```

## Testing and Validation {#testing-validation}

### DR Testing Schedule

```yaml
# dr-testing-schedule.yaml
disaster_recovery_testing:
  quarterly_full_test:
    frequency: "Every 3 months"
    scope: "Full disaster recovery"
    duration: "4 hours"
    participants:
      - SRE team
      - Development team
      - Management

    procedure:
      - Announce test window
      - Simulate complete cluster failure
      - Execute full recovery workflow
      - Verify all applications
      - Document findings
      - Review and update procedures

    success_criteria:
      - RTO < 2 hours
      - RPO < 15 minutes
      - All critical apps recovered
      - Data integrity verified
      - Team performance satisfactory

  monthly_partial_test:
    frequency: "Monthly"
    scope: "Partial recovery (non-production)"
    duration: "2 hours"
    participants:
      - SRE team

    procedure:
      - Backup current state
      - Delete test namespace
      - Restore from backup
      - Verify functionality
      - Document results

  weekly_backup_verification:
    frequency: "Weekly"
    scope: "Backup integrity check"
    duration: "30 minutes"
    participants:
      - SRE on-call

    procedure:
      - Verify all backups completed
      - Test backup restoration
      - Validate backup checksums
      - Check backup retention
```

### Recovery Validation Script

```bash
#!/bin/bash
# verify-recovery.sh - Comprehensive recovery validation

set -euo pipefail

echo "=== Disaster Recovery Verification ==="

# Test 1: Cluster Health
echo -e "\n--- Test 1: Cluster Health ---"
if kubectl cluster-info &>/dev/null; then
  echo "✓ Cluster is accessible"
else
  echo "✗ Cluster is not accessible"
  exit 1
fi

# Test 2: Node Status
echo -e "\n--- Test 2: Node Status ---"
node_count=$(kubectl get nodes --no-headers | wc -l)
ready_nodes=$(kubectl get nodes --no-headers | grep " Ready" | wc -l)

echo "Total nodes: $node_count"
echo "Ready nodes: $ready_nodes"

if [ "$node_count" = "$ready_nodes" ]; then
  echo "✓ All nodes are ready"
else
  echo "✗ Some nodes are not ready"
  kubectl get nodes
  exit 1
fi

# Test 3: Critical Namespaces
echo -e "\n--- Test 3: Critical Namespaces ---"
critical_namespaces=("kube-system" "argocd" "production" "staging")

for ns in "${critical_namespaces[@]}"; do
  if kubectl get ns "$ns" &>/dev/null; then
    echo "✓ Namespace $ns exists"
  else
    echo "✗ Namespace $ns missing"
    exit 1
  fi
done

# Test 4: GitOps Operator
echo -e "\n--- Test 4: GitOps Operator Status ---"
if kubectl get deployment argocd-server -n argocd &>/dev/null; then
  status=$(kubectl get deployment argocd-server -n argocd -o jsonpath='{.status.conditions[?(@.type=="Available")].status}')
  if [ "$status" = "True" ]; then
    echo "✓ ArgoCD is running"
  else
    echo "✗ ArgoCD is not ready"
    exit 1
  fi
fi

# Test 5: Applications
echo -e "\n--- Test 5: Application Status ---"
apps=$(argocd app list -o name)

for app in $apps; do
  health=$(argocd app get "$app" -o json | jq -r '.status.health.status')
  sync=$(argocd app get "$app" -o json | jq -r '.status.sync.status')

  if [ "$health" = "Healthy" ] && [ "$sync" = "Synced" ]; then
    echo "✓ App $app: Healthy and Synced"
  else
    echo "✗ App $app: Health=$health, Sync=$sync"
    exit 1
  fi
done

# Test 6: Service Endpoints
echo -e "\n--- Test 6: Service Endpoints ---"
services=(
  "production:frontend-service:8080"
  "production:backend-service:8080"
  "production:database-service:5432"
)

for svc in "${services[@]}"; do
  ns=$(echo $svc | cut -d: -f1)
  name=$(echo $svc | cut -d: -f2)
  port=$(echo $svc | cut -d: -f3)

  if kubectl get svc "$name" -n "$ns" &>/dev/null; then
    endpoints=$(kubectl get endpoints "$name" -n "$ns" -o jsonpath='{.subsets[*].addresses[*].ip}' | wc -w)
    if [ "$endpoints" -gt 0 ]; then
      echo "✓ Service $ns/$name has $endpoints endpoints"
    else
      echo "✗ Service $ns/$name has no endpoints"
      exit 1
    fi
  else
    echo "✗ Service $ns/$name not found"
    exit 1
  fi
done

# Test 7: Data Integrity
echo -e "\n--- Test 7: Data Integrity ---"
# This is application-specific, customize as needed
echo "Running data integrity checks..."

# Test 8: External Access
echo -e "\n--- Test 8: External Access ---"
if curl -f -s https://app.example.com/health > /dev/null; then
  echo "✓ External access working"
else
  echo "✗ External access failed"
  exit 1
fi

echo -e "\n✓ All recovery verification tests passed"
```

## Business Continuity Planning {#business-continuity}

### Business Continuity Plan Template

```markdown
# GitOps Disaster Recovery Business Continuity Plan

## 1. Executive Summary
- **Purpose**: Ensure business continuity during GitOps infrastructure failures
- **Scope**: Production Kubernetes clusters, GitOps operators, Git repositories
- **RTO**: 2 hours
- **RPO**: 15 minutes

## 2. Emergency Contacts

### Primary Contacts
- SRE Team Lead: John Doe - +1-555-0100
- DevOps Manager: Jane Smith - +1-555-0101
- CTO: Bob Johnson - +1-555-0102

### Escalation Path
1. On-Call SRE (24/7): +1-555-0200
2. SRE Team Lead (30 min response)
3. DevOps Manager (1 hour response)
4. CTO (2 hour response)

### External Vendors
- Cloud Provider Support: 1-800-CLOUD
- GitLab Support: support@gitlab.com
- Velero Support: Community Slack

## 3. Recovery Procedures

### Scenario 1: Complete Cluster Failure
**RTO**: 2 hours | **RPO**: 15 minutes

1. Declare incident (5 min)
2. Provision new cluster (30 min)
3. Restore from backup (45 min)
4. Verify applications (20 min)
5. Resume operations (10 min)

**Command**:
```bash
./gitops-recovery.sh full recovery-cluster latest
```

### Scenario 2: Git Repository Loss
**RTO**: 30 minutes | **RPO**: 0 minutes

1. Verify backup repositories (5 min)
2. Update Git remote URLs (10 min)
3. Sync applications (10 min)
4. Verify operations (5 min)

### Scenario 3: GitOps Operator Failure
**RTO**: 1 hour | **RPO**: 5 minutes

1. Backup current state (10 min)
2. Reinstall operator (20 min)
3. Restore configuration (20 min)
4. Verify sync (10 min)

## 4. Communication Plan

### Internal Communication
- **Slack**: #incident-response
- **Email**: incidents@example.com
- **Status Page**: status.example.com

### External Communication
- **Customers**: Via status page
- **Stakeholders**: Email within 1 hour
- **Public**: Twitter @examplestatus

## 5. Post-Incident Review
- Schedule within 48 hours
- Document lessons learned
- Update procedures
- Implement improvements
```

## Runbooks and Documentation {#runbooks}

### Comprehensive Runbook

```markdown
# GitOps Disaster Recovery Runbook

## Prerequisites
- Access to AWS console
- kubectl configured
- ArgoCD CLI installed
- Velero CLI installed
- Access to backup S3 bucket
- Access to Git repositories

## Step-by-Step Recovery Procedure

### Phase 1: Assessment (15 minutes)
**Objective**: Determine extent of failure

1. Check cluster accessibility
   ```bash
   kubectl cluster-info
   ```

2. Check GitOps operator status
   ```bash
   kubectl get pods -n argocd
   ```

3. Check application health
   ```bash
   argocd app list
   ```

4. Determine recovery scope
   - [ ] Cluster failure
   - [ ] Operator failure
   - [ ] Application failure
   - [ ] Data loss

### Phase 2: Preparation (15 minutes)
**Objective**: Prepare for recovery

1. Download latest backup information
   ```bash
   aws s3 ls s3://my-backups/velero/ --recursive
   ```

2. Verify backup integrity
   ```bash
   ./verify-git-backups.sh
   ```

3. Notify stakeholders
   ```bash
   ./send-incident-notification.sh
   ```

### Phase 3: Cluster Recovery (60 minutes)
**Objective**: Restore Kubernetes cluster

1. Provision new cluster
   ```bash
   eksctl create cluster -f cluster-config.yaml
   ```

2. Install Velero
   ```bash
   helm install velero vmware-tanzu/velero -f velero-values.yaml
   ```

3. Restore from backup
   ```bash
   velero restore create --from-backup $(velero backup get -o json | jq -r '.[0].metadata.name')
   ```

4. Wait for restoration
   ```bash
   velero restore describe RESTORE-NAME
   ```

### Phase 4: GitOps Recovery (30 minutes)
**Objective**: Restore GitOps operator and sync

1. Install ArgoCD
   ```bash
   kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
   ```

2. Restore ArgoCD state
   ```bash
   ./restore-argocd-state.sh latest
   ```

3. Sync all applications
   ```bash
   argocd app sync --all
   ```

### Phase 5: Verification (20 minutes)
**Objective**: Verify complete recovery

1. Run verification script
   ```bash
   ./verify-recovery.sh
   ```

2. Test critical endpoints
   ```bash
   curl -f https://app.example.com/health
   ```

3. Verify data integrity
   ```bash
   ./verify-data-integrity.sh
   ```

### Phase 6: Post-Recovery (10 minutes)
**Objective**: Return to normal operations

1. Update DNS if needed
   ```bash
   aws route53 change-resource-record-sets ...
   ```

2. Notify stakeholders of completion
   ```bash
   ./send-recovery-complete-notification.sh
   ```

3. Schedule post-incident review
   ```bash
   calendar add "DR Post-Incident Review" +2days
   ```

## Troubleshooting

### Issue: Backup Not Found
**Symptom**: velero backup get shows no backups

**Solution**:
1. Check S3 bucket access
2. Verify Velero configuration
3. Restore from secondary backup location

### Issue: ArgoCD Applications Won't Sync
**Symptom**: Applications stuck in "OutOfSync" state

**Solution**:
1. Check Git repository connectivity
2. Verify credentials
3. Check ArgoCD logs: `kubectl logs -n argocd deployment/argocd-application-controller`

### Issue: Persistent Volumes Not Restored
**Symptom**: PVCs in pending state

**Solution**:
1. Check storage class availability
2. Verify EBS CSI driver installed
3. Check Velero restore logs

## Emergency Contacts
- On-Call SRE: +1-555-0200
- AWS Support: 1-800-AWS
- Team Lead: +1-555-0100
```

## Conclusion

Comprehensive disaster recovery planning is essential for GitOps-managed Kubernetes environments. This guide has covered enterprise-grade strategies including automated backups, multi-cluster failover, recovery procedures, and complete business continuity planning that ensures rapid recovery from catastrophic failures.

Key takeaways:

1. **Automated Backups**: Implement continuous backup of Git repositories, GitOps operator state, and cluster resources
2. **Multi-Region Redundancy**: Deploy across multiple regions for high availability
3. **Recovery Automation**: Use pipelines and scripts to automate recovery procedures
4. **Regular Testing**: Perform quarterly full DR tests and monthly partial tests
5. **Documentation**: Maintain detailed runbooks and recovery procedures
6. **Business Continuity**: Align technical recovery with business requirements

For more information on GitOps and Kubernetes operations, see our guides on [Advanced GitOps implementation](/advanced-gitops-implementation-argocd-flux-enterprise-guide/) and [Kubernetes deployment strategies](/advanced-deployment-strategies-blue-green-canary-rolling-updates/).