---
title: "Kubernetes Prometheus AlertManager: Routing Trees, Inhibition, and Silencing at Scale"
date: 2031-02-28T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Prometheus", "AlertManager", "Monitoring", "Alerting", "PagerDuty", "SRE"]
categories:
- Kubernetes
- Monitoring
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-grade guide to Prometheus AlertManager covering routing tree design, PagerDuty and Slack receiver configuration, inhibition rules, silence management, high-availability clustering, and alert deduplication for enterprise Kubernetes monitoring."
more_link: "yes"
url: "/kubernetes-prometheus-alertmanager-routing-inhibition-silencing-scale/"
---

AlertManager is where raw Prometheus alerts become actionable incidents — or, if misconfigured, become an alert storm that drowns on-call engineers in noise. Effective AlertManager configuration requires understanding routing trees (which determine who gets notified), inhibition rules (which suppress child alerts when a parent fires), and HA clustering (which ensures alerts are delivered even when AlertManager pods restart).

This guide covers the full AlertManager operational model for enterprise Kubernetes environments, from routing tree design principles through production-hardened HA configuration.

<!--more-->

# Kubernetes Prometheus AlertManager: Routing Trees, Inhibition, and Silencing at Scale

## Section 1: AlertManager Architecture

AlertManager receives alerts from Prometheus (and other sources), deduplicates them, groups them, routes them to appropriate receivers, and manages silences and inhibitions.

### The Alert Flow

```
Prometheus evaluates alert rules
    ↓
Alert fires (state: pending → firing)
    ↓
Prometheus sends alert to AlertManager HTTP API
    ↓
AlertManager deduplicates (same fingerprint from multiple Prometheus instances)
    ↓
AlertManager groups alerts by configured labels
    ↓
AlertManager checks inhibition rules (suppress if matching inhibitor is firing)
    ↓
AlertManager checks silences (suppress if matching silence exists)
    ↓
AlertManager routes to receiver
    ↓
Receiver sends notification (PagerDuty, Slack, email, webhook)
```

### Key Concepts

- **Route**: A node in the routing tree that matches alerts by labels and sends them to a receiver.
- **Receiver**: A named notification endpoint (PagerDuty team, Slack channel, email list).
- **Grouping**: AlertManager combines multiple alerts with the same grouping labels into a single notification.
- **Inhibition**: Suppress low-severity alerts when a high-severity alert for the same component is firing.
- **Silence**: Time-limited suppression of specific alerts (used during maintenance windows).
- **Deduplication**: Multiple Prometheus instances sending the same alert result in one notification.

## Section 2: Deploying AlertManager in Kubernetes

### Using Prometheus Operator

```yaml
# AlertManager managed by Prometheus Operator
apiVersion: monitoring.coreos.com/v1
kind: Alertmanager
metadata:
  name: main
  namespace: monitoring
spec:
  # High availability: 3 replicas
  replicas: 3

  # Version
  image: quay.io/prometheus/alertmanager:v0.28.0

  # Storage for silences and notification log
  storage:
    volumeClaimTemplate:
      spec:
        storageClassName: gp3
        accessModes:
          - ReadWriteOnce
        resources:
          requests:
            storage: 10Gi

  # Resource limits
  resources:
    requests:
      cpu: 100m
      memory: 256Mi
    limits:
      cpu: 500m
      memory: 512Mi

  # Pod disruption budget
  podDisruptionBudget:
    minAvailable: 2

  # Security context
  securityContext:
    runAsUser: 65534
    runAsNonRoot: true
    fsGroup: 65534

  # External URL (needed for links in notifications)
  externalUrl: "https://alertmanager.example.com"

  # Gossip for HA cluster formation
  clusterAdvertiseAddress: ""  # Auto-detect

  # Alert retention
  retention: 120h

  # Configuration is provided via AlertmanagerConfig or Secret
  configSecret: alertmanager-main
---
# Service for external access
apiVersion: v1
kind: Service
metadata:
  name: alertmanager-main
  namespace: monitoring
spec:
  selector:
    alertmanager: main
  ports:
    - name: web
      port: 9093
      targetPort: web
    - name: mesh
      port: 9094
      targetPort: mesh
  type: ClusterIP
```

### Configuration Secret

```bash
# AlertManager configuration is stored as a Kubernetes Secret
kubectl create secret generic alertmanager-main \
  --from-file=alertmanager.yaml \
  --namespace monitoring
```

## Section 3: Routing Tree Design

The routing tree is the most important and most often misconfigured part of AlertManager. The root route is a catch-all; specific routes for different teams and severity levels are children.

### Production Routing Tree

```yaml
# alertmanager.yaml
global:
  resolve_timeout: 5m

  # PagerDuty global settings
  pagerduty_url: "https://events.pagerduty.com/v2/enqueue"

  # Slack global settings (webhook URL stored as env var for security)
  # Use ${SLACK_WEBHOOK_URL} interpolation if your deployment supports it

  # SMTP settings
  smtp_from: "alertmanager@example.com"
  smtp_smarthost: "smtp.example.com:587"
  smtp_auth_username: "alertmanager@example.com"
  smtp_auth_password_file: /etc/alertmanager/smtp_password
  smtp_require_tls: true

# Templates for notification content
templates:
  - "/etc/alertmanager/templates/*.tmpl"

# ======================================================
# ROUTING TREE
# ======================================================
route:
  # Root route — catch-all defaults
  receiver: "slack-ops"      # Default receiver for unmatched alerts
  group_by: ["alertname", "cluster", "service"]
  group_wait: 30s            # Wait 30s before sending first notification (aggregate)
  group_interval: 5m         # Resend if new alerts join the group after 5m
  repeat_interval: 4h        # Resend every 4h if alert stays firing

  routes:
    # ---- CRITICAL: Wake people up ----
    - match_re:
        severity: "critical|page"
      receiver: "pagerduty-critical"
      group_by: ["alertname", "cluster", "service", "instance"]
      group_wait: 10s
      repeat_interval: 1h

      # Sub-routes for specific critical alerts
      routes:
        # Database critical → database on-call
        - match_re:
            alertname: "Postgres.*|MySQL.*|Redis.*"
          receiver: "pagerduty-database"
          group_by: ["alertname", "cluster", "instance"]

        # Network critical → network on-call
        - match_re:
            alertname: "NetworkPartition|BGP.*|DNS.*"
          receiver: "pagerduty-network"
          group_by: ["alertname", "cluster", "zone"]

    # ---- WARNING: Slack only ----
    - match:
        severity: warning
      receiver: "slack-warning"
      group_by: ["alertname", "cluster", "service"]
      group_wait: 5m
      group_interval: 10m
      repeat_interval: 8h

      routes:
        # Platform team warnings → platform Slack
        - match_re:
            team: "platform|infra"
          receiver: "slack-platform"

        # Application team warnings → their Slack channels
        - match:
            team: payments
          receiver: "slack-payments-team"

        - match:
            team: frontend
          receiver: "slack-frontend-team"

    # ---- INFO: Low-priority tickets ----
    - match:
        severity: info
      receiver: "jira-create"
      group_wait: 15m
      group_interval: 30m
      repeat_interval: 24h
      continue: false

    # ---- Watchdog: ensure the pipeline is healthy ----
    - match:
        alertname: Watchdog
      receiver: "null"  # Suppress watchdog alerts
      repeat_interval: 1m

    # ---- Deadmanswitch: if this alert stops firing, the pipeline is broken ----
    - match:
        alertname: PrometheusAlertmanagerJobMissing
      receiver: "pagerduty-critical"
      group_wait: 0s
      repeat_interval: 15m

# ======================================================
# RECEIVERS
# ======================================================
receivers:
  # Null sink — for alerts we intentionally want to suppress
  - name: "null"

  # PagerDuty — critical on-call
  - name: "pagerduty-critical"
    pagerduty_configs:
      - routing_key_file: /etc/alertmanager/pagerduty_critical_key
        description: "{{ .CommonLabels.alertname }}: {{ .CommonAnnotations.summary }}"
        severity: "{{ if eq .CommonLabels.severity \"critical\" }}critical{{ else }}error{{ end }}"
        class: "{{ .CommonLabels.alertname }}"
        component: "{{ .CommonLabels.service }}"
        group: "{{ .CommonLabels.cluster }}"
        details:
          firing: "{{ .Alerts.Firing | len }}"
          resolved: "{{ .Alerts.Resolved | len }}"
          runbook: "{{ .CommonAnnotations.runbook_url }}"
          dashboard: "{{ .CommonAnnotations.dashboard_url }}"
        # Links for quick navigation
        links:
          - href: "{{ .CommonAnnotations.runbook_url }}"
            text: "Runbook"
          - href: "{{ .CommonAnnotations.dashboard_url }}"
            text: "Dashboard"
        send_resolved: true

  # PagerDuty — database on-call
  - name: "pagerduty-database"
    pagerduty_configs:
      - routing_key_file: /etc/alertmanager/pagerduty_database_key
        severity: critical
        description: "Database Alert: {{ .CommonLabels.alertname }}"
        send_resolved: true

  # PagerDuty — network on-call
  - name: "pagerduty-network"
    pagerduty_configs:
      - routing_key_file: /etc/alertmanager/pagerduty_network_key
        severity: critical
        description: "Network Alert: {{ .CommonLabels.alertname }}"
        send_resolved: true

  # Slack — general ops channel
  - name: "slack-ops"
    slack_configs:
      - api_url_file: /etc/alertmanager/slack_ops_webhook
        channel: "#ops-alerts"
        title: "{{ .CommonLabels.alertname }}"
        text: |
          *Summary:* {{ .CommonAnnotations.summary }}
          *Severity:* {{ .CommonLabels.severity | toUpper }}
          *Cluster:* {{ .CommonLabels.cluster }}
          *Service:* {{ .CommonLabels.service }}
          {{ range .Alerts.Firing }}• Instance: {{ .Labels.instance }}
          {{ end }}
        send_resolved: true
        icon_emoji: ":prometheus:"
        username: "AlertManager"
        actions:
          - type: button
            text: "Runbook"
            url: "{{ .CommonAnnotations.runbook_url }}"
          - type: button
            text: "Dashboard"
            url: "{{ .CommonAnnotations.dashboard_url }}"
            style: primary

  # Slack — warning channel
  - name: "slack-warning"
    slack_configs:
      - api_url_file: /etc/alertmanager/slack_ops_webhook
        channel: "#alerts-warning"
        title: "[WARNING] {{ .CommonLabels.alertname }}"
        text: "{{ .CommonAnnotations.summary }}"
        send_resolved: true
        color: "warning"

  # Slack — platform team
  - name: "slack-platform"
    slack_configs:
      - api_url_file: /etc/alertmanager/slack_platform_webhook
        channel: "#platform-alerts"
        title: "{{ .CommonLabels.alertname }}"
        text: "{{ .CommonAnnotations.summary }}\n{{ .CommonAnnotations.description }}"
        send_resolved: true

  # Slack — payments team
  - name: "slack-payments-team"
    slack_configs:
      - api_url_file: /etc/alertmanager/slack_payments_webhook
        channel: "#payments-on-call"
        title: "[{{ .CommonLabels.severity | toUpper }}] {{ .CommonLabels.alertname }}"
        text: |
          *{{ .CommonAnnotations.summary }}*
          {{ .CommonAnnotations.description }}
          Affected: {{ range .Alerts.Firing }}{{ .Labels.instance }} {{ end }}
        send_resolved: true

  # Frontend team Slack
  - name: "slack-frontend-team"
    slack_configs:
      - api_url_file: /etc/alertmanager/slack_frontend_webhook
        channel: "#frontend-alerts"
        title: "{{ .CommonLabels.alertname }}"
        text: "{{ .CommonAnnotations.summary }}"
        send_resolved: true

  # Jira ticket creation for info-level alerts
  - name: "jira-create"
    webhook_configs:
      - url: "http://jira-alertmanager-bridge.tooling.svc.cluster.local/alert"
        send_resolved: false
        max_alerts: 50
```

## Section 4: Inhibition Rules

Inhibition prevents alert noise by suppressing alerts when a more severe root-cause alert is already firing. Without inhibition, a single node failure can trigger dozens of alerts for every service running on that node.

### Key Inhibition Patterns

```yaml
# alertmanager.yaml (inhibit_rules section)
inhibit_rules:
  # ============================================================
  # Pattern 1: Critical suppresses Warning for same object
  # ============================================================
  - source_match:
      severity: critical
    target_match:
      severity: warning
    # Only inhibit when both alerts share these labels
    # (ensures we only suppress WARNING for the SAME service/cluster)
    equal:
      - cluster
      - service

  # ============================================================
  # Pattern 2: Node down suppresses all pod/container alerts
  # ============================================================
  - source_match:
      alertname: "NodeNotReady"
    target_match_re:
      alertname: "KubePod.*|KubeContainer.*|KubeDeployment.*"
    equal:
      - cluster
      - node

  # Same but for node unreachable (exporter down)
  - source_match:
      alertname: "NodeUnreachable"
    target_match_re:
      alertname: ".*"
    equal:
      - cluster
      - instance  # instance = node:port for most exporters

  # ============================================================
  # Pattern 3: Cluster down suppresses everything in that cluster
  # ============================================================
  - source_match:
      alertname: "KubernetesClusterUnreachable"
    target_match_re:
      alertname: ".*"
    equal:
      - cluster

  # ============================================================
  # Pattern 4: DNS failure suppresses network connectivity alerts
  # When DNS is broken, every service appears unreachable
  # ============================================================
  - source_match:
      alertname: "CoreDNSUnhealthy"
    target_match_re:
      alertname: "ServiceEndpointUnreachable|ProbeHTTPFailure.*"
    equal:
      - cluster

  # ============================================================
  # Pattern 5: Database degraded suppresses application errors
  # If the database is slow, don't page for high app error rate too
  # ============================================================
  - source_match_re:
      alertname: "Postgres.*|MySQL.*"
      severity: "critical"
    target_match:
      alertname: "HighErrorRate"
    equal:
      - cluster

  # ============================================================
  # Pattern 6: Maintenance window marker
  # A special "maintenance" alert inhibits all other alerts
  # ============================================================
  - source_match:
      alertname: "MaintenanceWindowActive"
    target_match_re:
      alertname: ".*"
    equal:
      - cluster
      - service

  # ============================================================
  # Pattern 7: Kubernetes node drain suppresses pod alerts
  # When a node is being drained, pod termination is expected
  # ============================================================
  - source_match:
      alertname: "NodeBeingDrained"
    target_match_re:
      alertname: "KubePodCrashLooping|KubePodNotReady"
    equal:
      - cluster
      - node
```

### Creating a Maintenance Window via Alert

```yaml
# Create a synthetic "maintenance" alert to trigger inhibition
# This is cleaner than a silence because it's visible in alert state
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: maintenance-windows
  namespace: monitoring
spec:
  groups:
    - name: maintenance
      rules:
        # This rule evaluates to 1 when the time is within a maintenance window
        # Combine with inhibit_rules targeting alertname="MaintenanceWindowActive"
        - record: cluster:maintenance_window:active
          expr: |
            # Maintenance window: Saturdays 2:00-4:00 AM UTC
            (hour() >= 2 and hour() < 4 and day_of_week() == 6) or vector(0)

        - alert: MaintenanceWindowActive
          expr: cluster:maintenance_window:active == 1
          labels:
            severity: info
            cluster: "{{ $labels.cluster }}"
          annotations:
            summary: "Maintenance window active"
```

## Section 5: Silences

Silences are temporary suppressions created manually (via the AlertManager UI or API) for planned maintenance.

### Creating Silences via API

```bash
# Port-forward to AlertManager
kubectl port-forward -n monitoring svc/alertmanager-main 9093:9093 &

# Create a 2-hour silence for a planned deployment
SILENCE_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
SILENCE_END=$(date -u -d "+2 hours" +%Y-%m-%dT%H:%M:%SZ)

curl -X POST http://localhost:9093/api/v2/silences \
  -H "Content-Type: application/json" \
  -d "{
    \"matchers\": [
      {\"name\": \"alertname\", \"value\": \".*\", \"isRegex\": true},
      {\"name\": \"service\", \"value\": \"payments-api\", \"isRegex\": false}
    ],
    \"startsAt\": \"${SILENCE_START}\",
    \"endsAt\": \"${SILENCE_END}\",
    \"createdBy\": \"$(whoami)\",
    \"comment\": \"Planned deployment of payments-api v2.5.0 (DEPLOY-1234)\"
  }"
```

### Silence Management Script

```bash
#!/bin/bash
# am-silence.sh — AlertManager silence management CLI

set -euo pipefail

AM_URL="${ALERTMANAGER_URL:-http://localhost:9093}"

usage() {
    cat <<'EOF'
Usage: am-silence.sh <command> [options]

Commands:
  create   Create a new silence
  list     List all silences
  expire   Expire (delete) a silence by ID
  extend   Extend an existing silence by duration

Examples:
  # Silence all alerts for service=api-gateway for 1 hour
  am-silence.sh create --service api-gateway --duration 1h --comment "Deploying v2.1.0"

  # Silence specific alert on a cluster
  am-silence.sh create --alertname NodeNotReady --cluster prod-us-east-1 --duration 30m

  # List active silences
  am-silence.sh list

  # Expire a silence
  am-silence.sh expire <silence-id>
EOF
    exit 1
}

create_silence() {
    local matchers=()
    local duration="1h"
    local comment=""
    local service="" alertname="" cluster="" namespace="" severity=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --service)    service="$2"; shift 2 ;;
            --alertname)  alertname="$2"; shift 2 ;;
            --cluster)    cluster="$2"; shift 2 ;;
            --namespace)  namespace="$2"; shift 2 ;;
            --severity)   severity="$2"; shift 2 ;;
            --duration)   duration="$2"; shift 2 ;;
            --comment)    comment="$2"; shift 2 ;;
            *) echo "Unknown option: $1"; usage ;;
        esac
    done

    if [ -z "$comment" ]; then
        echo "ERROR: --comment is required"
        exit 1
    fi

    # Build matchers array
    local matchers_json="["
    [ -n "$service" ]    && matchers_json+='{"name":"service","value":"'"$service"'","isRegex":false},'
    [ -n "$alertname" ]  && matchers_json+='{"name":"alertname","value":"'"$alertname"'","isRegex":false},'
    [ -n "$cluster" ]    && matchers_json+='{"name":"cluster","value":"'"$cluster"'","isRegex":false},'
    [ -n "$namespace" ]  && matchers_json+='{"name":"namespace","value":"'"$namespace"'","isRegex":false},'
    [ -n "$severity" ]   && matchers_json+='{"name":"severity","value":"'"$severity"'","isRegex":false},'
    matchers_json="${matchers_json%,}]"

    if [ "$matchers_json" = "[]" ]; then
        echo "ERROR: At least one matcher is required"
        exit 1
    fi

    # Parse duration (convert to seconds for date calculation)
    local seconds
    seconds=$(python3 -c "
import re, sys
d = '$duration'
m = re.match(r'^(\d+)(s|m|h|d)$', d)
if not m: sys.exit(1)
n, unit = int(m.group(1)), m.group(2)
print({'s':n,'m':n*60,'h':n*3600,'d':n*86400}[unit])
")

    local start end
    start=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    end=$(date -u -d "+${seconds} seconds" +%Y-%m-%dT%H:%M:%SZ)

    local payload
    payload=$(cat <<EOF
{
  "matchers": ${matchers_json},
  "startsAt": "${start}",
  "endsAt": "${end}",
  "createdBy": "$(whoami)",
  "comment": "${comment}"
}
EOF
    )

    local result
    result=$(curl -s -X POST "${AM_URL}/api/v2/silences" \
        -H "Content-Type: application/json" \
        -d "$payload")

    local silence_id
    silence_id=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin)['silenceID'])")

    echo "Silence created: $silence_id"
    echo "Expires at: $end"
    echo ""
    echo "To expire early: $0 expire $silence_id"
}

list_silences() {
    curl -s "${AM_URL}/api/v2/silences" | \
    python3 -c "
import sys, json
silences = json.load(sys.stdin)
active = [s for s in silences if s['status']['state'] == 'active']
print(f'Active silences: {len(active)}')
print()
for s in active:
    print(f\"ID: {s['id']}\")
    print(f\"  Comment: {s['comment']}\")
    print(f\"  Creator: {s['createdBy']}\")
    print(f\"  Ends at: {s['endsAt']}\")
    print(f\"  Matchers:\")
    for m in s['matchers']:
        print(f\"    {m['name']}={'~' if m['isRegex'] else ''}{m['value']}\")
    print()
"
}

expire_silence() {
    local silence_id="${1:?Usage: am-silence.sh expire <silence-id>}"
    curl -s -X DELETE "${AM_URL}/api/v2/silence/${silence_id}"
    echo "Silence ${silence_id} expired"
}

case "${1:-help}" in
    create) shift; create_silence "$@" ;;
    list)   list_silences ;;
    expire) expire_silence "${2:-}" ;;
    *) usage ;;
esac
```

## Section 6: AlertManager High Availability

AlertManager uses a gossip protocol (based on memberlist) to form a cluster. All AlertManager instances share notification state to prevent sending duplicate notifications when multiple instances receive the same alert.

### HA Configuration

```yaml
# StatefulSet for AlertManager HA (if not using Prometheus Operator)
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: alertmanager
  namespace: monitoring
spec:
  replicas: 3
  serviceName: alertmanager
  selector:
    matchLabels:
      app: alertmanager
  template:
    metadata:
      labels:
        app: alertmanager
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: alertmanager
              topologyKey: kubernetes.io/hostname

      containers:
        - name: alertmanager
          image: quay.io/prometheus/alertmanager:v0.28.0
          args:
            - "--config.file=/etc/alertmanager/alertmanager.yaml"
            - "--storage.path=/alertmanager"
            - "--web.external-url=https://alertmanager.example.com"
            - "--cluster.listen-address=0.0.0.0:9094"
            # Peer addresses — use the StatefulSet DNS names
            - "--cluster.peer=alertmanager-0.alertmanager.monitoring.svc.cluster.local:9094"
            - "--cluster.peer=alertmanager-1.alertmanager.monitoring.svc.cluster.local:9094"
            - "--cluster.peer=alertmanager-2.alertmanager.monitoring.svc.cluster.local:9094"
            - "--cluster.settle-timeout=30s"
            - "--cluster.gossip-interval=200ms"
            - "--cluster.pushpull-interval=1m"
          ports:
            - name: web
              containerPort: 9093
            - name: mesh
              containerPort: 9094
          readinessProbe:
            httpGet:
              path: /-/ready
              port: web
            initialDelaySeconds: 30
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /-/healthy
              port: web
            periodSeconds: 10
          volumeMounts:
            - name: config
              mountPath: /etc/alertmanager
            - name: storage
              mountPath: /alertmanager

      volumes:
        - name: config
          secret:
            secretName: alertmanager-main

  volumeClaimTemplates:
    - metadata:
        name: storage
      spec:
        storageClassName: gp3
        accessModes: [ReadWriteOnce]
        resources:
          requests:
            storage: 10Gi
```

### Verifying HA Cluster Health

```bash
# Check cluster membership
curl -s http://alertmanager:9093/api/v2/status | jq '{
  cluster: .cluster.status,
  peers: [.cluster.peers[] | {name: .name, address: .address, state: .state}]
}'

# Expected output:
# {
#   "cluster": "ready",
#   "peers": [
#     {"name": "alertmanager-0", "address": "10.0.1.100:9094", "state": "alive"},
#     {"name": "alertmanager-1", "address": "10.0.1.101:9094", "state": "alive"},
#     {"name": "alertmanager-2", "address": "10.0.1.102:9094", "state": "alive"}
#   ]
# }

# Check that Prometheus is sending to all AlertManager instances
# In prometheus.yaml:
# alerting:
#   alertmanagers:
#     - kubernetes_sd_configs:
#         - role: endpoints
#           namespaces:
#             names: [monitoring]
#       scheme: http
#       path_prefix: /
#       tls_config:
#         insecure_skip_verify: false
#       relabel_configs:
#         - source_labels: [__meta_kubernetes_service_name]
#           action: keep
#           regex: alertmanager
```

## Section 7: Alert Deduplication

When you run multiple Prometheus instances (for HA), each sends the same alert to AlertManager. AlertManager deduplicates based on the alert fingerprint (combination of alert name and labels).

```yaml
# Prometheus configuration — send to all AlertManager instances
# prometheus.yaml
alerting:
  alert_relabel_configs:
    # Normalize labels before sending to AlertManager
    # Strip dynamic labels that would prevent deduplication
    - action: labeldrop
      regex: "replica|pod_template_hash"

  alertmanagers:
    - scheme: http
      static_configs:
        - targets:
            - "alertmanager-0.alertmanager.monitoring.svc.cluster.local:9093"
            - "alertmanager-1.alertmanager.monitoring.svc.cluster.local:9093"
            - "alertmanager-2.alertmanager.monitoring.svc.cluster.local:9093"
      timeout: 10s
      api_version: v2
```

### Alert Fingerprint Design

The fingerprint is computed from the alert's label set. Labels that vary between Prometheus replicas will create different fingerprints and bypass deduplication:

```yaml
# BAD: including 'prometheus_replica' label breaks deduplication
- alert: HighErrorRate
  expr: |
    sum by (service, prometheus_replica) (rate(http_requests_total{status=~"5.."}[5m]))
    /
    sum by (service, prometheus_replica) (rate(http_requests_total[5m]))
    > 0.05
  labels:
    alertname: HighErrorRate
    severity: critical

# GOOD: aggregate across replicas to create a single fingerprint
- alert: HighErrorRate
  expr: |
    sum by (service) (rate(http_requests_total{status=~"5.."}[5m]))
    /
    sum by (service) (rate(http_requests_total[5m]))
    > 0.05
  labels:
    alertname: HighErrorRate
    severity: critical
```

## Section 8: Notification Templates

```
# /etc/alertmanager/templates/pagerduty.tmpl
{{ define "pagerduty.description" -}}
[{{ .CommonLabels.severity | toUpper }}] {{ .CommonLabels.alertname }}
Cluster: {{ .CommonLabels.cluster }}
Service: {{ .CommonLabels.service | default "unknown" }}
{{ range .Alerts.Firing }}
Instance: {{ .Labels.instance | default "N/A" }}
Value: {{ .Annotations.value | default "N/A" }}
{{ end }}
{{- end }}

{{ define "pagerduty.summary" -}}
{{ .CommonAnnotations.summary }}
{{ if gt (len .Alerts.Firing) 1 }}({{ len .Alerts.Firing }} instances firing){{ end }}
{{- end }}
```

```
# /etc/alertmanager/templates/slack.tmpl
{{ define "slack.title" -}}
[{{ .CommonLabels.severity | toUpper }}] {{ .CommonLabels.alertname }}
{{ if .CommonLabels.cluster }}on {{ .CommonLabels.cluster }}{{ end }}
{{- end }}

{{ define "slack.text" -}}
{{ .CommonAnnotations.summary }}
{{ if .CommonAnnotations.description }}
> {{ .CommonAnnotations.description }}
{{ end }}
*Affected:*
{{ range .Alerts.Firing -}}
• `{{ .Labels.instance | default .Labels.pod | default "unknown" }}`
  Value: {{ .Annotations.value | default "N/A" }}
{{ end }}
*Labels:* {{ range $k, $v := .CommonLabels }} `{{ $k }}={{ $v }}`{{ end }}
{{- end }}

{{ define "slack.color" -}}
{{ if eq .Status "resolved" }}good
{{ else if eq .CommonLabels.severity "critical" }}danger
{{ else if eq .CommonLabels.severity "warning" }}warning
{{ else }}#439FE0{{ end }}
{{- end }}
```

## Section 9: AlertmanagerConfig — Per-Team Configuration

With Prometheus Operator, teams can configure their own routing using `AlertmanagerConfig` objects in their namespace:

```yaml
# Team-specific AlertmanagerConfig
apiVersion: monitoring.coreos.com/v1alpha1
kind: AlertmanagerConfig
metadata:
  name: payments-team
  namespace: payments
spec:
  route:
    receiver: payments-slack
    matchers:
      - name: namespace
        value: payments
    groupBy:
      - alertname
      - service
    groupWait: 30s
    repeatInterval: 4h

  receivers:
    - name: payments-slack
      slackConfigs:
        - apiURL:
            name: slack-payments-secret
            key: webhook-url
          channel: "#payments-on-call"
          title: "{{ .CommonLabels.alertname }}"
          text: "{{ .CommonAnnotations.summary }}"
          sendResolved: true
```

## Section 10: Testing AlertManager Configuration

```bash
#!/bin/bash
# test-alertmanager.sh — validate routing before deploying

AM_URL="${ALERTMANAGER_URL:-http://localhost:9093}"

# Test configuration syntax
amtool check-config alertmanager.yaml

# Test routing for a specific alert
echo "Testing routing for critical alert..."
amtool --alertmanager.url="${AM_URL}" config routes test \
  --verify.receivers="pagerduty-critical" \
  alertname="HighCPU" severity="critical" cluster="prod-us-east-1" service="api"

# Test routing for warning
echo "Testing routing for warning alert..."
amtool --alertmanager.url="${AM_URL}" config routes test \
  --verify.receivers="slack-warning" \
  alertname="HighMemory" severity="warning" cluster="prod-us-east-1" team="platform"

# Test inhibition
echo "Testing inhibition rules..."
# Fire the inhibitor first
curl -s -X POST "${AM_URL}/api/v2/alerts" \
  -H "Content-Type: application/json" \
  -d '[{
    "labels": {
      "alertname": "NodeNotReady",
      "severity": "critical",
      "cluster": "prod-us-east-1",
      "node": "node-1"
    },
    "annotations": {"summary": "Node not ready"},
    "generatorURL": "http://test",
    "startsAt": "2031-01-01T00:00:00Z"
  }]'

# Then fire what should be inhibited
curl -s -X POST "${AM_URL}/api/v2/alerts" \
  -H "Content-Type: application/json" \
  -d '[{
    "labels": {
      "alertname": "KubePodCrashLooping",
      "severity": "warning",
      "cluster": "prod-us-east-1",
      "node": "node-1"
    },
    "annotations": {"summary": "Pod crash looping"},
    "generatorURL": "http://test",
    "startsAt": "2031-01-01T00:00:00Z"
  }]'

# Check if the inhibition worked — KubePodCrashLooping should NOT appear in active alerts
echo ""
echo "Active alerts (KubePodCrashLooping should be inhibited):"
curl -s "${AM_URL}/api/v2/alerts?active=true" | \
  python3 -c "
import sys, json
alerts = json.load(sys.stdin)
for a in alerts:
    print(f\"  {a['labels']['alertname']}: {a['status']['state']}\")
"
```

## Summary

Effective AlertManager configuration in production requires:

1. **Routing tree hierarchy**: root → severity → team → specific component. Specific routes should have `continue: false` (the default) to prevent double notifications.
2. **Inhibition rules** for every class of cascading failure: node down suppresses pod alerts, cluster unreachable suppresses all cluster alerts, database critical suppresses application error rates.
3. **HA clustering** with 3 replicas and pod anti-affinity across nodes — AlertManager gossip ensures only one notification is sent even when multiple instances receive the same alert.
4. **Persistent storage** for silences and notification log — without persistence, silences are lost on pod restart.
5. **Template customization** with runbook URL and dashboard links in every notification — on-call engineers should have all context in the notification itself.
6. **API-driven silences** integrated into your deployment pipeline — automatically silence alerts during planned deployments.
7. **Deduplication via label design** — Prometheus recording rules should aggregate away replica-specific labels before alerts fire.

The two most common AlertManager configuration mistakes are: (1) no inhibition rules, leading to alert storms when infrastructure fails, and (2) too-broad routing that sends critical pages to the wrong team. Invest time in both before your first production incident.
