---
title: "Grafana Unified Alerting: Migration from Legacy Alerts and Production Alert Management"
date: 2030-09-05T00:00:00-05:00
draft: false
tags: ["Grafana", "Alerting", "Prometheus", "Loki", "Observability", "Monitoring", "SRE"]
categories:
- Monitoring
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise Grafana alerting guide covering Unified Alerting architecture, alert rules with Prometheus, Loki, and external datasources, contact points and notification policies, silences, mute timings, and migrating from legacy Grafana alerts."
more_link: "yes"
url: "/grafana-unified-alerting-migration-production-management/"
---

Grafana's Unified Alerting (introduced in Grafana 8.0 and made default in Grafana 9.0) represents a complete architectural replacement of the legacy Grafana alerting system. The unified engine moves alert evaluation out of individual dashboard panels and into a dedicated scheduler, introduces multi-dimensional alerts (one rule producing multiple alert instances), and provides native Alertmanager integration for notification routing. For teams running legacy Grafana alerts, the migration is non-optional — legacy alerts reached end-of-support and their backend was removed in Grafana 11. This guide covers the full architecture, alert rule design across datasources, notification pipeline configuration, and the complete migration process from legacy alerts.

<!--more-->

## Unified Alerting Architecture

### Alert Rule Evaluation Engine

In Unified Alerting, alert rules are evaluated by a dedicated scheduler embedded in the Grafana backend. This replaces the legacy system where evaluations were tied to dashboard panels. Key architectural properties:

- Rules are stored in the Grafana database (SQLite or PostgreSQL/MySQL), not in dashboard JSON.
- Each rule belongs to a **folder** (analogous to a namespace) and a **group** (controls evaluation frequency).
- All rules in a group share a single evaluation interval. Rules are evaluated serially within a group, in parallel across groups.
- Rule evaluation produces **alert instances** — one per unique combination of label values in the query result.

### Alertmanager Integration

Grafana Unified Alerting ships with a built-in Alertmanager that handles routing, grouping, silencing, and notification dispatch. It can operate in three modes:

1. **Internal Alertmanager only** (default): Uses the built-in Alertmanager. State is stored in Grafana's database.
2. **External Alertmanager only**: Routes all alerts to an external Alertmanager (e.g., the kube-prometheus-stack Alertmanager). Grafana does not handle notifications.
3. **Both**: Sends alerts to both internal and external Alertmanagers. Useful during migration.

Configure Alertmanager mode in `grafana.ini`:

```ini
[unified_alerting]
enabled = true
execute_alerts = true
evaluation_timeout = 30s
max_annotations_to_keep = 100
min_interval = 10s
screenshots_capture = false

[unified_alerting.ha]
listen_address = "0.0.0.0:9094"
advertise_address = ""
peers = ""
peer_timeout = 15s

[alerting]
enabled = false  # Disable legacy alerting when unified alerting is enabled
```

### State Machine

Alert instances transition through the following states:

```
Normal → Pending → Firing → Normal
              ↓
           NoData
              ↓
           Error
```

- **Normal**: Query returns data below the threshold.
- **Pending**: Threshold exceeded but `for` duration not yet elapsed. No notification sent.
- **Firing**: Threshold exceeded for the full `for` duration. Notification sent.
- **NoData**: Query returns no data series (configurable action: Alert, NoData, or OK).
- **Error**: Query execution failed (configurable action: Alert, Error, or OK).

## Creating Alert Rules

### Prometheus Datasource Rules

```yaml
# Alert rules can be managed as Grafana-provisioned resources
# grafana/provisioning/alerting/prometheus-rules.yaml

apiVersion: 1
groups:
  - orgId: 1
    name: kubernetes-resources
    folder: kubernetes
    interval: 1m
    rules:
      - uid: kube-cpu-throttling
        title: "Container CPU Throttling High"
        condition: C
        data:
          - refId: A
            relativeTimeRange:
              from: 300
              to: 0
            datasourceUid: prometheus
            model:
              expr: |
                sum by (namespace, pod, container) (
                  rate(container_cpu_cfs_throttled_seconds_total[5m])
                ) /
                sum by (namespace, pod, container) (
                  rate(container_cpu_cfs_periods_total[5m])
                ) * 100
              intervalMs: 15000
              maxDataPoints: 43200
              refId: A
          - refId: B
            relativeTimeRange:
              from: 300
              to: 0
            datasourceUid: "__expr__"
            model:
              conditions:
                - evaluator:
                    params: []
                    type: gt
                  operator:
                    type: and
                  query:
                    params:
                      - B
                  reducer:
                    params: []
                    type: last
                  type: query
              datasource:
                type: __expr__
                uid: "__expr__"
              expression: A
              refId: B
              type: reduce
              reducer: last
          - refId: C
            relativeTimeRange:
              from: 300
              to: 0
            datasourceUid: "__expr__"
            model:
              conditions:
                - evaluator:
                    params:
                      - 25
                    type: gt
                  operator:
                    type: and
                  query:
                    params:
                      - C
                  reducer:
                    params: []
                    type: last
                  type: query
              datasource:
                type: __expr__
                uid: "__expr__"
              expression: B
              refId: C
              type: threshold
        noDataState: NoData
        execErrState: Error
        for: 5m
        annotations:
          summary: "Container {{ $labels.container }} in pod {{ $labels.pod }} is heavily CPU throttled"
          description: "CPU throttling {{ $value | printf \"%.1f\" }}% exceeds 25% threshold for container {{ $labels.container }} in namespace {{ $labels.namespace }}"
          runbook_url: "https://runbooks.example.com/cpu-throttling"
        labels:
          severity: warning
          team: platform
          category: resource
        isPaused: false
```

### Loki Datasource Rules (Log-Based Alerts)

```yaml
# Log-based alert: fire when error rate in logs exceeds threshold
- uid: loki-error-rate
  title: "Application Error Rate High"
  condition: C
  data:
    - refId: A
      relativeTimeRange:
        from: 300
        to: 0
      datasourceUid: loki
      model:
        expr: |
          sum(rate({namespace="production", app=~".+"} |= "level=error" [5m])) by (app)
        queryType: range
        refId: A
        legendFormat: "{{app}}"
    - refId: B
      datasourceUid: "__expr__"
      model:
        expression: A
        refId: B
        type: reduce
        reducer: last
    - refId: C
      datasourceUid: "__expr__"
      model:
        expression: B
        refId: C
        type: threshold
        conditions:
          - evaluator:
              params:
                - 10
              type: gt
  for: 3m
  annotations:
    summary: "High error rate in {{ $labels.app }}"
    description: "{{ $labels.app }} is producing {{ $value | printf \"%.1f\" }} errors/sec"
  labels:
    severity: warning
    datasource: loki
```

### Multi-Condition Alerts with Math Expressions

Grafana Unified Alerting supports expression chaining, enabling alerts that combine multiple queries:

```yaml
# Alert fires when BOTH CPU utilization is high AND memory utilization is high
data:
  - refId: CPU
    datasourceUid: prometheus
    model:
      expr: |
        avg by (instance) (
          100 - (avg by (instance) (irate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)
        )

  - refId: MEM
    datasourceUid: prometheus
    model:
      expr: |
        (1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100

  - refId: CPU_THRESHOLD
    datasourceUid: "__expr__"
    model:
      type: threshold
      expression: CPU
      conditions:
        - evaluator:
            params: [80]
            type: gt

  - refId: MEM_THRESHOLD
    datasourceUid: "__expr__"
    model:
      type: threshold
      expression: MEM
      conditions:
        - evaluator:
            params: [85]
            type: gt

  - refId: COMBINED
    datasourceUid: "__expr__"
    model:
      type: math
      expression: "$CPU_THRESHOLD && $MEM_THRESHOLD"
```

## Contact Points

Contact points define how and where to send alert notifications. Grafana supports email, Slack, PagerDuty, OpsGenie, VictorOps, Webhook, and many others.

```yaml
# grafana/provisioning/alerting/contact-points.yaml
apiVersion: 1
contactPoints:
  - orgId: 1
    name: platform-oncall-pagerduty
    receivers:
      - uid: pd-platform
        type: pagerduty
        settings:
          integrationKey: <pagerduty-integration-key>
          severity: critical
          class: kubernetes
          component: "{{ .Labels.app }}"
          group: "{{ .Labels.namespace }}"
          summary: "{{ .Annotations.summary }}"

  - orgId: 1
    name: platform-slack-warnings
    receivers:
      - uid: slack-platform-warnings
        type: slack
        settings:
          url: https://hooks.slack.com/services/<WORKSPACE_ID>/<CHANNEL_ID>/<WEBHOOK_TOKEN>
          channel: "#platform-alerts"
          username: "Grafana Alerting"
          title: |
            {{ if eq .Status "firing" }}:fire:{{ else }}:white_check_mark:{{ end }}
            {{ .GroupLabels.alertname }}
          text: |
            *Summary:* {{ .Annotations.summary }}
            *Severity:* {{ .Labels.severity }}
            *Namespace:* {{ .Labels.namespace }}
            {{ if .Annotations.runbook_url }}*Runbook:* {{ .Annotations.runbook_url }}{{ end }}
          iconEmoji: ":grafana:"

  - orgId: 1
    name: email-database-team
    receivers:
      - uid: email-db
        type: email
        settings:
          addresses: "database-oncall@example.com"
          subject: |
            [{{ .Status | toUpper }}] {{ .GroupLabels.alertname }} - {{ .Labels.severity }}
          message: |
            Alert: {{ .GroupLabels.alertname }}
            Status: {{ .Status }}
            Severity: {{ .Labels.severity }}

            {{ range .Alerts }}
            Summary: {{ .Annotations.summary }}
            Description: {{ .Annotations.description }}
            {{ end }}

  - orgId: 1
    name: webhook-custom
    receivers:
      - uid: webhook-incident
        type: webhook
        settings:
          url: "https://incident-manager.example.com/api/v1/alert"
          httpMethod: POST
          basicAuthUser: "grafana-alert"
          basicAuthPassword: <webhook-password>
          maxAlerts: 100
```

## Notification Policies

Notification policies control how alert instances are routed to contact points. They form a tree — alerts flow down from the default policy through matchers to find the most specific matching policy.

```yaml
# grafana/provisioning/alerting/notification-policies.yaml
apiVersion: 1
policies:
  - orgId: 1
    receiver: platform-slack-warnings    # Default receiver for all alerts
    group_by:
      - alertname
      - namespace
    group_wait: 30s
    group_interval: 5m
    repeat_interval: 4h
    routes:
      # Critical alerts → PagerDuty immediately
      - receiver: platform-oncall-pagerduty
        matchers:
          - name: severity
            value: critical
            isEqual: true
        group_by:
          - alertname
          - namespace
          - pod
        group_wait: 10s
        group_interval: 1m
        repeat_interval: 1h
        continue: false

      # Database team alerts → email
      - receiver: email-database-team
        matchers:
          - name: team
            value: database
            isEqual: true
        group_wait: 1m
        group_interval: 10m
        repeat_interval: 6h
        continue: true   # Also send to default (Slack)

      # Suppressed: non-production environments
      - receiver: "null"
        matchers:
          - name: env
            value: development|staging
            isRegexp: true
        continue: false
```

### Understanding Notification Policy Routing

The routing algorithm:

1. Start at the root policy.
2. Test each `routes` entry in order.
3. If a route matches and `continue: false`, stop at that route.
4. If a route matches and `continue: true`, send to that route AND continue testing remaining routes.
5. If no route matches, use the root policy's receiver.

## Silences

Silences suppress notifications for matching alerts without changing alert state. They are useful for planned maintenance, known issues awaiting fix, and alert tuning during initial deployment.

```yaml
# Create a silence via API
curl -X POST \
  "https://grafana.example.com/api/alertmanager/grafana/api/v2/silences" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <grafana-api-token>" \
  -d '{
    "matchers": [
      {
        "name": "namespace",
        "value": "staging",
        "isRegex": false,
        "isEqual": true
      }
    ],
    "startsAt": "2030-09-05T00:00:00Z",
    "endsAt": "2030-09-05T06:00:00Z",
    "createdBy": "platform-team",
    "comment": "Staging maintenance window 00:00-06:00 UTC"
  }'
```

```bash
# List active silences
curl -s "https://grafana.example.com/api/alertmanager/grafana/api/v2/silences" \
  -H "Authorization: Bearer <grafana-api-token>" | jq '.[] | select(.status.state == "active")'

# Delete a silence
SILENCE_ID="abc12345-1234-1234-1234-123456789abc"
curl -X DELETE \
  "https://grafana.example.com/api/alertmanager/grafana/api/v2/silence/${SILENCE_ID}" \
  -H "Authorization: Bearer <grafana-api-token>"
```

## Mute Timings

Mute timings define recurring time windows during which notifications are suppressed. Unlike silences (which are ad-hoc), mute timings are recurring schedules — ideal for business hours-only alerting or weekend suppression.

```yaml
# grafana/provisioning/alerting/mute-timings.yaml
apiVersion: 1
muteTimes:
  - orgId: 1
    name: weekends
    time_intervals:
      - weekdays:
          - saturday
          - sunday

  - orgId: 1
    name: business-hours-only
    time_intervals:
      - weekdays:
          - monday:friday
        times:
          - start_time: "09:00"
            end_time: "17:00"
        location: "America/New_York"

  - orgId: 1
    name: maintenance-window-weekly
    time_intervals:
      - weekdays:
          - sunday
        times:
          - start_time: "02:00"
            end_time: "06:00"
        location: "UTC"
```

Associate mute timings with notification policies:

```yaml
routes:
  - receiver: platform-slack-warnings
    matchers:
      - name: severity
        value: warning
    mute_time_intervals:
      - weekends
      - business-hours-only
```

## Migrating from Legacy Grafana Alerts

### Pre-Migration Assessment

```bash
# Export all legacy alert rules via API
curl -s "https://grafana.example.com/api/alerts" \
  -H "Authorization: Bearer <grafana-api-token>" \
  | jq '[.[] | {id, dashboardId, panelId, name, state, conditions: .settings.conditions}]' \
  > legacy-alerts-inventory.json

# Count legacy alerts
jq 'length' legacy-alerts-inventory.json
```

### Migration Tool

Grafana ships a built-in migration assistant at **Alerting → Legacy alerts → Migrate**. For automated/scripted migration:

```bash
# Grafana 10/11 migration API
# This migrates all legacy dashboard alerts to unified alerting rules
curl -X POST \
  "https://grafana.example.com/api/admin/provisioningMigration" \
  -H "Authorization: Bearer <grafana-api-token>" \
  -H "Content-Type: application/json" \
  -d '{"skipExistingNewAlerts": false}'
```

### Manual Migration: Panel Alert → Unified Rule

Legacy panel alerts embed alert conditions directly in dashboard JSON:

```json
{
  "alert": {
    "alertRuleTags": {},
    "conditions": [
      {
        "evaluator": {"params": [90], "type": "gt"},
        "operator": {"type": "and"},
        "query": {"datasourceId": 1, "model": {"expr": "..."}, "params": ["A", "5m", "now"]},
        "reducer": {"params": [], "type": "avg"},
        "type": "query"
      }
    ],
    "executionErrorState": "alerting",
    "for": "5m",
    "frequency": "1m",
    "handler": 1,
    "message": "CPU is high",
    "name": "High CPU Alert",
    "noDataState": "no_data",
    "notifications": [{"id": 3}]
  }
}
```

Equivalent Unified Alerting rule:

```yaml
- uid: migrated-high-cpu
  title: "High CPU Alert"
  condition: THRESHOLD
  data:
    - refId: A
      datasourceUid: prometheus
      model:
        expr: "avg(rate(node_cpu_seconds_total{mode!='idle'}[5m])) * 100"
    - refId: REDUCE
      datasourceUid: "__expr__"
      model:
        type: reduce
        expression: A
        reducer: mean
    - refId: THRESHOLD
      datasourceUid: "__expr__"
      model:
        type: threshold
        expression: REDUCE
        conditions:
          - evaluator:
              params: [90]
              type: gt
  noDataState: NoData
  execErrState: Error
  for: 5m
  annotations:
    summary: "CPU is high"
  labels:
    severity: warning
    migrated_from_legacy: "true"
```

### Migration Validation

After migrating, validate that the new rules are evaluating and firing as expected:

```bash
# Check rule evaluation state via API
curl -s "https://grafana.example.com/api/prometheus/grafana/api/v1/rules" \
  -H "Authorization: Bearer <grafana-api-token>" \
  | jq '.data.groups[].rules[] | {name: .name, state: .state, health: .health}'

# Verify no rules are in Error state
curl -s "https://grafana.example.com/api/prometheus/grafana/api/v1/rules" \
  -H "Authorization: Bearer <grafana-api-token>" \
  | jq '[.data.groups[].rules[] | select(.health == "err")] | length'
```

### Running Legacy and Unified Alerting in Parallel

During migration, run both systems temporarily to validate parity:

```ini
# grafana.ini — parallel mode
[unified_alerting]
enabled = true

[alerting]
enabled = true   # Keep legacy enabled during parallel validation period
```

After verifying unified rules match legacy alert behavior:

```ini
[alerting]
enabled = false   # Disable legacy alerting permanently
```

## Production Alert Rule Organization

### Folder Structure

```
Alerting Folders
├── kubernetes/
│   ├── control-plane (group: 1m interval)
│   ├── workloads (group: 1m interval)
│   └── storage (group: 2m interval)
├── infrastructure/
│   ├── nodes (group: 1m interval)
│   └── networking (group: 2m interval)
├── applications/
│   ├── checkout-service (group: 1m interval)
│   └── payment-service (group: 1m interval)
└── slo/
    ├── error-budget (group: 5m interval)
    └── latency (group: 5m interval)
```

### Alert Labeling Strategy

Consistent labels enable flexible routing without modifying notification policies:

```yaml
labels:
  severity: critical|warning|info
  team: platform|database|application|security
  category: resource|availability|latency|error-rate|security
  env: production|staging|development
  namespace: "{{ $labels.namespace }}"
  service: "{{ $labels.app }}"
```

## Provisioning with Terraform

For infrastructure-as-code management of Grafana alerting:

```hcl
# terraform/grafana-alerting.tf
terraform {
  required_providers {
    grafana = {
      source  = "grafana/grafana"
      version = ">= 3.0"
    }
  }
}

resource "grafana_folder" "kubernetes_alerts" {
  title = "Kubernetes Alerts"
}

resource "grafana_rule_group" "kubernetes_workloads" {
  name             = "workloads"
  folder_uid       = grafana_folder.kubernetes_alerts.uid
  interval_seconds = 60
  org_id           = 1

  rule {
    name           = "PodCrashLooping"
    condition      = "C"
    no_data_state  = "NoData"
    exec_err_state = "Error"
    for            = "5m"

    labels = {
      severity = "warning"
      team     = "platform"
    }

    annotations = {
      summary     = "Pod {{ $labels.namespace }}/{{ $labels.pod }} is crash looping"
      description = "Pod has restarted {{ $value }} times in the last 10 minutes"
      runbook_url = "https://runbooks.example.com/pod-crash-looping"
    }

    data {
      ref_id = "A"
      relative_time_range {
        from = 600
        to   = 0
      }
      datasource_uid = "prometheus"
      model = jsonencode({
        expr = "increase(kube_pod_container_status_restarts_total[10m]) > 3"
        refId = "A"
      })
    }

    data {
      ref_id         = "B"
      datasource_uid = "__expr__"
      model = jsonencode({
        refId      = "B"
        type       = "reduce"
        expression = "A"
        reducer    = "last"
      })
    }

    data {
      ref_id         = "C"
      datasource_uid = "__expr__"
      model = jsonencode({
        refId = "C"
        type  = "threshold"
        expression = "B"
        conditions = [{
          evaluator = { params = [0], type = "gt" }
        }]
      })
    }
  }
}

resource "grafana_contact_point" "pagerduty" {
  name = "platform-oncall"

  pagerduty {
    integration_key = var.pagerduty_integration_key
    severity        = "critical"
    class           = "kubernetes"
    component       = "{{ .Labels.app }}"
    group           = "{{ .Labels.namespace }}"
  }
}

resource "grafana_notification_policy" "root" {
  contact_point = grafana_contact_point.pagerduty.name
  group_by      = ["alertname", "namespace"]

  policy {
    matcher {
      label = "severity"
      match = "="
      value = "critical"
    }
    contact_point   = grafana_contact_point.pagerduty.name
    group_wait      = "10s"
    group_interval  = "1m"
    repeat_interval = "1h"
  }
}
```

## Alerting Best Practices

### Reducing Alert Fatigue

1. **Use `for` durations**: Never fire immediately on a single data point. Minimum `for: 2m` for resource-based alerts, `for: 5m` for infrastructure alerts.

2. **Group alerts intelligently**: Group by `alertname + namespace` rather than individual pod names to receive one notification per issue, not one per Pod.

3. **Use `repeat_interval` strategically**: Critical alerts: 1h repeat. Warning alerts: 4-6h repeat. Info alerts: 24h or no repeat.

4. **Leverage severity tiers**: Define clear distinctions between critical (page immediately, SLA impact), warning (next business day), and info (weekly digest).

5. **Implement inhibition rules**: Suppress lower-severity alerts when higher-severity alerts are active on the same component.

```yaml
# Inhibition: suppress warning when critical fires for same namespace
inhibit_rules:
  - source_matchers:
      - severity = critical
    target_matchers:
      - severity = warning
    equal:
      - namespace
      - alertname
```

## Summary

Grafana Unified Alerting provides a significantly more capable and operationally manageable alerting system than the legacy dashboard-panel-based approach. The key migration principles are: export and inventory all legacy alerts before migrating, run both systems in parallel during validation, and adopt a consistent labeling taxonomy that enables notification policy routing without per-alert contact point configuration. Provisioning alert rules, contact points, and notification policies as code (via YAML provisioning or Terraform) ensures reproducibility across environments and enables peer review of alerting changes. The combination of multi-dimensional alerts, flexible routing, mute timings, and Alertmanager-compatible silences makes Unified Alerting a production-grade foundation for observability pipelines at enterprise scale.
