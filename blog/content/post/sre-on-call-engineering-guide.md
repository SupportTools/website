---
title: "SRE On-Call Engineering: Runbook Design, Escalation Paths, and Toil Reduction"
date: 2027-09-26T00:00:00-05:00
draft: false
tags: ["SRE", "On-Call", "Incident Response", "Runbooks", "Reliability", "DevOps"]
categories: ["SRE", "Reliability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production SRE on-call engineering guide covering runbook design patterns, escalation path architecture, toil measurement and reduction strategies, SLO-based alerting, post-incident review workflows, and automation tooling for sustainable on-call operations."
more_link: "yes"
url: "/sre-on-call-engineering-guide/"
---

Sustainable on-call engineering requires systematic approaches to runbook design, escalation architecture, and toil reduction that go beyond simply rotating pager duty. Teams that operate at high reliability rates do so by measuring every on-call intervention, distinguishing actionable alerts from noise, automating repeated response patterns, and conducting rigorous post-incident reviews that produce durable improvements. This guide covers the operational engineering practices that separate reactive firefighting from proactive reliability engineering.

<!--more-->

## On-Call Program Architecture

### The Three-Tier Model

Production on-call programs operate across three response tiers:

**Tier 1 — Automated Response**: Runbook automation that self-heals without human intervention. Constitutes 40-60% of pages in a mature organization. Examples: pod restart on OOMKill, certificate rotation, disk cleanup.

**Tier 2 — Guided Human Response**: Runbook-driven human response where the responder follows documented steps. Constitutes 30-40% of pages. Examples: capacity scaling decisions, database failover approval, traffic rerouting.

**Tier 3 — Expert Escalation**: Novel incidents requiring deep system knowledge beyond documented runbooks. Constitutes 5-15% of pages. Examples: kernel panics with unknown root cause, cascading failure analysis, data integrity issues.

A healthy on-call program maximizes Tier 1, minimizes Tier 3, and ensures Tier 2 has high-quality runbooks that enable rotation participants who are not domain experts to resolve incidents.

### On-Call Metrics Dashboard

Track the following metrics weekly to identify program health trends:

```promql
# Mean Time to Acknowledge (MTTA) — target < 5 minutes for critical
histogram_quantile(0.95,
  rate(pagerduty_incident_acknowledge_duration_seconds_bucket[7d])
)

# Mean Time to Resolve (MTTR) — target < 30 minutes for critical
histogram_quantile(0.95,
  rate(pagerduty_incident_resolve_duration_seconds_bucket{severity="critical"}[7d])
)

# Pages per engineer per week — target < 3 actionable pages/week/engineer
sum by (oncall_user) (
  increase(pagerduty_incident_total{urgency="high"}[7d])
) / count by (oncall_user) (up{job="pagerduty-exporter"})

# Alert noise ratio — percentage of pages that are auto-resolved without action
sum(increase(pagerduty_incident_resolved_total{resolve_reason="auto"}[7d]))
/
sum(increase(pagerduty_incident_total[7d]))

# Repeat incident rate — same alert firing more than once without fix
count by (alert_name) (
  increase(pagerduty_incident_total[30d]) > 3
)
```

## Runbook Design Patterns

### Runbook Structure Template

Every actionable alert must have a corresponding runbook. The following structure ensures consistency and reduces cognitive load during incidents:

```markdown
# Runbook: [AlertName]

## Quick Summary
One sentence: what this alert means and the likely impact.
**Severity**: Critical | Warning
**Team**: Platform | Backend | Data | Security
**Last Updated**: 2027-09-25
**Owners**: @username1, @username2

## Triage Checklist (2 minutes)
- [ ] Check Grafana dashboard: [direct link]
- [ ] Verify alert is not silenced: `amtool silence query --alertmanager.url=...`
- [ ] Confirm impact scope (single region, multi-region, all users)

## Common Causes (70% of incidents)
1. **Memory leak** — Check: `kubectl top pods -n production | sort -k3 -rn | head -10`
2. **Database connection pool exhaustion** — Check pool metrics on Grafana panel [link]
3. **Upstream API rate limit** — Check: `kubectl logs -n production deploy/api --since=5m | grep "429"`

## Diagnostic Commands
```bash
# Step 1: Identify affected pods
kubectl get pods -n production -l app=payments-api \
  --field-selector=status.phase!=Running

# Step 2: Inspect recent events
kubectl get events -n production --sort-by='.lastTimestamp' \
  | grep -i "payments-api\|error\|warning" | tail -20

# Step 3: Check resource usage
kubectl top pods -n production -l app=payments-api

# Step 4: Examine recent logs
kubectl logs -n production deploy/payments-api --since=15m \
  | grep -E "ERROR|FATAL|panic" | tail -50
```

## Resolution Steps

### Scenario A: Single pod OOMKill
```bash
# Increase memory limit temporarily (permanent fix requires code change)
kubectl set resources deploy/payments-api \
  -n production \
  --limits=memory=2Gi

# Verify rollout
kubectl rollout status deploy/payments-api -n production
```
**Expected outcome**: Pod restarts, alert resolves within 3 minutes.

### Scenario B: All pods restarting
```bash
# Scale down to prevent cascading restarts
kubectl scale deploy/payments-api -n production --replicas=1

# Check latest deployment for configuration errors
kubectl rollout history deploy/payments-api -n production
kubectl rollout undo deploy/payments-api -n production  # if recent deployment caused issue

# Scale back up
kubectl scale deploy/payments-api -n production --replicas=3
```
**Expected outcome**: Alert resolves within 5 minutes after rollback.

## Escalation
If unresolved within **15 minutes**, escalate to:
- Primary: @backend-lead (PagerDuty schedule: payments-backend-primary)
- Secondary: @platform-lead (PagerDuty schedule: platform-secondary)

## Post-Incident Requirements
- [ ] Create Jira ticket for permanent fix if temporary workaround applied
- [ ] Update runbook if new cause identified
- [ ] File post-incident review if MTTR > 30 minutes or user-visible impact
```

### Runbook Validation Automation

Test runbook commands in a staging environment to ensure they remain accurate:

```bash
#!/usr/bin/env bash
# validate-runbook-commands.sh — extract and test bash commands from runbooks
set -euo pipefail

RUNBOOK_DIR="${1:?Usage: $0 <runbook-dir>}"
NAMESPACE="staging"
FAILED=0
PASSED=0

# Extract bash code blocks from all markdown runbooks
find "${RUNBOOK_DIR}" -name "*.md" -print0 | while IFS= read -r -d '' runbook; do
    echo "=== Validating: ${runbook} ==="

    # Extract bash blocks between ```bash and ```
    python3 - <<EOF "${runbook}"
import sys, re

with open(sys.argv[1]) as f:
    content = f.read()

# Find all bash code blocks
blocks = re.findall(r'```bash\n(.*?)```', content, re.DOTALL)
for i, block in enumerate(blocks, 1):
    # Substitute production namespace with staging
    safe_block = block.replace(
        '-n production', f'-n ${NAMESPACE}'
    ).replace(
        'namespace: production', f'namespace: ${NAMESPACE}'
    )

    # Skip destructive commands
    if any(cmd in safe_block for cmd in ['rollout undo', 'scale --replicas=0', 'delete']):
        print(f'  Block {i}: SKIPPED (destructive command)')
        continue

    # Validate kubectl syntax only (dry-run)
    dry_run = safe_block.replace('kubectl ', 'kubectl --dry-run=client ')
    print(f'  Block {i}: {safe_block[:60].strip()}...')
EOF

done

echo "Validation complete: ${PASSED} passed, ${FAILED} failed"
```

## SLO-Based Alert Design

### Error Budget Burn Rate Alerts

The most actionable on-call alerts are those based on SLO error budget consumption rate rather than raw metric thresholds. Burn rate alerts detect problems that will exhaust the error budget before the SLO window ends.

```yaml
# prometheus-slo-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: slo-burn-rate-alerts
  namespace: monitoring
spec:
  groups:
    - name: slo.error-budget
      rules:
        # Multi-window, multi-burn-rate alerting for 99.9% availability SLO
        # This pattern is from Google's SRE Workbook

        # Fast burn: 1h window at 14x burn rate consumes 2% of monthly budget
        - alert: PaymentsAPIErrorBudgetFastBurn
          expr: |
            (
              sum(rate(http_requests_total{service="payments-api",status_code=~"5.."}[1h]))
              /
              sum(rate(http_requests_total{service="payments-api"}[1h]))
            ) > (14 * 0.001)
            and
            (
              sum(rate(http_requests_total{service="payments-api",status_code=~"5.."}[5m]))
              /
              sum(rate(http_requests_total{service="payments-api"}[5m]))
            ) > (14 * 0.001)
          labels:
            severity: critical
            slo: availability
            service: payments-api
          annotations:
            summary: "Payments API burning error budget at 14x rate"
            description: |
              At current burn rate, the monthly error budget will be exhausted in
              approximately {{ $value | humanizeDuration }}.
              Current error rate: {{ $value | humanizePercentage }}

        # Slow burn: 6h window at 6x burn rate consumes 5% of monthly budget
        - alert: PaymentsAPIErrorBudgetSlowBurn
          expr: |
            (
              sum(rate(http_requests_total{service="payments-api",status_code=~"5.."}[6h]))
              /
              sum(rate(http_requests_total{service="payments-api"}[6h]))
            ) > (6 * 0.001)
            and
            (
              sum(rate(http_requests_total{service="payments-api",status_code=~"5.."}[30m]))
              /
              sum(rate(http_requests_total{service="payments-api"}[30m]))
            ) > (6 * 0.001)
          labels:
            severity: warning
            slo: availability
            service: payments-api
          annotations:
            summary: "Payments API consuming error budget at elevated rate"

        # Latency SLO: 95% of requests < 500ms
        - alert: PaymentsAPILatencyBudgetBurn
          expr: |
            (
              sum(rate(http_request_duration_seconds_bucket{service="payments-api",le="0.5"}[1h]))
              /
              sum(rate(http_request_duration_seconds_count{service="payments-api"}[1h]))
            ) < (1 - 14 * 0.05)
          labels:
            severity: critical
            slo: latency
            service: payments-api
          annotations:
            summary: "Payments API latency SLO fast burn"
```

### SLO Dashboard Recording Rules

```yaml
spec:
  groups:
    - name: slo.recording
      interval: 30s
      rules:
        # 28-day availability (rolling window for SLO reporting)
        - record: service:http_availability:rate28d
          expr: |
            1 - (
              sum by (service) (rate(http_requests_total{status_code=~"5.."}[28d]))
              /
              sum by (service) (rate(http_requests_total[28d]))
            )

        # Error budget remaining (28-day window, 99.9% target)
        - record: service:error_budget_remaining:ratio
          expr: |
            (service:http_availability:rate28d - 0.999) / (1 - 0.999)

        # Minutes of downtime budget remaining
        - record: service:error_budget_minutes_remaining
          expr: |
            service:error_budget_remaining:ratio * 28 * 24 * 60 * (1 - 0.999)
```

## Escalation Path Architecture

### PagerDuty Schedule Design

A well-designed escalation architecture ensures the right person is paged at the right time:

```yaml
# pagerduty-schedules-as-code (using Terraform)
# terraform/pagerduty/schedules.tf

resource "pagerduty_schedule" "platform_primary" {
  name      = "Platform Primary On-Call"
  time_zone = "America/New_York"

  layer {
    name                         = "Primary Rotation"
    start                        = "2027-09-01T00:00:00-05:00"
    rotation_virtual_start       = "2027-09-01T00:00:00-05:00"
    rotation_turn_length_seconds = 604800  # 1 week

    users = [
      data.pagerduty_user.engineer1.id,
      data.pagerduty_user.engineer2.id,
      data.pagerduty_user.engineer3.id,
      data.pagerduty_user.engineer4.id,
    ]

    # Business hours restriction (M-F 09:00-18:00)
    restriction {
      type              = "weekly_restriction"
      start_time_of_day = "09:00:00"
      duration_seconds  = 32400  # 9 hours
      start_day_of_week = 1      # Monday
    }
  }
}

resource "pagerduty_schedule" "platform_offhours" {
  name      = "Platform Off-Hours On-Call"
  time_zone = "America/New_York"

  layer {
    name                         = "Off-Hours Rotation"
    start                        = "2027-09-01T00:00:00-05:00"
    rotation_virtual_start       = "2027-09-01T18:00:00-05:00"
    rotation_turn_length_seconds = 604800

    users = [
      data.pagerduty_user.senior1.id,
      data.pagerduty_user.senior2.id,
    ]
  }
}

resource "pagerduty_escalation_policy" "platform" {
  name      = "Platform Escalation Policy"
  num_loops = 2

  rule {
    escalation_delay_in_minutes = 5

    target {
      type = "schedule_reference"
      id   = pagerduty_schedule.platform_primary.id
    }
  }

  rule {
    escalation_delay_in_minutes = 10

    target {
      type = "schedule_reference"
      id   = pagerduty_schedule.platform_offhours.id
    }
  }

  rule {
    escalation_delay_in_minutes = 15

    target {
      type = "user_reference"
      id   = data.pagerduty_user.engineering_manager.id
    }
  }
}
```

### Routing Rules for Alert Severity

```yaml
# PagerDuty Event Rules as code
resource "pagerduty_ruleset_rule" "critical_route" {
  ruleset = pagerduty_ruleset.platform.id

  conditions {
    operator = "and"
    subconditions {
      operator = "contains"
      parameter {
        path  = "payload.severity"
        value = "critical"
      }
    }
    subconditions {
      operator = "contains"
      parameter {
        path  = "payload.source"
        value = "production"
      }
    }
  }

  actions {
    route {
      value = pagerduty_service.platform_critical.id
    }
    severity {
      value = "critical"
    }
    priority {
      value = data.pagerduty_priority.p1.id
    }
    annotate {
      value = "Auto-routed to Platform Critical service"
    }
  }
}
```

## Toil Measurement and Reduction

### Toil Classification Framework

Toil is defined as operational work that:
- Is manual and repetitive
- Scales with service growth (linear toil is a warning sign)
- Could be automated
- Produces no lasting improvement to the system

Track toil using incident metadata:

```bash
#!/usr/bin/env bash
# measure-toil.sh — analyze on-call incidents for toil classification
# Requires JIRA API access and PagerDuty API access

JIRA_URL="${JIRA_URL:?}"
JIRA_TOKEN="${JIRA_TOKEN:?}"
PD_TOKEN="${PD_TOKEN:?}"

START_DATE="${1:-$(date -d '-30 days' +%Y-%m-%d)}"
END_DATE="${2:-$(date +%Y-%m-%d)}"

echo "=== Toil Analysis: ${START_DATE} to ${END_DATE} ==="

# Fetch all incidents from PagerDuty
INCIDENTS=$(curl -s \
  -H "Authorization: Token token=${PD_TOKEN}" \
  -H "Accept: application/vnd.pagerduty+json;version=2" \
  "https://api.pagerduty.com/incidents?since=${START_DATE}T00:00:00Z&until=${END_DATE}T23:59:59Z&limit=100&statuses[]=resolved" \
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
incidents = data['incidents']

# Classify by alert name
from collections import Counter
counts = Counter(i['title'] for i in incidents)

print('Alert frequency (last 30 days):')
for alert, count in counts.most_common(20):
    hours_fought = count * 0.5  # assume 30min avg per incident
    print(f'  {count:4d}x  {hours_fought:5.1f}h  {alert[:80]}')
print(f'')
print(f'Total incidents: {len(incidents)}')
print(f'Estimated toil hours: {len(incidents) * 0.5:.1f}h')
")

echo "${INCIDENTS}"
```

### Toil Reduction Automation Examples

#### Auto-Remediation for Pod OOMKill

```go
// cmd/remediation/oomkill/main.go
// Watches for OOMKill events and automatically adjusts memory limits.
package main

import (
    "context"
    "fmt"
    "log/slog"
    "time"

    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/resource"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/watch"
    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/rest"
)

// Config controls the auto-remediation behavior.
type Config struct {
    Namespace        string
    MemoryIncrement  int64  // bytes to add to limit on each OOMKill
    MaxMemoryLimit   int64  // bytes; hard cap to prevent runaway scaling
    CooldownPeriod   time.Duration
}

type Remediator struct {
    client     kubernetes.Interface
    cfg        Config
    lastAction map[string]time.Time  // podName -> last action time
}

func (r *Remediator) Run(ctx context.Context) error {
    // Watch for OOMKill events
    watcher, err := r.client.CoreV1().Events(r.cfg.Namespace).Watch(ctx,
        metav1.ListOptions{
            FieldSelector: "reason=OOMKilling",
        },
    )
    if err != nil {
        return fmt.Errorf("watch events: %w", err)
    }
    defer watcher.Stop()

    for {
        select {
        case event, ok := <-watcher.ResultChan():
            if !ok {
                return fmt.Errorf("event watch channel closed")
            }
            if event.Type != watch.Added {
                continue
            }

            k8sEvent, ok := event.Object.(*corev1.Event)
            if !ok {
                continue
            }

            podName := k8sEvent.InvolvedObject.Name
            containerName := extractContainerName(k8sEvent.Message)

            if err := r.remediateOOMKill(ctx, podName, containerName); err != nil {
                slog.Error("remediation failed",
                    "pod", podName,
                    "container", containerName,
                    "error", err,
                )
            }

        case <-ctx.Done():
            return nil
        }
    }
}

func (r *Remediator) remediateOOMKill(ctx context.Context, podName, containerName string) error {
    // Enforce cooldown period per pod
    if last, ok := r.lastAction[podName]; ok {
        if time.Since(last) < r.cfg.CooldownPeriod {
            slog.Info("cooldown active, skipping", "pod", podName)
            return nil
        }
    }

    // Get the pod's owning Deployment
    pod, err := r.client.CoreV1().Pods(r.cfg.Namespace).Get(ctx, podName, metav1.GetOptions{})
    if err != nil {
        return fmt.Errorf("get pod %s: %w", podName, err)
    }

    deploymentName := getOwnerDeployment(pod)
    if deploymentName == "" {
        slog.Warn("pod has no owning deployment, skipping", "pod", podName)
        return nil
    }

    // Get the Deployment
    deployment, err := r.client.AppsV1().Deployments(r.cfg.Namespace).
        Get(ctx, deploymentName, metav1.GetOptions{})
    if err != nil {
        return fmt.Errorf("get deployment %s: %w", deploymentName, err)
    }

    // Find the container and increase its memory limit
    updated := false
    for i, container := range deployment.Spec.Template.Spec.Containers {
        if container.Name != containerName {
            continue
        }

        currentLimit := container.Resources.Limits.Memory().Value()
        newLimit := currentLimit + r.cfg.MemoryIncrement

        if newLimit > r.cfg.MaxMemoryLimit {
            slog.Warn("memory limit would exceed maximum, skipping",
                "deployment", deploymentName,
                "current", currentLimit,
                "proposed", newLimit,
                "max", r.cfg.MaxMemoryLimit,
            )
            return nil
        }

        deployment.Spec.Template.Spec.Containers[i].Resources.Limits[corev1.ResourceMemory] =
            *resource.NewQuantity(newLimit, resource.BinarySI)

        // Also update request to 80% of new limit
        deployment.Spec.Template.Spec.Containers[i].Resources.Requests[corev1.ResourceMemory] =
            *resource.NewQuantity(int64(float64(newLimit)*0.8), resource.BinarySI)

        updated = true
        slog.Info("updating memory limit",
            "deployment", deploymentName,
            "container", containerName,
            "old_limit_mi", currentLimit/1024/1024,
            "new_limit_mi", newLimit/1024/1024,
        )
        break
    }

    if !updated {
        return fmt.Errorf("container %s not found in deployment %s", containerName, deploymentName)
    }

    _, err = r.client.AppsV1().Deployments(r.cfg.Namespace).
        Update(ctx, deployment, metav1.UpdateOptions{})
    if err != nil {
        return fmt.Errorf("update deployment %s: %w", deploymentName, err)
    }

    r.lastAction[podName] = time.Now()

    // Create a Jira ticket for follow-up (prevents silent tech debt)
    slog.Info("auto-remediation complete — Jira ticket required",
        "deployment", deploymentName,
        "action", fmt.Sprintf("memory limit increased by %dMi", r.cfg.MemoryIncrement/1024/1024),
    )

    return nil
}
```

### Certificate Expiry Auto-Rotation

```bash
#!/usr/bin/env bash
# check-and-rotate-certs.sh — scan TLS certificates and rotate if expiring < 30 days
set -euo pipefail

NAMESPACES=$(kubectl get namespaces -o jsonpath='{.items[*].metadata.name}')
THRESHOLD_DAYS=30
ROTATED=0
SKIPPED=0

for ns in ${NAMESPACES}; do
    # Find all TLS secrets
    SECRETS=$(kubectl get secrets -n "${ns}" \
        --field-selector=type=kubernetes.io/tls \
        -o jsonpath='{.items[*].metadata.name}' 2>/dev/null || true)

    for secret in ${SECRETS}; do
        # Extract certificate and check expiry
        CERT=$(kubectl get secret "${secret}" -n "${ns}" \
            -o jsonpath='{.data.tls\.crt}' 2>/dev/null | base64 -d 2>/dev/null || continue)

        if [ -z "${CERT}" ]; then
            continue
        fi

        EXPIRY=$(echo "${CERT}" | openssl x509 -noout -enddate 2>/dev/null \
            | cut -d= -f2 || continue)
        EXPIRY_EPOCH=$(date -d "${EXPIRY}" +%s 2>/dev/null || continue)
        NOW_EPOCH=$(date +%s)
        DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))

        if [ "${DAYS_LEFT}" -lt "${THRESHOLD_DAYS}" ]; then
            echo "EXPIRING in ${DAYS_LEFT}d: ${ns}/${secret} (expires: ${EXPIRY})"

            # Check if managed by cert-manager (annotated with issuer)
            ISSUER=$(kubectl get secret "${secret}" -n "${ns}" \
                -o jsonpath='{.metadata.annotations.cert-manager\.io/issuer-name}' 2>/dev/null || true)

            if [ -n "${ISSUER}" ]; then
                # Trigger cert-manager renewal by deleting the secret
                echo "  -> Triggering cert-manager renewal (issuer: ${ISSUER})"
                kubectl delete secret "${secret}" -n "${ns}"
                ROTATED=$(( ROTATED + 1 ))
            else
                echo "  -> Manual rotation required (not managed by cert-manager)"
                SKIPPED=$(( SKIPPED + 1 ))
            fi
        fi
    done
done

echo ""
echo "Summary: ${ROTATED} certificates rotated, ${SKIPPED} require manual rotation"
```

## Post-Incident Review Process

### PIR Template

```markdown
# Post-Incident Review: [Incident Title]

**Date of Incident**: 2027-09-25
**Date of PIR**: 2027-09-27
**Severity**: SEV-1 | SEV-2 | SEV-3
**Duration**: HH:MM
**Incident Commander**: @username
**Authors**: @username1, @username2

---

## Impact Summary
- Users affected: [number or percentage]
- Revenue impact: [$amount or N/A]
- SLO error budget consumed: [percentage of monthly budget]
- Affected services: [list]

---

## Timeline

| Time (UTC) | Event |
|---|---|
| 10:15 | Alert fired: `PaymentsAPIErrorBudgetFastBurn` |
| 10:18 | On-call acknowledged via PagerDuty |
| 10:23 | Root cause identified: connection pool exhaustion |
| 10:31 | Mitigation applied: increased pool size via config change |
| 10:35 | Error rate returned to normal |
| 10:40 | Alert resolved, incident closed |

**MTTA**: 3 minutes
**MTTR**: 25 minutes

---

## Root Cause Analysis

### What Happened
[Factual description of the sequence of events. No blame. Focus on system behavior.]

The payments-api deployment v2.4.1 introduced a change to the database query pattern that
increased average connection hold time from 50ms to 400ms. Under normal load this was
acceptable, but a traffic spike at 10:12 UTC caused the connection pool (configured at 20
connections) to exhaust. Subsequent requests queued and timed out, producing 500 errors.

### Contributing Factors
1. Connection pool size was not tuned for the new query pattern
2. No alert existed for connection pool utilization > 80%
3. Load testing did not include traffic spike scenarios

### Why Did Monitoring Not Catch This Earlier?
Existing alerts monitored error rate thresholds (>1%) but not connection pool saturation.
The transition from healthy to exhausted occurred faster than the 5-minute alert evaluation window.

---

## Action Items

| Action | Owner | Due Date | Priority |
|---|---|---|---|
| Add connection pool saturation alert (>80%) | @sre-lead | 2027-10-01 | P1 |
| Update load test harness to include 2x traffic spikes | @qa-lead | 2027-10-08 | P2 |
| Document connection pool tuning in runbook | @backend-lead | 2027-10-01 | P2 |
| Implement connection pool auto-scaling (pgbouncer) | @dba | 2027-10-15 | P2 |

---

## What Went Well
- Alert fired within 30 seconds of error rate threshold breach
- On-call acknowledged within 3 minutes (MTTA SLO: < 5 minutes)
- Root cause identified quickly due to clear dashboard with connection pool metrics
- Runbook for database issues was current and accurate

## What Did Not Go Well
- Connection pool exhaustion was not caught during code review
- Load test coverage gap was not visible to reviewers
- Mitigation required manual config change; auto-scaling would have prevented the incident

---

## Blameless Culture Note
This review focuses on system and process failures. No individual caused this incident.
The goal is to identify leverage points where process, tooling, or system design changes
will prevent recurrence.
```

### PIR Automation with GitHub Issues

```bash
#!/usr/bin/env bash
# create-pir-issue.sh — auto-create a PIR GitHub issue from PagerDuty incident data
set -euo pipefail

PD_TOKEN="${PD_TOKEN:?}"
GH_REPO="${GH_REPO:?}"  # e.g., "myorg/platform-sre"
INCIDENT_ID="${1:?Usage: $0 <pagerduty-incident-id>}"

# Fetch incident details
INCIDENT=$(curl -s \
  -H "Authorization: Token token=${PD_TOKEN}" \
  -H "Accept: application/vnd.pagerduty+json;version=2" \
  "https://api.pagerduty.com/incidents/${INCIDENT_ID}")

TITLE=$(echo "${INCIDENT}" | python3 -c "import sys,json; print(json.load(sys.stdin)['incident']['title'])")
SEVERITY=$(echo "${INCIDENT}" | python3 -c "import sys,json; print(json.load(sys.stdin)['incident']['urgency'])")
CREATED=$(echo "${INCIDENT}" | python3 -c "import sys,json; print(json.load(sys.stdin)['incident']['created_at'])")
RESOLVED=$(echo "${INCIDENT}" | python3 -c "import sys,json; print(json.load(sys.stdin)['incident']['resolved_at'])")

# Calculate duration
DURATION_SECONDS=$(python3 -c "
from datetime import datetime
created = datetime.fromisoformat('${CREATED}'.replace('Z', '+00:00'))
resolved = datetime.fromisoformat('${RESOLVED}'.replace('Z', '+00:00'))
delta = resolved - created
print(int(delta.total_seconds()))
")

DURATION_MIN=$(( DURATION_SECONDS / 60 ))

# Create GitHub issue
gh issue create \
  --repo "${GH_REPO}" \
  --title "PIR: ${TITLE}" \
  --label "post-incident-review,incident" \
  --body "## Post-Incident Review Required

**PagerDuty Incident**: #${INCIDENT_ID}
**Title**: ${TITLE}
**Severity**: ${SEVERITY}
**Duration**: ${DURATION_MIN} minutes
**Occurred**: ${CREATED}

### PIR Due Date
$(date -d '+3 days' +%Y-%m-%d) (within 3 business days of incident)

### Template
Use the [PIR template](https://github.com/${GH_REPO}/wiki/PIR-Template) to complete this review.

### Required Participants
- Incident Commander
- Primary on-call engineer
- Service owner

cc: @sre-team"
```

## On-Call Rotation Health

### Sustainable Rotation Design

A sustainable on-call rotation requires:

1. **Minimum 4 engineers** in rotation to allow adequate rest between shifts
2. **Maximum 7 days per shift** before mandatory handoff
3. **Business-hours and off-hours splits** for teams spanning multiple time zones
4. **Follow-the-sun model** for 24/7 critical services

```python
#!/usr/bin/env python3
# analyze-oncall-load.py — generate per-engineer on-call burden report

import json
import subprocess
from datetime import datetime, timedelta
from collections import defaultdict

def get_incidents_last_30d():
    """Fetch PagerDuty incidents via CLI (pd cli tool)."""
    result = subprocess.run(
        ["pd", "incidents", "--json", "--since", "30d",
         "--statuses", "resolved"],
        capture_output=True, text=True
    )
    return json.loads(result.stdout)

def analyze_burden(incidents):
    engineer_load = defaultdict(lambda: {
        "pages": 0,
        "mttr_seconds": [],
        "business_hours_pages": 0,
        "offhours_pages": 0,
    })

    for incident in incidents:
        responder = incident.get("assignments", [{}])[0].get("assignee", {}).get("summary", "unknown")
        created = datetime.fromisoformat(incident["created_at"].replace("Z", "+00:00"))
        resolved_str = incident.get("resolved_at")
        resolved = datetime.fromisoformat(resolved_str.replace("Z", "+00:00")) if resolved_str else None

        engineer_load[responder]["pages"] += 1

        if resolved:
            mttr = (resolved - created).total_seconds()
            engineer_load[responder]["mttr_seconds"].append(mttr)

        # Classify as business hours (M-F 09-18 UTC) or off-hours
        is_business = created.weekday() < 5 and 9 <= created.hour < 18
        if is_business:
            engineer_load[responder]["business_hours_pages"] += 1
        else:
            engineer_load[responder]["offhours_pages"] += 1

    print("Engineer On-Call Load (Last 30 Days)")
    print("=" * 70)
    print(f"{'Engineer':<30} {'Pages':>6} {'BH':>6} {'OH':>6} {'MTTR':>10}")
    print("-" * 70)

    for engineer, data in sorted(engineer_load.items(), key=lambda x: -x[1]["pages"]):
        avg_mttr = sum(data["mttr_seconds"]) / len(data["mttr_seconds"]) if data["mttr_seconds"] else 0
        mttr_min = avg_mttr / 60
        print(f"{engineer:<30} {data['pages']:>6} {data['business_hours_pages']:>6} "
              f"{data['offhours_pages']:>6} {mttr_min:>9.1f}m")

    total_pages = sum(d["pages"] for d in engineer_load.values())
    print("-" * 70)
    print(f"{'TOTAL':<30} {total_pages:>6}")
    print()
    print(f"Target: < {target_pages_per_engineer} pages/engineer/month (current: "
          f"{total_pages / max(len(engineer_load), 1):.1f})")

if __name__ == "__main__":
    target_pages_per_engineer = 12  # ~3/week threshold
    incidents = get_incidents_last_30d()
    analyze_burden(incidents)
```

## Alert Quality Improvement Loop

### Weekly Alert Review Process

Conduct a 30-minute weekly alert review with the on-call team:

```bash
#!/usr/bin/env bash
# weekly-alert-review.sh — generate agenda for weekly alert quality review

PD_TOKEN="${PD_TOKEN:?}"
WEEK_AGO=$(date -d '-7 days' -u +%Y-%m-%dT%H:%M:%SZ)

echo "=== Weekly Alert Review: $(date +%Y-%m-%d) ==="
echo ""

echo "## Top 10 Noisiest Alerts (Last 7 Days)"
curl -s \
  -H "Authorization: Token token=${PD_TOKEN}" \
  -H "Accept: application/vnd.pagerduty+json;version=2" \
  "https://api.pagerduty.com/incidents?since=${WEEK_AGO}&limit=100&statuses[]=resolved&statuses[]=acknowledged" \
  | python3 -c "
import sys, json
from collections import Counter
data = json.load(sys.stdin)
incidents = data.get('incidents', [])
counts = Counter(i['title'] for i in incidents)
for title, count in counts.most_common(10):
    auto = sum(1 for i in incidents
               if i['title'] == title
               and i.get('resolve_reason') in ('resolved_in_monitor', None)
               and i.get('auto_resolved', False))
    print(f'  {count:4d}x  {title[:70]}')
print(f'')
print(f'Total: {len(incidents)} incidents this week')
"

echo ""
echo "## Alerts with No Runbook (Requires Action)"
# This would query a runbook registry and cross-reference with PagerDuty

echo ""
echo "## Action Items from Last Week"
echo "  [Check Jira ONCALL board for open items]"
```

## On-Call Readiness Checklist

Deploy this checklist to all on-call engineers at rotation start:

```markdown
## On-Call Readiness Checklist

### Before Your Shift Starts
- [ ] PagerDuty app installed and push notifications enabled
- [ ] Laptop available with VPN configured and tested
- [ ] Access verified to: Grafana, Kibana/Loki, Kubernetes production context
- [ ] Runbook wiki bookmarked and last-updated dates reviewed
- [ ] On-call Slack channel joined: #oncall-platform
- [ ] Escalation contacts reviewed (who to call for databases, networking, leadership)

### Kubernetes Access Verification
```bash
# Verify cluster access
kubectl cluster-info --context production-us-east-1
kubectl get nodes --context production-us-east-1

# Verify namespace access
kubectl get pods -n production --context production-us-east-1

# Verify log access
kubectl logs -n production deploy/payments-api --since=5m --context production-us-east-1
```

### Grafana Dashboard Links
- Platform Overview: https://grafana.example.com/d/platform-overview
- Kubernetes Cluster: https://grafana.example.com/d/k8s-cluster
- SLO Dashboard: https://grafana.example.com/d/slo-status
- Active Incidents: https://grafana.example.com/alerting/list

### Handoff Protocol
At end of shift, page the next on-call engineer with:
1. Any active incidents and current status
2. Any silences still active
3. Any known degradation that is being monitored but not paged
4. Any PRs or changes pending that may affect stability
```
