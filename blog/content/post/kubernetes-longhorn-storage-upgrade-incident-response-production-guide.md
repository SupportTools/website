---
title: "Kubernetes Longhorn Storage Upgrade Incident Response: Production Troubleshooting and Recovery Guide"
date: 2026-08-31T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Longhorn", "Storage", "Incident Response", "Troubleshooting", "Production", "DevOps"]
categories: ["Kubernetes", "DevOps", "Infrastructure"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Master Kubernetes Longhorn storage upgrade incident response with comprehensive troubleshooting strategies, production recovery procedures, and enterprise-grade storage management patterns for critical infrastructure."
more_link: "yes"
url: "/kubernetes-longhorn-storage-upgrade-incident-response-production-guide/"
---

Production Kubernetes storage systems represent some of the most critical infrastructure components in modern enterprise environments, where storage upgrade incidents can cascade into application-wide outages affecting business continuity. Longhorn, as a cloud-native distributed storage solution, requires sophisticated upgrade procedures and incident response strategies that minimize service disruption while maintaining data integrity.

Understanding how to effectively diagnose, troubleshoot, and recover from Longhorn storage upgrade failures is essential for platform engineering teams managing production Kubernetes clusters. This comprehensive guide explores real-world incident scenarios, advanced troubleshooting methodologies, and proven recovery patterns based on production incident analysis.

<!--more-->

## Executive Summary

Longhorn storage upgrade incidents in production Kubernetes environments require systematic incident response procedures that prioritize data protection, service restoration, and root cause analysis. This guide provides comprehensive strategies for managing complex storage upgrade scenarios, implementing effective recovery procedures, and establishing preventive measures that ensure reliable storage system operations at enterprise scale.

## Understanding Longhorn Architecture and Upgrade Complexity

### Longhorn System Components

Longhorn's distributed architecture involves multiple interacting components that must be carefully coordinated during upgrades:

```yaml
# Longhorn system architecture overview
apiVersion: v1
kind: ConfigMap
metadata:
  name: longhorn-architecture-overview
  namespace: longhorn-system
data:
  components.yaml: |
    longhorn_manager:
      purpose: "Central coordination and API management"
      deployment_type: "DaemonSet"
      upgrade_impact: "High - Controls all storage operations"

    longhorn_driver:
      purpose: "CSI driver implementation"
      deployment_type: "DaemonSet + Deployment"
      upgrade_impact: "Critical - Affects volume mounting"

    longhorn_ui:
      purpose: "Web interface for management"
      deployment_type: "Deployment"
      upgrade_impact: "Low - UI only"

    instance_manager:
      purpose: "Manages volume replicas and engines"
      deployment_type: "DaemonSet"
      upgrade_impact: "Critical - Affects data path"

    storage_engine:
      purpose: "Volume data management"
      deployment_type: "Pod per volume"
      upgrade_impact: "Critical - Requires careful coordination"
```

### Pre-Upgrade Assessment Framework

Implement comprehensive pre-upgrade assessments to identify potential issues:

```bash
#!/bin/bash
# Script: longhorn-pre-upgrade-assessment.sh
# Purpose: Comprehensive pre-upgrade assessment for Longhorn storage

set -euo pipefail

# Configuration
NAMESPACE="longhorn-system"
LOG_FILE="/var/log/longhorn-upgrade-assessment-$(date +%Y%m%d_%H%M%S).log"
ASSESSMENT_REPORT="/tmp/longhorn-assessment-report.json"

function log_message() {
    local level="$1"
    local message="$2"
    local timestamp=$(date -u +"%Y-%m-%d %H:%M:%S UTC")

    echo "[$timestamp] [$level] $message" | tee -a "$LOG_FILE"
}

function assess_cluster_health() {
    log_message "INFO" "Starting cluster health assessment"

    # Check node status
    local unhealthy_nodes=$(kubectl get nodes -o json | \
        jq -r '.items[] | select(.status.conditions[] | select(.type=="Ready" and .status!="True")) | .metadata.name' | wc -l)

    if [[ $unhealthy_nodes -gt 0 ]]; then
        log_message "WARN" "$unhealthy_nodes unhealthy nodes detected"
        kubectl get nodes -o wide
    fi

    # Check system resource usage
    log_message "INFO" "Checking system resource usage"
    kubectl top nodes 2>/dev/null || log_message "WARN" "Metrics server not available"

    # Check for resource constraints
    local resource_pressure=$(kubectl get nodes -o json | \
        jq -r '.items[].status.conditions[] | select(.type=="MemoryPressure" or .type=="DiskPressure") | select(.status=="True")')

    if [[ -n "$resource_pressure" ]]; then
        log_message "ERROR" "Resource pressure detected on nodes"
        echo "$resource_pressure"
    fi

    log_message "INFO" "Cluster health assessment completed"
}

function assess_longhorn_system_health() {
    log_message "INFO" "Assessing Longhorn system health"

    # Check Longhorn namespace
    if ! kubectl get namespace "$NAMESPACE" >/dev/null 2>&1; then
        log_message "ERROR" "Longhorn namespace not found: $NAMESPACE"
        return 1
    fi

    # Check core Longhorn deployments
    local deployments=("longhorn-driver-deployer" "longhorn-ui" "csi-attacher" "csi-provisioner" "csi-resizer" "csi-snapshotter")
    local daemonsets=("longhorn-manager" "longhorn-csi-plugin" "engine-image-ei")

    for deployment in "${deployments[@]}"; do
        local ready_replicas=$(kubectl get deployment "$deployment" -n "$NAMESPACE" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
        local desired_replicas=$(kubectl get deployment "$deployment" -n "$NAMESPACE" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "0")

        if [[ "$ready_replicas" != "$desired_replicas" ]]; then
            log_message "WARN" "Deployment $deployment not fully ready: $ready_replicas/$desired_replicas"
        else
            log_message "INFO" "Deployment $deployment healthy: $ready_replicas/$desired_replicas"
        fi
    done

    for daemonset in "${daemonsets[@]}"; do
        local ready_nodes=$(kubectl get daemonset "$daemonset" -n "$NAMESPACE" -o jsonpath='{.status.numberReady}' 2>/dev/null || echo "0")
        local desired_nodes=$(kubectl get daemonset "$daemonset" -n "$NAMESPACE" -o jsonpath='{.status.desiredNumberScheduled}' 2>/dev/null || echo "0")

        if [[ "$ready_nodes" != "$desired_nodes" ]]; then
            log_message "WARN" "DaemonSet $daemonset not fully ready: $ready_nodes/$desired_nodes"
        else
            log_message "INFO" "DaemonSet $daemonset healthy: $ready_nodes/$desired_nodes"
        fi
    done
}

function assess_volume_health() {
    log_message "INFO" "Assessing Longhorn volume health"

    # Get all volumes and their health status
    local volumes=$(kubectl get volumes.longhorn.io -n "$NAMESPACE" -o json)
    local total_volumes=$(echo "$volumes" | jq '.items | length')
    local unhealthy_volumes=$(echo "$volumes" | jq '[.items[] | select(.status.state != "attached" and .status.state != "detached")] | length')

    log_message "INFO" "Total volumes: $total_volumes, Unhealthy: $unhealthy_volumes"

    if [[ $unhealthy_volumes -gt 0 ]]; then
        log_message "WARN" "Found $unhealthy_volumes unhealthy volumes"
        echo "$volumes" | jq -r '.items[] | select(.status.state != "attached" and .status.state != "detached") | .metadata.name + ": " + .status.state'
    fi

    # Check replica health
    local replicas=$(kubectl get replicas.longhorn.io -n "$NAMESPACE" -o json)
    local unhealthy_replicas=$(echo "$replicas" | jq '[.items[] | select(.status.currentState != "running")] | length')

    if [[ $unhealthy_replicas -gt 0 ]]; then
        log_message "WARN" "Found $unhealthy_replicas unhealthy replicas"
        echo "$replicas" | jq -r '.items[] | select(.status.currentState != "running") | .metadata.name + ": " + .status.currentState'
    fi
}

function assess_storage_configuration() {
    log_message "INFO" "Assessing storage configuration"

    # Check storage classes
    local longhorn_storage_classes=$(kubectl get storageclass -o json | jq -r '.items[] | select(.provisioner == "driver.longhorn.io") | .metadata.name')

    for sc in $longhorn_storage_classes; do
        log_message "INFO" "Found Longhorn StorageClass: $sc"

        # Check for any problematic configurations
        local reclaim_policy=$(kubectl get storageclass "$sc" -o jsonpath='{.reclaimPolicy}')
        if [[ "$reclaim_policy" != "Retain" && "$reclaim_policy" != "Delete" ]]; then
            log_message "WARN" "Unusual reclaim policy for StorageClass $sc: $reclaim_policy"
        fi
    done

    # Check node and disk status
    local nodes_info=$(kubectl get nodes.longhorn.io -n "$NAMESPACE" -o json)
    local nodes_with_issues=$(echo "$nodes_info" | jq '[.items[] | select(.status.conditions[] | select(.status != "True"))] | length')

    if [[ $nodes_with_issues -gt 0 ]]; then
        log_message "WARN" "Found $nodes_with_issues Longhorn nodes with issues"
        echo "$nodes_info" | jq -r '.items[] | select(.status.conditions[] | select(.status != "True")) | .metadata.name'
    fi
}

function generate_assessment_report() {
    log_message "INFO" "Generating assessment report"

    local cluster_info=$(kubectl cluster-info 2>/dev/null || echo "Cluster info unavailable")
    local k8s_version=$(kubectl version -o json 2>/dev/null | jq -r '.serverVersion.gitVersion' || echo "Unknown")
    local longhorn_version=$(kubectl get deployment longhorn-ui -n "$NAMESPACE" -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null | cut -d':' -f2 || echo "Unknown")

    cat > "$ASSESSMENT_REPORT" <<EOF
{
  "assessment_timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "cluster_info": {
    "kubernetes_version": "$k8s_version",
    "longhorn_version": "$longhorn_version",
    "node_count": $(kubectl get nodes --no-headers | wc -l)
  },
  "health_summary": {
    "cluster_healthy": $(assess_cluster_health >/dev/null 2>&1 && echo "true" || echo "false"),
    "longhorn_healthy": $(assess_longhorn_system_health >/dev/null 2>&1 && echo "true" || echo "false"),
    "volumes_healthy": $(assess_volume_health >/dev/null 2>&1 && echo "true" || echo "false")
  },
  "recommendations": [
    "Ensure all nodes are in Ready state before upgrade",
    "Verify all volumes are in healthy state",
    "Create backup of critical data before upgrade",
    "Plan for potential service disruption during upgrade"
  ]
}
EOF

    log_message "INFO" "Assessment report generated: $ASSESSMENT_REPORT"
    cat "$ASSESSMENT_REPORT" | jq .
}

function check_upgrade_prerequisites() {
    log_message "INFO" "Checking upgrade prerequisites"

    # Check Helm installation
    if ! command -v helm >/dev/null 2>&1; then
        log_message "ERROR" "Helm not installed or not in PATH"
        return 1
    fi

    # Check current Helm release
    local current_release=$(helm list -n "$NAMESPACE" -o json | jq -r '.[] | select(.name == "longhorn") | .chart' || echo "Not found")
    log_message "INFO" "Current Helm release: $current_release"

    # Check for pending volumes
    local pending_volumes=$(kubectl get pv -o json | jq '[.items[] | select(.spec.storageClassName // "" | contains("longhorn")) | select(.status.phase == "Pending")] | length')

    if [[ $pending_volumes -gt 0 ]]; then
        log_message "WARN" "Found $pending_volumes pending Longhorn PersistentVolumes"
    fi

    # Check for running pods using Longhorn volumes
    local pods_with_longhorn=$(kubectl get pods --all-namespaces -o json | \
        jq '[.items[] | select(.spec.volumes[]?.persistentVolumeClaim) |
        select(.status.phase == "Running")] | length')

    log_message "INFO" "Found $pods_with_longhorn running pods potentially using persistent storage"

    return 0
}

# Main assessment execution
function run_full_assessment() {
    log_message "INFO" "Starting comprehensive Longhorn pre-upgrade assessment"

    assess_cluster_health
    assess_longhorn_system_health
    assess_volume_health
    assess_storage_configuration
    check_upgrade_prerequisites
    generate_assessment_report

    log_message "INFO" "Assessment completed. Review $LOG_FILE and $ASSESSMENT_REPORT"

    # Display summary
    echo ""
    echo "🔍 Pre-Upgrade Assessment Summary"
    echo "================================="
    echo "📄 Detailed log: $LOG_FILE"
    echo "📊 Assessment report: $ASSESSMENT_REPORT"
    echo ""

    if jq -e '.health_summary | to_entries[] | select(.value == false)' "$ASSESSMENT_REPORT" >/dev/null; then
        echo "⚠️  Health issues detected. Review assessment before proceeding with upgrade."
        return 1
    else
        echo "✅ System appears healthy for upgrade"
        return 0
    fi
}

# Execution
case "${1:-assess}" in
    "assess")
        run_full_assessment
        ;;
    "cluster")
        assess_cluster_health
        ;;
    "longhorn")
        assess_longhorn_system_health
        ;;
    "volumes")
        assess_volume_health
        ;;
    "storage")
        assess_storage_configuration
        ;;
    "report")
        generate_assessment_report
        ;;
    *)
        echo "Usage: $0 {assess|cluster|longhorn|volumes|storage|report}"
        exit 1
        ;;
esac
```

## Incident Response and Troubleshooting Framework

### Systematic Incident Investigation

Implement structured incident investigation procedures:

```bash
#!/bin/bash
# Script: longhorn-incident-investigation.sh
# Purpose: Systematic investigation of Longhorn storage incidents

set -euo pipefail

# Configuration
NAMESPACE="longhorn-system"
INCIDENT_ID="${INCIDENT_ID:-$(date +%Y%m%d_%H%M%S)}"
INVESTIGATION_DIR="/tmp/longhorn-incident-$INCIDENT_ID"
EVIDENCE_ARCHIVE="$INVESTIGATION_DIR/evidence-$INCIDENT_ID.tar.gz"

function setup_investigation_environment() {
    echo "🔍 Setting up incident investigation environment"

    mkdir -p "$INVESTIGATION_DIR"/{logs,configs,diagnostics,timeline}

    cat > "$INVESTIGATION_DIR/incident-metadata.json" <<EOF
{
  "incident_id": "$INCIDENT_ID",
  "start_time": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "investigator": "${USER:-unknown}",
  "cluster_context": "$(kubectl config current-context)",
  "kubernetes_version": "$(kubectl version -o json 2>/dev/null | jq -r '.serverVersion.gitVersion' || echo 'unknown')",
  "longhorn_version": "$(kubectl get deployment longhorn-ui -n $NAMESPACE -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo 'unknown')"
}
EOF

    echo "📁 Investigation directory: $INVESTIGATION_DIR"
}

function collect_system_evidence() {
    echo "📊 Collecting system evidence"

    local evidence_dir="$INVESTIGATION_DIR/evidence"
    mkdir -p "$evidence_dir"

    # Collect cluster-wide information
    kubectl cluster-info > "$evidence_dir/cluster-info.txt" 2>&1
    kubectl get nodes -o wide > "$evidence_dir/nodes.txt" 2>&1
    kubectl get events --all-namespaces --sort-by='.lastTimestamp' > "$evidence_dir/cluster-events.txt" 2>&1

    # Collect Longhorn-specific information
    kubectl get all -n "$NAMESPACE" -o wide > "$evidence_dir/longhorn-resources.txt" 2>&1
    kubectl get volumes.longhorn.io -n "$NAMESPACE" -o yaml > "$evidence_dir/longhorn-volumes.yaml" 2>&1
    kubectl get nodes.longhorn.io -n "$NAMESPACE" -o yaml > "$evidence_dir/longhorn-nodes.yaml" 2>&1
    kubectl get replicas.longhorn.io -n "$NAMESPACE" -o yaml > "$evidence_dir/longhorn-replicas.yaml" 2>&1
    kubectl get engines.longhorn.io -n "$NAMESPACE" -o yaml > "$evidence_dir/longhorn-engines.yaml" 2>&1

    # Collect storage classes and persistent volumes
    kubectl get storageclass -o yaml > "$evidence_dir/storage-classes.yaml" 2>&1
    kubectl get pv -o yaml > "$evidence_dir/persistent-volumes.yaml" 2>&1
    kubectl get pvc --all-namespaces -o yaml > "$evidence_dir/persistent-volume-claims.yaml" 2>&1

    # Collect system logs
    echo "📝 Collecting system logs"
    kubectl logs -n "$NAMESPACE" -l app=longhorn-manager --all-containers --previous > "$evidence_dir/longhorn-manager-logs-previous.txt" 2>&1 || true
    kubectl logs -n "$NAMESPACE" -l app=longhorn-manager --all-containers > "$evidence_dir/longhorn-manager-logs-current.txt" 2>&1 || true

    kubectl logs -n "$NAMESPACE" -l app=longhorn-driver-deployer --all-containers > "$evidence_dir/longhorn-driver-logs.txt" 2>&1 || true
    kubectl logs -n "$NAMESPACE" -l app=csi-attacher --all-containers > "$evidence_dir/csi-attacher-logs.txt" 2>&1 || true
    kubectl logs -n "$NAMESPACE" -l app=csi-provisioner --all-containers > "$evidence_dir/csi-provisioner-logs.txt" 2>&1 || true

    echo "✅ System evidence collected"
}

function analyze_upgrade_state() {
    echo "🔄 Analyzing upgrade state"

    local analysis_dir="$INVESTIGATION_DIR/analysis"
    mkdir -p "$analysis_dir"

    # Check Helm release status
    if command -v helm >/dev/null 2>&1; then
        helm list -n "$NAMESPACE" -o yaml > "$analysis_dir/helm-releases.yaml" 2>&1
        helm status longhorn -n "$NAMESPACE" > "$analysis_dir/helm-status.txt" 2>&1 || true
        helm history longhorn -n "$NAMESPACE" > "$analysis_dir/helm-history.txt" 2>&1 || true
    fi

    # Analyze pod states
    echo "Analyzing pod states..." > "$analysis_dir/pod-analysis.txt"
    kubectl get pods -n "$NAMESPACE" -o json | jq -r '
      .items[] |
      select(.status.phase != "Running" or (.status.containerStatuses[]? | select(.ready != true))) |
      "\(.metadata.name): \(.status.phase) - " + (
        if .status.containerStatuses then
          (.status.containerStatuses[] | "\(.name)=\(.ready)") | tostring
        else
          "No container status"
        end
      )
    ' >> "$analysis_dir/pod-analysis.txt"

    # Check for stuck resources
    echo "Checking for stuck resources..." >> "$analysis_dir/resource-analysis.txt"
    kubectl get pods -n "$NAMESPACE" -o json | jq -r '
      .items[] |
      select(.metadata.deletionTimestamp and (.status.phase == "Terminating")) |
      "\(.metadata.name): Stuck in terminating state since \(.metadata.deletionTimestamp)"
    ' >> "$analysis_dir/resource-analysis.txt"

    # Analyze volume attachment issues
    echo "Analyzing volume attachment issues..." > "$analysis_dir/volume-analysis.txt"
    kubectl get volumeattachments -o json | jq -r '
      .items[] |
      select(.spec.attacher == "driver.longhorn.io") |
      select(.status.attached != true) |
      "\(.metadata.name): \(.spec.nodeName) - \(.status.attachmentMetadata // "No metadata")"
    ' >> "$analysis_dir/volume-analysis.txt"

    echo "✅ Upgrade state analysis completed"
}

function identify_failure_patterns() {
    echo "🔍 Identifying failure patterns"

    local patterns_dir="$INVESTIGATION_DIR/patterns"
    mkdir -p "$patterns_dir"

    # Common failure patterns to check
    local log_files=("$INVESTIGATION_DIR/evidence"/*.txt)

    # Pattern 1: BackoffLimitExceeded
    echo "Checking for BackoffLimitExceeded patterns..." > "$patterns_dir/backoff-limit.txt"
    for log_file in "${log_files[@]}"; do
        if [[ -f "$log_file" ]]; then
            grep -n "BackoffLimitExceeded\|Job has reached the specified backoff limit" "$log_file" >> "$patterns_dir/backoff-limit.txt" 2>/dev/null || true
        fi
    done

    # Pattern 2: Node scheduling issues
    echo "Checking for node scheduling issues..." > "$patterns_dir/scheduling-issues.txt"
    for log_file in "${log_files[@]}"; do
        if [[ -f "$log_file" ]]; then
            grep -n "FailedScheduling\|Unschedulable\|NoNodeAvailable" "$log_file" >> "$patterns_dir/scheduling-issues.txt" 2>/dev/null || true
        fi
    done

    # Pattern 3: Volume attachment failures
    echo "Checking for volume attachment failures..." > "$patterns_dir/volume-attachment.txt"
    for log_file in "${log_files[@]}"; do
        if [[ -f "$log_file" ]]; then
            grep -n "FailedAttachVolume\|FailedMount\|VolumeAttachment" "$log_file" >> "$patterns_dir/volume-attachment.txt" 2>/dev/null || true
        fi
    done

    # Pattern 4: Disk configuration errors
    echo "Checking for disk configuration errors..." > "$patterns_dir/disk-config.txt"
    for log_file in "${log_files[@]}"; do
        if [[ -f "$log_file" ]]; then
            grep -n "failed to get disk config\|unknown disk type\|disk.*not found" "$log_file" >> "$patterns_dir/disk-config.txt" 2>/dev/null || true
        fi
    done

    # Pattern 5: Image pull issues
    echo "Checking for image pull issues..." > "$patterns_dir/image-pull.txt"
    for log_file in "${log_files[@]}"; do
        if [[ -f "$log_file" ]]; then
            grep -n "ImagePullBackOff\|ErrImagePull\|Failed to pull image" "$log_file" >> "$patterns_dir/image-pull.txt" 2>/dev/null || true
        fi
    done

    echo "✅ Failure pattern identification completed"
}

function create_recovery_plan() {
    echo "📋 Creating recovery plan"

    local recovery_dir="$INVESTIGATION_DIR/recovery"
    mkdir -p "$recovery_dir"

    # Analyze current system state to determine recovery steps
    local recovery_plan="$recovery_dir/recovery-plan.md"

    cat > "$recovery_plan" <<'EOF'
# Longhorn Storage Incident Recovery Plan

## Incident Overview
- **Incident ID**: {{INCIDENT_ID}}
- **Start Time**: {{START_TIME}}
- **System State**: To be determined based on evidence

## Pre-Recovery Checklist
- [ ] All evidence collected and analyzed
- [ ] Backup of current configuration captured
- [ ] Recovery plan reviewed by senior team member
- [ ] Maintenance window scheduled if required

## Recovery Steps

### Phase 1: Immediate Stabilization
1. **Stop causing additional damage**
   - Prevent new volume operations if needed
   - Scale down non-critical workloads if necessary

2. **Assess current workload impact**
   - Identify affected applications
   - Document service disruption scope

### Phase 2: System Recovery
1. **Address immediate issues**
   - Fix any stuck terminating resources
   - Resolve node scheduling issues
   - Clear any blocked volume attachments

2. **Validate core functionality**
   - Test volume creation/deletion
   - Verify data access for existing volumes
   - Confirm storage class functionality

### Phase 3: Service Restoration
1. **Gradual workload restoration**
   - Scale up critical applications first
   - Monitor for any recurring issues
   - Validate data integrity

2. **Full system validation**
   - Run comprehensive storage tests
   - Verify all volumes are healthy
   - Confirm monitoring and alerting

## Rollback Procedures
If recovery fails, consider:
1. Helm rollback to previous version
2. Restore from backup if data corruption occurred
3. Emergency migration to alternative storage solution

## Post-Recovery Tasks
- [ ] Update monitoring and alerting
- [ ] Document lessons learned
- [ ] Update upgrade procedures
- [ ] Schedule post-mortem meeting

EOF

    # Replace placeholders
    sed -i "s/{{INCIDENT_ID}}/$INCIDENT_ID/g" "$recovery_plan"
    sed -i "s/{{START_TIME}}/$(date -u +%Y-%m-%dT%H:%M:%SZ)/g" "$recovery_plan"

    echo "📄 Recovery plan created: $recovery_plan"
}

function generate_investigation_report() {
    echo "📊 Generating investigation report"

    local report_file="$INVESTIGATION_DIR/investigation-report.md"

    cat > "$report_file" <<EOF
# Longhorn Storage Incident Investigation Report

## Incident Details
- **Incident ID**: $INCIDENT_ID
- **Investigation Start**: $(date -u +%Y-%m-%dT%H:%M:%SZ)
- **Investigator**: ${USER:-unknown}
- **Cluster**: $(kubectl config current-context)

## System Information
- **Kubernetes Version**: $(kubectl version -o json 2>/dev/null | jq -r '.serverVersion.gitVersion' || echo 'unknown')
- **Longhorn Version**: $(kubectl get deployment longhorn-ui -n $NAMESPACE -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null | cut -d':' -f2 || echo 'unknown')
- **Node Count**: $(kubectl get nodes --no-headers | wc -l)

## Evidence Collected
- System configurations and resource states
- Application and system logs
- Cluster events and timeline
- Volume and storage analysis

## Key Findings
$(if [[ -s "$INVESTIGATION_DIR/patterns/backoff-limit.txt" ]]; then echo "- BackoffLimitExceeded errors detected"; fi)
$(if [[ -s "$INVESTIGATION_DIR/patterns/scheduling-issues.txt" ]]; then echo "- Node scheduling issues identified"; fi)
$(if [[ -s "$INVESTIGATION_DIR/patterns/volume-attachment.txt" ]]; then echo "- Volume attachment failures found"; fi)
$(if [[ -s "$INVESTIGATION_DIR/patterns/disk-config.txt" ]]; then echo "- Disk configuration errors present"; fi)
$(if [[ -s "$INVESTIGATION_DIR/patterns/image-pull.txt" ]]; then echo "- Image pull issues detected"; fi)

## Recommended Actions
1. Review detailed analysis in patterns/ directory
2. Follow recovery plan in recovery/recovery-plan.md
3. Implement preventive measures based on findings

## Investigation Artifacts
- **Evidence Archive**: Will be created at $EVIDENCE_ARCHIVE
- **Investigation Directory**: $INVESTIGATION_DIR
- **Recovery Plan**: $INVESTIGATION_DIR/recovery/recovery-plan.md

EOF

    echo "📄 Investigation report: $report_file"
}

function create_evidence_archive() {
    echo "📦 Creating evidence archive"

    tar -czf "$EVIDENCE_ARCHIVE" -C "$(dirname "$INVESTIGATION_DIR")" "$(basename "$INVESTIGATION_DIR")"

    echo "✅ Evidence archive created: $EVIDENCE_ARCHIVE"
    echo "📊 Archive size: $(du -h "$EVIDENCE_ARCHIVE" | cut -f1)"
}

# Main investigation workflow
function run_full_investigation() {
    echo "🚨 Starting Longhorn storage incident investigation"

    setup_investigation_environment
    collect_system_evidence
    analyze_upgrade_state
    identify_failure_patterns
    create_recovery_plan
    generate_investigation_report
    create_evidence_archive

    echo ""
    echo "🔍 Investigation Summary"
    echo "======================="
    echo "📁 Investigation directory: $INVESTIGATION_DIR"
    echo "📄 Investigation report: $INVESTIGATION_DIR/investigation-report.md"
    echo "📋 Recovery plan: $INVESTIGATION_DIR/recovery/recovery-plan.md"
    echo "📦 Evidence archive: $EVIDENCE_ARCHIVE"
    echo ""
    echo "Next steps:"
    echo "1. Review investigation report"
    echo "2. Follow recovery plan procedures"
    echo "3. Archive evidence for future reference"
}

# Execution
case "${1:-investigate}" in
    "investigate")
        run_full_investigation
        ;;
    "evidence")
        setup_investigation_environment
        collect_system_evidence
        ;;
    "analyze")
        analyze_upgrade_state
        identify_failure_patterns
        ;;
    "recovery")
        create_recovery_plan
        ;;
    "report")
        generate_investigation_report
        ;;
    "archive")
        create_evidence_archive
        ;;
    *)
        echo "Usage: $0 {investigate|evidence|analyze|recovery|report|archive}"
        exit 1
        ;;
esac
```

## Advanced Recovery Procedures

### Comprehensive Recovery Automation

Implement automated recovery procedures for common incident scenarios:

```bash
#!/bin/bash
# Script: longhorn-recovery-automation.sh
# Purpose: Automated recovery procedures for Longhorn storage incidents

set -euo pipefail

# Configuration
NAMESPACE="longhorn-system"
BACKUP_DIR="/var/backups/longhorn-recovery"
RECOVERY_LOG="/var/log/longhorn-recovery-$(date +%Y%m%d_%H%M%S).log"

function log_recovery_step() {
    local level="$1"
    local message="$2"
    local timestamp=$(date -u +"%Y-%m-%d %H:%M:%S UTC")

    echo "[$timestamp] [$level] $message" | tee -a "$RECOVERY_LOG"
}

function create_system_backup() {
    log_recovery_step "INFO" "Creating system configuration backup"

    mkdir -p "$BACKUP_DIR/$(date +%Y%m%d_%H%M%S)"
    local backup_dir="$BACKUP_DIR/$(date +%Y%m%d_%H%M%S)"

    # Backup Longhorn resources
    kubectl get volumes.longhorn.io -n "$NAMESPACE" -o yaml > "$backup_dir/volumes-backup.yaml"
    kubectl get nodes.longhorn.io -n "$NAMESPACE" -o yaml > "$backup_dir/nodes-backup.yaml"
    kubectl get settings.longhorn.io -n "$NAMESPACE" -o yaml > "$backup_dir/settings-backup.yaml"

    # Backup Helm values
    if command -v helm >/dev/null 2>&1; then
        helm get values longhorn -n "$NAMESPACE" > "$backup_dir/helm-values-backup.yaml" 2>/dev/null || true
    fi

    log_recovery_step "INFO" "System backup created in $backup_dir"
}

function recover_from_backoff_limit_exceeded() {
    log_recovery_step "INFO" "Recovering from BackoffLimitExceeded errors"

    # Find and delete failed jobs
    local failed_jobs=$(kubectl get jobs -n "$NAMESPACE" -o json | \
        jq -r '.items[] | select(.status.conditions[]? | select(.type == "Failed" and .status == "True")) | .metadata.name')

    for job in $failed_jobs; do
        if [[ -n "$job" ]]; then
            log_recovery_step "INFO" "Deleting failed job: $job"
            kubectl delete job "$job" -n "$NAMESPACE" --force --grace-period=0 || true
        fi
    done

    # Clean up associated pods
    local failed_pods=$(kubectl get pods -n "$NAMESPACE" -o json | \
        jq -r '.items[] | select(.status.phase == "Failed") | .metadata.name')

    for pod in $failed_pods; do
        if [[ -n "$pod" ]]; then
            log_recovery_step "INFO" "Deleting failed pod: $pod"
            kubectl delete pod "$pod" -n "$NAMESPACE" --force --grace-period=0 || true
        fi
    done

    # Wait for cleanup
    log_recovery_step "INFO" "Waiting for resource cleanup..."
    sleep 30

    # Retry any pending operations
    log_recovery_step "INFO" "Checking for pending operations to retry"
}

function recover_node_scheduling_issues() {
    log_recovery_step "INFO" "Recovering from node scheduling issues"

    # Check for nodes with taints that prevent scheduling
    local tainted_nodes=$(kubectl get nodes -o json | \
        jq -r '.items[] | select(.spec.taints[]? | select(.effect == "NoSchedule" or .effect == "NoExecute")) | .metadata.name')

    for node in $tainted_nodes; do
        if [[ -n "$node" ]]; then
            log_recovery_step "WARN" "Node $node has scheduling taints"
            kubectl describe node "$node" | grep -A 10 "Taints:"
        fi
    done

    # Check for cordoned nodes
    local cordoned_nodes=$(kubectl get nodes -o json | \
        jq -r '.items[] | select(.spec.unschedulable == true) | .metadata.name')

    for node in $cordoned_nodes; do
        if [[ -n "$node" ]]; then
            log_recovery_step "INFO" "Uncordoning node: $node"
            kubectl uncordon "$node" || log_recovery_step "WARN" "Failed to uncordon $node"
        fi
    done

    # Restart kubelet on problematic nodes if needed
    log_recovery_step "INFO" "Node scheduling recovery completed"
}

function recover_volume_attachment_issues() {
    log_recovery_step "INFO" "Recovering from volume attachment issues"

    # Find stuck volume attachments
    local stuck_attachments=$(kubectl get volumeattachments -o json | \
        jq -r '.items[] | select(.spec.attacher == "driver.longhorn.io") | select(.status.attached != true) | .metadata.name')

    for attachment in $stuck_attachments; do
        if [[ -n "$attachment" ]]; then
            log_recovery_step "INFO" "Analyzing stuck volume attachment: $attachment"

            # Get attachment details
            kubectl describe volumeattachment "$attachment"

            # Check if the associated node is available
            local node_name=$(kubectl get volumeattachment "$attachment" -o jsonpath='{.spec.nodeName}')
            if kubectl get node "$node_name" >/dev/null 2>&1; then
                log_recovery_step "INFO" "Node $node_name is available, attempting to resolve attachment"

                # Delete and recreate attachment if necessary
                kubectl delete volumeattachment "$attachment" --grace-period=0 || true
                sleep 10
            else
                log_recovery_step "WARN" "Node $node_name not available for attachment $attachment"
            fi
        fi
    done

    # Restart CSI components if needed
    log_recovery_step "INFO" "Restarting CSI components to resolve attachment issues"
    kubectl delete pods -n "$NAMESPACE" -l app=longhorn-csi-plugin --force --grace-period=0 || true
    kubectl delete pods -n "$NAMESPACE" -l app=csi-attacher --force --grace-period=0 || true

    # Wait for pods to restart
    sleep 60

    log_recovery_step "INFO" "Volume attachment recovery completed"
}

function recover_disk_configuration_errors() {
    log_recovery_step "INFO" "Recovering from disk configuration errors"

    # Get all Longhorn nodes
    local longhorn_nodes=$(kubectl get nodes.longhorn.io -n "$NAMESPACE" -o json)

    # Check each node's disk configuration
    echo "$longhorn_nodes" | jq -r '.items[] | .metadata.name' | while read -r node; do
        if [[ -n "$node" ]]; then
            log_recovery_step "INFO" "Checking disk configuration for node: $node"

            # Get node details
            local node_info=$(kubectl get nodes.longhorn.io "$node" -n "$NAMESPACE" -o json)

            # Check for disk configuration errors
            local disk_errors=$(echo "$node_info" | jq -r '.status.diskStatus // {} | to_entries[] | select(.value.conditions[]? | select(.type == "Ready" and .status != "True")) | .key')

            for disk in $disk_errors; do
                if [[ -n "$disk" ]]; then
                    log_recovery_step "WARN" "Disk $disk on node $node has configuration errors"

                    # Attempt to fix disk configuration
                    kubectl patch nodes.longhorn.io "$node" -n "$NAMESPACE" --type='json' -p="[
                      {
                        \"op\": \"remove\",
                        \"path\": \"/spec/disks/$disk/tags\"
                      }
                    ]" 2>/dev/null || log_recovery_step "WARN" "Failed to reset disk tags for $disk"
                fi
            done
        fi
    done

    # Restart Longhorn manager to refresh disk status
    log_recovery_step "INFO" "Restarting Longhorn manager to refresh disk status"
    kubectl delete pods -n "$NAMESPACE" -l app=longhorn-manager --force --grace-period=0 || true

    # Wait for restart
    sleep 60

    log_recovery_step "INFO" "Disk configuration recovery completed"
}

function recover_from_image_pull_issues() {
    log_recovery_step "INFO" "Recovering from image pull issues"

    # Find pods with image pull issues
    local image_pull_pods=$(kubectl get pods -n "$NAMESPACE" -o json | \
        jq -r '.items[] | select(.status.containerStatuses[]? | select(.state.waiting.reason == "ImagePullBackOff" or .state.waiting.reason == "ErrImagePull")) | .metadata.name')

    for pod in $image_pull_pods; do
        if [[ -n "$pod" ]]; then
            log_recovery_step "INFO" "Deleting pod with image pull issues: $pod"
            kubectl delete pod "$pod" -n "$NAMESPACE" --force --grace-period=0 || true
        fi
    done

    # Check if image pull secrets are configured correctly
    local pull_secrets=$(kubectl get pods -n "$NAMESPACE" -o json | \
        jq -r '.items[0].spec.imagePullSecrets[]?.name' 2>/dev/null || echo "none")

    if [[ "$pull_secrets" != "none" ]]; then
        log_recovery_step "INFO" "Image pull secrets configured: $pull_secrets"
    else
        log_recovery_step "INFO" "No image pull secrets configured"
    fi

    # Wait for pod recreation
    sleep 30

    log_recovery_step "INFO" "Image pull recovery completed"
}

function validate_system_recovery() {
    log_recovery_step "INFO" "Validating system recovery"

    # Check all Longhorn pods are running
    local running_pods=$(kubectl get pods -n "$NAMESPACE" --no-headers | grep "Running" | wc -l)
    local total_pods=$(kubectl get pods -n "$NAMESPACE" --no-headers | wc -l)

    log_recovery_step "INFO" "Pod status: $running_pods/$total_pods running"

    if [[ $running_pods -lt $total_pods ]]; then
        log_recovery_step "WARN" "Not all pods are running yet"
        kubectl get pods -n "$NAMESPACE" | grep -v "Running"
    fi

    # Check volume health
    local healthy_volumes=$(kubectl get volumes.longhorn.io -n "$NAMESPACE" -o json | \
        jq '[.items[] | select(.status.state == "attached" or .status.state == "detached")] | length')
    local total_volumes=$(kubectl get volumes.longhorn.io -n "$NAMESPACE" --no-headers | wc -l)

    log_recovery_step "INFO" "Volume status: $healthy_volumes/$total_volumes healthy"

    # Test basic functionality
    log_recovery_step "INFO" "Testing basic storage functionality"

    # Create a test PVC
    local test_pvc_name="longhorn-recovery-test-$(date +%s)"

    cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: $test_pvc_name
  namespace: default
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: longhorn
  resources:
    requests:
      storage: 1Gi
EOF

    # Wait for PVC to be bound
    local timeout=120
    local count=0
    while [[ $count -lt $timeout ]]; do
        local pvc_status=$(kubectl get pvc "$test_pvc_name" -n default -o jsonpath='{.status.phase}' 2>/dev/null || echo "NotFound")

        if [[ "$pvc_status" == "Bound" ]]; then
            log_recovery_step "INFO" "Test PVC successfully bound"
            kubectl delete pvc "$test_pvc_name" -n default || true
            break
        fi

        sleep 5
        count=$((count + 5))
    done

    if [[ $count -ge $timeout ]]; then
        log_recovery_step "WARN" "Test PVC failed to bind within timeout"
        kubectl delete pvc "$test_pvc_name" -n default || true
    fi

    log_recovery_step "INFO" "System recovery validation completed"
}

function orchestrate_full_recovery() {
    log_recovery_step "INFO" "Starting comprehensive Longhorn recovery procedure"

    # Create backup before any recovery actions
    create_system_backup

    # Recovery phases
    log_recovery_step "INFO" "Phase 1: Resolving immediate issues"
    recover_from_backoff_limit_exceeded
    recover_node_scheduling_issues

    log_recovery_step "INFO" "Phase 2: Storage-specific recovery"
    recover_volume_attachment_issues
    recover_disk_configuration_errors

    log_recovery_step "INFO" "Phase 3: Image and pod recovery"
    recover_from_image_pull_issues

    log_recovery_step "INFO" "Phase 4: System validation"
    validate_system_recovery

    log_recovery_step "INFO" "Recovery procedure completed"

    # Generate recovery summary
    echo ""
    echo "🔧 Recovery Summary"
    echo "=================="
    echo "📄 Recovery log: $RECOVERY_LOG"
    echo "💾 System backup: $BACKUP_DIR"
    echo ""
    echo "Next steps:"
    echo "1. Monitor system stability"
    echo "2. Run comprehensive tests"
    echo "3. Update monitoring and alerting"
    echo "4. Document incident and recovery"
}

# Execution
case "${1:-full}" in
    "full")
        orchestrate_full_recovery
        ;;
    "backoff")
        create_system_backup
        recover_from_backoff_limit_exceeded
        ;;
    "scheduling")
        create_system_backup
        recover_node_scheduling_issues
        ;;
    "volumes")
        create_system_backup
        recover_volume_attachment_issues
        ;;
    "disks")
        create_system_backup
        recover_disk_configuration_errors
        ;;
    "images")
        create_system_backup
        recover_from_image_pull_issues
        ;;
    "validate")
        validate_system_recovery
        ;;
    "backup")
        create_system_backup
        ;;
    *)
        echo "Usage: $0 {full|backoff|scheduling|volumes|disks|images|validate|backup}"
        echo ""
        echo "Recovery procedures:"
        echo "  full        - Run complete recovery workflow"
        echo "  backoff     - Recover from BackoffLimitExceeded errors"
        echo "  scheduling  - Resolve node scheduling issues"
        echo "  volumes     - Fix volume attachment problems"
        echo "  disks       - Repair disk configuration errors"
        echo "  images      - Resolve image pull issues"
        echo "  validate    - Validate system health"
        echo "  backup      - Create system backup only"
        ;;
esac
```

## Production Upgrade Best Practices

### Comprehensive Upgrade Workflow

Implement enterprise-grade upgrade procedures:

```yaml
# longhorn-upgrade-workflow.yaml
# Comprehensive Longhorn upgrade workflow with safety checks

apiVersion: v1
kind: ConfigMap
metadata:
  name: longhorn-upgrade-config
  namespace: longhorn-system
data:
  upgrade-checklist.yaml: |
    pre_upgrade_checks:
      - name: "Cluster Health"
        description: "Verify all nodes are healthy and ready"
        critical: true
        command: "kubectl get nodes -o json | jq '.items[] | select(.status.conditions[] | select(.type==\"Ready\" and .status!=\"True\"))' | jq length"
        expected: "0"

      - name: "Longhorn System Health"
        description: "All Longhorn components are running"
        critical: true
        command: "kubectl get pods -n longhorn-system --no-headers | grep -v Running | wc -l"
        expected: "0"

      - name: "Volume Health"
        description: "All volumes are in healthy state"
        critical: true
        command: "kubectl get volumes.longhorn.io -n longhorn-system -o json | jq '[.items[] | select(.status.state != \"attached\" and .status.state != \"detached\")] | length'"
        expected: "0"

      - name: "Backup Verification"
        description: "Recent backups are available"
        critical: false
        command: "kubectl get backups.longhorn.io -n longhorn-system --sort-by=.metadata.creationTimestamp | tail -5"
        expected: "At least one recent backup"

      - name: "Resource Availability"
        description: "Sufficient resources for upgrade"
        critical: true
        command: "kubectl top nodes --no-headers | awk '{print $3}' | sed 's/%//' | awk '{if($1>80) print $1}' | wc -l"
        expected: "0"

    upgrade_steps:
      - phase: "Preparation"
        steps:
          - name: "Scale down non-critical workloads"
            description: "Reduce system load during upgrade"
            command: "kubectl scale deployment non-critical-app --replicas=0"

          - name: "Create configuration backup"
            description: "Backup current Longhorn configuration"
            command: "kubectl get all,pv,pvc,sc -o yaml > longhorn-backup-$(date +%Y%m%d).yaml"

      - phase: "Upgrade Execution"
        steps:
          - name: "Update Helm repository"
            description: "Ensure latest charts are available"
            command: "helm repo update"

          - name: "Perform Helm upgrade"
            description: "Execute the actual upgrade"
            command: "helm upgrade longhorn longhorn/longhorn --namespace longhorn-system --wait --timeout=10m"

          - name: "Monitor upgrade progress"
            description: "Watch for successful pod transitions"
            command: "kubectl get pods -n longhorn-system -w"

      - phase: "Validation"
        steps:
          - name: "Verify system health"
            description: "Check all components are healthy"
            command: "kubectl get pods -n longhorn-system"

          - name: "Test volume operations"
            description: "Create and delete test volume"
            command: "kubectl apply -f test-pvc.yaml && kubectl delete -f test-pvc.yaml"

          - name: "Restore workloads"
            description: "Scale up previously scaled down workloads"
            command: "kubectl scale deployment non-critical-app --replicas=3"

    rollback_procedure:
      - name: "Immediate rollback"
        description: "Roll back to previous version if upgrade fails"
        command: "helm rollback longhorn -n longhorn-system"

      - name: "Emergency recovery"
        description: "Emergency procedures if rollback fails"
        steps:
          - "Stop all volume operations"
          - "Restore from backup"
          - "Notify incident response team"

---
apiVersion: batch/v1
kind: Job
metadata:
  name: longhorn-pre-upgrade-validator
  namespace: longhorn-system
spec:
  template:
    spec:
      restartPolicy: OnFailure
      serviceAccountName: longhorn-pre-upgrade-validator
      containers:
      - name: validator
        image: bitnami/kubectl:latest
        command: ["/bin/bash"]
        args:
        - -c
        - |
          set -euo pipefail

          echo "🔍 Starting Longhorn pre-upgrade validation"

          # Function to run validation check
          validate_check() {
            local name="$1"
            local description="$2"
            local command="$3"
            local expected="$4"
            local critical="$5"

            echo "Validating: $name"
            echo "Description: $description"

            if eval "$command"; then
              echo "✅ $name: PASSED"
              return 0
            else
              echo "❌ $name: FAILED"
              if [[ "$critical" == "true" ]]; then
                echo "🚨 Critical check failed. Aborting upgrade."
                exit 1
              fi
              return 1
            fi
          }

          # Cluster health check
          validate_check \
            "Cluster Health" \
            "Verify all nodes are healthy and ready" \
            "[ \$(kubectl get nodes -o json | jq '.items[] | select(.status.conditions[] | select(.type==\"Ready\" and .status!=\"True\"))' | jq length) -eq 0 ]" \
            "0" \
            "true"

          # Longhorn system health
          validate_check \
            "Longhorn System Health" \
            "All Longhorn components are running" \
            "[ \$(kubectl get pods -n longhorn-system --no-headers | grep -v Running | wc -l) -eq 0 ]" \
            "0" \
            "true"

          # Volume health
          validate_check \
            "Volume Health" \
            "All volumes are in healthy state" \
            "[ \$(kubectl get volumes.longhorn.io -n longhorn-system -o json | jq '[.items[] | select(.status.state != \"attached\" and .status.state != \"detached\")] | length') -eq 0 ]" \
            "0" \
            "true"

          echo "🎉 All critical validation checks passed"
          echo "System is ready for Longhorn upgrade"

---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: longhorn-pre-upgrade-validator
  namespace: longhorn-system

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: longhorn-pre-upgrade-validator
rules:
- apiGroups: [""]
  resources: ["nodes", "pods", "persistentvolumes", "persistentvolumeclaims"]
  verbs: ["get", "list"]
- apiGroups: ["storage.k8s.io"]
  resources: ["storageclasses"]
  verbs: ["get", "list"]
- apiGroups: ["longhorn.io"]
  resources: ["*"]
  verbs: ["get", "list"]
- apiGroups: ["metrics.k8s.io"]
  resources: ["nodes", "pods"]
  verbs: ["get", "list"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: longhorn-pre-upgrade-validator
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: longhorn-pre-upgrade-validator
subjects:
- kind: ServiceAccount
  name: longhorn-pre-upgrade-validator
  namespace: longhorn-system
```

## Monitoring and Alerting for Upgrade Operations

### Comprehensive Monitoring Setup

Implement monitoring and alerting for Longhorn operations:

```yaml
# longhorn-monitoring.yaml
# Comprehensive monitoring and alerting for Longhorn storage

apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: longhorn-storage-alerts
  namespace: longhorn-system
  labels:
    app: longhorn
spec:
  groups:
  - name: longhorn.storage
    rules:
    - alert: LonghornVolumeUnhealthy
      expr: longhorn_volume_robustness != 2
      for: 5m
      labels:
        severity: warning
        component: longhorn
      annotations:
        summary: "Longhorn volume {{ $labels.volume }} is not healthy"
        description: "Volume {{ $labels.volume }} has been unhealthy for more than 5 minutes"

    - alert: LonghornNodeDown
      expr: longhorn_node_count_total - longhorn_node_count_ready > 0
      for: 2m
      labels:
        severity: critical
        component: longhorn
      annotations:
        summary: "Longhorn node is down"
        description: "{{ $value }} Longhorn node(s) have been down for more than 2 minutes"

    - alert: LonghornDiskSpaceLow
      expr: (longhorn_disk_capacity_bytes - longhorn_disk_usage_bytes) / longhorn_disk_capacity_bytes * 100 < 10
      for: 5m
      labels:
        severity: warning
        component: longhorn
      annotations:
        summary: "Longhorn disk space low on {{ $labels.node }}"
        description: "Disk {{ $labels.disk }} on node {{ $labels.node }} has less than 10% free space"

    - alert: LonghornReplicaFailure
      expr: increase(longhorn_replica_degraded_total[5m]) > 0
      for: 1m
      labels:
        severity: critical
        component: longhorn
      annotations:
        summary: "Longhorn replica failure detected"
        description: "Replica degradation detected in the last 5 minutes"

    - alert: LonghornBackupFailure
      expr: increase(longhorn_backup_state_error_total[10m]) > 0
      for: 1m
      labels:
        severity: warning
        component: longhorn
      annotations:
        summary: "Longhorn backup failure"
        description: "Backup failures detected in the last 10 minutes"

    - alert: LonghornUpgradeInProgress
      expr: longhorn_manager_cpu_usage_seconds_total > 0 and on() kube_deployment_status_replicas{deployment="longhorn-ui",namespace="longhorn-system"} != on() kube_deployment_status_ready_replicas{deployment="longhorn-ui",namespace="longhorn-system"}
      for: 30m
      labels:
        severity: warning
        component: longhorn
      annotations:
        summary: "Longhorn upgrade taking too long"
        description: "Longhorn upgrade has been in progress for more than 30 minutes"

---
apiVersion: v1
kind: ConfigMap
metadata:
  name: longhorn-incident-runbook
  namespace: longhorn-system
data:
  volume-unhealthy.md: |
    # Longhorn Volume Unhealthy Incident Response

    ## Initial Assessment
    1. Check volume status: `kubectl get volumes.longhorn.io -n longhorn-system`
    2. Identify affected applications
    3. Check replica health: `kubectl get replicas.longhorn.io -n longhorn-system`

    ## Recovery Steps
    1. Attempt replica rebuild if possible
    2. Check node health and disk space
    3. Consider volume backup and restore if needed
    4. Escalate to storage team if no progress in 15 minutes

  node-down.md: |
    # Longhorn Node Down Incident Response

    ## Immediate Actions
    1. Verify node status: `kubectl get nodes`
    2. Check node conditions and events
    3. Attempt to restart node services if accessible

    ## Recovery Procedures
    1. Evacuate workloads from affected node
    2. Replace node if hardware failure
    3. Monitor volume replica redistribution
    4. Verify all volumes remain accessible

  disk-space-low.md: |
    # Longhorn Disk Space Low Incident Response

    ## Emergency Actions
    1. Identify largest volumes: `kubectl get volumes.longhorn.io -n longhorn-system --sort-by=.spec.size`
    2. Check for unnecessary snapshots or backups
    3. Consider temporary volume expansion if possible

    ## Resolution Steps
    1. Clean up old snapshots and backups
    2. Add additional disk space to node
    3. Rebalance replicas across nodes
    4. Implement automated cleanup policies

---
apiVersion: v1
kind: ConfigMap
metadata:
  name: longhorn-upgrade-notifications
  namespace: longhorn-system
data:
  webhook-config.yaml: |
    webhooks:
      slack:
        url: "https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK"
        channel: "#storage-alerts"
        username: "Longhorn Monitor"

      teams:
        url: "https://company.webhook.office.com/webhookb2/YOUR/TEAMS/WEBHOOK"

      email:
        smtp_server: "smtp.company.com"
        from: "alerts@company.com"
        to: ["storage-team@company.com", "oncall@company.com"]

  notification-script.sh: |
    #!/bin/bash
    # Notification script for Longhorn events

    send_notification() {
      local level="$1"
      local title="$2"
      local message="$3"

      # Slack notification
      curl -X POST \
        -H 'Content-type: application/json' \
        --data "{\"channel\":\"#storage-alerts\",\"username\":\"Longhorn Monitor\",\"text\":\"[$level] $title\",\"attachments\":[{\"color\":\"danger\",\"text\":\"$message\"}]}" \
        "$SLACK_WEBHOOK_URL"

      # Email notification for critical alerts
      if [[ "$level" == "CRITICAL" ]]; then
        echo "$message" | mail -s "[$level] Longhorn Storage Alert: $title" storage-team@company.com
      fi
    }

    # Usage examples:
    # send_notification "WARNING" "Volume Unhealthy" "Volume pvc-12345 is degraded"
    # send_notification "CRITICAL" "Node Down" "Storage node worker-3 is unreachable"
```

## Conclusion

Kubernetes Longhorn storage upgrade incidents require comprehensive preparation, systematic investigation, and well-orchestrated recovery procedures that prioritize data protection and service continuity. By implementing the strategies, tools, and procedures outlined in this guide, platform engineering teams can effectively manage complex storage upgrade scenarios while minimizing business impact.

The key to successful incident response lies in preparation through pre-upgrade assessments, systematic investigation using structured methodologies, and implementing automated recovery procedures that can quickly restore service functionality. Regular testing of these procedures, comprehensive monitoring, and continuous improvement based on incident learnings ensure your storage infrastructure remains reliable and resilient.

As Kubernetes storage systems continue to evolve in complexity and scale, maintaining robust incident response capabilities becomes increasingly critical for ensuring enterprise-grade reliability and maintaining customer trust in production environments.