---
title: "Alertmanager: Advanced Routing, Silencing, and Inhibition for Production"
date: 2027-03-21T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Alertmanager", "Prometheus", "Alerting", "Incident Management"]
categories: ["Kubernetes", "Observability", "Incident Management"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production Alertmanager configuration guide covering nested routing trees, receiver configuration (Slack, PagerDuty, OpsGenie, email), inhibition rules to suppress symptom alerts, time-based routing for on-call schedules, HA clustering, and alert deduplication strategies."
more_link: "yes"
url: "/alertmanager-routing-silencing-production-guide/"
---

Alertmanager transforms raw Prometheus alert firings into actionable notifications routed to the right person at the right time through the right channel. A well-designed routing tree prevents alert storms from drowning on-call engineers in noise, while inhibition rules ensure that a single root cause does not generate dozens of symptomatic notifications. This guide walks through a complete production Alertmanager configuration covering nested routing, multi-receiver setups, time-based routing for on-call schedules, inhibition rule design, HA clustering, and the amtool CLI for validating routing decisions before deployment.

<!--more-->

## Routing Tree Architecture

### Route Structure

Every alert that fires in Prometheus passes through the Alertmanager routing tree exactly once (unless `continue: true` is set). The tree is evaluated top-down, and the first matching route wins.

```
root route (default receiver: pagerduty-low-severity)
├── match: severity=critical
│   ├── match: team=database
│   │   └── receiver: pagerduty-dba (escalates to DBA on-call)
│   ├── match: team=platform
│   │   └── receiver: pagerduty-platform (platform on-call)
│   └── receiver: pagerduty-general (catch-all for critical)
├── match: severity=warning
│   ├── match: team=database
│   │   └── receiver: slack-dba-alerts
│   ├── match: team=platform
│   │   └── receiver: slack-platform-alerts
│   └── receiver: slack-general-warnings
└── receiver: pagerduty-low-severity (default: info and uncategorized)
```

### Complete alertmanager.yaml

```yaml
# alertmanager.yaml — production configuration
global:
  # Default SMTP configuration for email receivers
  smtp_smarthost: "smtp.mailrelay.support.tools:587"
  smtp_from: "alertmanager@support.tools"
  smtp_auth_username: "alertmanager@support.tools"
  smtp_auth_password_file: /etc/alertmanager/secrets/smtp_password
  smtp_require_tls: true

  # Default resolve timeout: how long after an alert stops firing before sending a resolve notification
  resolve_timeout: 5m

  # Slack API URL loaded from file (never inline secrets)
  slack_api_url_file: /etc/alertmanager/secrets/slack_webhook_url

# Templates for notification content
templates:
  - /etc/alertmanager/templates/*.tmpl

# Inhibition rules suppress child alerts when a parent alert is firing
inhibit_rules:
  # Suppress all node-level alerts when the node is not ready
  - source_matchers:
      - alertname=NodeNotReady
    target_matchers:
      - alertname=~"Node.*"
    equal:
      - node

  # Suppress pod-level alerts when the node hosting the pod is unreachable
  - source_matchers:
      - alertname=NodeNotReady
    target_matchers:
      - alertname=~"Pod.*|Container.*|Deployment.*"
    equal:
      - node                       # pod must be on the failing node

  # Suppress high-latency warnings when the service is completely down
  - source_matchers:
      - alertname=ServiceDown
      - severity=critical
    target_matchers:
      - alertname=ServiceHighLatency
      - severity=warning
    equal:
      - service
      - namespace

  # Suppress individual job failure alerts when entire cluster is degraded
  - source_matchers:
      - alertname=KubernetesClusterDegraded
    target_matchers:
      - alertname=~"KubernetesJob.*|KubernetesCronJob.*"

# Time intervals define periods for routing decisions
time_intervals:
  - name: business-hours
    time_intervals:
      - weekdays: ["monday:friday"]
        times:
          - start_time: "09:00"
            end_time: "17:00"
        location: America/New_York

  - name: non-business-hours
    time_intervals:
      - weekdays: ["monday:friday"]
        times:
          - start_time: "00:00"
            end_time: "09:00"
          - start_time: "17:00"
            end_time: "24:00"
      - weekdays: ["saturday", "sunday"]

  - name: maintenance-window
    time_intervals:
      - weekdays: ["sunday"]
        times:
          - start_time: "02:00"
            end_time: "06:00"
        location: UTC

# The root route — every alert passes through this
route:
  receiver: pagerduty-low-severity
  group_by:
    - alertname
    - cluster
    - namespace
  group_wait: 30s                  # wait 30s before sending first notification (allows grouping)
  group_interval: 5m               # wait 5m before sending follow-up notifications for the same group
  repeat_interval: 4h              # re-notify if alert is still firing after 4 hours

  routes:
    # ----------------------------------------------------------------
    # Maintenance window: silence all non-critical alerts
    # ----------------------------------------------------------------
    - active_time_intervals:
        - maintenance-window
      matchers:
        - severity != critical
      receiver: blackhole           # silently discard during maintenance

    # ----------------------------------------------------------------
    # Critical alerts: always go to PagerDuty
    # ----------------------------------------------------------------
    - matchers:
        - severity = critical
      group_wait: 10s              # shorter wait for critical — get notified faster
      group_interval: 2m
      repeat_interval: 1h
      routes:
        # Database team critical alerts
        - matchers:
            - team = database
            - severity = critical
          receiver: pagerduty-dba
          group_by: [alertname, namespace, cluster]

        # Platform team critical alerts (infrastructure, Kubernetes)
        - matchers:
            - team = platform
            - severity = critical
          receiver: pagerduty-platform
          group_by: [alertname, cluster, node]

        # Security team critical alerts
        - matchers:
            - team = security
            - severity = critical
          receiver: pagerduty-security
          continue: true           # also send to general security Slack channel

        # Catch-all for critical alerts without a team label
        - matchers:
            - severity = critical
          receiver: pagerduty-general

    # ----------------------------------------------------------------
    # Warning alerts: route to Slack during business hours,
    # PagerDuty low-severity outside business hours
    # ----------------------------------------------------------------
    - matchers:
        - severity = warning
      routes:
        # Database team warnings
        - matchers:
            - team = database
          active_time_intervals:
            - business-hours
          receiver: slack-dba-alerts
        - matchers:
            - team = database
          active_time_intervals:
            - non-business-hours
          receiver: pagerduty-low-severity

        # Platform team warnings
        - matchers:
            - team = platform
          active_time_intervals:
            - business-hours
          receiver: slack-platform-alerts
        - matchers:
            - team = platform
          active_time_intervals:
            - non-business-hours
          receiver: pagerduty-low-severity

        # Application team warnings — Slack only, no PagerDuty
        - matchers:
            - team = application
          receiver: slack-application-alerts

        # Catch-all warnings
        - receiver: slack-general-warnings

    # ----------------------------------------------------------------
    # Info alerts: Slack only, no paging
    # ----------------------------------------------------------------
    - matchers:
        - severity = info
      receiver: slack-info-feed

# ----------------------------------------------------------------
# Receivers
# ----------------------------------------------------------------
receivers:
  # ---- Blackhole: silently discard ----
  - name: blackhole

  # ---- PagerDuty receivers ----
  - name: pagerduty-general
    pagerduty_configs:
      - routing_key_file: /etc/alertmanager/secrets/pagerduty_general_key
        severity: '{{ if eq .CommonLabels.severity "critical" }}critical{{ else }}warning{{ end }}'
        description: '{{ .CommonAnnotations.summary }}'
        details:
          firing: '{{ .Alerts.Firing | len }}'
          resolved: '{{ .Alerts.Resolved | len }}'
          cluster: '{{ .CommonLabels.cluster }}'
          namespace: '{{ .CommonLabels.namespace }}'
          runbook: '{{ .CommonAnnotations.runbook_url }}'
        client: "Alertmanager"
        client_url: "https://alertmanager.support.tools"

  - name: pagerduty-platform
    pagerduty_configs:
      - routing_key_file: /etc/alertmanager/secrets/pagerduty_platform_key
        severity: critical
        description: '{{ .CommonAnnotations.summary }}'
        details:
          cluster: '{{ .CommonLabels.cluster }}'
          node: '{{ .CommonLabels.node }}'
          namespace: '{{ .CommonLabels.namespace }}'
          runbook: '{{ .CommonAnnotations.runbook_url }}'

  - name: pagerduty-dba
    pagerduty_configs:
      - routing_key_file: /etc/alertmanager/secrets/pagerduty_dba_key
        severity: critical
        description: '{{ .CommonAnnotations.summary }}'
        details:
          database: '{{ .CommonLabels.database }}'
          namespace: '{{ .CommonLabels.namespace }}'
          runbook: '{{ .CommonAnnotations.runbook_url }}'

  - name: pagerduty-security
    pagerduty_configs:
      - routing_key_file: /etc/alertmanager/secrets/pagerduty_security_key
        severity: critical
        description: '[SECURITY] {{ .CommonAnnotations.summary }}'
        details:
          namespace: '{{ .CommonLabels.namespace }}'
          node: '{{ .CommonLabels.node }}'
          runbook: '{{ .CommonAnnotations.runbook_url }}'

  - name: pagerduty-low-severity
    pagerduty_configs:
      - routing_key_file: /etc/alertmanager/secrets/pagerduty_low_key
        severity: warning
        description: '{{ .CommonAnnotations.summary }}'

  # ---- Slack receivers ----
  - name: slack-platform-alerts
    slack_configs:
      - channel: "#platform-alerts"
        send_resolved: true
        title: '{{ template "slack.title" . }}'
        text: '{{ template "slack.body" . }}'
        color: '{{ template "slack.color" . }}'
        actions:
          - type: button
            text: Runbook
            url: '{{ .CommonAnnotations.runbook_url }}'
          - type: button
            text: Silence
            url: '{{ template "alertmanager.silenceURL" . }}'

  - name: slack-dba-alerts
    slack_configs:
      - channel: "#database-alerts"
        send_resolved: true
        title: '{{ template "slack.title" . }}'
        text: '{{ template "slack.body" . }}'
        color: '{{ template "slack.color" . }}'

  - name: slack-application-alerts
    slack_configs:
      - channel: "#app-alerts"
        send_resolved: true
        title: '{{ template "slack.title" . }}'
        text: '{{ template "slack.body" . }}'
        color: '{{ template "slack.color" . }}'

  - name: slack-general-warnings
    slack_configs:
      - channel: "#alerts-general"
        send_resolved: false       # no resolved notifications for general warnings
        title: '{{ template "slack.title" . }}'
        text: '{{ template "slack.body" . }}'
        color: '{{ template "slack.color" . }}'

  - name: slack-info-feed
    slack_configs:
      - channel: "#monitoring-feed"
        send_resolved: false
        title: '{{ .CommonAnnotations.summary }}'
        text: '{{ .CommonAnnotations.description }}'

  # ---- Email receiver ----
  - name: email-operations
    email_configs:
      - to: "operations@support.tools"
        send_resolved: true
        headers:
          Subject: '[{{ .Status | toUpper }}] {{ .CommonAnnotations.summary }}'
        html: '{{ template "email.html" . }}'

  # ---- OpsGenie receiver ----
  - name: opsgenie-platform
    opsgenie_configs:
      - api_key_file: /etc/alertmanager/secrets/opsgenie_api_key
        api_url: "https://api.opsgenie.com/"
        message: '{{ .CommonAnnotations.summary }}'
        description: '{{ .CommonAnnotations.description }}'
        priority: '{{ if eq .CommonLabels.severity "critical" }}P1{{ else if eq .CommonLabels.severity "warning" }}P2{{ else }}P3{{ end }}'
        details:
          cluster: '{{ .CommonLabels.cluster }}'
          namespace: '{{ .CommonLabels.namespace }}'
          team: '{{ .CommonLabels.team }}'
        tags: '{{ .CommonLabels.team }},{{ .CommonLabels.severity }},{{ .CommonLabels.cluster }}'
        responders:
          - name: platform-oncall
            type: team
```

## Notification Templates

### Template File

```
{{/* templates/slack.tmpl */}}

{{/* Determine color based on alert status and severity */}}
{{ define "slack.color" -}}
  {{- if eq .Status "resolved" -}}
    good
  {{- else if eq .CommonLabels.severity "critical" -}}
    danger
  {{- else if eq .CommonLabels.severity "warning" -}}
    warning
  {{- else -}}
    #439FE0
  {{- end -}}
{{- end }}

{{/* Alert title with status indicator */}}
{{ define "slack.title" -}}
  {{- if eq .Status "resolved" -}}
    [RESOLVED] {{ .CommonAnnotations.summary }}
  {{- else -}}
    [{{ .CommonLabels.severity | toUpper }}] {{ .CommonAnnotations.summary }}
  {{- end -}}
{{- end }}

{{/* Alert body with details and links */}}
{{ define "slack.body" -}}
*Description:* {{ .CommonAnnotations.description }}

*Labels:*
{{ range .CommonLabels.SortedPairs -}}
  • *{{ .Name }}:* {{ .Value }}
{{ end -}}

{{- if gt (len .Alerts.Firing) 0 -}}
*Firing alerts ({{ len .Alerts.Firing }}):*
{{ range .Alerts.Firing -}}
  • {{ .Labels.alertname }} — {{ .Annotations.summary }}
{{ end -}}
{{- end -}}

{{- if gt (len .Alerts.Resolved) 0 -}}
*Resolved alerts ({{ len .Alerts.Resolved }}):*
{{ range .Alerts.Resolved -}}
  • {{ .Labels.alertname }} — resolved at {{ .EndsAt.Format "15:04:05 UTC" }}
{{ end -}}
{{- end -}}
{{- end }}

{{/* Silence URL generator */}}
{{ define "alertmanager.silenceURL" -}}
  {{ .ExternalURL }}/#/silences/new?filter=%7B
  {{- range .CommonLabels.SortedPairs -}}
    {{- if ne .Name "alertname" -}}
      {{- .Name }}%3D"{{- .Value -}}"%2C
    {{- end -}}
  {{- end -}}
  alertname%3D"{{- .CommonLabels.alertname -}}"%7D
{{- end }}
```

## Inhibition Rule Design Patterns

### Infrastructure vs Application Alert Hierarchy

The most important inhibition relationships follow the infrastructure dependency tree:

```yaml
inhibit_rules:
  # Level 1: Entire cluster degraded → suppress all node/pod alerts
  - source_matchers:
      - alertname = KubernetesAPIServerDown
    target_matchers:
      - alertname =~ "Kubernetes.*|Pod.*|Container.*|Node.*"

  # Level 2: Node unreachable → suppress all workloads on that node
  - source_matchers:
      - alertname = NodeNotReady
    target_matchers:
      - alertname =~ "Pod.*|Container.*|Deployment.*"
    equal:
      - node

  # Level 3: Database cluster degraded → suppress individual DB alerts
  - source_matchers:
      - alertname = PostgreSQLClusterDown
    target_matchers:
      - alertname =~ "PostgreSQL.*"
    equal:
      - namespace
      - cluster

  # Suppress connection pool exhaustion when DB is down
  # (connection exhaustion is a symptom, not a cause)
  - source_matchers:
      - alertname = PostgreSQLDown
      - severity = critical
    target_matchers:
      - alertname = PgBouncerConnectionExhausted
    equal:
      - namespace

  # Suppress latency alerts when error rate is critical
  # (high latency is expected when error rate is 100%)
  - source_matchers:
      - alertname = ServiceErrorRateCritical
    target_matchers:
      - alertname = ServiceHighLatency
    equal:
      - service
      - namespace
```

### Inhibition Rule Caveats

Inhibition matches on labels only, not on alert values. A source alert must currently be **firing** (not just have fired recently) for inhibition to apply. The `equal` field requires both source and target to have matching values for the listed label keys — an absent label does not match a present one.

```bash
# Test inhibition rules locally with amtool
amtool check-config /etc/alertmanager/alertmanager.yaml

# Simulate which alerts would be inhibited given a firing NodeNotReady
amtool alert query --alertmanager.url=http://alertmanager.monitoring.svc.cluster.local:9093
```

## HA Clustering with Gossip Protocol

Alertmanager uses the Gossip protocol (via memberlist) to coordinate deduplication and silences across a cluster. Each replica maintains a full copy of the state; alerts are deduplicated before notifications are sent.

### Helm Values for HA

```yaml
# alertmanager-ha-values.yaml
alertmanager:
  alertmanagerSpec:
    replicas: 3

    # Gossip cluster port
    clusterPort: 9094

    # Pod anti-affinity: one replica per availability zone
    podAntiAffinity: hard
    podAntiAffinityTopologyKey: topology.kubernetes.io/zone

    # Persist silences and notification log across restarts
    storage:
      volumeClaimTemplate:
        spec:
          storageClassName: gp3
          accessModes: [ReadWriteOnce]
          resources:
            requests:
              storage: 2Gi

    # External URL for deep-linking from notifications
    externalUrl: "https://alertmanager.support.tools"

    resources:
      requests:
        cpu: 100m
        memory: 256Mi
      limits:
        cpu: 500m
        memory: 512Mi

    # Alertmanager configuration secret reference
    configSecret: alertmanager-production-config

    # Template ConfigMap
    volumes:
      - name: alertmanager-templates
        configMap:
          name: alertmanager-templates
    volumeMounts:
      - name: alertmanager-templates
        mountPath: /etc/alertmanager/templates
```

### Verifying HA Cluster Health

```bash
# Check that all replicas are peered
kubectl exec -it -n monitoring alertmanager-0 -- \
  amtool cluster show --alertmanager.url=http://localhost:9093

# Expected output:
# Cluster ID: a3f2b1c4d5e6f7a8
# Members (3):
#   10.0.1.45:9094  alertmanager-0  alive
#   10.0.1.67:9094  alertmanager-1  alive
#   10.0.2.12:9094  alertmanager-2  alive
```

## Prometheus Operator AlertmanagerConfig CRD

The Prometheus Operator provides the `AlertmanagerConfig` CRD, which allows teams to contribute routing configuration without requiring access to the global `alertmanager.yaml`. Routes and receivers defined in an `AlertmanagerConfig` are automatically scoped to the resource's namespace.

```yaml
# alertmanagerconfig-database-team.yaml
apiVersion: monitoring.coreos.com/v1alpha1
kind: AlertmanagerConfig
metadata:
  name: database-team-routing
  namespace: production
  labels:
    alertmanagerConfig: production
spec:
  route:
    receiver: database-slack
    groupBy:
      - alertname
      - database
    matchers:
      - name: team
        value: database
        matchType: "="
    routes:
      # Critical DB alerts during off-hours go to PagerDuty
      - receiver: database-pagerduty
        matchers:
          - name: severity
            value: critical
            matchType: "="
        activeTimeIntervals:
          - non-business-hours

  receivers:
    - name: database-slack
      slackConfigs:
        - channel: "#database-alerts-prod"
          sendResolved: true
          title: '[{{ .Status | toUpper }}] {{ .CommonAnnotations.summary }}'
          text: |
            *Database:* {{ .CommonLabels.database }}
            *Namespace:* {{ .CommonLabels.namespace }}
            *Description:* {{ .CommonAnnotations.description }}

    - name: database-pagerduty
      pagerdutyConfigs:
        - routingKey:
            name: database-pagerduty-secret
            key: routingKey
          severity: critical
          description: '{{ .CommonAnnotations.summary }}'
```

## Silence Management

### Creating Silences via amtool

```bash
# Silence all alerts for a specific cluster during a 2-hour maintenance window
amtool silence add \
  --alertmanager.url=http://alertmanager.monitoring.svc.cluster.local:9093 \
  --author="mmattox@support.tools" \
  --comment="Planned Kubernetes upgrade maintenance" \
  --duration=2h \
  cluster=prod-us-east-1

# Silence a specific alert for a specific namespace
amtool silence add \
  --alertmanager.url=http://alertmanager.monitoring.svc.cluster.local:9093 \
  --author="mmattox@support.tools" \
  --comment="Known issue, ticket PLAT-4821" \
  --duration=24h \
  alertname=KubePodCrashLooping namespace=legacy-apps

# List active silences
amtool silence query \
  --alertmanager.url=http://alertmanager.monitoring.svc.cluster.local:9093

# Expire a silence immediately
# Capture the silence ID from the output of 'amtool silence query' first
SILENCE_ID="abc12345-de67-89fg-hi01-jk234567lmno"
amtool silence expire \
  --alertmanager.url=http://alertmanager.monitoring.svc.cluster.local:9093 \
  "${SILENCE_ID}"
```

### Silence via Alertmanager API

```bash
# Create a silence via REST API
curl -s -X POST \
  http://alertmanager.monitoring.svc.cluster.local:9093/api/v2/silences \
  -H "Content-Type: application/json" \
  -d '{
    "matchers": [
      {"name": "cluster", "value": "prod-us-east-1", "isRegex": false},
      {"name": "severity", "value": "warning", "isRegex": false}
    ],
    "startsAt": "2027-03-21T02:00:00Z",
    "endsAt": "2027-03-21T06:00:00Z",
    "createdBy": "mmattox@support.tools",
    "comment": "Scheduled maintenance: Kubernetes version upgrade"
  }' | jq '.silenceID'

# Delete a silence by ID
curl -s -X DELETE \
  http://alertmanager.monitoring.svc.cluster.local:9093/api/v2/silences/abc12345-de67-89fg-hi01-jk234567lmno
```

## Validating Routing with amtool

### Route Testing Before Deployment

```bash
# Test which receiver a given set of labels would route to
amtool config routes test \
  --config.file=/etc/alertmanager/alertmanager.yaml \
  --verify.receivers=pagerduty-platform \
  severity=critical team=platform alertname=NodeNotReady cluster=prod-us-east-1

# Test the full routing tree for a complex label set
amtool config routes show \
  --config.file=/etc/alertmanager/alertmanager.yaml

# Check the configuration file is valid YAML and references valid receivers
amtool check-config /etc/alertmanager/alertmanager.yaml
```

### Integration Test Script

```bash
#!/usr/bin/env bash
# test_alertmanager_routing.sh — validate routing before config rollout

set -euo pipefail

AM_URL="http://alertmanager.monitoring.svc.cluster.local:9093"
CONFIG_FILE="/etc/alertmanager/alertmanager.yaml"

echo "=== Validating Alertmanager configuration ==="
amtool check-config "${CONFIG_FILE}"

echo ""
echo "=== Testing critical platform alert routing ==="
amtool config routes test \
  --config.file="${CONFIG_FILE}" \
  alertname=NodeNotReady \
  severity=critical \
  team=platform \
  cluster=prod-us-east-1

echo ""
echo "=== Testing warning database alert routing (business hours) ==="
amtool config routes test \
  --config.file="${CONFIG_FILE}" \
  alertname=PostgreSQLReplicationLag \
  severity=warning \
  team=database \
  namespace=production

echo ""
echo "=== Testing maintenance window suppression ==="
# Note: time_intervals require amtool 0.27+
amtool config routes test \
  --config.file="${CONFIG_FILE}" \
  alertname=PodCrashLooping \
  severity=warning \
  namespace=production

echo ""
echo "All routing tests passed."
```

## Deploying Configuration via Kubernetes Secret

```yaml
# alertmanager-secret.yaml
# The Prometheus Operator reads the alertmanager config from this Secret
apiVersion: v1
kind: Secret
metadata:
  name: alertmanager-production-config
  namespace: monitoring
type: Opaque
stringData:
  alertmanager.yaml: |
    # (paste full alertmanager.yaml content here)
    # In production, use a ConfigMap generator or Helm --set-file
---
# Mount secrets for receiver credentials separately
apiVersion: v1
kind: Secret
metadata:
  name: alertmanager-receiver-secrets
  namespace: monitoring
type: Opaque
stringData:
  pagerduty_general_key: "EXAMPLE_TOKEN_REPLACE_ME"
  pagerduty_platform_key: "EXAMPLE_TOKEN_REPLACE_ME"
  pagerduty_dba_key: "EXAMPLE_TOKEN_REPLACE_ME"
  pagerduty_security_key: "EXAMPLE_TOKEN_REPLACE_ME"
  pagerduty_low_key: "EXAMPLE_TOKEN_REPLACE_ME"
  opsgenie_api_key: "EXAMPLE_TOKEN_REPLACE_ME"
  smtp_password: "EXAMPLE_TOKEN_REPLACE_ME"
```

```yaml
# alertmanagerspec-secrets.yaml — mount receiver secrets into Alertmanager pods
alertmanager:
  alertmanagerSpec:
    volumes:
      - name: receiver-secrets
        secret:
          secretName: alertmanager-receiver-secrets
    volumeMounts:
      - name: receiver-secrets
        mountPath: /etc/alertmanager/secrets
        readOnly: true
```

## Alert Grouping Strategies

### Grouping Key Design

The `group_by` fields determine which alerts are batched into a single notification. Poor grouping choices cause either alert floods (too granular) or missed detail (too coarse).

```yaml
# Route for deployment-level alerts: group per deployment
- matchers:
    - alertname =~ "Deployment.*"
  group_by:
    - alertname
    - namespace
    - deployment
  group_wait: 30s
  group_interval: 5m

# Route for node-level alerts: group per node (not per pod)
- matchers:
    - alertname =~ "Node.*"
  group_by:
    - alertname
    - node
    - cluster
  group_wait: 15s
  group_interval: 2m

# Route for batch job alerts: group per job type
- matchers:
    - alertname =~ "BatchJob.*"
  group_by:
    - alertname
    - job
    - environment
  group_wait: 60s
  group_interval: 10m
```

### Preventing Alert Storms with group_wait and group_interval

During a cascading failure, hundreds of alerts fire within seconds. Without grouping:

- 200 pod CrashLooping alerts → 200 individual PagerDuty incidents
- On-call engineer spends 20 minutes acknowledging instead of investigating

With proper grouping:

```yaml
route:
  group_by: [alertname, cluster, namespace]
  group_wait: 30s      # collect for 30s before sending — absorbs initial storm
  group_interval: 5m   # send updates every 5m (not every new firing)
  repeat_interval: 4h  # re-page after 4h if still firing
```

This converts 200 individual notifications into 1-3 grouped notifications within 30 seconds.

## Deployment Checklist

```bash
# 1. Validate configuration syntax
amtool check-config /tmp/alertmanager-new.yaml

# 2. Test critical routing paths
amtool config routes test \
  --config.file=/tmp/alertmanager-new.yaml \
  severity=critical team=platform alertname=NodeNotReady

# 3. Apply new configuration
kubectl create secret generic alertmanager-production-config \
  --from-file=alertmanager.yaml=/tmp/alertmanager-new.yaml \
  --namespace=monitoring \
  --dry-run=client -o yaml | kubectl apply -f -

# 4. Wait for Alertmanager to reload
kubectl rollout restart statefulset/alertmanager-production -n monitoring
kubectl rollout status statefulset/alertmanager-production -n monitoring

# 5. Verify cluster health post-reload
kubectl exec -n monitoring alertmanager-production-0 -- \
  amtool cluster show --alertmanager.url=http://localhost:9093

# 6. Send a test alert to verify routing end-to-end
curl -s -X POST \
  http://alertmanager.monitoring.svc.cluster.local:9093/api/v2/alerts \
  -H "Content-Type: application/json" \
  -d '[{
    "labels": {
      "alertname": "TestAlert",
      "severity": "warning",
      "team": "platform",
      "cluster": "prod-us-east-1",
      "namespace": "monitoring"
    },
    "annotations": {
      "summary": "Test alert for routing validation",
      "description": "This is a routing test. Please ignore."
    }
  }]'
```

## Summary

Production Alertmanager configuration rests on four core design principles:

- **Route tree depth**: build from most-specific (critical + team) to most-general (default receiver), using `continue: true` only when a notification genuinely needs to reach multiple receivers
- **Inhibition over silencing**: define inhibition rules for structural parent/child relationships (node down inhibits pod alerts on that node) to prevent alert storms from single root causes
- **Time-based routing**: route warnings to Slack during business hours and to low-priority PagerDuty outside hours, reserving high-priority paging for critical alerts at all times
- **Group wait tuning**: use `group_wait: 10-30s` for critical routes and `group_wait: 60s+` for batch and info routes to absorb storm bursts without delaying urgent notifications

Validate every configuration change with `amtool check-config` and `amtool config routes test` before applying to production, and verify HA cluster peer status after any statefulset restart.
