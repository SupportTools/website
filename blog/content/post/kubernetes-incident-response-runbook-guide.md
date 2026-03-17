---
title: "Kubernetes Incident Response: On-Call Runbooks, Escalation, and Post-Mortems"
date: 2027-08-01T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Incident Response", "SRE", "On-Call", "Runbook"]
categories:
- SRE
- Kubernetes
- Incident Response
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes incident response including severity classification, automated runbook execution with Argo Workflows, PagerDuty integration, triage decision trees for common failures, blameless post-mortem templates, and MTTR/MTTA metrics tracking."
more_link: "yes"
url: "/kubernetes-incident-response-runbook-guide/"
---

Kubernetes incident response is a discipline that sits at the intersection of technical expertise and organizational process. When a SEV1 fires at 3 AM, the difference between a 12-minute recovery and a 3-hour outage often comes down to whether the on-call engineer has a clear runbook, automated diagnostic tooling, and well-rehearsed escalation paths. This guide provides a production-grade framework for classifying incidents, executing automated runbooks, integrating with alerting platforms, and systematically improving through blameless post-mortems.

<!--more-->

# [Kubernetes Incident Response: On-Call Runbooks, Escalation, and Post-Mortems](#kubernetes-incident-response-runbook-guide)

## Section 1: Incident Severity Classification

### Severity Matrix

Consistent severity classification ensures appropriate response urgency and escalation without creating alert fatigue.

| Severity | Impact | Response Time | Escalation | Examples |
|---|---|---|---|---|
| SEV1 | Full service outage, data loss risk | Immediate page, 5m ack | Exec + on-call lead | All pods down, etcd unavailable |
| SEV2 | Major feature degraded, SLO burning fast | Page, 15m ack | On-call lead | >50% pods crashlooping, ingress down |
| SEV3 | Minor degradation, SLO at risk | Ticket + Slack, 1h response | Team Slack channel | Single pod OOMKilled, slow rollout |
| SEV4 | No user impact, pre-emptive action | Next business day | N/A | Node disk 80%, certificate expires in 30d |

### Automated Severity Assignment via Prometheus Alert Labels

```yaml
# prometheus-rules/severity-routing.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: incident-severity-rules
  namespace: monitoring
spec:
  groups:
  - name: incident.severity
    rules:
    # SEV1: Complete availability loss
    - alert: ServiceCompleteOutage
      expr: |
        sum by (namespace, service) (
          kube_deployment_status_replicas_available{namespace=~"production|cde"}
        ) == 0
        and
        sum by (namespace, service) (
          kube_deployment_spec_replicas{namespace=~"production|cde"}
        ) > 0
      for: 2m
      labels:
        severity: critical
        incident_severity: SEV1
        page: "true"
        runbook: "service-complete-outage"
      annotations:
        summary: "SEV1: {{ $labels.namespace }}/{{ $labels.service }} has 0 available replicas"
        description: |
          All replicas for {{ $labels.service }} in namespace {{ $labels.namespace }}
          are unavailable. Immediate investigation required.

    # SEV2: Majority of pods failing
    - alert: ServiceMajorDegradation
      expr: |
        sum by (namespace, deployment) (
          kube_deployment_status_replicas_available
        )
        /
        sum by (namespace, deployment) (
          kube_deployment_spec_replicas
        )
        < 0.5
      for: 5m
      labels:
        severity: critical
        incident_severity: SEV2
        page: "true"
        runbook: "service-major-degradation"

    # SEV3: CrashLoopBackOff detected
    - alert: PodCrashLoopBackOff
      expr: |
        sum by (namespace, pod, container) (
          kube_pod_container_status_waiting_reason{
            reason="CrashLoopBackOff",
            namespace=~"production|staging"
          }
        ) > 0
      for: 5m
      labels:
        severity: warning
        incident_severity: SEV3
        page: "false"
        runbook: "pod-crashloopbackoff"
```

---

## Section 2: PagerDuty Integration

### AlertManager Routing Configuration

```yaml
# alertmanager/config.yaml
global:
  resolve_timeout: 5m
  pagerduty_url: https://events.pagerduty.com/v2/enqueue

route:
  group_by: ['alertname', 'namespace', 'incident_severity']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  receiver: 'default-slack'
  routes:
  # SEV1: Immediate page
  - match:
      incident_severity: SEV1
    receiver: sev1-pagerduty
    continue: true
    group_wait: 0s
    repeat_interval: 30m

  # SEV2: Page with 5m delay (allow auto-remediation)
  - match:
      incident_severity: SEV2
    receiver: sev2-pagerduty
    group_wait: 5m
    repeat_interval: 1h

  # SEV3: Slack ticket
  - match:
      incident_severity: SEV3
    receiver: sev3-slack-ticket
    group_wait: 10m
    repeat_interval: 24h

  # SEV4: Ticket only
  - match:
      incident_severity: SEV4
    receiver: sev4-ticket
    repeat_interval: 168h

receivers:
- name: sev1-pagerduty
  pagerduty_configs:
  - routing_key: PAGERDUTY_ROUTING_KEY_SEV1_REPLACE_ME
    description: >
      {{ .CommonAnnotations.summary }}
    severity: critical
    details:
      namespace: '{{ .CommonLabels.namespace }}'
      runbook: 'https://runbooks.support.tools/{{ .CommonLabels.runbook }}'
      cluster: '{{ .CommonLabels.cluster }}'
    links:
    - href: 'https://runbooks.support.tools/{{ .CommonLabels.runbook }}'
      text: 'Open Runbook'
    - href: 'https://grafana.support.tools/d/kubernetes-overview'
      text: 'Grafana Dashboard'

- name: sev2-pagerduty
  pagerduty_configs:
  - routing_key: PAGERDUTY_ROUTING_KEY_SEV2_REPLACE_ME
    severity: error

- name: sev3-slack-ticket
  slack_configs:
  - api_url: https://hooks.slack.com/services/TXXXXXXXXX/BXXXXXXXXX/REPLACE_WITH_YOUR_WEBHOOK_TOKEN
    channel: '#incidents-sev3'
    title: 'SEV3: {{ .CommonAnnotations.summary }}'
    text: |
      *Runbook*: https://runbooks.support.tools/{{ .CommonLabels.runbook }}
      *Namespace*: {{ .CommonLabels.namespace }}
      *Details*: {{ .CommonAnnotations.description }}

- name: sev4-ticket
  webhook_configs:
  - url: https://jira.support.tools/webhooks/alertmanager
    send_resolved: true

- name: default-slack
  slack_configs:
  - api_url: https://hooks.slack.com/services/TXXXXXXXXX/BXXXXXXXXX/REPLACE_WITH_YOUR_WEBHOOK_TOKEN
    channel: '#platform-alerts'
    title: '{{ .GroupLabels.alertname }}'
    text: '{{ range .Alerts }}{{ .Annotations.summary }}{{ end }}'
```

---

## Section 3: Automated Runbook Execution with Argo Workflows

Argo Workflows enables executable runbooks — structured diagnostic and remediation workflows that execute automatically on alert trigger.

### Workflow Template: CrashLoopBackOff Triage

```yaml
# argo-workflows/crashloopbackoff-runbook.yaml
apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: crashloopbackoff-triage
  namespace: argo
spec:
  entrypoint: triage-main
  arguments:
    parameters:
    - name: namespace
    - name: pod-name
    - name: container-name

  templates:
  - name: triage-main
    steps:
    - - name: collect-pod-info
        template: collect-pod-info
    - - name: collect-recent-logs
        template: collect-recent-logs
      - name: check-resource-limits
        template: check-resource-limits
    - - name: check-configmap-secrets
        template: check-configmap-secrets
    - - name: generate-diagnosis
        template: generate-diagnosis
        arguments:
          parameters:
          - name: pod-info
            value: "{{steps.collect-pod-info.outputs.result}}"
          - name: recent-logs
            value: "{{steps.collect-recent-logs.outputs.result}}"
          - name: resource-status
            value: "{{steps.check-resource-limits.outputs.result}}"

  - name: collect-pod-info
    inputs:
      parameters:
      - name: namespace
        value: "{{workflow.parameters.namespace}}"
      - name: pod-name
        value: "{{workflow.parameters.pod-name}}"
    script:
      image: bitnami/kubectl:1.30
      command: [sh]
      source: |
        echo "=== Pod Description ==="
        kubectl describe pod {{inputs.parameters.pod-name}} \
          -n {{inputs.parameters.namespace}}
        echo "=== Pod Events ==="
        kubectl get events \
          -n {{inputs.parameters.namespace}} \
          --field-selector involvedObject.name={{inputs.parameters.pod-name}} \
          --sort-by='.lastTimestamp'

  - name: collect-recent-logs
    script:
      image: bitnami/kubectl:1.30
      command: [sh]
      source: |
        echo "=== Current Container Logs (last 100 lines) ==="
        kubectl logs \
          {{workflow.parameters.pod-name}} \
          -n {{workflow.parameters.namespace}} \
          -c {{workflow.parameters.container-name}} \
          --tail=100 2>/dev/null || echo "Container not running"

        echo "=== Previous Container Logs (last 100 lines) ==="
        kubectl logs \
          {{workflow.parameters.pod-name}} \
          -n {{workflow.parameters.namespace}} \
          -c {{workflow.parameters.container-name}} \
          --previous --tail=100 2>/dev/null || echo "No previous logs"

  - name: check-resource-limits
    script:
      image: bitnami/kubectl:1.30
      command: [sh]
      source: |
        echo "=== Resource Limits vs Usage ==="
        kubectl top pod {{workflow.parameters.pod-name}} \
          -n {{workflow.parameters.namespace}} \
          --containers 2>/dev/null || echo "metrics-server unavailable"

        echo "=== OOMKill check in node journal ==="
        NODE=$(kubectl get pod {{workflow.parameters.pod-name}} \
          -n {{workflow.parameters.namespace}} \
          -o jsonpath='{.spec.nodeName}')
        echo "Pod node: ${NODE}"

  - name: check-configmap-secrets
    script:
      image: bitnami/kubectl:1.30
      command: [sh]
      source: |
        echo "=== ConfigMap/Secret mount status ==="
        kubectl get pod {{workflow.parameters.pod-name}} \
          -n {{workflow.parameters.namespace}} \
          -o jsonpath='{.status.conditions}' | python3 -m json.tool

  - name: generate-diagnosis
    inputs:
      parameters:
      - name: pod-info
      - name: recent-logs
      - name: resource-status
    script:
      image: registry.support.tools/diagnostic-tools:1.0.0
      command: [python3]
      source: |
        import re
        import sys

        logs = """{{inputs.parameters.recent-logs}}"""
        resources = """{{inputs.parameters.resource-status}}"""

        diagnosis = []

        # OOMKilled detection
        if "OOMKilled" in """{{inputs.parameters.pod-info}}""":
            diagnosis.append({
                "cause": "OOMKilled",
                "action": "Increase memory limit or investigate memory leak",
                "severity": "HIGH"
            })

        # Exit code detection
        exit_codes = re.findall(r'Exit Code:\s+(\d+)', """{{inputs.parameters.pod-info}}""")
        for code in exit_codes:
            if code == "1":
                diagnosis.append({"cause": "Application error (exit 1)", "action": "Check application logs", "severity": "MEDIUM"})
            elif code == "127":
                diagnosis.append({"cause": "Command not found", "action": "Verify container entrypoint", "severity": "HIGH"})
            elif code == "137":
                diagnosis.append({"cause": "SIGKILL (OOM or external kill)", "action": "Check memory limits", "severity": "HIGH"})

        # Log pattern analysis
        error_patterns = [
            (r'connection refused', "Dependency connection failure"),
            (r'no such file or directory', "Missing file/volume mount"),
            (r'permission denied', "File permission or RBAC issue"),
            (r'cannot connect to', "Network connectivity issue"),
        ]

        for pattern, message in error_patterns:
            if re.search(pattern, logs, re.IGNORECASE):
                diagnosis.append({"cause": message, "action": "Check volume mounts and network policies", "severity": "MEDIUM"})

        import json
        print(json.dumps({"diagnoses": diagnosis}, indent=2))
```

### Webhook Trigger from AlertManager

```yaml
# argo-workflows/event-source.yaml
apiVersion: argoproj.io/v1alpha1
kind: EventSource
metadata:
  name: alertmanager-webhook
  namespace: argo
spec:
  webhook:
    alertmanager:
      port: "12000"
      endpoint: /alertmanager
      method: POST
---
apiVersion: argoproj.io/v1alpha1
kind: Sensor
metadata:
  name: crashloopbackoff-sensor
  namespace: argo
spec:
  dependencies:
  - name: alertmanager-dep
    eventSourceName: alertmanager-webhook
    eventName: alertmanager
    filters:
      data:
      - path: body.alerts.0.labels.runbook
        type: string
        value:
        - pod-crashloopbackoff
  triggers:
  - template:
      name: crashloopbackoff-workflow
      argoWorkflow:
        operation: submit
        source:
          resource:
            apiVersion: argoproj.io/v1alpha1
            kind: Workflow
            metadata:
              generateName: crashloopbackoff-triage-
              namespace: argo
            spec:
              workflowTemplateRef:
                name: crashloopbackoff-triage
        parameters:
        - src:
            dependencyName: alertmanager-dep
            dataKey: body.alerts.0.labels.namespace
          dest: spec.arguments.parameters.0.value
        - src:
            dependencyName: alertmanager-dep
            dataKey: body.alerts.0.labels.pod
          dest: spec.arguments.parameters.1.value
        - src:
            dependencyName: alertmanager-dep
            dataKey: body.alerts.0.labels.container
          dest: spec.arguments.parameters.2.value
```

---

## Section 4: Triage Decision Trees for Common Kubernetes Failures

### OOMKilled Decision Tree

```
OOMKilled Alert Triggered
         │
         ├─ kubectl describe pod <name> -n <ns>
         │   └─ Check "Last State: OOMKilled"
         │
         ├─ Is this a spike or persistent?
         │   ├─ SPIKE: kubectl top pod --containers
         │   │   └─ Check workload for one-time bulk operation
         │   │       └─ Action: Add resource limit buffer or PodDisruptionBudget
         │   └─ PERSISTENT: Check memory growth trend
         │       └─ kubectl exec -it <pod> -- /proc/meminfo
         │           └─ Action: Investigate memory leak; raise limits temporarily
         │
         └─ Immediate mitigation:
             kubectl scale deployment/<name> --replicas=<current+2>
             kubectl set resources deployment/<name> --limits=memory=<new_limit>
```

```bash
# OOMKilled diagnostic script
#!/bin/bash
# Usage: ./oom-triage.sh <namespace> <pod-prefix>
NS="${1:-production}"
POD_PREFIX="${2}"

echo "=== Scanning for OOMKilled pods in ${NS} ==="
kubectl get pods -n "${NS}" -o json | \
  jq -r '.items[] | select(.status.containerStatuses[]?.lastState.terminated.reason == "OOMKilled") |
    .metadata.name + " | OOMKilled at: " +
    (.status.containerStatuses[0].lastState.terminated.finishedAt // "unknown") +
    " | Limit: " + (.spec.containers[0].resources.limits.memory // "none")'

echo ""
echo "=== Memory usage vs limits ==="
kubectl top pods -n "${NS}" --sort-by=memory 2>/dev/null | head -20

echo ""
echo "=== Node memory pressure ==="
kubectl get nodes -o custom-columns=\
'NAME:.metadata.name,STATUS:.status.conditions[-1].type,MEMORY_PRESSURE:.status.conditions[?(@.type=="MemoryPressure")].status'
```

### CrashLoopBackOff Decision Tree

```bash
#!/bin/bash
# crashloop-triage.sh — systematic CrashLoopBackOff diagnosis
NS="${1:-production}"
POD="${2}"

echo "=== Exit code analysis ==="
EXIT_CODE=$(kubectl get pod "${POD}" -n "${NS}" \
  -o jsonpath='{.status.containerStatuses[0].lastState.terminated.exitCode}' 2>/dev/null)

case "${EXIT_CODE}" in
  "0")   echo "DIAGNOSIS: Application exited cleanly (exit 0) — check restart policy" ;;
  "1")   echo "DIAGNOSIS: Application error — check logs for exception/error message" ;;
  "2")   echo "DIAGNOSIS: Misuse of shell built-in — check entrypoint/command" ;;
  "126") echo "DIAGNOSIS: Permission issue — check container user and file permissions" ;;
  "127") echo "DIAGNOSIS: Command not found — verify container image and entrypoint" ;;
  "128") echo "DIAGNOSIS: Invalid exit argument" ;;
  "130") echo "DIAGNOSIS: Script terminated by Control-C (SIGINT)" ;;
  "137") echo "DIAGNOSIS: SIGKILL — likely OOMKilled or external process kill" ;;
  "143") echo "DIAGNOSIS: SIGTERM — graceful shutdown signal (check preStop hooks)" ;;
  *)     echo "DIAGNOSIS: Unknown exit code ${EXIT_CODE} — check application documentation" ;;
esac

echo ""
echo "=== Last 50 lines of previous container logs ==="
kubectl logs "${POD}" -n "${NS}" --previous --tail=50 2>/dev/null || \
  echo "No previous logs available"

echo ""
echo "=== ConfigMap and Secret volumes ==="
kubectl get pod "${POD}" -n "${NS}" \
  -o jsonpath='{range .spec.volumes[*]}{.name}: {.configMap.name}{.secret.secretName}{"\n"}{end}'

echo ""
echo "=== Checking referenced secrets exist ==="
SECRET_NAMES=$(kubectl get pod "${POD}" -n "${NS}" \
  -o jsonpath='{range .spec.volumes[*]}{.secret.secretName}{" "}{end}')
for SECRET in ${SECRET_NAMES}; do
  if kubectl get secret "${SECRET}" -n "${NS}" &>/dev/null; then
    echo "  OK: secret/${SECRET} exists"
  else
    echo "  MISSING: secret/${SECRET} — this is likely the cause"
  fi
done
```

### PodPending Decision Tree

```bash
#!/bin/bash
# pending-pod-triage.sh
NS="${1:-production}"
POD="${2}"

echo "=== Pod scheduling status ==="
kubectl describe pod "${POD}" -n "${NS}" | grep -A 20 "Events:"

echo ""
echo "=== Identifying pending reason ==="
REASON=$(kubectl get pod "${POD}" -n "${NS}" \
  -o jsonpath='{.status.conditions[?(@.type=="PodScheduled")].reason}')
echo "Schedule condition reason: ${REASON}"

case "${REASON}" in
  "Unschedulable")
    echo ""
    echo "=== Node capacity ==="
    kubectl describe nodes | grep -A 5 "Allocated resources"

    echo ""
    echo "=== Taints that may block scheduling ==="
    kubectl get nodes -o custom-columns=\
'NAME:.metadata.name,TAINTS:.spec.taints[*].key'

    echo ""
    echo "=== Resource requests vs available ==="
    kubectl get pod "${POD}" -n "${NS}" \
      -o jsonpath='{range .spec.containers[*]}{.name}: CPU={.resources.requests.cpu} MEM={.resources.requests.memory}{"\n"}{end}'
    ;;

  "")
    echo ""
    echo "=== Checking PVC binding ==="
    PVC_NAMES=$(kubectl get pod "${POD}" -n "${NS}" \
      -o jsonpath='{range .spec.volumes[*]}{.persistentVolumeClaim.claimName}{" "}{end}')
    for PVC in ${PVC_NAMES}; do
      STATUS=$(kubectl get pvc "${PVC}" -n "${NS}" \
        -o jsonpath='{.status.phase}' 2>/dev/null)
      echo "  PVC ${PVC}: ${STATUS:-NOT FOUND}"
    done
    ;;
esac
```

### NodeNotReady Decision Tree

```bash
#!/bin/bash
# node-not-ready-triage.sh
NODE="${1}"

echo "=== Node conditions ==="
kubectl get node "${NODE}" \
  -o jsonpath='{range .status.conditions[*]}{.type}: {.status} — {.message}{"\n"}{end}'

echo ""
echo "=== kubelet status (requires node SSH) ==="
echo "Run on node: systemctl status kubelet"
echo "Run on node: journalctl -u kubelet --since '10 minutes ago' | tail -50"

echo ""
echo "=== Pods on the affected node ==="
kubectl get pods --all-namespaces \
  --field-selector "spec.nodeName=${NODE}" \
  -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,STATUS:.status.phase'

echo ""
echo "=== Cordon node to prevent new scheduling while investigating ==="
echo "kubectl cordon ${NODE}"

echo ""
echo "=== Node resource usage ==="
kubectl describe node "${NODE}" | grep -A 20 "Allocated resources:"
```

---

## Section 5: On-Call Handoff Procedures

### Handoff Template

```yaml
# on-call-handoff/template.yaml
handoff:
  date: "2027-08-01"
  outgoing_oncall: "alice@support.tools"
  incoming_oncall: "bob@support.tools"
  shift_end: "2027-08-01T08:00:00Z"

  active_incidents: []
  # If active:
  # - id: INC-2027-080101
  #   severity: SEV2
  #   summary: "Payment service elevated 5xx"
  #   current_state: "Monitoring after config rollback"
  #   next_action: "Confirm error rate drops to baseline by 09:00"
  #   runbook: "https://runbooks.support.tools/payment-5xx"

  open_alerts:
  - name: "NodeDiskPressure"
    namespace: "production"
    node: "worker-node-07"
    action_taken: "Ticket created, non-critical disk cleanup scheduled"
    ticket: "PLAT-4421"

  known_issues:
  - description: "Deployment of checkout-v2.3.1 scheduled for 10:00 UTC"
    risk: "Medium — new payment provider integration"
    rollback_plan: "kubectl rollout undo deployment/checkout"

  service_health_summary:
    api_server: "Green — 99.97% availability last 24h"
    payment_service: "Green"
    auth_service: "Yellow — elevated latency p99 340ms (SLO threshold 300ms)"

  error_budget_status:
    api_server_monthly_remaining: "78%"
    payment_service_monthly_remaining: "91%"

  escalation_contacts:
  - role: "On-call lead"
    name: "Charlie Smith"
    pagerduty: "charlie-oncall"
  - role: "Payments team lead"
    name: "Diana Jones"
    slack: "@diana-j"
  - role: "Infrastructure lead"
    name: "Evan Williams"
    phone: "Contact via PagerDuty SEV1 escalation"
```

---

## Section 6: kubectl Plugins for Incident Triage

### kubectl-incidents Plugin

```bash
#!/bin/bash
# kubectl-incidents
# Install: cp kubectl-incidents /usr/local/bin/ && chmod +x /usr/local/bin/kubectl-incidents
# Usage: kubectl incidents [namespace]

NS="${1:-production}"

echo "========================================="
echo " KUBERNETES INCIDENT TRIAGE DASHBOARD"
echo " Cluster: $(kubectl config current-context)"
echo " Namespace: ${NS}"
echo " Time: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "========================================="
echo ""

echo "=== CRITICAL: Pods Not Running ==="
kubectl get pods -n "${NS}" --field-selector "status.phase!=Running,status.phase!=Succeeded" \
  -o custom-columns='NAME:.metadata.name,STATUS:.status.phase,REASON:.status.reason' \
  2>/dev/null | head -20

echo ""
echo "=== Pods in CrashLoopBackOff ==="
kubectl get pods -n "${NS}" -o json | \
  jq -r '.items[] |
    select(.status.containerStatuses[]?.state.waiting.reason == "CrashLoopBackOff") |
    .metadata.name + " | restarts=" +
    (.status.containerStatuses[0].restartCount | tostring)' | head -10

echo ""
echo "=== Pending Pods ==="
kubectl get pods -n "${NS}" --field-selector "status.phase=Pending" \
  -o custom-columns='NAME:.metadata.name,NODE:.spec.nodeName,AGE:.metadata.creationTimestamp' \
  2>/dev/null | head -10

echo ""
echo "=== Recent Events (Warnings) ==="
kubectl get events -n "${NS}" --field-selector type=Warning \
  --sort-by='.lastTimestamp' -o \
  custom-columns='TIME:.lastTimestamp,REASON:.reason,OBJECT:.involvedObject.name,MESSAGE:.message' \
  2>/dev/null | tail -15

echo ""
echo "=== Node Status ==="
kubectl get nodes -o custom-columns=\
'NAME:.metadata.name,STATUS:.status.conditions[-1].type,ROLES:.metadata.labels.kubernetes\.io/role,VERSION:.status.nodeInfo.kubeletVersion'

echo ""
echo "=== Deployments Not at Desired Replicas ==="
kubectl get deployments -n "${NS}" -o json | \
  jq -r '.items[] |
    select(.status.availableReplicas != .spec.replicas) |
    .metadata.name + " desired=" + (.spec.replicas | tostring) +
    " available=" + (.status.availableReplicas // 0 | tostring)' | head -10
```

---

## Section 7: Blameless Post-Mortem Template

Blameless post-mortems focus on system failure modes rather than individual blame, producing systemic improvements rather than punitive action.

```markdown
# Post-Mortem: [Incident Title]

**Incident ID**: INC-2027-XXXXXX
**Date**: YYYY-MM-DD
**Severity**: SEVX
**Duration**: X minutes
**Error Budget Consumed**: X%
**Author**: [Author Name]
**Status**: DRAFT | IN REVIEW | FINAL

---

## Summary

One paragraph: what happened, what the user impact was, how long it lasted,
and what the immediate mitigation was. Written for a non-technical audience.

---

## Impact

- **User impact**: [Describe what users experienced]
- **Services affected**: [List services]
- **Requests failed**: [Estimated count or percentage]
- **Revenue impact**: [$X or "Unknown"]
- **SLO impact**: [X% of monthly error budget consumed]

---

## Timeline

| Time (UTC) | Event |
|---|---|
| HH:MM | Alert fired: [alert name] |
| HH:MM | On-call engineer acknowledged |
| HH:MM | Initial triage began |
| HH:MM | Root cause hypothesis formed |
| HH:MM | Mitigation attempted: [describe] |
| HH:MM | Mitigation confirmed effective |
| HH:MM | All signals returned to baseline |
| HH:MM | Incident resolved |

---

## Root Cause

Technical description of the root cause. Be specific about the system
component, the condition that triggered the failure, and why the existing
safeguards did not prevent or detect it sooner.

---

## Contributing Factors

List each contributing factor separately. Use "How" not "Who" framing.

1. [Factor 1]: Why this condition existed
2. [Factor 2]: Why this condition was not detected earlier
3. [Factor 3]: Why the impact was not contained

---

## What Went Well

- On-call engineer acknowledged within 4 minutes (target: 5 minutes)
- Runbook was accurate and led directly to root cause
- Rollback procedure completed in 90 seconds

---

## What Could Have Gone Better

- Alert fired 8 minutes after failure began due to long evaluation window
- No automated mitigation was in place for this failure mode
- Runbook did not cover the specific configuration edge case encountered

---

## Action Items

| ID | Title | Owner | Due Date | Priority | SLO Improvement |
|---|---|---|---|---|---|
| AI-001 | Reduce alert evaluation window from 10m to 2m | platform | YYYY-MM-DD | P1 | Reduces detection time by 8m |
| AI-002 | Add automated rollback for config validation failures | platform | YYYY-MM-DD | P1 | Eliminates this failure mode |
| AI-003 | Update runbook with new edge case documentation | oncall | YYYY-MM-DD | P2 | Reduces MTTR by ~5m |

---

## Lessons Learned

Narrative description of the key insights from this incident. Focus on
systemic improvements and what can be learned about the system's
resilience characteristics.
```

---

## Section 8: Incident Metrics (MTTR and MTTA)

### Prometheus Incident Metrics Exporter

```go
// incident-metrics-exporter/main.go
package main

import (
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	incidentDurationSeconds = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "incident_duration_seconds",
			Help:    "Duration of incidents from detection to resolution",
			Buckets: prometheus.ExponentialBuckets(60, 2, 12),
		},
		[]string{"severity", "service", "root_cause_category"},
	)

	incidentAckDurationSeconds = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "incident_ack_duration_seconds",
			Help:    "Time from alert fire to acknowledgment",
			Buckets: prometheus.LinearBuckets(60, 60, 10),
		},
		[]string{"severity", "team"},
	)

	incidentsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "incidents_total",
			Help: "Total number of incidents by severity and outcome",
		},
		[]string{"severity", "outcome", "service"},
	)

	activeIncidents = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "active_incidents",
			Help: "Currently active incidents by severity",
		},
		[]string{"severity"},
	)
)

// RecordIncident records metrics when an incident closes
func RecordIncident(severity, service, rootCause, outcome string,
	startTime, ackTime, endTime time.Time) {

	duration := endTime.Sub(startTime).Seconds()
	ackDuration := ackTime.Sub(startTime).Seconds()

	incidentDurationSeconds.WithLabelValues(severity, service, rootCause).
		Observe(duration)

	incidentAckDurationSeconds.WithLabelValues(severity, service).
		Observe(ackDuration)

	incidentsTotal.WithLabelValues(severity, outcome, service).Inc()
}

func main() {
	http.Handle("/metrics", promhttp.Handler())
	http.ListenAndServe(":9092", nil)
}
```

### MTTR/MTTA Prometheus Queries

```promql
# MTTR (Mean Time to Recovery) — 30-day rolling average
histogram_quantile(0.50,
  sum by (le, severity) (
    rate(incident_duration_seconds_bucket[30d])
  )
)

# MTTA (Mean Time to Acknowledge) — by severity
histogram_quantile(0.90,
  sum by (le, severity) (
    rate(incident_ack_duration_seconds_bucket[30d])
  )
)

# Incident rate by severity
sum by (severity) (
  increase(incidents_total[30d])
)

# SEV1 MTTR trend (week over week comparison)
histogram_quantile(0.50,
  sum by (le) (rate(incident_duration_seconds_bucket{severity="SEV1"}[7d]))
)
-
histogram_quantile(0.50,
  sum by (le) (rate(incident_duration_seconds_bucket{severity="SEV1"}[7d] offset 7d))
)
```

---

## Section 9: Runbook Automation Registry

Maintaining a registry of runbooks as Kubernetes resources enables automated discovery and linking from alert rules.

```yaml
# runbook-registry/configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: runbook-registry
  namespace: monitoring
  labels:
    component: incident-response
data:
  registry.yaml: |
    runbooks:
    - id: pod-crashloopbackoff
      title: "Pod CrashLoopBackOff"
      url: "https://runbooks.support.tools/pod-crashloopbackoff"
      automated_workflow: crashloopbackoff-triage
      typical_causes:
      - "Missing secret or configmap"
      - "Application startup error"
      - "OOMKilled"
      - "Misconfigured entrypoint"
      avg_resolution_minutes: 8

    - id: service-complete-outage
      title: "Complete Service Outage"
      url: "https://runbooks.support.tools/service-complete-outage"
      automated_workflow: service-outage-triage
      typical_causes:
      - "Deployment rollout failure"
      - "Node failure"
      - "ConfigMap/Secret deletion"
      avg_resolution_minutes: 12

    - id: service-major-degradation
      title: "Major Service Degradation"
      url: "https://runbooks.support.tools/service-major-degradation"
      automated_workflow: degradation-triage
      typical_causes:
      - "Resource exhaustion"
      - "Dependency failure"
      - "Traffic spike without HPA headroom"
      avg_resolution_minutes: 15

    - id: node-not-ready
      title: "Node NotReady"
      url: "https://runbooks.support.tools/node-not-ready"
      automated_workflow: node-triage
      typical_causes:
      - "kubelet crash"
      - "Disk pressure"
      - "Network partition"
      - "Container runtime failure"
      avg_resolution_minutes: 20
```

---

## Summary

Effective Kubernetes incident response requires three pillars operating in concert: rapid detection through precise alerting, accelerated triage through automated diagnostic runbooks, and continuous improvement through blameless post-mortems. Severity classification ensures the right response level without alert fatigue. Argo Workflows transforms static runbook documents into executable diagnostic pipelines that reduce cognitive load during high-stress incidents. PagerDuty routing configuration ensures the right people are paged with the right urgency. MTTR and MTTA metrics provide the feedback loop that drives runbook improvement over time. When combined with structured post-mortems and tracked action items, this framework converts every incident into a lasting reliability investment.
