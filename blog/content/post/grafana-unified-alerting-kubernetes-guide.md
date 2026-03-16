---
title: "Grafana Unified Alerting: Enterprise Alert Management on Kubernetes"
date: 2027-03-22T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Grafana", "Alerting", "Prometheus", "Observability"]
categories: ["Kubernetes", "Observability", "Alerting"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Grafana Unified Alerting on Kubernetes, covering alert rule provisioning via ConfigMaps, contact points (Slack, PagerDuty, webhook), notification policies, silences, multi-dimensional alerting with label matchers, recording rules, and GitOps management with Terraform."
more_link: "yes"
url: "/grafana-unified-alerting-kubernetes-guide/"
---

Grafana Unified Alerting consolidates alert rule management, contact point configuration, and notification policy routing into a single interface that works across multiple data sources simultaneously. Unlike the legacy per-dashboard alerting system, Unified Alerting evaluates rules on a centralized scheduler, supports multi-dimensional alerts with label-based routing, and provides a GitOps-friendly provisioning API that integrates with Terraform and file-based configuration management. This guide covers the complete production deployment of Grafana Unified Alerting on Kubernetes, from Helm configuration through provisioning, GitOps workflows, and Grafana OnCall integration.

<!--more-->

## Unified Alerting vs Legacy Dashboard Alerts

### Architecture Comparison

| Aspect | Legacy Dashboard Alerts | Unified Alerting |
|---|---|---|
| Rule storage | Stored in dashboard JSON | Dedicated alert rule database |
| Data source support | Single data source per alert | Multi-datasource, multi-query |
| Rule evaluation | Per-dashboard scheduler | Centralized scheduler |
| Label propagation | No label support | Full label-based dimensions |
| Notification routing | Per-alert channel | Policy tree with label matching |
| State history | Dashboard annotations | Dedicated state history in Loki |
| GitOps provisioning | Manual export | File provisioning / Terraform |
| Silences | Not supported | Full silence API |

### Multi-Dimensional Alerting

Unified Alerting fires one alert instance per unique label combination. A single rule like "pod restart rate is high" creates individual alert instances for each pod, each with its own state lifecycle.

```
Rule: "PodHighRestartRate"
Query result:
  {pod="api-server-abc", namespace="production"} → 3.2 restarts/min → FIRING
  {pod="api-server-def", namespace="production"} → 0.1 restarts/min → OK
  {pod="worker-xyz", namespace="staging"}        → 0.8 restarts/min → PENDING
```

Each firing instance carries its own labels, enabling routing policies to distinguish between production and staging, or between different teams responsible for different pods.

## Grafana Helm Configuration for Unified Alerting

### Core Helm Values

```yaml
# grafana-values.yaml
grafana:
  image:
    repository: grafana/grafana
    tag: 10.4.0

  # Grafana configuration via grafana.ini
  grafana.ini:
    # Enable Unified Alerting (mandatory for Grafana 9+; legacy alerting is removed)
    alerting:
      enabled: false               # disable legacy alerting engine
    unified_alerting:
      enabled: true
      # Evaluation group concurrency
      max_attempts: 3
      min_interval: 10s            # minimum evaluation interval
      # HA: use a shared database for alert state when running multiple replicas
      ha_listen_address: "0.0.0.0:9094"
      ha_peer_timeout: 15s
      ha_reconnect_timeout: 2m

    # External URL for links in notifications
    server:
      root_url: "https://grafana.support.tools"
      domain: "grafana.support.tools"

    # Database for alert state persistence
    database:
      type: postgres
      host: "postgres.monitoring.svc.cluster.local:5432"
      name: grafana
      user: grafana
      password: "${GF_DATABASE_PASSWORD}"
      ssl_mode: require

    # State history backend (requires Loki)
    unified_alerting.state_history:
      enabled: true
      backend: loki
      loki_remote_url: "http://loki-gateway.monitoring.svc.cluster.local/loki/api/v1/push"

    # Provisioning configuration
    paths:
      provisioning: /etc/grafana/provisioning

  # Mount provisioning ConfigMaps
  extraConfigmapMounts:
    - name: grafana-alert-rules
      mountPath: /etc/grafana/provisioning/alerting
      configMap: grafana-alert-rules
      readOnly: true

    - name: grafana-contact-points
      mountPath: /etc/grafana/provisioning/alerting/contact-points
      configMap: grafana-contact-points
      readOnly: true

    - name: grafana-notification-policies
      mountPath: /etc/grafana/provisioning/alerting/policies
      configMap: grafana-notification-policies
      readOnly: true

  # HA: 2 replicas sharing PostgreSQL alert state
  replicas: 2

  # Persistent storage for dashboards (alert rules are in DB)
  persistence:
    enabled: true
    storageClassName: gp3
    size: 10Gi

  resources:
    requests:
      cpu: 250m
      memory: 512Mi
    limits:
      cpu: 1000m
      memory: 1Gi
```

## Alert Rule Anatomy

### Rule Structure

A Grafana alert rule consists of:

1. **Query**: One or more queries against configured data sources
2. **Condition**: Expression evaluated against query results (threshold, reduce, math)
3. **Pending period**: How long the condition must be true before firing
4. **Annotations**: Human-readable metadata for notifications
5. **Labels**: Key-value pairs for routing and grouping

### Expression Types

```
Query A:  [Prometheus query]         → time series data
          ↓
Reduce B: [reduce A, function=last]  → scalar per label set
          ↓
Threshold C: [B > 5]                 → boolean per label set (FIRING/OK)
```

## Provisioning Alert Rules via ConfigMap

### ConfigMap: Infrastructure Alert Rules

```yaml
# grafana-alert-rules-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-alert-rules
  namespace: monitoring
data:
  infrastructure-rules.yaml: |
    apiVersion: 1
    groups:
      - orgId: 1
        name: Infrastructure
        folder: Infrastructure Alerts
        interval: 1m
        rules:
          # Node memory pressure alert
          - uid: node-memory-pressure-001
            title: Node Memory Utilization High
            condition: C
            for: 5m
            labels:
              severity: warning
              team: platform
              component: node
            annotations:
              summary: "Node {{ $labels.node }} memory utilization exceeds 85%"
              description: |
                Node {{ $labels.node }} in cluster {{ $labels.cluster }} is using
                {{ $values.B | humanizePercentage }} of available memory.
                Current usage: {{ $values.B.Value | humanize }}%
              runbook_url: "https://runbooks.support.tools/platform/node-memory-pressure"
            data:
              - refId: A
                datasourceUid: prometheus-prod
                model:
                  expr: |
                    (
                      1 - (
                        node_memory_MemAvailable_bytes
                        / node_memory_MemTotal_bytes
                      )
                    ) * 100
                  legendFormat: "{{ node }}"
                  intervalMs: 15000
                  maxDataPoints: 43200

              - refId: B
                datasourceUid: "__expr__"
                model:
                  conditions:
                    - evaluator:
                        params: []
                        type: gt
                      operator:
                        type: and
                      query:
                        params: [A]
                      reducer:
                        type: last
                      type: query
                  datasource:
                    type: __expr__
                    uid: "__expr__"
                  expression: A
                  reducer: last
                  type: reduce

              - refId: C
                datasourceUid: "__expr__"
                model:
                  conditions:
                    - evaluator:
                        params: [85]
                        type: gt
                      operator:
                        type: and
                      query:
                        params: [B]
                      reducer:
                        type: last
                      type: query
                  datasource:
                    type: __expr__
                    uid: "__expr__"
                  expression: B
                  type: threshold

          # Pod crash loop alert (multi-dimensional)
          - uid: pod-crash-loop-001
            title: Pod CrashLooping
            condition: C
            for: 2m
            labels:
              severity: warning
              team: "{{ $labels.team }}"      # inherit from metric labels
            annotations:
              summary: "Pod {{ $labels.pod }} in {{ $labels.namespace }} is crash looping"
              description: |
                Pod {{ $labels.pod }} has restarted {{ $values.B.Value | int }} times
                in the last 15 minutes. Check container logs for root cause.
              runbook_url: "https://runbooks.support.tools/kubernetes/crashloopbackoff"
            data:
              - refId: A
                datasourceUid: prometheus-prod
                model:
                  expr: |
                    increase(
                      kube_pod_container_status_restarts_total{
                        namespace!~"kube-system|monitoring"
                      }[15m]
                    )
                  legendFormat: "{{ namespace }}/{{ pod }}"
                  intervalMs: 60000
                  maxDataPoints: 100

              - refId: B
                datasourceUid: "__expr__"
                model:
                  expression: A
                  reducer: last
                  type: reduce
                  datasource:
                    type: __expr__
                    uid: "__expr__"

              - refId: C
                datasourceUid: "__expr__"
                model:
                  conditions:
                    - evaluator:
                        params: [5]
                        type: gt
                      query:
                        params: [B]
                      reducer:
                        type: last
                      type: query
                  expression: B
                  type: threshold
                  datasource:
                    type: __expr__
                    uid: "__expr__"

      - orgId: 1
        name: Kubernetes Workloads
        folder: Infrastructure Alerts
        interval: 2m
        rules:
          # Deployment replica availability
          - uid: deployment-replica-shortage-001
            title: Deployment Below Desired Replicas
            condition: C
            for: 5m
            labels:
              severity: warning
              team: platform
            annotations:
              summary: "Deployment {{ $labels.deployment }} has fewer ready replicas than desired"
              description: |
                Deployment {{ $labels.deployment }} in {{ $labels.namespace }} has
                {{ $values.B.Value | int }} ready replicas but expects
                {{ $values.D.Value | int }}.
            data:
              - refId: A
                datasourceUid: prometheus-prod
                model:
                  expr: kube_deployment_status_replicas_ready
                  legendFormat: "{{ namespace }}/{{ deployment }}"

              - refId: B
                datasourceUid: "__expr__"
                model:
                  expression: A
                  reducer: last
                  type: reduce
                  datasource:
                    type: __expr__
                    uid: "__expr__"

              - refId: C
                datasourceUid: prometheus-prod
                model:
                  expr: kube_deployment_spec_replicas
                  legendFormat: "{{ namespace }}/{{ deployment }}"

              - refId: D
                datasourceUid: "__expr__"
                model:
                  expression: C
                  reducer: last
                  type: reduce
                  datasource:
                    type: __expr__
                    uid: "__expr__"

              # Math expression: ready < desired
              - refId: E
                datasourceUid: "__expr__"
                model:
                  expression: "$B < $D"
                  type: math
                  datasource:
                    type: __expr__
                    uid: "__expr__"
```

### ConfigMap: Application SLO Alert Rules

```yaml
# grafana-alert-rules-slo-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-alert-rules-slo
  namespace: monitoring
data:
  slo-rules.yaml: |
    apiVersion: 1
    groups:
      - orgId: 1
        name: SLO Alerts
        folder: SLO Alerts
        interval: 1m
        rules:
          # Error rate SLO breach alert
          - uid: error-rate-slo-001
            title: Service Error Rate SLO Breach
            condition: C
            for: 5m
            labels:
              severity: critical
              team: "{{ $labels.team }}"
              slo: error_rate
            annotations:
              summary: "Service {{ $labels.service }} error rate exceeds SLO threshold"
              description: |
                Service {{ $labels.service }} error rate is {{ $values.B.Value | humanizePercentage }},
                exceeding the 1% SLO threshold.
              runbook_url: "https://runbooks.support.tools/slo/error-rate-breach"
            data:
              - refId: A
                datasourceUid: prometheus-prod
                model:
                  expr: |
                    sum by (service, namespace, team) (
                      rate(http_requests_total{status=~"5.."}[5m])
                    )
                    /
                    sum by (service, namespace, team) (
                      rate(http_requests_total[5m])
                    )

              - refId: B
                datasourceUid: "__expr__"
                model:
                  expression: A
                  reducer: last
                  type: reduce
                  datasource:
                    type: __expr__
                    uid: "__expr__"

              - refId: C
                datasourceUid: "__expr__"
                model:
                  conditions:
                    - evaluator:
                        params: [0.01]    # 1% error rate SLO
                        type: gt
                      query:
                        params: [B]
                      reducer:
                        type: last
                      type: query
                  expression: B
                  type: threshold
                  datasource:
                    type: __expr__
                    uid: "__expr__"

          # P99 latency SLO alert
          - uid: p99-latency-slo-001
            title: Service P99 Latency SLO Breach
            condition: C
            for: 10m
            labels:
              severity: warning
              team: "{{ $labels.team }}"
              slo: p99_latency
            annotations:
              summary: "Service {{ $labels.service }} P99 latency exceeds 500ms SLO"
              description: |
                Service {{ $labels.service }} P99 latency is {{ $values.B.Value | humanizeDuration }},
                exceeding the 500ms SLO threshold.
            data:
              - refId: A
                datasourceUid: prometheus-prod
                model:
                  expr: |
                    histogram_quantile(0.99,
                      sum by (service, namespace, team, le) (
                        rate(http_request_duration_seconds_bucket[5m])
                      )
                    ) * 1000

              - refId: B
                datasourceUid: "__expr__"
                model:
                  expression: A
                  reducer: last
                  type: reduce
                  datasource:
                    type: __expr__
                    uid: "__expr__"

              - refId: C
                datasourceUid: "__expr__"
                model:
                  conditions:
                    - evaluator:
                        params: [500]     # 500ms in milliseconds
                        type: gt
                      query:
                        params: [B]
                      type: query
                  expression: B
                  type: threshold
                  datasource:
                    type: __expr__
                    uid: "__expr__"
```

## Contact Points Configuration

### Provisioned Contact Points

```yaml
# grafana-contact-points-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-contact-points
  namespace: monitoring
data:
  contact-points.yaml: |
    apiVersion: 1
    contactPoints:
      - orgId: 1
        name: PagerDuty Platform
        receivers:
          - uid: pagerduty-platform-001
            type: pagerduty
            settings:
              integrationKey: "${PAGERDUTY_PLATFORM_KEY}"
              severity: '{{ if eq .CommonLabels.severity "critical" }}critical{{ else }}warning{{ end }}'
              summary: '{{ .CommonAnnotations.summary }}'
              details: |
                cluster: {{ .CommonLabels.cluster }}
                namespace: {{ .CommonLabels.namespace }}
                runbook: {{ .CommonAnnotations.runbook_url }}
            disableResolveMessage: false

      - orgId: 1
        name: Slack Platform Alerts
        receivers:
          - uid: slack-platform-001
            type: slack
            settings:
              url: "${SLACK_PLATFORM_WEBHOOK_URL}"
              recipient: "#platform-alerts"
              title: |
                {{ if eq .Status "resolved" }}[RESOLVED]{{ else }}[{{ .CommonLabels.severity | toUpper }}]{{ end }}
                {{ .CommonAnnotations.summary }}
              text: |
                *Namespace:* {{ .CommonLabels.namespace }}
                *Cluster:* {{ .CommonLabels.cluster }}
                *Description:* {{ .CommonAnnotations.description }}
                *Runbook:* {{ .CommonAnnotations.runbook_url }}
              mentionChannel: ""
            disableResolveMessage: false

      - orgId: 1
        name: Slack Database Alerts
        receivers:
          - uid: slack-dba-001
            type: slack
            settings:
              url: "${SLACK_DBA_WEBHOOK_URL}"
              recipient: "#database-alerts"
              title: |
                {{ if eq .Status "resolved" }}[RESOLVED]{{ else }}[{{ .CommonLabels.severity | toUpper }}]{{ end }}
                {{ .CommonAnnotations.summary }}
              text: |
                *Database:* {{ .CommonLabels.database }}
                *Namespace:* {{ .CommonLabels.namespace }}
                *Description:* {{ .CommonAnnotations.description }}
            disableResolveMessage: false

      - orgId: 1
        name: PagerDuty DBA
        receivers:
          - uid: pagerduty-dba-001
            type: pagerduty
            settings:
              integrationKey: "${PAGERDUTY_DBA_KEY}"
              severity: critical
              summary: '[DATABASE] {{ .CommonAnnotations.summary }}'
            disableResolveMessage: false

      - orgId: 1
        name: Generic Webhook
        receivers:
          - uid: webhook-generic-001
            type: webhook
            settings:
              url: "https://hooks.support.tools/alertmanager/ingest"
              httpMethod: POST
              username: alertmanager
              password: "${WEBHOOK_PASSWORD}"
              maxAlerts: 50
            disableResolveMessage: false
```

## Notification Policy Tree

### Provisioned Notification Policies

```yaml
# grafana-notification-policies-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-notification-policies
  namespace: monitoring
data:
  policies.yaml: |
    apiVersion: 1
    policies:
      - orgId: 1
        receiver: PagerDuty Platform   # default receiver (critical, unrouted alerts)
        group_by:
          - alertname
          - cluster
          - namespace
        group_wait: 30s
        group_interval: 5m
        repeat_interval: 4h
        routes:
          # Critical alerts: always PagerDuty
          - receiver: PagerDuty Platform
            object_matchers:
              - ["severity", "=", "critical"]
              - ["team", "=", "platform"]
            group_wait: 10s
            group_interval: 2m
            repeat_interval: 1h

          - receiver: PagerDuty DBA
            object_matchers:
              - ["severity", "=", "critical"]
              - ["team", "=", "database"]
            group_wait: 10s
            repeat_interval: 1h

          # Warning alerts: route to Slack by team
          - receiver: Slack Platform Alerts
            object_matchers:
              - ["severity", "=", "warning"]
              - ["team", "=", "platform"]
            group_wait: 60s
            group_interval: 10m
            repeat_interval: 8h

          - receiver: Slack Database Alerts
            object_matchers:
              - ["severity", "=", "warning"]
              - ["team", "=", "database"]
            group_wait: 60s
            repeat_interval: 8h

          # SLO breaches: always high-priority regardless of team
          - receiver: PagerDuty Platform
            object_matchers:
              - ["slo", "=~", ".+"]
              - ["severity", "=", "critical"]
            group_wait: 5s
            repeat_interval: 30m

          # Webhook for all alerts (audit trail)
          - receiver: Generic Webhook
            object_matchers:
              - ["alertname", "=~", ".+"]    # matches everything
            continue: true                    # continue to other routes
            group_wait: 0s
            group_interval: 1m
```

## Recording Rules in Grafana

Grafana can evaluate and store recording rules against Prometheus, reducing query complexity for dashboards and alert conditions.

```yaml
# grafana-recording-rules-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-recording-rules
  namespace: monitoring
data:
  recording-rules.yaml: |
    apiVersion: 1
    groups:
      - orgId: 1
        name: SLO Recording Rules
        folder: Recording Rules
        interval: 1m
        rules:
          # Pre-aggregate error rate per service (used by dashboards and alert conditions)
          - uid: recording-error-rate-001
            title: service:http_error_rate:ratio_rate5m
            condition: A
            labels:
              recording: "true"
            data:
              - refId: A
                datasourceUid: prometheus-prod
                model:
                  expr: |
                    sum by (service, namespace, team) (
                      rate(http_requests_total{status=~"5.."}[5m])
                    )
                    /
                    sum by (service, namespace, team) (
                      rate(http_requests_total[5m])
                    )
```

## Folder-Based RBAC for Alert Rules

Grafana Unified Alerting respects folder-level RBAC. Teams can manage alert rules in their own folders without access to infrastructure rules.

```yaml
# grafana-folder-rbac.yaml — Grafana API provisioning
# Create folder for each team with appropriate RBAC
apiVersion: 1
folders:
  - title: Infrastructure Alerts
    uid: infrastructure-alerts
    orgId: 1

  - title: Database Alerts
    uid: database-alerts
    orgId: 1

  - title: Application Alerts
    uid: application-alerts
    orgId: 1

  - title: SLO Alerts
    uid: slo-alerts
    orgId: 1
```

```bash
# Set folder permissions via Grafana API
# Platform team: editor access to Infrastructure Alerts folder
curl -s -X POST \
  https://grafana.support.tools/api/folders/infrastructure-alerts/permissions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${GRAFANA_ADMIN_TOKEN}" \
  -d '{
    "items": [
      {"teamId": 1, "permission": 2},
      {"teamId": 2, "permission": 1}
    ]
  }'
```

## Silence Management

### Programmatic Silence via Grafana API

```bash
# Create a silence for a planned maintenance window
curl -s -X POST \
  https://grafana.support.tools/api/alertmanager/grafana/api/v2/silences \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${GRAFANA_API_TOKEN}" \
  -d '{
    "matchers": [
      {"name": "cluster", "value": "prod-us-east-1", "isRegex": false},
      {"name": "team", "value": "platform", "isRegex": false}
    ],
    "startsAt": "2027-03-22T02:00:00Z",
    "endsAt": "2027-03-22T06:00:00Z",
    "createdBy": "mmattox@support.tools",
    "comment": "Scheduled Kubernetes 1.30 upgrade"
  }' | jq '.id'

# List active silences
curl -s \
  https://grafana.support.tools/api/alertmanager/grafana/api/v2/silences \
  -H "Authorization: Bearer ${GRAFANA_API_TOKEN}" | jq '.[] | select(.status.state == "active")'

# Delete a silence
SILENCE_ID="abc12345-de67-89fg-hi01-jk234567lmno"
curl -s -X DELETE \
  "https://grafana.support.tools/api/alertmanager/grafana/api/v2/silences/${SILENCE_ID}" \
  -H "Authorization: Bearer ${GRAFANA_API_TOKEN}"
```

## GitOps Management with Terraform

The Grafana Terraform provider enables full GitOps management of alert rules, contact points, and notification policies.

### Terraform Configuration

```hcl
# providers.tf
terraform {
  required_providers {
    grafana = {
      source  = "grafana/grafana"
      version = "~> 3.0"
    }
  }
}

provider "grafana" {
  url  = "https://grafana.support.tools"
  auth = var.grafana_api_token
}
```

```hcl
# variables.tf
variable "grafana_api_token" {
  description = "Grafana API token for Terraform provider authentication"
  type        = string
  sensitive   = true
}

variable "pagerduty_platform_key" {
  description = "PagerDuty integration key for platform on-call"
  type        = string
  sensitive   = true
}

variable "slack_platform_webhook_url" {
  description = "Slack incoming webhook URL for platform alerts channel"
  type        = string
  sensitive   = true
}
```

```hcl
# alert_folders.tf
resource "grafana_folder" "infrastructure" {
  title = "Infrastructure Alerts"
  uid   = "infrastructure-alerts"
}

resource "grafana_folder" "slo" {
  title = "SLO Alerts"
  uid   = "slo-alerts"
}

resource "grafana_folder" "database" {
  title = "Database Alerts"
  uid   = "database-alerts"
}
```

```hcl
# contact_points.tf
resource "grafana_contact_point" "pagerduty_platform" {
  name = "PagerDuty Platform"

  pagerduty {
    integration_key = var.pagerduty_platform_key
    severity        = "critical"
    summary         = "{{ .CommonAnnotations.summary }}"
  }
}

resource "grafana_contact_point" "slack_platform" {
  name = "Slack Platform Alerts"

  slack {
    url        = var.slack_platform_webhook_url
    recipient  = "#platform-alerts"
    title      = "[{{ .Status | toUpper }}] {{ .CommonAnnotations.summary }}"
    text       = "Cluster: {{ .CommonLabels.cluster }}\nNamespace: {{ .CommonLabels.namespace }}\n{{ .CommonAnnotations.description }}"
  }
}
```

```hcl
# notification_policy.tf
resource "grafana_notification_policy" "root" {
  contact_point = grafana_contact_point.pagerduty_platform.name
  group_by      = ["alertname", "cluster", "namespace"]

  group_wait      = "30s"
  group_interval  = "5m"
  repeat_interval = "4h"

  policy {
    contact_point = grafana_contact_point.pagerduty_platform.name
    group_by      = ["alertname", "cluster"]

    matcher {
      label = "severity"
      match = "="
      value = "critical"
    }
    matcher {
      label = "team"
      match = "="
      value = "platform"
    }

    group_wait      = "10s"
    repeat_interval = "1h"
  }

  policy {
    contact_point = grafana_contact_point.slack_platform.name
    group_by      = ["alertname", "namespace"]

    matcher {
      label = "severity"
      match = "="
      value = "warning"
    }
    matcher {
      label = "team"
      match = "="
      value = "platform"
    }

    group_wait      = "60s"
    repeat_interval = "8h"
  }
}
```

```hcl
# alert_rules.tf
resource "grafana_rule_group" "infrastructure" {
  name             = "Infrastructure"
  folder_uid       = grafana_folder.infrastructure.uid
  interval_seconds = 60

  rule {
    name      = "Node Memory Utilization High"
    condition = "C"
    for       = "5m"

    labels = {
      severity  = "warning"
      team      = "platform"
      component = "node"
    }

    annotations = {
      summary     = "Node {{ $labels.node }} memory utilization exceeds 85%"
      description = "Node {{ $labels.node }} memory usage is {{ $values.B.Value | humanize }}%"
      runbook_url = "https://runbooks.support.tools/platform/node-memory-pressure"
    }

    data {
      ref_id         = "A"
      datasource_uid = "prometheus-prod"
      model = jsonencode({
        expr          = "(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100"
        legendFormat  = "{{ node }}"
        intervalMs    = 15000
        maxDataPoints = 43200
      })
    }

    data {
      ref_id         = "B"
      datasource_uid = "__expr__"
      model = jsonencode({
        expression = "A"
        reducer    = "last"
        type       = "reduce"
        datasource = { type = "__expr__", uid = "__expr__" }
      })
    }

    data {
      ref_id         = "C"
      datasource_uid = "__expr__"
      model = jsonencode({
        conditions = [{
          evaluator = { params = [85], type = "gt" }
          query     = { params = ["B"] }
          reducer   = { type = "last" }
          type      = "query"
        }]
        expression = "B"
        type       = "threshold"
        datasource = { type = "__expr__", uid = "__expr__" }
      })
    }
  }
}
```

```bash
# Initialize and plan the Terraform configuration
terraform init
terraform plan \
  -var="grafana_api_token=${GRAFANA_API_TOKEN}" \
  -var="pagerduty_platform_key=${PAGERDUTY_PLATFORM_KEY}" \
  -var="slack_platform_webhook_url=${SLACK_PLATFORM_WEBHOOK_URL}"

# Apply to production
terraform apply -auto-approve \
  -var="grafana_api_token=${GRAFANA_API_TOKEN}" \
  -var="pagerduty_platform_key=${PAGERDUTY_PLATFORM_KEY}" \
  -var="slack_platform_webhook_url=${SLACK_PLATFORM_WEBHOOK_URL}"
```

## Alert State History in Loki

When the Loki state history backend is enabled, every alert state transition is recorded as a log entry in Loki with structured labels.

### Querying Alert State History

```logql
# Find all FIRING events for a specific alert rule
{alertname="PodCrashLooping", cluster="prod-us-east-1"}
| json
| line_format "{{.state}} at {{.time}}: {{.labels}}"

# Count alert firings per namespace in the last 24 hours
sum by (namespace) (
  count_over_time(
    {alertname=~".+", cluster="prod-us-east-1"}
    | json
    | state = "Alerting"
    [24h]
  )
)

# Find all alerts that transitioned to NORMAL (resolved) today
{cluster="prod-us-east-1"}
| json
| state = "Normal"
| line_format "{{.alertname}} resolved at {{.time}} — was firing for {{.labels}}"
```

### Grafana Dashboard Panel for Alert History

```json
{
  "title": "Alert State History — Last 24h",
  "type": "logs",
  "datasource": {"uid": "loki-prod", "type": "loki"},
  "targets": [
    {
      "expr": "{job=\"grafana\", cluster=\"prod-us-east-1\"} | json | state =~ \"Alerting|Normal\"",
      "legendFormat": "",
      "refId": "A"
    }
  ]
}
```

## Grafana OnCall Integration

Grafana OnCall extends Unified Alerting with on-call scheduling, escalation policies, and mobile push notifications.

### Connecting OnCall to Grafana Unified Alerting

```bash
# Install Grafana OnCall Helm chart
helm repo add grafana https://grafana.github.io/helm-charts
helm upgrade --install grafana-oncall grafana/oncall \
  --namespace monitoring \
  --version 1.11.0 \
  --set "grafana.enabled=false" \
  --set "externalGrafana.url=https://grafana.support.tools" \
  --set "externalGrafana.apiKey=${GRAFANA_ONCALL_API_KEY}" \
  --wait
```

### OnCall Integration in Grafana Contact Point

```yaml
# Add OnCall as a Grafana contact point (via Grafana UI or Terraform)
# OnCall provides a webhook URL that accepts Grafana alert payloads
receivers:
  - uid: oncall-integration-001
    type: oncall
    settings:
      url: "https://oncall.support.tools/integrations/v1/grafana/abc123def456/"
      httpMethod: POST
      maxAlerts: 100
```

### Escalation Policy

OnCall escalation policies determine who gets paged and in what order when an alert is not acknowledged within the defined window.

```yaml
# oncall-escalation-policy.yaml (configured in Grafana OnCall UI)
escalation_policy:
  name: Platform On-Call Escalation
  steps:
    - type: notify_on_call_from_schedule
      schedule: Platform On-Call Schedule
      important: true

    - type: wait
      duration: 15m              # wait 15 minutes for acknowledgement

    - type: notify_on_call_from_schedule
      schedule: Platform On-Call Backup
      important: true

    - type: wait
      duration: 15m

    - type: notify_team_members
      team: Platform Team         # notify entire team as last resort
```

## Comparison with Prometheus Alertmanager

| Feature | Grafana Unified Alerting | Prometheus Alertmanager |
|---|---|---|
| Alert rule authoring | Grafana UI, file provisioning, Terraform | PrometheusRule CRD (Prometheus Operator) |
| Multi-datasource rules | Yes (Loki, Prometheus, any Grafana source) | Prometheus only |
| State history | Loki backend | No native history |
| Visual rule editor | Yes | No |
| Notification routing | Built-in policy tree | External Alertmanager required |
| GitOps | Terraform provider, file provisioning | Alertmanager ConfigMap / Secret |
| Silence UI | Built into Grafana | Separate Alertmanager UI |
| Template language | Go templates (same as Alertmanager) | Go templates |
| High availability | Shared database (PostgreSQL/MySQL) | Gossip protocol (mesh) |
| Inhibition rules | No native inhibition | Full inhibition rule support |

Grafana Unified Alerting is the preferred choice when the team already operates Grafana as the primary observability interface, when alert rules need to span multiple data sources, or when state history visibility is important. Prometheus Alertmanager remains the better choice when inhibition rules are required, when operating without Grafana, or when alert rules are managed alongside PrometheusRule CRDs in GitOps pipelines.

## Summary

Grafana Unified Alerting provides a complete alert management platform native to the Grafana ecosystem. Key production deployment practices:

- Enable the Loki state history backend to provide visibility into alert lifecycle events beyond what dashboards show
- Use file-based provisioning via ConfigMaps for alert rules, contact points, and notification policies to maintain GitOps compatibility without Terraform
- Leverage the Terraform Grafana provider for organizations with existing Terraform infrastructure workflows
- Define folder-level RBAC so teams can manage their own alert rules without requiring Grafana admin access
- Use multi-dimensional alerting with label matchers to route notifications to the correct team based on labels inherited from metric label sets
- For organizations requiring inhibition rules or managing alert rules alongside Prometheus CRDs, integrate external Prometheus Alertmanager rather than relying solely on Grafana's built-in notification routing
