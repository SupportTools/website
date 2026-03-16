---
title: "Kubernetes DaemonSet Scheduling Troubleshooting: Production Debugging and Node Management Guide"
date: 2026-08-24T00:00:00-05:00
draft: false
tags: ["Kubernetes", "DaemonSet", "Troubleshooting", "Node Management", "Scheduling", "Production", "Debugging"]
categories: ["Kubernetes", "Troubleshooting", "Infrastructure"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Master Kubernetes DaemonSet scheduling troubleshooting with comprehensive debugging methodologies, node readiness analysis, and production-ready resolution strategies for complex scheduling issues."
more_link: "yes"
url: "/kubernetes-daemonset-scheduling-troubleshooting-production-debugging-guide/"
---

Kubernetes DaemonSet scheduling issues represent some of the most challenging troubleshooting scenarios in production environments, where critical system components fail to deploy across cluster nodes as expected. These issues can cascade into broader infrastructure problems, affecting monitoring, logging, storage, and networking capabilities that underpin entire application ecosystems.

Understanding how to systematically diagnose and resolve DaemonSet scheduling problems requires deep knowledge of Kubernetes scheduling mechanics, node conditions, taints and tolerations, and cluster networking. This comprehensive guide explores advanced troubleshooting methodologies based on real-world production scenarios and provides actionable solutions for complex scheduling challenges.

<!--more-->

## Executive Summary

Kubernetes DaemonSet scheduling failures require systematic troubleshooting approaches that examine node conditions, scheduling constraints, resource availability, and cluster configuration issues. This guide provides comprehensive methodologies for diagnosing complex scheduling problems, implementing automated resolution strategies, and building robust monitoring systems that prevent DaemonSet-related production incidents.

## Understanding DaemonSet Scheduling Architecture

### DaemonSet Controller Mechanics

DaemonSets operate through sophisticated scheduling logic that must account for numerous factors:

```yaml
# Comprehensive DaemonSet scheduling analysis configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: daemonset-scheduling-analysis
  namespace: kube-system
data:
  scheduling-factors.yaml: |
    daemonset_scheduling_requirements:
      node_selection:
        - "Node must be in Ready state"
        - "Node must not have SchedulingDisabled condition"
        - "Node taints must be tolerated by DaemonSet"
        - "NodeSelector requirements must be satisfied"

      resource_requirements:
        - "Sufficient CPU resources available"
        - "Sufficient memory resources available"
        - "Required volumes can be mounted"
        - "Host ports are available if specified"

      network_requirements:
        - "CNI plugin operational on node"
        - "Pod CIDR allocation available"
        - "Host networking accessible if required"

      security_constraints:
        - "Pod Security Standards compliance"
        - "Service Account permissions"
        - "SecurityContext requirements met"
        - "Admission controller approvals"

    common_scheduling_failures:
      node_not_ready:
        symptoms:
          - "Pods remain in Pending state"
          - "desiredNumberScheduled < number of nodes"
          - "Node shows NotReady condition"
        causes:
          - "Kubelet not running or unhealthy"
          - "Container runtime issues"
          - "Network connectivity problems"

      taints_not_tolerated:
        symptoms:
          - "Pods not scheduled on specific nodes"
          - "Event shows FailedScheduling due to taints"
          - "desiredNumberScheduled excludes tainted nodes"
        causes:
          - "Node initialization taints not removed"
          - "Cloud provider taints present"
          - "Custom taints blocking scheduling"

      resource_constraints:
        symptoms:
          - "Pods in Pending state with resource warnings"
          - "Events show Insufficient resources"
          - "Node pressure conditions present"
        causes:
          - "CPU or memory limits exceeded"
          - "Disk pressure on nodes"
          - "Pod limit per node reached"

      node_selector_mismatch:
        symptoms:
          - "Pods not scheduled on any nodes"
          - "No events or warnings generated"
          - "DaemonSet shows 0 desired pods"
        causes:
          - "NodeSelector labels not present on nodes"
          - "Label selectors too restrictive"
          - "Node labels changed after DaemonSet creation"

---
# DaemonSet troubleshooting toolkit
apiVersion: v1
kind: ConfigMap
metadata:
  name: daemonset-troubleshooting-tools
  namespace: kube-system
data:
  diagnostic-commands.yaml: |
    basic_checks:
      - name: "Check DaemonSet status"
        command: "kubectl get daemonset -A -o wide"
        description: "Overview of all DaemonSets and their scheduling status"

      - name: "Describe problematic DaemonSet"
        command: "kubectl describe daemonset <daemonset-name> -n <namespace>"
        description: "Detailed information including events and conditions"

      - name: "Check node status"
        command: "kubectl get nodes -o wide"
        description: "Node readiness and basic information"

      - name: "Check node conditions"
        command: "kubectl describe nodes"
        description: "Detailed node conditions and resource usage"

    advanced_diagnostics:
      - name: "Check node taints"
        command: "kubectl get nodes -o json | jq '.items[] | {name: .metadata.name, taints: .spec.taints}'"
        description: "Identify taints that might prevent scheduling"

      - name: "Check DaemonSet tolerations"
        command: "kubectl get daemonset <name> -o json | jq '.spec.template.spec.tolerations'"
        description: "Verify DaemonSet tolerations match node taints"

      - name: "Check node labels"
        command: "kubectl get nodes --show-labels"
        description: "Verify node labels for NodeSelector requirements"

      - name: "Check pod resource requests"
        command: "kubectl get daemonset <name> -o json | jq '.spec.template.spec.containers[].resources'"
        description: "Analyze resource requirements vs node capacity"

    event_analysis:
      - name: "Check recent cluster events"
        command: "kubectl get events --sort-by='.lastTimestamp' -A"
        description: "Recent events that might indicate scheduling issues"

      - name: "Filter DaemonSet-related events"
        command: "kubectl get events --field-selector involvedObject.kind=DaemonSet -A"
        description: "Events specifically related to DaemonSet operations"

      - name: "Check node events"
        command: "kubectl get events --field-selector involvedObject.kind=Node -A"
        description: "Node-related events that might affect scheduling"

    scheduler_diagnostics:
      - name: "Check scheduler logs"
        command: "kubectl logs -n kube-system -l component=kube-scheduler"
        description: "Scheduler decision logs for troubleshooting"

      - name: "Check kubelet logs on problematic nodes"
        command: "journalctl -u kubelet -f"
        description: "Kubelet logs on nodes where pods aren't scheduling"
```

### Advanced Diagnostic Framework

Implement comprehensive diagnostic automation for DaemonSet issues:

```bash
#!/bin/bash
# Script: daemonset-diagnostics.sh
# Purpose: Comprehensive DaemonSet scheduling diagnostics

set -euo pipefail

# Configuration
DIAGNOSTIC_LOG="/var/log/daemonset-diagnostics-$(date +%Y%m%d_%H%M%S).log"
DIAGNOSTIC_REPORT="/tmp/daemonset-diagnostic-report-$(date +%Y%m%d_%H%M%S).json"

function log_diagnostic() {
    local level="$1"
    local message="$2"
    local timestamp=$(date -u +"%Y-%m-%d %H:%M:%S UTC")

    echo "[$timestamp] [$level] $message" | tee -a "$DIAGNOSTIC_LOG"
}

function analyze_cluster_state() {
    log_diagnostic "INFO" "Analyzing cluster state for DaemonSet scheduling"

    # Get basic cluster information
    local cluster_info=$(kubectl cluster-info 2>/dev/null | head -5)
    local k8s_version=$(kubectl version -o json 2>/dev/null | jq -r '.serverVersion.gitVersion' || echo "unknown")
    local node_count=$(kubectl get nodes --no-headers | wc -l)

    log_diagnostic "INFO" "Cluster: $k8s_version, Nodes: $node_count"

    # Check overall node health
    local ready_nodes=$(kubectl get nodes -o json | jq '[.items[] | select(.status.conditions[] | select(.type=="Ready" and .status=="True"))] | length')
    local not_ready_nodes=$((node_count - ready_nodes))

    if [[ $not_ready_nodes -gt 0 ]]; then
        log_diagnostic "WARN" "$not_ready_nodes nodes are not ready"
        kubectl get nodes | grep -v " Ready "
    fi

    # Check for node pressure conditions
    local nodes_with_pressure=$(kubectl get nodes -o json | jq -r '.items[] | select(.status.conditions[] | select(.type | test("Pressure$") and .status=="True")) | .metadata.name')

    if [[ -n "$nodes_with_pressure" ]]; then
        log_diagnostic "WARN" "Nodes with pressure conditions detected"
        for node in $nodes_with_pressure; do
            log_diagnostic "WARN" "Node $node has resource pressure"
        done
    fi

    log_diagnostic "INFO" "Cluster state analysis completed"
}

function analyze_daemonset_status() {
    local namespace="${1:-}"
    local daemonset_name="${2:-}"

    log_diagnostic "INFO" "Analyzing DaemonSet status"

    # Get all DaemonSets if not specified
    if [[ -z "$namespace" || -z "$daemonset_name" ]]; then
        log_diagnostic "INFO" "Analyzing all DaemonSets in cluster"

        # Get DaemonSet summary
        kubectl get daemonset -A -o json | jq -r '
          .items[] |
          "\(.metadata.namespace)/\(.metadata.name): \(.status.desiredNumberScheduled)/\(.status.numberReady) ready"
        ' | while read -r ds_info; do
            log_diagnostic "INFO" "DaemonSet status: $ds_info"
        done

        # Find problematic DaemonSets
        local problematic_ds=$(kubectl get daemonset -A -o json | jq -r '
          .items[] |
          select(.status.desiredNumberScheduled != .status.numberReady) |
          "\(.metadata.namespace),\(.metadata.name)"
        ')

        if [[ -n "$problematic_ds" ]]; then
            log_diagnostic "WARN" "Found DaemonSets with scheduling issues"
            echo "$problematic_ds" | while IFS=',' read -r ns name; do
                analyze_specific_daemonset "$ns" "$name"
            done
        fi
    else
        analyze_specific_daemonset "$namespace" "$daemonset_name"
    fi
}

function analyze_specific_daemonset() {
    local namespace="$1"
    local daemonset_name="$2"

    log_diagnostic "INFO" "Analyzing DaemonSet: $namespace/$daemonset_name"

    # Get DaemonSet details
    local ds_json=$(kubectl get daemonset "$daemonset_name" -n "$namespace" -o json)

    local desired=$(echo "$ds_json" | jq -r '.status.desiredNumberScheduled // 0')
    local ready=$(echo "$ds_json" | jq -r '.status.numberReady // 0')
    local available=$(echo "$ds_json" | jq -r '.status.numberAvailable // 0')
    local unavailable=$(echo "$ds_json" | jq -r '.status.numberUnavailable // 0')

    log_diagnostic "INFO" "DaemonSet $namespace/$daemonset_name: $ready/$desired ready, $unavailable unavailable"

    # Check tolerations
    local tolerations=$(echo "$ds_json" | jq -r '.spec.template.spec.tolerations // []')
    log_diagnostic "INFO" "DaemonSet tolerations: $(echo "$tolerations" | jq -c .)"

    # Check node selector
    local node_selector=$(echo "$ds_json" | jq -r '.spec.template.spec.nodeSelector // {}')
    log_diagnostic "INFO" "DaemonSet nodeSelector: $(echo "$node_selector" | jq -c .)"

    # Get DaemonSet events
    local ds_events=$(kubectl get events -n "$namespace" --field-selector involvedObject.name="$daemonset_name" --sort-by=.lastTimestamp 2>/dev/null || echo "")

    if [[ -n "$ds_events" ]]; then
        log_diagnostic "INFO" "Recent events for DaemonSet $namespace/$daemonset_name:"
        echo "$ds_events" | tail -5
    fi

    # Check pod status
    log_diagnostic "INFO" "Analyzing pods for DaemonSet $namespace/$daemonset_name"

    local pods=$(kubectl get pods -n "$namespace" -l "$(kubectl get daemonset "$daemonset_name" -n "$namespace" -o jsonpath='{.spec.selector.matchLabels}' | jq -r 'to_entries | map("\(.key)=\(.value)") | join(",")')" -o json)

    echo "$pods" | jq -r '.items[] | "\(.metadata.name): \(.status.phase) on \(.spec.nodeName // "unscheduled")"' | while read -r pod_info; do
        log_diagnostic "INFO" "Pod status: $pod_info"
    done

    # Identify nodes without pods
    identify_missing_pod_nodes "$namespace" "$daemonset_name" "$ds_json"
}

function identify_missing_pod_nodes() {
    local namespace="$1"
    local daemonset_name="$2"
    local ds_json="$3"

    log_diagnostic "INFO" "Identifying nodes missing DaemonSet pods"

    # Get all nodes
    local all_nodes=$(kubectl get nodes -o json | jq -r '.items[] | .metadata.name')

    # Get nodes with pods
    local nodes_with_pods=$(kubectl get pods -n "$namespace" -l "$(echo "$ds_json" | jq -r '.spec.selector.matchLabels | to_entries | map("\(.key)=\(.value)") | join(",")')" -o json | jq -r '.items[] | select(.spec.nodeName) | .spec.nodeName' | sort -u)

    # Find missing nodes
    local missing_nodes=""
    for node in $all_nodes; do
        if ! echo "$nodes_with_pods" | grep -q "^$node$"; then
            missing_nodes="$missing_nodes $node"
        fi
    done

    if [[ -n "$missing_nodes" ]]; then
        log_diagnostic "WARN" "Nodes without DaemonSet pods: $missing_nodes"

        for node in $missing_nodes; do
            analyze_node_scheduling_constraints "$node" "$ds_json"
        done
    else
        log_diagnostic "INFO" "All eligible nodes have DaemonSet pods"
    fi
}

function analyze_node_scheduling_constraints() {
    local node_name="$1"
    local ds_json="$2"

    log_diagnostic "INFO" "Analyzing scheduling constraints for node: $node_name"

    # Get node information
    local node_json=$(kubectl get node "$node_name" -o json)

    # Check node readiness
    local node_ready=$(echo "$node_json" | jq -r '.status.conditions[] | select(.type=="Ready") | .status')
    if [[ "$node_ready" != "True" ]]; then
        log_diagnostic "ERROR" "Node $node_name is not ready: $node_ready"
        return 1
    fi

    # Check node scheduling
    local unschedulable=$(echo "$node_json" | jq -r '.spec.unschedulable // false')
    if [[ "$unschedulable" == "true" ]]; then
        log_diagnostic "ERROR" "Node $node_name is marked as unschedulable"
        return 1
    fi

    # Check taints vs tolerations
    local node_taints=$(echo "$node_json" | jq -r '.spec.taints // []')
    local ds_tolerations=$(echo "$ds_json" | jq -r '.spec.template.spec.tolerations // []')

    if [[ "$node_taints" != "[]" ]]; then
        log_diagnostic "INFO" "Node $node_name has taints: $(echo "$node_taints" | jq -c .)"

        # Check if DaemonSet tolerates all taints
        local taint_check_result=$(check_taint_toleration "$node_taints" "$ds_tolerations")

        if [[ "$taint_check_result" != "ok" ]]; then
            log_diagnostic "ERROR" "DaemonSet cannot tolerate node taints: $taint_check_result"
            return 1
        fi
    fi

    # Check node selector
    local node_selector=$(echo "$ds_json" | jq -r '.spec.template.spec.nodeSelector // {}')
    if [[ "$node_selector" != "{}" ]]; then
        local node_labels=$(echo "$node_json" | jq -r '.metadata.labels')

        local selector_check=$(check_node_selector_match "$node_labels" "$node_selector")

        if [[ "$selector_check" != "ok" ]]; then
            log_diagnostic "ERROR" "Node $node_name does not match nodeSelector: $selector_check"
            return 1
        fi
    fi

    # Check resource availability
    check_node_resource_availability "$node_name" "$ds_json"

    log_diagnostic "INFO" "Node $node_name constraints analysis completed"
}

function check_taint_toleration() {
    local node_taints="$1"
    local ds_tolerations="$2"

    # Use kubectl to simulate scheduling decision
    local temp_pod=$(mktemp)

    cat > "$temp_pod" <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: taint-test-pod
spec:
  tolerations: $(echo "$ds_tolerations")
  containers:
  - name: test
    image: alpine:latest
    command: ["sleep", "3600"]
  nodeSelector:
    kubernetes.io/hostname: "$node_name"
EOF

    # Test if pod would be scheduled
    if kubectl apply --dry-run=server -f "$temp_pod" >/dev/null 2>&1; then
        rm -f "$temp_pod"
        echo "ok"
    else
        rm -f "$temp_pod"
        echo "taint_toleration_mismatch"
    fi
}

function check_node_selector_match() {
    local node_labels="$1"
    local node_selector="$2"

    # Check each selector requirement
    echo "$node_selector" | jq -r 'to_entries[] | "\(.key)=\(.value)"' | while read -r requirement; do
        local key="${requirement%%=*}"
        local value="${requirement##*=}"

        local node_value=$(echo "$node_labels" | jq -r --arg key "$key" '.[$key] // "not_found"')

        if [[ "$node_value" != "$value" ]]; then
            echo "selector_mismatch_${key}"
            return 1
        fi
    done

    echo "ok"
}

function check_node_resource_availability() {
    local node_name="$1"
    local ds_json="$2"

    log_diagnostic "INFO" "Checking resource availability on node: $node_name"

    # Get node capacity and allocatable resources
    local node_capacity=$(kubectl describe node "$node_name" | grep -A 10 "Capacity:" | grep -E "(cpu|memory)" | awk '{print $1 $2}')
    local node_allocatable=$(kubectl describe node "$node_name" | grep -A 10 "Allocatable:" | grep -E "(cpu|memory)" | awk '{print $1 $2}')

    log_diagnostic "INFO" "Node $node_name capacity: $node_capacity"
    log_diagnostic "INFO" "Node $node_name allocatable: $node_allocatable"

    # Get DaemonSet resource requests
    local ds_resources=$(echo "$ds_json" | jq -r '.spec.template.spec.containers[] | .resources.requests // {}')

    if [[ "$ds_resources" != "{}" ]]; then
        log_diagnostic "INFO" "DaemonSet resource requests: $(echo "$ds_resources" | jq -c .)"

        # Check if resources can be satisfied (basic check)
        local cpu_request=$(echo "$ds_resources" | jq -r '.cpu // "0"')
        local memory_request=$(echo "$ds_resources" | jq -r '.memory // "0"')

        if [[ "$cpu_request" != "0" || "$memory_request" != "0" ]]; then
            log_diagnostic "INFO" "DaemonSet requests: CPU=$cpu_request, Memory=$memory_request"
        fi
    fi
}

function generate_resolution_suggestions() {
    local namespace="$1"
    local daemonset_name="$2"

    log_diagnostic "INFO" "Generating resolution suggestions for $namespace/$daemonset_name"

    # Get DaemonSet and node information
    local ds_json=$(kubectl get daemonset "$daemonset_name" -n "$namespace" -o json)
    local nodes_json=$(kubectl get nodes -o json)

    # Common resolution strategies
    cat <<EOF

🔧 Resolution Suggestions for DaemonSet $namespace/$daemonset_name:

1. Node Taint Issues:
   - Check for unexpected taints: kubectl get nodes -o json | jq '.items[] | {name: .metadata.name, taints: .spec.taints}'
   - Remove problematic taints: kubectl taint node <node-name> <taint-key>-
   - Add tolerations to DaemonSet if taints are intentional

2. Node Selector Issues:
   - Verify node labels: kubectl get nodes --show-labels
   - Update node labels: kubectl label node <node-name> <key>=<value>
   - Modify DaemonSet nodeSelector if too restrictive

3. Resource Constraints:
   - Check node resource usage: kubectl describe nodes
   - Reduce DaemonSet resource requests if possible
   - Add nodes with sufficient resources

4. Node Readiness Issues:
   - Check kubelet status: systemctl status kubelet
   - Check container runtime: systemctl status docker/containerd
   - Review kubelet logs: journalctl -u kubelet -f

5. Network Issues:
   - Verify CNI plugin status on problematic nodes
   - Check pod CIDR allocation
   - Test network connectivity between nodes

EOF

    log_diagnostic "INFO" "Resolution suggestions generated"
}

function create_diagnostic_report() {
    local namespace="${1:-all}"
    local daemonset_name="${2:-all}"

    log_diagnostic "INFO" "Creating comprehensive diagnostic report"

    cat > "$DIAGNOSTIC_REPORT" <<EOF
{
  "diagnostic_info": {
    "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "cluster_context": "$(kubectl config current-context)",
    "kubernetes_version": "$(kubectl version -o json 2>/dev/null | jq -r '.serverVersion.gitVersion' || echo 'unknown')",
    "target_namespace": "$namespace",
    "target_daemonset": "$daemonset_name"
  },
  "cluster_summary": {
    "total_nodes": $(kubectl get nodes --no-headers | wc -l),
    "ready_nodes": $(kubectl get nodes -o json | jq '[.items[] | select(.status.conditions[] | select(.type=="Ready" and .status=="True"))] | length'),
    "total_daemonsets": $(kubectl get daemonset -A --no-headers | wc -l),
    "problematic_daemonsets": $(kubectl get daemonset -A -o json | jq '[.items[] | select(.status.desiredNumberScheduled != .status.numberReady)] | length')
  },
  "detailed_analysis": "See diagnostic log: $DIAGNOSTIC_LOG",
  "recommendations": [
    "Review node taints and DaemonSet tolerations",
    "Verify node readiness and resource availability",
    "Check cluster events for scheduling failures",
    "Validate network connectivity and CNI status"
  ]
}
EOF

    log_diagnostic "INFO" "Diagnostic report created: $DIAGNOSTIC_REPORT"
    cat "$DIAGNOSTIC_REPORT" | jq .
}

function run_automated_fixes() {
    local namespace="$1"
    local daemonset_name="$2"

    log_diagnostic "INFO" "Running automated fixes for common DaemonSet issues"

    # Fix 1: Remove common problematic taints
    local problematic_taints=(
        "node.cloudprovider.kubernetes.io/uninitialized"
        "node.kubernetes.io/not-ready"
        "node.kubernetes.io/unreachable"
    )

    for taint in "${problematic_taints[@]}"; do
        local nodes_with_taint=$(kubectl get nodes -o json | jq -r --arg taint "$taint" '.items[] | select(.spec.taints[]? | select(.key == $taint)) | .metadata.name')

        for node in $nodes_with_taint; do
            log_diagnostic "INFO" "Attempting to remove taint $taint from node $node"

            # Check if taint should be automatically removed
            if [[ "$taint" == "node.cloudprovider.kubernetes.io/uninitialized" ]]; then
                local node_ready=$(kubectl get node "$node" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')
                if [[ "$node_ready" == "True" ]]; then
                    log_diagnostic "INFO" "Removing initialization taint from ready node $node"
                    kubectl taint node "$node" "$taint:NoSchedule-" || true
                fi
            fi
        done
    done

    # Fix 2: Restart DaemonSet if needed
    log_diagnostic "INFO" "Restarting DaemonSet to trigger rescheduling"
    kubectl rollout restart daemonset "$daemonset_name" -n "$namespace" || true

    # Fix 3: Wait and re-check
    sleep 30

    log_diagnostic "INFO" "Automated fixes completed, re-checking status"
    analyze_specific_daemonset "$namespace" "$daemonset_name"
}

# Main diagnostic workflow
function run_comprehensive_diagnostics() {
    local namespace="${1:-}"
    local daemonset_name="${2:-}"

    log_diagnostic "INFO" "Starting comprehensive DaemonSet diagnostics"

    analyze_cluster_state
    analyze_daemonset_status "$namespace" "$daemonset_name"

    if [[ -n "$namespace" && -n "$daemonset_name" ]]; then
        generate_resolution_suggestions "$namespace" "$daemonset_name"
    fi

    create_diagnostic_report "$namespace" "$daemonset_name"

    log_diagnostic "INFO" "Comprehensive diagnostics completed"

    echo ""
    echo "🔍 Diagnostic Summary"
    echo "===================="
    echo "📄 Diagnostic log: $DIAGNOSTIC_LOG"
    echo "📊 Diagnostic report: $DIAGNOSTIC_REPORT"
    echo ""
    echo "Next steps:"
    echo "1. Review detailed diagnostic log"
    echo "2. Apply suggested resolutions"
    echo "3. Monitor DaemonSet status after changes"
}

# Execution
case "${1:-help}" in
    "diagnose")
        run_comprehensive_diagnostics "${2:-}" "${3:-}"
        ;;
    "cluster")
        analyze_cluster_state
        ;;
    "daemonset")
        if [[ -n "${2:-}" && -n "${3:-}" ]]; then
            analyze_specific_daemonset "$2" "$3"
        else
            analyze_daemonset_status
        fi
        ;;
    "fix")
        if [[ -n "${2:-}" && -n "${3:-}" ]]; then
            run_automated_fixes "$2" "$3"
        else
            echo "Usage: $0 fix <namespace> <daemonset-name>"
        fi
        ;;
    "report")
        create_diagnostic_report "${2:-all}" "${3:-all}"
        ;;
    *)
        echo "Kubernetes DaemonSet Diagnostics Tool"
        echo "===================================="
        echo ""
        echo "Usage: $0 {diagnose|cluster|daemonset|fix|report} [namespace] [daemonset-name]"
        echo ""
        echo "Commands:"
        echo "  diagnose [ns] [ds]    - Run comprehensive diagnostics"
        echo "  cluster               - Analyze cluster state"
        echo "  daemonset [ns] [ds]   - Analyze specific DaemonSet"
        echo "  fix <ns> <ds>         - Apply automated fixes"
        echo "  report [ns] [ds]      - Generate diagnostic report"
        ;;
esac
```

## Advanced Monitoring and Prevention Strategies

### Proactive DaemonSet Health Monitoring

Implement comprehensive monitoring systems to prevent DaemonSet scheduling issues:

```yaml
# Advanced DaemonSet monitoring configuration
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: daemonset-scheduling-alerts
  namespace: kube-system
  labels:
    app: daemonset-monitoring
spec:
  groups:
  - name: daemonset.scheduling
    rules:
    - alert: DaemonSetPodsNotScheduled
      expr: |
        (
          kube_daemonset_status_desired_number_scheduled
          -
          kube_daemonset_status_number_ready
        ) > 0
      for: 5m
      labels:
        severity: warning
        component: scheduling
      annotations:
        summary: "DaemonSet {{ $labels.namespace }}/{{ $labels.daemonset }} has unscheduled pods"
        description: "DaemonSet {{ $labels.namespace }}/{{ $labels.daemonset }} has {{ $value }} pods that are not scheduled on nodes for more than 5 minutes"
        runbook_url: "https://runbooks.company.com/daemonset-scheduling"

    - alert: DaemonSetSchedulingStuck
      expr: |
        (
          kube_daemonset_status_desired_number_scheduled
          -
          kube_daemonset_status_number_ready
        ) > 0
      for: 30m
      labels:
        severity: critical
        component: scheduling
      annotations:
        summary: "DaemonSet scheduling stuck for {{ $labels.namespace }}/{{ $labels.daemonset }}"
        description: "DaemonSet {{ $labels.namespace }}/{{ $labels.daemonset }} has been unable to schedule pods for more than 30 minutes"

    - alert: NodeWithoutDaemonSetPods
      expr: |
        (
          count by (node) (kube_node_info{node=~".+"})
          unless
          count by (node) (kube_pod_info{created_by_kind="DaemonSet", node=~".+"})
        ) > 0
      for: 10m
      labels:
        severity: warning
        component: scheduling
      annotations:
        summary: "Node {{ $labels.node }} missing DaemonSet pods"
        description: "Node {{ $labels.node }} does not have any DaemonSet pods scheduled"

    - alert: DaemonSetUpdateStuck
      expr: |
        (
          kube_daemonset_status_desired_number_scheduled
          -
          kube_daemonset_status_updated_number_scheduled
        ) > 0
      for: 15m
      labels:
        severity: warning
        component: rollout
      annotations:
        summary: "DaemonSet update stuck for {{ $labels.namespace }}/{{ $labels.daemonset }}"
        description: "DaemonSet {{ $labels.namespace }}/{{ $labels.daemonset }} update has been stuck for more than 15 minutes"

---
# Automated DaemonSet health checker
apiVersion: batch/v1
kind: CronJob
metadata:
  name: daemonset-health-checker
  namespace: kube-system
spec:
  schedule: "*/5 * * * *"  # Every 5 minutes
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          serviceAccount: daemonset-health-checker
          containers:
          - name: health-checker
            image: bitnami/kubectl:latest
            command: ["/bin/bash"]
            args:
            - -c
            - |
              set -euo pipefail

              echo "🔍 Starting DaemonSet health check"

              # Check all DaemonSets
              daemonsets=$(kubectl get daemonset -A -o json)

              # Find DaemonSets with scheduling issues
              problematic_ds=$(echo "$daemonsets" | jq -r '
                .items[] |
                select(.status.desiredNumberScheduled != .status.numberReady) |
                "\(.metadata.namespace),\(.metadata.name),\(.status.desiredNumberScheduled),\(.status.numberReady)"
              ')

              if [[ -n "$problematic_ds" ]]; then
                echo "⚠️  Found DaemonSets with scheduling issues:"
                echo "$problematic_ds" | while IFS=',' read -r namespace name desired ready; do
                  echo "  $namespace/$name: $ready/$desired ready"

                  # Check for common issues
                  # 1. Node taints
                  nodes_with_init_taint=$(kubectl get nodes -o json | jq -r '
                    .items[] |
                    select(.spec.taints[]? | select(.key == "node.cloudprovider.kubernetes.io/uninitialized")) |
                    .metadata.name
                  ')

                  if [[ -n "$nodes_with_init_taint" ]]; then
                    echo "    Found nodes with initialization taint: $nodes_with_init_taint"

                    for node in $nodes_with_init_taint; do
                      node_ready=$(kubectl get node "$node" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')
                      if [[ "$node_ready" == "True" ]]; then
                        echo "    Auto-removing initialization taint from ready node: $node"
                        kubectl taint node "$node" "node.cloudprovider.kubernetes.io/uninitialized:NoSchedule-" || echo "    Failed to remove taint"
                      fi
                    done
                  fi

                  # 2. Check for not ready nodes
                  not_ready_nodes=$(kubectl get nodes -o json | jq -r '
                    .items[] |
                    select(.status.conditions[] | select(.type=="Ready" and .status!="True")) |
                    .metadata.name
                  ')

                  if [[ -n "$not_ready_nodes" ]]; then
                    echo "    Found not ready nodes: $not_ready_nodes"
                  fi
                done
              else
                echo "✅ All DaemonSets are healthy"
              fi

              echo "🔍 DaemonSet health check completed"

---
# DaemonSet troubleshooting dashboard
apiVersion: v1
kind: ConfigMap
metadata:
  name: daemonset-troubleshooting-dashboard
  namespace: kube-system
data:
  dashboard.json: |
    {
      "dashboard": {
        "title": "DaemonSet Scheduling Health",
        "panels": [
          {
            "title": "DaemonSet Status Overview",
            "type": "stat",
            "targets": [
              {
                "expr": "kube_daemonset_status_desired_number_scheduled",
                "legendFormat": "Desired Pods"
              },
              {
                "expr": "kube_daemonset_status_number_ready",
                "legendFormat": "Ready Pods"
              }
            ]
          },
          {
            "title": "Scheduling Success Rate",
            "type": "gauge",
            "targets": [
              {
                "expr": "kube_daemonset_status_number_ready / kube_daemonset_status_desired_number_scheduled * 100",
                "legendFormat": "Success Rate %"
              }
            ]
          },
          {
            "title": "DaemonSet Pods per Node",
            "type": "heatmap",
            "targets": [
              {
                "expr": "count by (node) (kube_pod_info{created_by_kind=\"DaemonSet\"})",
                "legendFormat": "{{ node }}"
              }
            ]
          },
          {
            "title": "Node Taints",
            "type": "table",
            "targets": [
              {
                "expr": "kube_node_spec_taint",
                "legendFormat": "{{ node }} - {{ key }}"
              }
            ]
          },
          {
            "title": "Recent Scheduling Events",
            "type": "logs",
            "targets": [
              {
                "expr": "kube_pod_container_status_waiting_reason{reason=~\".*Scheduling.*|.*Taint.*\"}",
                "legendFormat": "Scheduling Issues"
              }
            ]
          }
        ]
      }
    }

---
# Automated recovery system
apiVersion: apps/v1
kind: Deployment
metadata:
  name: daemonset-recovery-controller
  namespace: kube-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app: daemonset-recovery-controller
  template:
    metadata:
      labels:
        app: daemonset-recovery-controller
    spec:
      serviceAccount: daemonset-recovery-controller
      containers:
      - name: controller
        image: bitnami/kubectl:latest
        command: ["/bin/bash"]
        args:
        - -c
        - |
          set -euo pipefail

          echo "🤖 Starting DaemonSet recovery controller"

          while true; do
            echo "Checking for DaemonSet issues..."

            # Find DaemonSets with persistent scheduling issues
            problematic_ds=$(kubectl get daemonset -A -o json | jq -r '
              .items[] |
              select(
                .status.desiredNumberScheduled != .status.numberReady and
                (.metadata.labels["recovery.disabled"] // "false") != "true"
              ) |
              "\(.metadata.namespace),\(.metadata.name)"
            ')

            if [[ -n "$problematic_ds" ]]; then
              echo "Found problematic DaemonSets, initiating recovery..."

              echo "$problematic_ds" | while IFS=',' read -r namespace name; do
                echo "Processing DaemonSet: $namespace/$name"

                # Apply common fixes
                # 1. Remove initialization taints from ready nodes
                ready_nodes_with_init_taint=$(kubectl get nodes -o json | jq -r '
                  .items[] |
                  select(
                    (.spec.taints[]? | select(.key == "node.cloudprovider.kubernetes.io/uninitialized")) and
                    (.status.conditions[] | select(.type=="Ready" and .status=="True"))
                  ) |
                  .metadata.name
                ')

                for node in $ready_nodes_with_init_taint; do
                  echo "Removing initialization taint from node: $node"
                  kubectl taint node "$node" "node.cloudprovider.kubernetes.io/uninitialized:NoSchedule-" || echo "Failed to remove taint"
                done

                # 2. Restart DaemonSet if no progress for extended time
                last_update=$(kubectl get daemonset "$name" -n "$namespace" -o jsonpath='{.status.observedGeneration}' || echo "0")
                creation_time=$(kubectl get daemonset "$name" -n "$namespace" -o jsonpath='{.metadata.creationTimestamp}')

                # Simple restart trigger (can be enhanced with more sophisticated logic)
                echo "Triggering DaemonSet restart for: $namespace/$name"
                kubectl patch daemonset "$name" -n "$namespace" -p '{"spec":{"template":{"metadata":{"annotations":{"kubectl.kubernetes.io/restartedAt":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}}}}}'

                # 3. Add annotation to prevent immediate re-processing
                kubectl annotate daemonset "$name" -n "$namespace" \
                  "recovery.processed=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
                  --overwrite

                sleep 10
              done
            else
              echo "All DaemonSets appear healthy"
            fi

            # Wait before next check
            sleep 300  # 5 minutes
          done
```

## Enterprise Integration and Compliance

### Comprehensive Audit and Compliance Framework

Implement enterprise-grade audit and compliance for DaemonSet operations:

```yaml
# DaemonSet compliance and audit configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: daemonset-compliance-config
  namespace: kube-system
data:
  compliance-requirements.yaml: |
    security_requirements:
      pod_security_standards:
        - "All DaemonSets must comply with restricted PSS"
        - "Security contexts must be properly configured"
        - "Non-root containers required where possible"

      network_security:
        - "Network policies must be defined for DaemonSet pods"
        - "Host networking limited to essential components"
        - "Port access restricted to necessary services"

      resource_management:
        - "Resource requests and limits must be specified"
        - "QoS class must be appropriate for workload"
        - "Node resource consumption monitored"

    operational_requirements:
      scheduling_constraints:
        - "Critical DaemonSets must tolerate all node taints"
        - "Node selectors must be justified and documented"
        - "Scheduling policies must prevent resource conflicts"

      lifecycle_management:
        - "Rolling update strategies must be configured"
        - "Health checks must be implemented"
        - "Graceful termination must be supported"

      monitoring_requirements:
        - "Resource usage must be monitored"
        - "Scheduling health must be tracked"
        - "Performance metrics must be collected"

---
# Automated compliance checker
apiVersion: batch/v1
kind: CronJob
metadata:
  name: daemonset-compliance-checker
  namespace: kube-system
spec:
  schedule: "0 6 * * *"  # Daily at 6 AM
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          serviceAccount: daemonset-compliance-checker
          containers:
          - name: compliance-checker
            image: bitnami/kubectl:latest
            command: ["/bin/bash"]
            args:
            - -c
            - |
              set -euo pipefail

              echo "🔍 Starting DaemonSet compliance check"

              compliance_report="/tmp/daemonset-compliance-$(date +%Y%m%d).json"

              # Initialize report
              cat > "$compliance_report" <<EOF
              {
                "report_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
                "cluster": "$(kubectl config current-context)",
                "compliance_checks": {
                  "security": {},
                  "resource_management": {},
                  "scheduling": {},
                  "monitoring": {}
                },
                "violations": [],
                "summary": {}
              }
              EOF

              # Get all DaemonSets
              daemonsets=$(kubectl get daemonset -A -o json)

              total_ds=$(echo "$daemonsets" | jq '.items | length')
              compliant_ds=0
              violations=0

              echo "$daemonsets" | jq -c '.items[]' | while read -r ds; do
                namespace=$(echo "$ds" | jq -r '.metadata.namespace')
                name=$(echo "$ds" | jq -r '.metadata.name')

                echo "Checking compliance for: $namespace/$name"

                # Security compliance checks
                security_context=$(echo "$ds" | jq -r '.spec.template.spec.securityContext // {}')
                containers=$(echo "$ds" | jq -r '.spec.template.spec.containers[]')

                # Check for non-root containers
                root_containers=$(echo "$containers" | jq -r 'select(.securityContext.runAsUser == 0 or .securityContext.runAsUser == null)')
                if [[ -n "$root_containers" ]]; then
                  echo "  ⚠️  Running as root user"
                  violations=$((violations + 1))
                fi

                # Resource management checks
                containers_without_resources=$(echo "$containers" | jq -r 'select(.resources.requests == null or .resources.limits == null)')
                if [[ -n "$containers_without_resources" ]]; then
                  echo "  ⚠️  Missing resource requests/limits"
                  violations=$((violations + 1))
                fi

                # Scheduling checks
                tolerations=$(echo "$ds" | jq -r '.spec.template.spec.tolerations // []')
                if [[ "$tolerations" == "[]" ]]; then
                  echo "  ⚠️  No tolerations specified (may not schedule on all nodes)"
                fi

                # Health check compliance
                liveness_probe=$(echo "$containers" | jq -r 'select(.livenessProbe != null)')
                readiness_probe=$(echo "$containers" | jq -r 'select(.readinessProbe != null)')

                if [[ -z "$liveness_probe" ]]; then
                  echo "  ⚠️  Missing liveness probe"
                  violations=$((violations + 1))
                fi

                if [[ -z "$readiness_probe" ]]; then
                  echo "  ⚠️  Missing readiness probe"
                  violations=$((violations + 1))
                fi

                echo "  ✅ Compliance check completed for $namespace/$name"
              done

              # Generate final report
              echo ""
              echo "📊 Compliance Summary"
              echo "===================="
              echo "Total DaemonSets: $total_ds"
              echo "Compliance violations: $violations"

              if [[ $violations -eq 0 ]]; then
                echo "✅ All DaemonSets are compliant"
              else
                echo "⚠️  Compliance violations detected"
              fi

              echo "📄 Detailed report: $compliance_report"

---
# Service accounts and RBAC for compliance tools
apiVersion: v1
kind: ServiceAccount
metadata:
  name: daemonset-health-checker
  namespace: kube-system

---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: daemonset-recovery-controller
  namespace: kube-system

---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: daemonset-compliance-checker
  namespace: kube-system

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: daemonset-management
rules:
- apiGroups: [""]
  resources: ["nodes", "pods", "events"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["apps"]
  resources: ["daemonsets"]
  verbs: ["get", "list", "watch", "patch", "update"]
- apiGroups: [""]
  resources: ["nodes"]
  verbs: ["patch"]  # For removing taints

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: daemonset-health-checker
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: daemonset-management
subjects:
- kind: ServiceAccount
  name: daemonset-health-checker
  namespace: kube-system

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: daemonset-recovery-controller
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: daemonset-management
subjects:
- kind: ServiceAccount
  name: daemonset-recovery-controller
  namespace: kube-system

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: daemonset-compliance-checker
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: daemonset-management
subjects:
- kind: ServiceAccount
  name: daemonset-compliance-checker
  namespace: kube-system
```

## Conclusion

Kubernetes DaemonSet scheduling troubleshooting requires systematic diagnostic approaches that examine the complete scheduling pipeline, from node conditions and taints to resource availability and network constraints. By implementing the comprehensive diagnostic frameworks, automated monitoring systems, and enterprise-grade compliance tools outlined in this guide, platform engineering teams can effectively prevent, diagnose, and resolve complex DaemonSet scheduling issues in production environments.

The key to successful DaemonSet management lies in proactive monitoring, automated remediation of common issues, and maintaining comprehensive audit trails that support both operational efficiency and regulatory compliance. As Kubernetes clusters grow in complexity and scale, these systematic approaches become increasingly critical for maintaining reliable infrastructure services that depend on DaemonSet deployments.

Regular testing of diagnostic procedures, continuous improvement of automation systems, and thorough documentation of resolution strategies ensure your Kubernetes infrastructure remains resilient and capable of supporting mission-critical workloads that depend on consistent DaemonSet scheduling across all cluster nodes.