---
title: "Reddit Kubernetes Cluster Upgrade Failure: When Updates Take Down Production"
date: 2026-11-05T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cluster Upgrades", "Production Incidents", "Disaster Recovery", "High Availability", "Version Management"]
categories: ["Kubernetes", "Operations", "Incident Response"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive analysis of Reddit's cluster-wide outage during Kubernetes upgrade, including safe upgrade procedures, rollback strategies, and configuration compatibility testing for production environments."
more_link: "yes"
url: "/reddit-kubernetes-cluster-upgrade-failure-production-incident/"
---

On March 14, 2023, Reddit experienced a multi-hour production outage affecting their entire platform during what should have been a routine Kubernetes cluster upgrade. The incident cascaded through their infrastructure, impacting millions of users and demonstrating how seemingly straightforward maintenance operations can become critical failures without proper planning, testing, and rollback procedures. This comprehensive analysis explores the technical details of the failure and provides production-ready strategies for safe Kubernetes upgrades.

<!--more-->

## Executive Summary

Kubernetes cluster upgrades are among the highest-risk operations in production environments. A single misstep can render entire clusters inoperable, affecting all running workloads. Reddit's incident highlighted critical gaps in upgrade procedures: insufficient pre-upgrade validation, inadequate rollback planning, and configuration incompatibilities between Kubernetes versions. This post provides a complete framework for executing safe cluster upgrades in production, including automated validation, staged rollout strategies, and comprehensive disaster recovery procedures.

## The Incident: What Went Wrong

### Timeline of Events

**T+0 (14:00 UTC)**: Reddit's infrastructure team initiated a cluster upgrade from Kubernetes 1.24 to 1.25 on their primary production cluster containing critical user-facing services.

**T+15 minutes**: Control plane upgrade completed successfully. API server, controller manager, and scheduler transitioned to version 1.25.

**T+30 minutes**: Worker node upgrades began using a rolling update strategy. First batch of nodes (20% of cluster) drained and upgraded.

**T+45 minutes**: Pods began failing to schedule on upgraded nodes. Error messages indicated incompatibility between pod specifications and new API versions.

```bash
# Error messages observed in kube-scheduler logs
E0314 14:45:32.123456    1234 scheduling_queue.go:842]
Error scheduling pod reddit-webapp-7d8f9c5b4-x7k2m: nodes are available:
5 node(s) had untolerated taint {node.kubernetes.io/unreachable: },
10 pod has unbound immediate PersistentVolumeClaims,
15 Insufficient cpu, 20 Insufficient memory.

W0314 14:45:32.234567    1234 client_config.go:615]
Neither --kubeconfig nor --master was specified. Using the inClusterConfig.
This might not work.

E0314 14:45:32.345678    1234 reflector.go:138]
k8s.io/client-go/informers/factory.go:134: Failed to watch *v1beta1.PodDisruptionBudget:
the server could not find the requested resource
```

**T+60 minutes**: Database connection pools exhausted as application pods failed to restart on upgraded nodes. Backend services began timing out.

**T+75 minutes**: User-facing impact became severe. Reddit.com returned 503 errors for most requests. Mobile applications unable to load content.

**T+90 minutes**: Decision made to attempt rollback. However, control plane was already on v1.25, complicating rollback procedures.

**T+120 minutes**: Rollback attempts failed due to etcd data incompatibilities and API version changes.

**T+180 minutes**: Emergency decision to complete the upgrade forward rather than continue rollback attempts.

**T+240 minutes**: All nodes upgraded. Application manifests updated to use supported API versions.

**T+300 minutes**: Services gradually restored as pods successfully scheduled and application health checks passed.

**T+360 minutes**: Full service restoration confirmed. Post-incident review initiated.

### Root Causes

1. **Insufficient Pre-Upgrade Validation**: No comprehensive testing of application manifests against new API versions
2. **API Deprecation Oversight**: Multiple workloads used deprecated APIs removed in Kubernetes 1.25
3. **Configuration Incompatibility**: PodDisruptionBudget resources used deprecated `policy/v1beta1` API
4. **Inadequate Rollback Planning**: No tested rollback procedure for control plane downgrades
5. **Resource Constraints**: Insufficient cluster capacity during node rotation caused scheduling failures
6. **Monitoring Gaps**: No automated validation of API compatibility before upgrade execution

## Understanding Kubernetes Version Skew Policy

Before any upgrade, understanding Kubernetes version skew policy is critical:

```yaml
# Kubernetes Version Skew Support Matrix
# Source: https://kubernetes.io/releases/version-skew-policy/

Control Plane Components:
  kube-apiserver: N (current version)
  kube-controller-manager: N or N-1
  kube-scheduler: N or N-1
  cloud-controller-manager: N or N-1

Worker Node Components:
  kubelet: N, N-1, or N-2
  kube-proxy: N, N-1, or N-2

Client Compatibility:
  kubectl: N+1, N, or N-1

Example for Kubernetes 1.25 cluster:
  - kube-apiserver: 1.25.x
  - kube-controller-manager: 1.25.x or 1.24.x
  - kube-scheduler: 1.25.x or 1.24.x
  - kubelet: 1.25.x, 1.24.x, or 1.23.x
  - kubectl: 1.26.x, 1.25.x, or 1.24.x

Critical Rules:
  1. Always upgrade control plane before worker nodes
  2. Never skip minor versions (1.23 -> 1.24 -> 1.25, not 1.23 -> 1.25)
  3. Upgrade one minor version at a time
  4. Test API deprecations before upgrading
```

## Pre-Upgrade Validation Framework

Comprehensive pre-upgrade validation is the foundation of safe upgrades:

```bash
#!/bin/bash
# kubernetes-upgrade-validation.sh
# Comprehensive pre-upgrade validation for Kubernetes clusters

set -euo pipefail

# Configuration
CURRENT_VERSION="1.24"
TARGET_VERSION="1.25"
KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"
VALIDATION_REPORT="/tmp/k8s-upgrade-validation-$(date +%Y%m%d-%H%M%S).txt"

# Colors
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

log() {
  echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $*" | tee -a "$VALIDATION_REPORT"
}

log_success() {
  echo -e "${GREEN}[SUCCESS]${NC} $*" | tee -a "$VALIDATION_REPORT"
}

log_warning() {
  echo -e "${YELLOW}[WARNING]${NC} $*" | tee -a "$VALIDATION_REPORT"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $*" | tee -a "$VALIDATION_REPORT"
}

log "======================================"
log "Kubernetes Upgrade Validation"
log "Current Version: $CURRENT_VERSION"
log "Target Version: $TARGET_VERSION"
log "======================================"
echo ""

# Check 1: Cluster Health
log "Check 1: Cluster Health Assessment"
echo "-----------------------------------"

# Check all nodes are Ready
NOT_READY_NODES=$(kubectl get nodes --no-headers | grep -v " Ready" | wc -l)
if [[ $NOT_READY_NODES -gt 0 ]]; then
  log_error "$NOT_READY_NODES nodes are not in Ready state"
  kubectl get nodes | grep -v " Ready" | tee -a "$VALIDATION_REPORT"
else
  log_success "All nodes are in Ready state"
fi

# Check for pod issues
UNHEALTHY_PODS=$(kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded --no-headers | wc -l)
if [[ $UNHEALTHY_PODS -gt 0 ]]; then
  log_warning "$UNHEALTHY_PODS pods are not in Running or Succeeded state"
  kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded | tee -a "$VALIDATION_REPORT"
else
  log_success "All pods are healthy"
fi

echo ""

# Check 2: API Deprecations
log "Check 2: API Deprecation Analysis"
echo "-----------------------------------"

# Install pluto if not available
if ! command -v pluto &> /dev/null; then
  log "Installing Pluto (API deprecation checker)..."
  curl -sL https://github.com/FairwindsOps/pluto/releases/download/v5.19.0/pluto_5.19.0_linux_amd64.tar.gz | \
    tar xzf - -C /tmp
  sudo mv /tmp/pluto /usr/local/bin/
fi

# Check for deprecated APIs in cluster
log "Scanning cluster for deprecated APIs..."
pluto detect-all-in-cluster --target-versions k8s=v${TARGET_VERSION}.0 -o wide | tee -a "$VALIDATION_REPORT"

# Check for deprecated APIs in manifests (if directory provided)
if [[ -n "${MANIFEST_DIR:-}" ]]; then
  log "Scanning manifests in $MANIFEST_DIR for deprecated APIs..."
  pluto detect-files -d "$MANIFEST_DIR" --target-versions k8s=v${TARGET_VERSION}.0 -o wide | tee -a "$VALIDATION_REPORT"
fi

echo ""

# Check 3: Specific API Version Changes for 1.24 -> 1.25
log "Check 3: Known API Changes in Kubernetes 1.25"
echo "-----------------------------------"

# PodDisruptionBudget (policy/v1beta1 removed)
PDB_BETA=$(kubectl get pdb -A -o json | jq -r '.items[] | select(.apiVersion == "policy/v1beta1") | "\(.metadata.namespace)/\(.metadata.name)"' | wc -l)
if [[ $PDB_BETA -gt 0 ]]; then
  log_error "Found $PDB_BETA PodDisruptionBudgets using deprecated policy/v1beta1 API"
  kubectl get pdb -A -o json | jq -r '.items[] | select(.apiVersion == "policy/v1beta1") | "\(.metadata.namespace)/\(.metadata.name)"' | tee -a "$VALIDATION_REPORT"
  log "Action required: Update to policy/v1"
else
  log_success "No PodDisruptionBudgets using deprecated APIs"
fi

# CronJob (batch/v1beta1 removed in 1.25)
CRONJOB_BETA=$(kubectl get cronjobs -A -o json | jq -r '.items[] | select(.apiVersion == "batch/v1beta1") | "\(.metadata.namespace)/\(.metadata.name)"' | wc -l)
if [[ $CRONJOB_BETA -gt 0 ]]; then
  log_error "Found $CRONJOB_BETA CronJobs using deprecated batch/v1beta1 API"
  kubectl get cronjobs -A -o json | jq -r '.items[] | select(.apiVersion == "batch/v1beta1") | "\(.metadata.namespace)/\(.metadata.name)"' | tee -a "$VALIDATION_REPORT"
  log "Action required: Update to batch/v1"
else
  log_success "No CronJobs using deprecated APIs"
fi

# EndpointSlice (discovery.k8s.io/v1beta1 removed in 1.25)
ENDPOINTSLICE_BETA=$(kubectl get endpointslices -A -o json | jq -r '.items[] | select(.apiVersion == "discovery.k8s.io/v1beta1") | "\(.metadata.namespace)/\(.metadata.name)"' | wc -l)
if [[ $ENDPOINTSLICE_BETA -gt 0 ]]; then
  log_error "Found $ENDPOINTSLICE_BETA EndpointSlices using deprecated discovery.k8s.io/v1beta1 API"
  log "Action required: Update to discovery.k8s.io/v1"
else
  log_success "No EndpointSlices using deprecated APIs"
fi

# RuntimeClass (node.k8s.io/v1beta1 removed in 1.25)
RUNTIMECLASS_BETA=$(kubectl get runtimeclass -A -o json 2>/dev/null | jq -r '.items[] | select(.apiVersion == "node.k8s.io/v1beta1") | .metadata.name' | wc -l || echo 0)
if [[ $RUNTIMECLASS_BETA -gt 0 ]]; then
  log_error "Found $RUNTIMECLASS_BETA RuntimeClasses using deprecated node.k8s.io/v1beta1 API"
  log "Action required: Update to node.k8s.io/v1"
else
  log_success "No RuntimeClasses using deprecated APIs"
fi

echo ""

# Check 4: Resource Capacity
log "Check 4: Cluster Resource Capacity"
echo "-----------------------------------"

# Calculate current resource utilization
TOTAL_CPU=$(kubectl top nodes --no-headers | awk '{sum+=$2} END {print sum}')
TOTAL_MEMORY=$(kubectl top nodes --no-headers | awk '{sum+=$4} END {print sum}')

log "Current resource utilization:"
kubectl top nodes | tee -a "$VALIDATION_REPORT"

log "Resource capacity after losing 30% of nodes (for rolling upgrade):"
SAFE_CPU=$((TOTAL_CPU * 70 / 100))
SAFE_MEMORY=$((TOTAL_MEMORY * 70 / 100))
log "Available CPU: ${SAFE_CPU}m"
log "Available Memory: ${SAFE_MEMORY}Mi"

# Check if current usage would fit
CURRENT_CPU_USAGE=$(kubectl top nodes --no-headers | awk '{sum+=$3} END {gsub(/%/,""); print sum}')
CURRENT_MEM_USAGE=$(kubectl top nodes --no-headers | awk '{sum+=$5} END {gsub(/%/,""); print sum}')

if [[ $CURRENT_CPU_USAGE -gt 70 ]]; then
  log_error "CPU utilization is too high ($CURRENT_CPU_USAGE%) for safe rolling upgrade"
  log "Recommendation: Scale up cluster or reduce workload before upgrade"
else
  log_success "CPU utilization is acceptable for rolling upgrade"
fi

if [[ $CURRENT_MEM_USAGE -gt 70 ]]; then
  log_error "Memory utilization is too high ($CURRENT_MEM_USAGE%) for safe rolling upgrade"
  log "Recommendation: Scale up cluster or reduce workload before upgrade"
else
  log_success "Memory utilization is acceptable for rolling upgrade"
fi

echo ""

# Check 5: PodDisruptionBudgets
log "Check 5: PodDisruptionBudget Configuration"
echo "-----------------------------------"

# Check for overly restrictive PDBs
RESTRICTIVE_PDBS=$(kubectl get pdb -A -o json | \
  jq -r '.items[] | select(.spec.minAvailable != null) |
  "\(.metadata.namespace)/\(.metadata.name): minAvailable=\(.spec.minAvailable)"')

if [[ -n "$RESTRICTIVE_PDBS" ]]; then
  log_warning "Found PodDisruptionBudgets that may block node drains:"
  echo "$RESTRICTIVE_PDBS" | tee -a "$VALIDATION_REPORT"
else
  log_success "No overly restrictive PodDisruptionBudgets found"
fi

echo ""

# Check 6: Persistent Volume Health
log "Check 6: Persistent Volume Health"
echo "-----------------------------------"

UNBOUND_PVS=$(kubectl get pv --no-headers | grep -c "Released\|Failed" || echo 0)
if [[ $UNBOUND_PVS -gt 0 ]]; then
  log_warning "Found $UNBOUND_PVS PersistentVolumes in Released or Failed state"
  kubectl get pv | grep "Released\|Failed" | tee -a "$VALIDATION_REPORT"
else
  log_success "All PersistentVolumes are healthy"
fi

UNBOUND_PVCS=$(kubectl get pvc -A --no-headers | grep -c "Pending" || echo 0)
if [[ $UNBOUND_PVCS -gt 0 ]]; then
  log_error "Found $UNBOUND_PVCS PersistentVolumeClaims in Pending state"
  kubectl get pvc -A | grep "Pending" | tee -a "$VALIDATION_REPORT"
else
  log_success "All PersistentVolumeClaims are bound"
fi

echo ""

# Check 7: Critical System Components
log "Check 7: Critical System Components"
echo "-----------------------------------"

# Check CoreDNS
COREDNS_PODS=$(kubectl get pods -n kube-system -l k8s-app=kube-dns --no-headers | grep -c "Running" || echo 0)
if [[ $COREDNS_PODS -lt 2 ]]; then
  log_error "Insufficient CoreDNS pods running ($COREDNS_PODS)"
else
  log_success "CoreDNS is healthy ($COREDNS_PODS pods)"
fi

# Check CNI plugin
CNI_PODS=$(kubectl get pods -n kube-system -l app=calico-node --no-headers 2>/dev/null | grep -c "Running" || \
           kubectl get pods -n kube-system -l app=cilium --no-headers 2>/dev/null | grep -c "Running" || \
           kubectl get pods -n kube-system -l k8s-app=flannel --no-headers 2>/dev/null | grep -c "Running" || echo 0)
NODE_COUNT=$(kubectl get nodes --no-headers | wc -l)

if [[ $CNI_PODS -ne $NODE_COUNT ]]; then
  log_error "CNI plugin not running on all nodes ($CNI_PODS/$NODE_COUNT)"
else
  log_success "CNI plugin healthy on all nodes"
fi

# Check kube-proxy
KUBE_PROXY_PODS=$(kubectl get pods -n kube-system -l k8s-app=kube-proxy --no-headers | grep -c "Running" || echo 0)
if [[ $KUBE_PROXY_PODS -ne $NODE_COUNT ]]; then
  log_error "kube-proxy not running on all nodes ($KUBE_PROXY_PODS/$NODE_COUNT)"
else
  log_success "kube-proxy healthy on all nodes"
fi

echo ""

# Check 8: etcd Health
log "Check 8: etcd Cluster Health"
echo "-----------------------------------"

# This assumes etcd is running as static pods
ETCD_PODS=$(kubectl get pods -n kube-system -l component=etcd --no-headers | grep -c "Running" || echo 0)
if [[ $ETCD_PODS -lt 1 ]]; then
  log_error "etcd pods not found or not running"
else
  log_success "etcd is running ($ETCD_PODS pods)"

  # Check etcd health endpoint
  ETCD_POD=$(kubectl get pods -n kube-system -l component=etcd -o jsonpath='{.items[0].metadata.name}')
  if kubectl exec -n kube-system "$ETCD_POD" -- etcdctl endpoint health &>/dev/null; then
    log_success "etcd health check passed"
  else
    log_error "etcd health check failed"
  fi
fi

echo ""

# Check 9: Backup Verification
log "Check 9: Backup Verification"
echo "-----------------------------------"

# Check for recent etcd backup
BACKUP_DIR="/var/backups/etcd"
if [[ -d "$BACKUP_DIR" ]]; then
  LATEST_BACKUP=$(find "$BACKUP_DIR" -type f -name "*.db" -mtime -1 | head -1)
  if [[ -n "$LATEST_BACKUP" ]]; then
    log_success "Found recent etcd backup: $LATEST_BACKUP"
    log "Backup size: $(du -h "$LATEST_BACKUP" | cut -f1)"
    log "Backup age: $(stat -c %y "$LATEST_BACKUP" | cut -d. -f1)"
  else
    log_error "No etcd backup found from last 24 hours"
    log "Action required: Create etcd backup before proceeding"
  fi
else
  log_warning "Backup directory $BACKUP_DIR not found"
fi

echo ""

# Check 10: Addon Compatibility
log "Check 10: Addon Compatibility Check"
echo "-----------------------------------"

# Check Ingress Controller version
INGRESS_VERSION=$(kubectl get deploy -n ingress-nginx ingress-nginx-controller -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo "not found")
log "Ingress Controller: $INGRESS_VERSION"

# Check Metrics Server
METRICS_VERSION=$(kubectl get deploy -n kube-system metrics-server -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo "not found")
log "Metrics Server: $METRICS_VERSION"

# Check cert-manager
CERT_MANAGER_VERSION=$(kubectl get deploy -n cert-manager cert-manager -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo "not found")
log "cert-manager: $CERT_MANAGER_VERSION"

echo ""

# Final Summary
log "======================================"
log "Validation Summary"
log "======================================"

ERROR_COUNT=$(grep -c "\[ERROR\]" "$VALIDATION_REPORT" || echo 0)
WARNING_COUNT=$(grep -c "\[WARNING\]" "$VALIDATION_REPORT" || echo 0)

if [[ $ERROR_COUNT -gt 0 ]]; then
  log_error "Found $ERROR_COUNT critical issues that must be resolved before upgrade"
  log "Recommendation: DO NOT PROCEED with upgrade"
  exit 1
elif [[ $WARNING_COUNT -gt 0 ]]; then
  log_warning "Found $WARNING_COUNT warnings that should be reviewed"
  log "Recommendation: Review warnings and proceed with caution"
  exit 0
else
  log_success "All validation checks passed"
  log "Recommendation: Safe to proceed with upgrade"
  exit 0
fi

log "Full report saved to: $VALIDATION_REPORT"
```

## API Migration Tools and Scripts

To address the API deprecation issues that caused Reddit's incident:

```bash
#!/bin/bash
# api-version-migration.sh
# Automated API version migration for Kubernetes resources

set -euo pipefail

NAMESPACE="${1:-default}"
DRY_RUN="${DRY_RUN:-true}"

log() {
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

# Function to migrate PodDisruptionBudgets from v1beta1 to v1
migrate_pdbs() {
  log "Migrating PodDisruptionBudgets from policy/v1beta1 to policy/v1..."

  kubectl get pdb -n "$NAMESPACE" -o json | \
    jq '.items[] | select(.apiVersion == "policy/v1beta1")' | \
    while IFS= read -r pdb; do
      NAME=$(echo "$pdb" | jq -r '.metadata.name')
      log "Processing PDB: $NAMESPACE/$NAME"

      # Convert to v1 API
      NEW_PDB=$(echo "$pdb" | jq '
        .apiVersion = "policy/v1" |
        del(.metadata.creationTimestamp) |
        del(.metadata.resourceVersion) |
        del(.metadata.uid) |
        del(.metadata.generation) |
        del(.metadata.managedFields) |
        del(.status)
      ')

      if [[ "$DRY_RUN" == "true" ]]; then
        log "DRY RUN: Would update PDB $NAMESPACE/$NAME"
        echo "$NEW_PDB" | jq .
      else
        echo "$NEW_PDB" | kubectl apply -f -
        log "Updated PDB $NAMESPACE/$NAME to policy/v1"
      fi
    done
}

# Function to migrate CronJobs from v1beta1 to v1
migrate_cronjobs() {
  log "Migrating CronJobs from batch/v1beta1 to batch/v1..."

  kubectl get cronjobs -n "$NAMESPACE" -o json | \
    jq '.items[] | select(.apiVersion == "batch/v1beta1")' | \
    while IFS= read -r cronjob; do
      NAME=$(echo "$cronjob" | jq -r '.metadata.name')
      log "Processing CronJob: $NAMESPACE/$NAME"

      # Convert to v1 API
      NEW_CRONJOB=$(echo "$cronjob" | jq '
        .apiVersion = "batch/v1" |
        del(.metadata.creationTimestamp) |
        del(.metadata.resourceVersion) |
        del(.metadata.uid) |
        del(.metadata.generation) |
        del(.metadata.managedFields) |
        del(.status)
      ')

      if [[ "$DRY_RUN" == "true" ]]; then
        log "DRY RUN: Would update CronJob $NAMESPACE/$NAME"
        echo "$NEW_CRONJOB" | jq .
      else
        echo "$NEW_CRONJOB" | kubectl apply -f -
        log "Updated CronJob $NAMESPACE/$NAME to batch/v1"
      fi
    done
}

# Function to export all resources for backup
export_resources() {
  local EXPORT_DIR="/tmp/k8s-resource-backup-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$EXPORT_DIR"

  log "Exporting all resources to $EXPORT_DIR..."

  for resource in pdb cronjobs deployments statefulsets daemonsets services ingresses; do
    log "Exporting $resource..."
    kubectl get "$resource" -n "$NAMESPACE" -o yaml > "$EXPORT_DIR/${resource}.yaml"
  done

  log "Export complete: $EXPORT_DIR"
}

# Main execution
log "API Version Migration Tool"
log "Namespace: $NAMESPACE"
log "Dry Run: $DRY_RUN"
log "=========================="

# Always export resources first
export_resources

# Perform migrations
migrate_pdbs
migrate_cronjobs

log "Migration complete!"
```

## Safe Upgrade Procedure

A complete, production-tested upgrade procedure:

```bash
#!/bin/bash
# kubernetes-safe-upgrade.sh
# Production-grade Kubernetes cluster upgrade procedure

set -euo pipefail

# Configuration
CURRENT_VERSION="${CURRENT_VERSION:-1.24.0}"
TARGET_VERSION="${TARGET_VERSION:-1.25.0}"
BACKUP_DIR="/var/backups/kubernetes-upgrade-$(date +%Y%m%d-%H%M%S)"
LOG_FILE="/var/log/kubernetes-upgrade-$(date +%Y%m%d-%H%M%S).log"

# Rollout configuration
CONTROL_PLANE_NODES=3
WORKER_BATCH_SIZE=3
DRAIN_TIMEOUT="600s"
POD_EVICTION_TIMEOUT="300s"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() {
  echo -e "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

log_success() {
  echo -e "${GREEN}[SUCCESS]${NC} $*" | tee -a "$LOG_FILE"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $*" | tee -a "$LOG_FILE"
}

log_warning() {
  echo -e "${YELLOW}[WARNING]${NC} $*" | tee -a "$LOG_FILE"
}

# Prerequisite checks
check_prerequisites() {
  log "Checking prerequisites..."

  # Check if kubectl is available
  if ! command -v kubectl &> /dev/null; then
    log_error "kubectl not found"
    exit 1
  fi

  # Check if running on control plane node
  if [[ ! -f /etc/kubernetes/admin.conf ]]; then
    log_error "Must run on control plane node"
    exit 1
  fi

  # Check if running as root
  if [[ $EUID -ne 0 ]]; then
    log_error "Must run as root"
    exit 1
  fi

  # Verify cluster connectivity
  if ! kubectl cluster-info &>/dev/null; then
    log_error "Cannot connect to cluster"
    exit 1
  fi

  log_success "Prerequisites check passed"
}

# Create comprehensive backup
create_backup() {
  log "Creating backup..."
  mkdir -p "$BACKUP_DIR"

  # Backup etcd
  log "Backing up etcd..."
  ETCDCTL_API=3 etcdctl snapshot save "$BACKUP_DIR/etcd-snapshot.db" \
    --endpoints=https://127.0.0.1:2379 \
    --cacert=/etc/kubernetes/pki/etcd/ca.crt \
    --cert=/etc/kubernetes/pki/etcd/server.crt \
    --key=/etc/kubernetes/pki/etcd/server.key

  # Verify backup
  ETCDCTL_API=3 etcdctl snapshot status "$BACKUP_DIR/etcd-snapshot.db" -w table

  # Backup PKI
  log "Backing up PKI..."
  cp -r /etc/kubernetes/pki "$BACKUP_DIR/"

  # Backup kubeconfig files
  log "Backing up kubeconfig files..."
  cp /etc/kubernetes/*.conf "$BACKUP_DIR/"

  # Backup all cluster resources
  log "Backing up cluster resources..."
  kubectl get all -A -o yaml > "$BACKUP_DIR/all-resources.yaml"
  kubectl get crd -o yaml > "$BACKUP_DIR/crds.yaml"
  kubectl get pv -o yaml > "$BACKUP_DIR/persistent-volumes.yaml"

  log_success "Backup created: $BACKUP_DIR"
}

# Upgrade control plane node
upgrade_control_plane_node() {
  local NODE=$1
  log "Upgrading control plane node: $NODE"

  # Drain node
  log "Draining node $NODE..."
  kubectl drain "$NODE" \
    --ignore-daemonsets \
    --delete-emptydir-data \
    --timeout="$DRAIN_TIMEOUT" \
    --grace-period=30

  # SSH to node and perform upgrade (adjust for your environment)
  log "Upgrading kubelet and kubeadm on $NODE..."

  ssh "$NODE" <<'ENDSSH'
    set -euo pipefail

    # Update package index
    apt-get update

    # Upgrade kubeadm
    apt-mark unhold kubeadm
    apt-get install -y kubeadm=${TARGET_VERSION}-00
    apt-mark hold kubeadm

    # Upgrade node
    kubeadm upgrade node

    # Upgrade kubelet and kubectl
    apt-mark unhold kubelet kubectl
    apt-get install -y kubelet=${TARGET_VERSION}-00 kubectl=${TARGET_VERSION}-00
    apt-mark hold kubelet kubectl

    # Restart kubelet
    systemctl daemon-reload
    systemctl restart kubelet
ENDSSH

  # Uncordon node
  log "Uncordoning node $NODE..."
  kubectl uncordon "$NODE"

  # Wait for node to be ready
  log "Waiting for node $NODE to be ready..."
  kubectl wait --for=condition=Ready node/"$NODE" --timeout=300s

  log_success "Control plane node $NODE upgraded successfully"
}

# Upgrade worker node
upgrade_worker_node() {
  local NODE=$1
  log "Upgrading worker node: $NODE"

  # Drain node
  log "Draining node $NODE..."
  kubectl drain "$NODE" \
    --ignore-daemonsets \
    --delete-emptydir-data \
    --timeout="$DRAIN_TIMEOUT" \
    --grace-period=30 \
    --pod-selector='app!=critical-service'  # Adjust for your critical services

  # SSH to node and perform upgrade
  log "Upgrading kubelet and kubectl on $NODE..."

  ssh "$NODE" <<'ENDSSH'
    set -euo pipefail

    # Update package index
    apt-get update

    # Upgrade kubeadm
    apt-mark unhold kubeadm
    apt-get install -y kubeadm=${TARGET_VERSION}-00
    apt-mark hold kubeadm

    # Upgrade kubelet config
    kubeadm upgrade node

    # Upgrade kubelet and kubectl
    apt-mark unhold kubelet kubectl
    apt-get install -y kubelet=${TARGET_VERSION}-00 kubectl=${TARGET_VERSION}-00
    apt-mark hold kubelet kubectl

    # Restart kubelet
    systemctl daemon-reload
    systemctl restart kubelet
ENDSSH

  # Uncordon node
  log "Uncordoning node $NODE..."
  kubectl uncordon "$NODE"

  # Wait for node to be ready
  log "Waiting for node $NODE to be ready..."
  kubectl wait --for=condition=Ready node/"$NODE" --timeout=300s

  log_success "Worker node $NODE upgraded successfully"
}

# Verify cluster health
verify_cluster_health() {
  log "Verifying cluster health..."

  # Check all nodes are ready
  NOT_READY=$(kubectl get nodes --no-headers | grep -v " Ready" | wc -l)
  if [[ $NOT_READY -gt 0 ]]; then
    log_error "$NOT_READY nodes are not ready"
    return 1
  fi

  # Check all pods are running
  UNHEALTHY_PODS=$(kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded --no-headers | wc -l)
  if [[ $UNHEALTHY_PODS -gt 0 ]]; then
    log_warning "$UNHEALTHY_PODS pods are not healthy"
    kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded
  fi

  # Check component health
  kubectl get cs

  log_success "Cluster health verification passed"
}

# Main execution
main() {
  log "======================================"
  log "Kubernetes Cluster Upgrade"
  log "Current Version: $CURRENT_VERSION"
  log "Target Version: $TARGET_VERSION"
  log "======================================"

  # Run prerequisite checks
  check_prerequisites

  # Create backup
  create_backup

  # Confirm upgrade
  read -p "Proceed with upgrade? (yes/no): " confirm
  if [[ "$confirm" != "yes" ]]; then
    log "Upgrade cancelled"
    exit 0
  fi

  # Get first control plane node (usually the current node)
  FIRST_CP_NODE=$(hostname)
  log "Upgrading first control plane node: $FIRST_CP_NODE"

  # Upgrade kubeadm on first control plane node
  log "Upgrading kubeadm..."
  apt-mark unhold kubeadm
  apt-get update && apt-get install -y kubeadm=${TARGET_VERSION}-00
  apt-mark hold kubeadm

  # Verify kubeadm version
  kubeadm version

  # Plan upgrade
  log "Planning upgrade..."
  kubeadm upgrade plan

  # Apply upgrade
  log "Applying upgrade..."
  kubeadm upgrade apply v${TARGET_VERSION} -y

  # Upgrade kubelet and kubectl on first control plane
  log "Upgrading kubelet and kubectl..."
  apt-mark unhold kubelet kubectl
  apt-get install -y kubelet=${TARGET_VERSION}-00 kubectl=${TARGET_VERSION}-00
  apt-mark hold kubelet kubectl

  systemctl daemon-reload
  systemctl restart kubelet

  # Verify first control plane
  verify_cluster_health

  # Upgrade remaining control plane nodes
  REMAINING_CP_NODES=$(kubectl get nodes -l node-role.kubernetes.io/control-plane --no-headers | grep -v "$FIRST_CP_NODE" | awk '{print $1}')

  for NODE in $REMAINING_CP_NODES; do
    upgrade_control_plane_node "$NODE"
    verify_cluster_health
    sleep 30
  done

  # Upgrade worker nodes in batches
  WORKER_NODES=$(kubectl get nodes -l '!node-role.kubernetes.io/control-plane' --no-headers | awk '{print $1}')
  WORKER_ARRAY=($WORKER_NODES)

  for ((i=0; i<${#WORKER_ARRAY[@]}; i+=$WORKER_BATCH_SIZE)); do
    BATCH=("${WORKER_ARRAY[@]:i:$WORKER_BATCH_SIZE}")

    log "Upgrading worker batch: ${BATCH[*]}"

    for NODE in "${BATCH[@]}"; do
      upgrade_worker_node "$NODE" &
    done

    # Wait for batch to complete
    wait

    # Verify cluster health after each batch
    verify_cluster_health

    # Pause between batches
    if [[ $((i + $WORKER_BATCH_SIZE)) -lt ${#WORKER_ARRAY[@]} ]]; then
      log "Pausing 60 seconds before next batch..."
      sleep 60
    fi
  done

  log_success "======================================"
  log_success "Upgrade completed successfully!"
  log_success "======================================"
  log "Backup location: $BACKUP_DIR"
  log "Log file: $LOG_FILE"
}

# Run main function
main
```

## Post-Upgrade Validation

After the upgrade, comprehensive validation is critical:

```bash
#!/bin/bash
# post-upgrade-validation.sh

set -euo pipefail

log() {
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

log "Post-Upgrade Validation"
log "======================="

# 1. Verify all nodes are on new version
log "Checking node versions..."
kubectl get nodes -o wide

EXPECTED_VERSION="v1.25.0"
MISMATCHED_NODES=$(kubectl get nodes -o json | \
  jq -r --arg ver "$EXPECTED_VERSION" \
  '.items[] | select(.status.nodeInfo.kubeletVersion != $ver) | .metadata.name')

if [[ -n "$MISMATCHED_NODES" ]]; then
  log "ERROR: Nodes not on expected version:"
  echo "$MISMATCHED_NODES"
  exit 1
fi

# 2. Verify all pods are running
log "Checking pod health..."
kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded

# 3. Run smoke tests
log "Running smoke tests..."

# Test DNS resolution
kubectl run test-dns --image=busybox:1.28 --rm -it --restart=Never -- nslookup kubernetes.default

# Test service connectivity
kubectl run test-connectivity --image=curlimages/curl:latest --rm -it --restart=Never -- \
  curl -k https://kubernetes.default.svc.cluster.local

# 4. Verify metrics
log "Checking metrics server..."
kubectl top nodes
kubectl top pods -A | head -20

# 5. Test application endpoints
log "Testing application endpoints..."
# Add your specific application health checks here

log "Post-upgrade validation complete!"
```

## Rollback Procedures

Critical rollback procedures when upgrades fail:

```bash
#!/bin/bash
# kubernetes-upgrade-rollback.sh
# Emergency rollback procedure

set -euo pipefail

BACKUP_DIR="${1:-}"

if [[ -z "$BACKUP_DIR" ]]; then
  echo "Usage: $0 <backup-directory>"
  exit 1
fi

if [[ ! -d "$BACKUP_DIR" ]]; then
  echo "ERROR: Backup directory not found: $BACKUP_DIR"
  exit 1
fi

log() {
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

log "EMERGENCY ROLLBACK PROCEDURE"
log "============================"
log "Backup: $BACKUP_DIR"

read -p "This will restore cluster to previous state. Continue? (yes/no): " confirm
if [[ "$confirm" != "yes" ]]; then
  log "Rollback cancelled"
  exit 0
fi

# 1. Restore etcd from snapshot
log "Restoring etcd..."
ETCDCTL_API=3 etcdctl snapshot restore "$BACKUP_DIR/etcd-snapshot.db" \
  --data-dir="/var/lib/etcd-restore" \
  --initial-cluster="$(hostname)=https://$(hostname -I | awk '{print $1}'):2380" \
  --initial-advertise-peer-urls="https://$(hostname -I | awk '{print $1}'):2380"

# Stop etcd
systemctl stop etcd

# Replace data directory
mv /var/lib/etcd /var/lib/etcd.backup
mv /var/lib/etcd-restore /var/lib/etcd

# Start etcd
systemctl start etcd

# 2. Restore certificates if needed
log "Restoring certificates..."
cp -r "$BACKUP_DIR/pki/"* /etc/kubernetes/pki/

# 3. Restore kubeconfig files
log "Restoring kubeconfig files..."
cp "$BACKUP_DIR"/*.conf /etc/kubernetes/

# 4. Restart control plane components
log "Restarting control plane..."
systemctl restart kubelet

log "Rollback complete. Verify cluster health!"
```

## Conclusion

Reddit's Kubernetes upgrade failure demonstrates that even routine maintenance operations require meticulous planning, comprehensive validation, and tested recovery procedures. The key lessons:

1. **Pre-Upgrade Validation is Critical**: Never upgrade without comprehensive API compatibility testing
2. **Staged Rollouts Save Production**: Upgrade in small batches with validation between each stage
3. **Resource Capacity Matters**: Ensure sufficient capacity for pod rescheduling during node rotation
4. **Backups are Non-Negotiable**: Always have tested, recent backups before major changes
5. **Rollback Procedures Must Be Tested**: Know how to roll back before you need to
6. **Monitoring and Alerting**: Real-time validation during upgrades catches issues early

By implementing these procedures and tools, organizations can perform Kubernetes upgrades with confidence, minimizing downtime and business impact.