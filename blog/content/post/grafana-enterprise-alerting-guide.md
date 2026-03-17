---
title: "Grafana Enterprise Alerting: Production Alert Management and Routing"
date: 2027-09-23T00:00:00-05:00
draft: false
tags: ["Grafana", "Alerting", "Monitoring", "PagerDuty", "Kubernetes"]
categories:
- Monitoring
- Grafana
author: "Matthew Mattox - mmattox@support.tools"
description: "Grafana unified alerting system covering alert rule configuration with PromQL and LogQL, notification policies, routing trees, contact point configuration for PagerDuty and Slack, silences, inhibitions, multi-dimensional alerting, Grafana OnCall integration, and migration from legacy alerting."
more_link: "yes"
url: "/grafana-enterprise-alerting-guide/"
---

Grafana's unified alerting system consolidates alert rules, contact points, and notification policies into a single configuration plane that spans Prometheus, Loki, and external data sources. For production environments, effective alert management requires more than writing PromQL expressions — it demands thoughtful routing trees, escalation policies, silence management, and integration with on-call platforms. This guide covers the complete Grafana alerting stack with production-ready configurations.

<!--more-->

# Grafana Enterprise Alerting: Production Alert Management and Routing

## Section 1: Grafana Alerting Architecture

### Components Overview

Grafana unified alerting consists of five core components:

1. **Alert Rules** — PromQL/LogQL expressions evaluated on a schedule
2. **Contact Points** — Destinations for notifications (PagerDuty, Slack, email)
3. **Notification Policies** — Routing tree that maps labels to contact points
4. **Silences** — Time-based suppression of specific label matchers
5. **Alert Groups** — Grouping of related alerts for deduplication

```bash
# Grafana alerting configuration path
# /etc/grafana/grafana.ini or Helm values

[unified_alerting]
enabled = true
execute_alerts = true

# Evaluation interval
evaluation_timeout = 30s

# HA configuration for multi-replica Grafana
ha_listen_address = 0.0.0.0:9094
ha_advertise_address = ${POD_IP}:9094
ha_peers = grafana-0.grafana-headless:9094,grafana-1.grafana-headless:9094,grafana-2.grafana-headless:9094
ha_peer_timeout = 15s
ha_gossip_interval = 200ms
ha_push_pull_interval = 60s

# External Alertmanager
[unified_alerting.alertmanager]
# Route alerts to external Alertmanager instead of built-in
send_alerts_to_alertmanager = all
```

### Grafana Helm Configuration for Alerting

```yaml
# grafana-values.yaml — alerting-focused Helm values
grafana.ini:
  unified_alerting:
    enabled: "true"
    execute_alerts: "true"
    evaluation_timeout: 30s
    max_annotations_to_keep: 100
    min_interval: 10s

  feature_toggles:
    enable: "ngalert correlations alertingBigTransactions"

  server:
    root_url: "https://grafana.example.com"

replicas: 3

resources:
  requests:
    cpu: 500m
    memory: 1Gi
  limits:
    cpu: "2"
    memory: 2Gi

persistence:
  enabled: true
  size: 10Gi

# Sidecar for automatic provisioning
sidecar:
  alerts:
    enabled: true
    label: grafana_alert
    searchNamespace: ALL
  dashboards:
    enabled: true
    label: grafana_dashboard
    searchNamespace: ALL
  datasources:
    enabled: true
    label: grafana_datasource
    searchNamespace: monitoring
```

---

## Section 2: Alert Rule Configuration

### PromQL Alert Rules

```yaml
# grafana-alert-rules-configmap.yaml
# Provisioned via Grafana sidecar or API
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-alert-rules
  namespace: monitoring
  labels:
    grafana_alert: "1"
data:
  platform-alerts.yaml: |
    apiVersion: 1
    groups:
    - orgId: 1
      name: Platform SLOs
      folder: Production Alerts
      interval: 1m
      rules:
      - uid: platform-availability-slo
        title: "Service Availability Below SLO"
        condition: C
        data:
        - refId: A
          queryType: range
          relativeTimeRange:
            from: 300
            to: 0
          datasourceUid: prometheus-production
          model:
            expr: |
              sum by (service, namespace) (
                rate(http_requests_total{code=~"5.."}[5m])
              ) /
              sum by (service, namespace) (
                rate(http_requests_total[5m])
              )
            intervalMs: 15000
            maxDataPoints: 43200
            refId: A
        - refId: C
          queryType: ""
          relativeTimeRange:
            from: 0
            to: 0
          datasourceUid: "-100"
          model:
            type: classic_conditions
            refId: C
            conditions:
            - evaluator:
                params: [0.01]
                type: gt
              operator:
                type: and
              query:
                params: [A]
              reducer:
                params: []
                type: last
              type: query
        dashboardUid: platform-overview
        panelId: 4
        noDataState: NoData
        execErrState: Error
        for: 5m
        annotations:
          summary: "{{ $labels.service }} availability below 99% SLO"
          description: "Error rate is {{ $values.A.Text }} for service {{ $labels.service }} in {{ $labels.namespace }}"
          runbook: "https://runbooks.example.com/availability"
        labels:
          severity: critical
          team: platform
          slo: availability
        isPaused: false
```

### LogQL Alert Rules for Loki

```yaml
# grafana-loki-alert-rules.yaml
apiVersion: 1
groups:
- orgId: 1
  name: Application Log Alerts
  folder: Production Alerts
  interval: 2m
  rules:
  - uid: high-error-log-rate
    title: "High Error Log Rate"
    condition: B
    data:
    - refId: A
      queryType: instant
      relativeTimeRange:
        from: 300
        to: 0
      datasourceUid: loki-production
      model:
        expr: |
          sum by (app, namespace) (
            rate({namespace=~"production|staging"} |= "ERROR" | json [5m])
          )
        instant: true
        intervalMs: 2000
        maxDataPoints: 43200
        refId: A
    - refId: B
      queryType: ""
      relativeTimeRange:
        from: 0
        to: 0
      datasourceUid: "-100"
      model:
        type: classic_conditions
        refId: B
        conditions:
        - evaluator:
            params: [10]
            type: gt
          operator:
            type: and
          query:
            params: [A]
          reducer:
            params: []
            type: last
          type: query
    noDataState: NoData
    execErrState: Error
    for: 3m
    annotations:
      summary: "High error rate in {{ $labels.app }}"
      description: "{{ $values.A.Text }} errors/sec in namespace {{ $labels.namespace }}"
    labels:
      severity: warning
      team: "{{ $labels.app }}"

  - uid: oom-kill-detected
    title: "OOM Kill Detected"
    condition: B
    data:
    - refId: A
      queryType: instant
      relativeTimeRange:
        from: 300
        to: 0
      datasourceUid: loki-production
      model:
        expr: |
          count_over_time({job="systemd-journal"} |= "oom-kill" [5m])
        instant: true
        refId: A
    - refId: B
      queryType: ""
      relativeTimeRange:
        from: 0
        to: 0
      datasourceUid: "-100"
      model:
        type: classic_conditions
        refId: B
        conditions:
        - evaluator:
            params: [0]
            type: gt
          operator:
            type: and
          query:
            params: [A]
          reducer:
            params: []
            type: last
          type: query
    noDataState: OK
    for: 0s
    annotations:
      summary: "OOM kill detected on {{ $labels.node }}"
      description: "{{ $values.A.Text }} OOM kills in the last 5 minutes"
    labels:
      severity: critical
```

---

## Section 3: Contact Points

### Multi-Channel Contact Point Configuration

```yaml
# grafana-contact-points.yaml — provisioned configuration
apiVersion: 1
contactPoints:
- orgId: 1
  name: PagerDuty Critical
  receivers:
  - uid: pagerduty-critical
    type: pagerduty
    settings:
      integrationKey: "$__env{PAGERDUTY_CRITICAL_KEY}"
      severity: critical
      autoResolve: true
      details:
        cluster: "{{ .CommonLabels.cluster }}"
        namespace: "{{ .CommonLabels.namespace }}"
        runbook: "{{ .CommonAnnotations.runbook }}"
    disableResolveMessage: false

- orgId: 1
  name: PagerDuty Warning
  receivers:
  - uid: pagerduty-warning
    type: pagerduty
    settings:
      integrationKey: "$__env{PAGERDUTY_WARNING_KEY}"
      severity: warning
      autoResolve: true
    disableResolveMessage: false

- orgId: 1
  name: Slack Platform
  receivers:
  - uid: slack-platform
    type: slack
    settings:
      url: "$__env{SLACK_PLATFORM_WEBHOOK_URL}"
      channel: "#alerts-platform"
      username: Grafana Alerts
      icon_emoji: ":grafana:"
      title: |
        [{{ .Status | toUpper }}{{ if eq .Status "firing" }} ({{ .Alerts.Firing | len }}){{ end }}] {{ .CommonLabels.alertname }}
      text: |
        {{ range .Alerts }}
        *Alert:* {{ .Annotations.summary }}
        *Namespace:* {{ .Labels.namespace | default "N/A" }}
        *Severity:* {{ .Labels.severity }}
        {{ if .Annotations.runbook }}*Runbook:* {{ .Annotations.runbook }}{{ end }}
        ---
        {{ end }}
      mentionUsers: ""
      mentionGroups: ""
      mentionChannel: "here"
    disableResolveMessage: false

- orgId: 1
  name: Slack Warnings
  receivers:
  - uid: slack-warnings
    type: slack
    settings:
      url: "$__env{SLACK_WARNINGS_WEBHOOK_URL}"
      channel: "#alerts-warnings"
      username: Grafana Alerts
      icon_emoji: ":warning:"
    disableResolveMessage: false

- orgId: 1
  name: OpsGenie
  receivers:
  - uid: opsgenie-primary
    type: opsgenie
    settings:
      apiKey: "$__env{OPSGENIE_API_KEY}"
      apiUrl: "https://api.opsgenie.com/v2/alerts"
      message: "{{ .CommonLabels.alertname }}"
      description: "{{ .CommonAnnotations.description }}"
      tags:
        cluster: "{{ .CommonLabels.cluster }}"
        namespace: "{{ .CommonLabels.namespace }}"
      priority: P1
      responders:
      - type: team
        name: platform-team
    disableResolveMessage: false

- orgId: 1
  name: Email Digest
  receivers:
  - uid: email-digest
    type: email
    settings:
      addresses: "platform-alerts@example.com;oncall@example.com"
      subject: |
        [{{ .Status | toUpper }}] {{ .CommonLabels.alertname }} - {{ .CommonLabels.cluster }}
      singleEmail: true
    disableResolveMessage: false

- orgId: 1
  name: Webhook Automation
  receivers:
  - uid: webhook-auto-remediation
    type: webhook
    settings:
      url: "http://auto-remediation.platform.svc.cluster.local:8080/webhook"
      httpMethod: POST
      maxAlerts: 10
      authorization:
        type: Bearer
        credentialsFile: /etc/grafana/webhook-token
    disableResolveMessage: false
```

---

## Section 4: Notification Policies and Routing

### Routing Tree Configuration

```yaml
# grafana-notification-policy.yaml
apiVersion: 1
policies:
- orgId: 1
  receiver: PagerDuty Warning
  group_by: [alertname, cluster, namespace]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h

  routes:
  # Critical alerts — immediate notification
  - receiver: PagerDuty Critical
    object_matchers:
    - [severity, =, critical]
    group_wait: 0s
    repeat_interval: 1h
    continue: false

  # SLO breaches — dedicated escalation path
  - receiver: PagerDuty Critical
    object_matchers:
    - [slo, =~, "availability|latency"]
    group_wait: 0s
    repeat_interval: 30m
    continue: true
  - receiver: Slack Platform
    object_matchers:
    - [slo, =~, "availability|latency"]
    continue: false

  # Node-level issues — platform team Slack
  - receiver: Slack Platform
    object_matchers:
    - [alertname, =~, "Node.*|Kubernetes.*"]
    group_by: [node, cluster]
    repeat_interval: 2h
    continue: false

  # Warning alerts
  - receiver: Slack Warnings
    object_matchers:
    - [severity, =, warning]
    repeat_interval: 8h
    continue: false

  # Auto-remediation for specific alerts
  - receiver: Webhook Automation
    object_matchers:
    - [alertname, =~, "PodCrashLooping|DiskPressure"]
    group_wait: 2m
    continue: true

  # Everything else to email
  - receiver: Email Digest
    object_matchers:
    - [severity, =~, "info|none"]
    repeat_interval: 24h
    continue: false
```

---

## Section 5: Silences and Inhibitions

### Programmatic Silence Management

```bash
#!/usr/bin/env bash
# grafana-silence.sh — create a Grafana alerting silence via API

GRAFANA_URL="${GRAFANA_URL:-https://grafana.example.com}"
GRAFANA_TOKEN="${GRAFANA_TOKEN:?GRAFANA_TOKEN must be set}"

# Create a maintenance window silence (2 hours)
START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
END=$(date -u -d "+2 hours" +%Y-%m-%dT%H:%M:%SZ)

create_silence() {
  local namespace="$1"
  local comment="$2"
  local duration_hours="${3:-2}"
  local end_time
  end_time=$(date -u -d "+${duration_hours} hours" +%Y-%m-%dT%H:%M:%SZ)

  curl -s -X POST \
    -H "Authorization: Bearer ${GRAFANA_TOKEN}" \
    -H "Content-Type: application/json" \
    "${GRAFANA_URL}/api/alertmanager/grafana/api/v2/silences" \
    -d "{
      \"matchers\": [
        {\"name\": \"namespace\", \"value\": \"${namespace}\", \"isRegex\": false, \"isEqual\": true}
      ],
      \"startsAt\": \"${START}\",
      \"endsAt\": \"${end_time}\",
      \"comment\": \"${comment}\",
      \"createdBy\": \"$(git config user.email 2>/dev/null || echo automation)\"
    }"
}

# Create silence for a deployment rollout
create_silence "production" "Deployment rollout v2.5.1 - $(date)" 1

# List active silences
list_silences() {
  curl -s \
    -H "Authorization: Bearer ${GRAFANA_TOKEN}" \
    "${GRAFANA_URL}/api/alertmanager/grafana/api/v2/silences" | \
    python3 -c "
import json, sys
silences = json.load(sys.stdin)
active = [s for s in silences if s['status']['state'] == 'active']
print(f'Active silences: {len(active)}')
for s in active:
    matchers = ', '.join(f\"{m['name']}={m['value']}\" for m in s['matchers'])
    print(f'  [{s[\"id\"][:8]}] {matchers} — {s[\"comment\"]}')
    print(f'          Ends: {s[\"endsAt\"]}')
"
}

list_silences
```

### Alert State Investigation

```bash
#!/usr/bin/env bash
# check-alert-state.sh — investigate firing alerts

GRAFANA_URL="${GRAFANA_URL:-https://grafana.example.com}"
GRAFANA_TOKEN="${GRAFANA_TOKEN:?GRAFANA_TOKEN must be set}"

# List all firing alerts
curl -s \
  -H "Authorization: Bearer ${GRAFANA_TOKEN}" \
  "${GRAFANA_URL}/api/alertmanager/grafana/api/v2/alerts?active=true&silenced=false" | \
  python3 -c "
import json, sys
alerts = json.load(sys.stdin)
print(f'Firing alerts: {len(alerts)}')
for a in sorted(alerts, key=lambda x: x['labels'].get('severity', 'info')):
    sev = a['labels'].get('severity', 'unknown')
    name = a['labels'].get('alertname', 'unknown')
    ns = a['labels'].get('namespace', '-')
    summary = a['annotations'].get('summary', 'No summary')
    print(f'  [{sev:8}] {name} ({ns}): {summary}')
"

# Get alert group details
curl -s \
  -H "Authorization: Bearer ${GRAFANA_TOKEN}" \
  "${GRAFANA_URL}/api/alertmanager/grafana/api/v2/alerts/groups" | \
  python3 -c "
import json, sys
groups = json.load(sys.stdin)
for g in groups:
    print(f'Group: {g[\"labels\"]}')
    print(f'  Alerts: {len(g[\"alerts\"])}')
    print(f'  Receiver: {g[\"receiver\"][\"name\"]}')
"
```

---

## Section 6: Multi-Dimensional Alerting

### Alert Labels for Routing and Context

```yaml
# best-practices for alert label design

# Labels used for routing:
# severity    — critical|warning|info
# team        — who owns the alert (platform|backend|data|security)
# slo         — whether this is an SLO breach (availability|latency|error-rate)
# cluster     — which cluster (injected via external labels)
# namespace   — Kubernetes namespace
# environment — production|staging

# Labels NOT to use in routing (high cardinality):
# pod         — changes with every restart; use deployment instead
# container   — too granular for routing
# instance    — changes with node replacement

# Example well-labeled alert rule:
# labels:
#   severity: critical
#   team: backend
#   slo: availability
#   component: payment-service
```

### Template-Based Alert Messages

```yaml
# grafana-alert-templates.yaml
apiVersion: 1
templates:
- orgId: 1
  name: default-message
  template: |
    {{ define "default-message" }}
    {{- if gt (len .Alerts.Firing) 0 }}
    *FIRING Alerts ({{ len .Alerts.Firing }})*
    {{ range .Alerts.Firing }}
    - *{{ .Labels.alertname }}*
      Namespace: {{ .Labels.namespace | default "N/A" }}
      Summary: {{ .Annotations.summary | default "No summary" }}
      {{ if .Annotations.runbook }}Runbook: {{ .Annotations.runbook }}{{ end }}
    {{ end }}
    {{ end }}
    {{- if gt (len .Alerts.Resolved) 0 }}
    *RESOLVED ({{ len .Alerts.Resolved }})*
    {{ range .Alerts.Resolved }}
    - *{{ .Labels.alertname }}* ({{ .Labels.namespace }})
    {{ end }}
    {{ end }}
    {{ end }}

- orgId: 1
  name: slack-rich
  template: |
    {{ define "slack-rich-title" }}
    [{{ .Status | toUpper }}{{ if eq .Status "firing" }} ({{ len .Alerts.Firing }}){{ end }}] {{ .CommonLabels.alertname }}
    {{ end }}

    {{ define "slack-rich-body" }}
    {{ range .Alerts }}
    *{{ .Annotations.summary }}*
    {{ if .Annotations.description }}{{ .Annotations.description }}{{ end }}
    Labels: {{ range $k, $v := .Labels }} `{{ $k }}={{ $v }}` {{ end }}
    {{ if .GeneratorURL }}
    <{{ .GeneratorURL }}|View in Grafana>
    {{ end }}
    {{ end }}
    {{ end }}
```

---

## Section 7: Grafana OnCall Integration

### OnCall Configuration

```yaml
# grafana-oncall-values.yaml — deploy Grafana OnCall
engine:
  replicaCount: 2
  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      cpu: "2"
      memory: 2Gi
  env:
  - name: FEATURE_TELEGRAM_LONG_POLLING_ENABLED
    value: "false"
  - name: SLACK_CLIENT_OAUTH_ID
    valueFrom:
      secretKeyRef:
        name: oncall-secrets
        key: slack-client-id

celery:
  replicaCount: 2
  resources:
    requests:
      cpu: "1"
      memory: 2Gi

redis:
  enabled: true
  architecture: replication

mariadb:
  enabled: false

externalMysql:
  host: mysql.platform.svc.cluster.local
  port: 3306
  db_name: oncall
  user: oncall
  existingSecret: oncall-db-secret
  secretKey: password
```

### OnCall Escalation Chain via API

```bash
#!/usr/bin/env bash
# configure-oncall.sh — set up OnCall escalation chains via API

ONCALL_URL="${ONCALL_URL:-https://oncall.example.com}"
ONCALL_TOKEN="${ONCALL_TOKEN:?ONCALL_TOKEN must be set}"

# Create an escalation policy
curl -s -X POST \
  -H "Authorization: ${ONCALL_TOKEN}" \
  -H "Content-Type: application/json" \
  "${ONCALL_URL}/api/v1/escalation_policies/" \
  -d '{
    "name": "Platform Critical",
    "steps": [
      {
        "type": "notify_person_next_each_time",
        "important": true,
        "duration": 300,
        "persons_to_notify": ["<user-id-1>", "<user-id-2>"]
      },
      {
        "type": "notify_group",
        "duration": 300,
        "group_to_notify": "<team-id>"
      },
      {
        "type": "trigger_webhook",
        "duration": 0,
        "webhook_url": "https://escalation.example.com/platform-critical"
      }
    ]
  }'
```

---

## Section 8: Migrating from Legacy Alerting

### Migration Checklist

```bash
#!/usr/bin/env bash
# migrate-legacy-alerts.sh — inventory legacy Grafana alerts before migration

GRAFANA_URL="${GRAFANA_URL:-https://grafana.example.com}"
GRAFANA_TOKEN="${GRAFANA_TOKEN:?GRAFANA_TOKEN must be set}"

echo "=== Legacy Alert Inventory ==="

# Count legacy alerts
LEGACY_COUNT=$(curl -s \
  -H "Authorization: Bearer ${GRAFANA_TOKEN}" \
  "${GRAFANA_URL}/api/alerts" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
echo "Legacy alerts found: ${LEGACY_COUNT}"

# List by state
curl -s \
  -H "Authorization: Bearer ${GRAFANA_TOKEN}" \
  "${GRAFANA_URL}/api/alerts?state=alerting" | \
  python3 -c "
import json, sys
alerts = json.load(sys.stdin)
print(f'Currently alerting: {len(alerts)}')
for a in alerts:
    print(f'  [{a[\"id\"]}] {a[\"name\"]} - {a[\"dashboardSlug\"]}')
"

echo ""
echo "=== Unified Alerting Rules ==="
# Count unified alerting rules
curl -s \
  -H "Authorization: Bearer ${GRAFANA_TOKEN}" \
  "${GRAFANA_URL}/api/ruler/grafana/api/v1/rules" | \
  python3 -c "
import json, sys
rules = json.load(sys.stdin)
total = sum(len(v) for folder in rules.values() for v in folder.values())
print(f'Unified alert rules: {total}')
"
```

### Grafana Dashboard Alert Panel Migration

```python
#!/usr/bin/env python3
# convert-dashboard-alerts.py — convert legacy dashboard alerts to unified rules

import json
import sys
import yaml
import requests
from datetime import datetime

GRAFANA_URL = "https://grafana.example.com"
GRAFANA_TOKEN = "Bearer <token>"  # set via environment variable in practice

def get_legacy_alerts():
    resp = requests.get(
        f"{GRAFANA_URL}/api/alerts",
        headers={"Authorization": GRAFANA_TOKEN}
    )
    resp.raise_for_status()
    return resp.json()

def convert_to_unified_rule(alert):
    """Convert a legacy alert to Grafana unified alerting format."""
    return {
        "uid": f"migrated-{alert['id']}",
        "title": alert["name"],
        "condition": "C",
        "data": [
            {
                "refId": "A",
                "queryType": "range",
                "relativeTimeRange": {"from": 300, "to": 0},
                "datasourceUid": alert.get("datasourceId", ""),
                "model": {
                    "expr": alert.get("settings", {}).get("query", ""),
                    "refId": "A"
                }
            }
        ],
        "noDataState": "NoData",
        "execErrState": "Error",
        "for": f"{alert.get('for', 300)}s",
        "annotations": {
            "summary": alert["name"],
            "migrated_from_id": str(alert["id"]),
            "migrated_at": datetime.utcnow().isoformat()
        },
        "labels": {
            "severity": "warning",
            "migrated": "true"
        }
    }

def main():
    alerts = get_legacy_alerts()
    print(f"Found {len(alerts)} legacy alerts to migrate")

    rules = [convert_to_unified_rule(a) for a in alerts]

    # Write to YAML for review before applying
    output = {
        "apiVersion": 1,
        "groups": [
            {
                "orgId": 1,
                "name": "Migrated Legacy Alerts",
                "folder": "Migrated",
                "interval": "1m",
                "rules": rules
            }
        ]
    }

    with open("migrated-alerts.yaml", "w") as f:
        yaml.dump(output, f, default_flow_style=False)

    print("Migration written to migrated-alerts.yaml")
    print("Review before applying with: kubectl apply -f migrated-alerts.yaml")

if __name__ == "__main__":
    main()
```

---

## Section 9: Alert Quality and Noise Reduction

### Alert Effectiveness Metrics

```promql
# PromQL queries for alert quality monitoring

# Alert firing rate by severity (should be low for critical/warning)
sum by (severity) (
  rate(grafana_alerting_rule_evaluations_total{state="firing"}[24h])
)

# Alert flap rate (alerts that fire and resolve quickly)
# High flap rate indicates poor thresholds
sum by (alertname) (
  changes(ALERTS{alertstate="firing"}[1h])
) > 3

# Alert resolution time (how long alerts stay firing)
sum by (alertname) (
  last_over_time(ALERTS{alertstate="firing"}[24h])
) / count by (alertname) (
  last_over_time(ALERTS{alertstate="firing"}[24h])
)
```

### Recommended Alert Hygiene Rules

```yaml
# alert-policy-checklist.yaml
# Every alert MUST have:
# 1. A clear, actionable summary annotation
# 2. A runbook annotation pointing to a real runbook
# 3. A severity label (critical/warning/info)
# 4. A team label for routing
# 5. A minimum 'for' duration of at least 1m (avoid transient spikes)

# Alert SHOULD NOT:
# - Fire for events that require no human action
# - Have no resolution path (if no action exists, it shouldn't alert)
# - Use high-cardinality label values (pod names, request IDs)
# - Alert on symptoms instead of impact (prefer user-facing metrics)

# Alert tuning workflow:
# 1. Deploy with severity=info and no routing
# 2. Observe firing patterns over 1 week
# 3. Adjust thresholds based on actual signal vs noise
# 4. Promote to warning with routing when signal is reliable
# 5. Promote to critical only when consistent human action is required
```

Grafana unified alerting provides a consolidated view across all data sources but requires careful design to avoid alert fatigue. The routing tree, contact point configuration, and silence management patterns in this guide establish a production-grade alert management system that scales from a single cluster to a multi-region, multi-team environment. The most critical investment is in alert quality — an alert that fires without a clear action or runbook represents noise that erodes on-call engineer trust in the entire alerting system.
