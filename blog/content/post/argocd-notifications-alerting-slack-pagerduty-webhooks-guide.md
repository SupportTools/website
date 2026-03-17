---
title: "ArgoCD Notifications and Alerting: Slack, PagerDuty, and Custom Webhooks"
date: 2028-12-13T00:00:00-05:00
draft: false
tags: ["ArgoCD", "GitOps", "Kubernetes", "Notifications", "PagerDuty", "Slack"]
categories:
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to configuring ArgoCD notifications for enterprise environments, covering Slack integration, PagerDuty alerts, custom webhook integrations, multi-team routing, and notification policy design for production GitOps workflows."
more_link: "yes"
url: "/argocd-notifications-alerting-slack-pagerduty-webhooks-guide/"
---

ArgoCD manages the desired state of dozens or hundreds of applications in production Kubernetes clusters. Without a robust notification system, deployment failures, sync errors, and health degradation events go undetected until customers or on-call engineers notice symptoms. The ArgoCD Notifications controller provides a declarative, flexible system for routing application events to any alerting destination.

This guide covers the complete ArgoCD notifications architecture: installing and configuring the notifications controller, creating templates and triggers for meaningful alert content, integrating with Slack for team notifications, PagerDuty for on-call alerting, and custom webhooks for internal systems, plus patterns for multi-team notification routing and alert fatigue reduction.

<!--more-->

## ArgoCD Notifications Architecture

The ArgoCD Notifications system consists of three conceptual layers:

1. **Services**: Connection configurations for external notification systems (Slack, PagerDuty, email, webhooks)
2. **Templates**: Reusable message formats that define what information to include in notifications
3. **Triggers**: Conditions (expressed as Lua scripts) that determine when to send notifications

**Subscriptions** connect applications to triggers and specify which services to notify. They can be applied globally (via the ArgoCD configuration ConfigMap) or per-application (via application annotations).

### Installation

ArgoCD Notifications is bundled with ArgoCD since v2.3. For standalone installation or upgrades:

```bash
# Install with Helm (recommended for production)
helm upgrade --install argocd argo/argo-cd \
  --namespace argocd \
  --create-namespace \
  --version 6.12.0 \
  --set notifications.enabled=true \
  --set notifications.metrics.enabled=true \
  --set notifications.metrics.serviceMonitor.enabled=true

# Verify notifications controller is running
kubectl get pods -n argocd -l app.kubernetes.io/component=notifications-controller
```

## Configuring Notification Services

Services are configured in the `argocd-notifications-cm` ConfigMap. Secrets for API tokens and webhook URLs are stored separately in `argocd-notifications-secret`.

### Slack Integration

```bash
# Create a Slack Bot token
# 1. Go to https://api.slack.com/apps
# 2. Create a new app, add "Incoming Webhooks" and "chat:write" OAuth scopes
# 3. Install the app to your workspace and copy the Bot Token (xoxb-...)

# Store the Slack token in the notifications secret
kubectl create secret generic argocd-notifications-secret \
  --namespace argocd \
  --from-literal=slack-token=xoxb-your-bot-token-here \
  --dry-run=client -o yaml | kubectl apply -f -
```

```yaml
# argocd-notifications-cm ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-notifications-cm
  namespace: argocd
data:
  service.slack: |
    token: $slack-token
    username: ArgoCD
    icon: ":argo:"
    # Optional: set a default signing secret for webhook verification
    signingSecret: $slack-signing-secret
```

### PagerDuty Integration

```bash
# Create a PagerDuty Events API v2 integration key
# 1. In PagerDuty: Services > Service Directory > [Your Service] > Integrations
# 2. Add an integration: Events API v2
# 3. Copy the Integration Key

kubectl create secret generic argocd-notifications-secret \
  --namespace argocd \
  --from-literal=pagerduty-token=pdp_your_integration_key \
  --dry-run=client -o yaml | kubectl apply -f -
```

```yaml
# In argocd-notifications-cm
data:
  service.pagerduty: |
    token: $pagerduty-token
    # serviceID is overridden per-notification; this is the fallback
    serviceID: PXXXXXXX
```

### Custom Webhook Configuration

```yaml
# In argocd-notifications-cm
data:
  service.webhook.teams: |
    url: https://companyname.webhook.office.com/webhookb2/abc123@def456/IncomingWebhook/xyz789/zzz
    headers:
    - name: Content-Type
      value: application/json

  service.webhook.internal-alerting: |
    url: https://alerts.internal.example.com/api/v1/argocd-events
    headers:
    - name: Content-Type
      value: application/json
    - name: Authorization
      value: Bearer $internal-alerting-token
    # Optional: custom TLS for internal services
    insecureSkipVerify: false
```

## Notification Templates

Templates define the content of notifications using the Go template language with access to the ArgoCD application object.

### Slack Deployment Notification Template

```yaml
# In argocd-notifications-cm
data:
  template.app-deployed: |
    message: |
      :white_check_mark: Application *{{.app.metadata.name}}* has been deployed.
    slack:
      attachments: |
        [{
          "title": "{{.app.metadata.name}}",
          "title_link": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}",
          "color": "#18be52",
          "fields": [
            {
              "title": "Sync Status",
              "value": "{{.app.status.sync.status}}",
              "short": true
            },
            {
              "title": "Repository",
              "value": "{{.app.spec.source.repoURL}}",
              "short": true
            },
            {
              "title": "Revision",
              "value": "{{.app.status.sync.revision}}",
              "short": true
            },
            {
              "title": "Environment",
              "value": "{{.app.metadata.labels.environment}}",
              "short": true
            }
          ],
          "footer": "ArgoCD",
          "ts": {{.app.status.operationState.finishedAt | toUnixTime}}
        }]
      groupingKey: "{{.app.metadata.name}}-deployed"
      notifyBroadcast: false

  template.app-sync-failed: |
    message: |
      :x: Application *{{.app.metadata.name}}* sync FAILED.
    slack:
      attachments: |
        [{
          "title": "{{.app.metadata.name}} - Sync Failed",
          "title_link": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}",
          "color": "#E96D76",
          "fields": [
            {
              "title": "Error",
              "value": "{{.app.status.operationState.message}}",
              "short": false
            },
            {
              "title": "Repository",
              "value": "{{.app.spec.source.repoURL}}",
              "short": true
            },
            {
              "title": "Target Revision",
              "value": "{{.app.spec.source.targetRevision}}",
              "short": true
            },
            {
              "title": "Phase",
              "value": "{{.app.status.operationState.phase}}",
              "short": true
            }
          ],
          "footer": "ArgoCD | {{.app.metadata.namespace}}"
        }]
      groupingKey: "{{.app.metadata.name}}-sync-failed"

  template.app-health-degraded: |
    message: |
      :warning: Application *{{.app.metadata.name}}* health is DEGRADED.
    slack:
      attachments: |
        [{
          "title": "{{.app.metadata.name}} - Health Degraded",
          "title_link": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}",
          "color": "#f4c030",
          "fields": [
            {
              "title": "Health Status",
              "value": "{{.app.status.health.status}}",
              "short": true
            },
            {
              "title": "Message",
              "value": "{{.app.status.health.message}}",
              "short": false
            },
            {{range .app.status.resources}}
            {{if eq .health.status "Degraded"}}
            {
              "title": "{{.kind}}/{{.name}}",
              "value": "{{.health.message}}",
              "short": false
            },
            {{end}}
            {{end}}
            {
              "title": "Environment",
              "value": "{{.app.metadata.labels.environment}}",
              "short": true
            }
          ]
        }]
```

### PagerDuty Template

```yaml
  template.app-sync-failed-pagerduty: |
    message: "ArgoCD: Application {{.app.metadata.name}} sync failed"
    pagerdutyV2:
      routingKey: $pagerduty-token
      class: "argocd-sync-failure"
      component: "{{.app.metadata.name}}"
      group: "{{.app.metadata.labels.team}}"
      severity: "error"
      customDetails: |
        {
          "application": "{{.app.metadata.name}}",
          "namespace": "{{.app.spec.destination.namespace}}",
          "cluster": "{{.app.spec.destination.server}}",
          "repository": "{{.app.spec.source.repoURL}}",
          "revision": "{{.app.spec.source.targetRevision}}",
          "error": "{{.app.status.operationState.message}}",
          "argocd_url": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}"
        }

  template.app-health-critical-pagerduty: |
    message: "ArgoCD: Application {{.app.metadata.name}} is unhealthy in production"
    pagerdutyV2:
      routingKey: $pagerduty-token
      class: "argocd-health-critical"
      component: "{{.app.metadata.name}}"
      group: "{{.app.metadata.labels.team}}"
      severity: "critical"
      customDetails: |
        {
          "application": "{{.app.metadata.name}}",
          "health_status": "{{.app.status.health.status}}",
          "health_message": "{{.app.status.health.message}}",
          "sync_status": "{{.app.status.sync.status}}",
          "environment": "{{.app.metadata.labels.environment}}",
          "argocd_url": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}"
        }
```

### Microsoft Teams Webhook Template

```yaml
  template.app-deployed-teams: |
    webhook:
      teams:
        method: POST
        body: |
          {
            "@type": "MessageCard",
            "@context": "http://schema.org/extensions",
            "themeColor": "18BE52",
            "summary": "{{.app.metadata.name}} deployed successfully",
            "sections": [{
              "activityTitle": "Deployment Successful: **{{.app.metadata.name}}**",
              "activitySubtitle": "{{.app.metadata.labels.environment}} environment",
              "activityImage": "https://argo-cd.readthedocs.io/en/stable/assets/logo.png",
              "facts": [
                {"name": "Revision", "value": "{{.app.status.sync.revision}}"},
                {"name": "Repository", "value": "{{.app.spec.source.repoURL}}"},
                {"name": "Namespace", "value": "{{.app.spec.destination.namespace}}"},
                {"name": "Status", "value": "{{.app.status.sync.status}}"}
              ]
            }],
            "potentialAction": [{
              "@type": "OpenUri",
              "name": "View in ArgoCD",
              "targets": [{
                "os": "default",
                "uri": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}"
              }]
            }]
          }
```

## Triggers: Defining When to Notify

Triggers are Lua scripts that evaluate application state. Multiple conditions can be defined per trigger using `when`, `oncePer`, and `send` fields.

### Standard Trigger Definitions

```yaml
# In argocd-notifications-cm
data:
  trigger.on-deployed: |
    - description: Application was deployed successfully
      oncePer: app.status.operationState?.syncResult?.revision
      send:
      - app-deployed
      when: |
        app.status.operationState != nil and
        app.status.operationState.phase in ['Succeeded'] and
        app.status.health.status == 'Healthy'

  trigger.on-sync-failed: |
    - description: Application sync has failed
      send:
      - app-sync-failed
      when: |
        app.status.operationState != nil and
        app.status.operationState.phase in ['Error', 'Failed']

  trigger.on-sync-running: |
    - description: Application is currently syncing
      send:
      - app-syncing
      when: |
        app.status.operationState != nil and
        app.status.operationState.phase in ['Running']

  trigger.on-health-degraded: |
    - description: Application health has degraded
      send:
      - app-health-degraded
      when: |
        app.status.health.status == 'Degraded'

  trigger.on-health-degraded-critical: |
    - description: Critical application has degraded health (production only)
      send:
      - app-health-critical-pagerduty
      - app-health-degraded
      when: |
        app.status.health.status == 'Degraded' and
        app.metadata.labels.environment == 'production' and
        app.metadata.labels.severity == 'critical'

  trigger.on-sync-status-unknown: |
    - description: Application sync status is unknown
      send:
      - app-sync-status-unknown
      when: app.status.sync.status == 'Unknown'
```

### Advanced Trigger: Comparing Revisions

```yaml
  trigger.on-new-image-deployed: |
    - description: A new container image has been deployed
      oncePer: app.status.summary.images
      send:
      - app-new-image
      when: |
        app.status.operationState != nil and
        app.status.operationState.phase in ['Succeeded'] and
        len(app.status.summary.images) > 0
```

### Using `oncePer` to Prevent Duplicate Notifications

The `oncePer` field is critical for preventing notification storms. Without it, a trigger that continuously evaluates to `true` will send a notification on every evaluation cycle (default: 30 seconds).

```yaml
  trigger.on-sync-failed: |
    - description: Application sync has failed — notify once per operation
      # oncePer with the operation start time prevents re-notification
      # for the same failed sync operation
      oncePer: app.status.operationState?.startedAt
      send:
      - app-sync-failed
      when: |
        app.status.operationState != nil and
        app.status.operationState.phase in ['Error', 'Failed']
```

## Default Subscriptions

Default subscriptions apply to all applications matching a selector. Configure them in the `argocd-notifications-cm`:

```yaml
  defaultTriggers: |
    - on-sync-failed
    - on-health-degraded
    - on-deployed
```

To route different event types to different Slack channels based on application labels:

```yaml
  subscriptions: |
    # Production alerts go to the prod-alerts channel
    - recipients:
      - slack:prod-alerts
      triggers:
      - on-sync-failed
      - on-health-degraded-critical
      selector: environment=production

    # All deployment notifications go to the deploys channel
    - recipients:
      - slack:deployments
      triggers:
      - on-deployed
      selector: ""

    # Development/staging failures go to the dev-alerts channel
    - recipients:
      - slack:dev-alerts
      triggers:
      - on-sync-failed
      - on-health-degraded
      selector: environment notin (production)
```

## Per-Application Notification Configuration

Applications can override global subscriptions or add team-specific notifications via annotations:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: payments-api-production
  namespace: argocd
  annotations:
    # Route notifications for this app to the payments team channel
    notifications.argoproj.io/subscribe.on-deployed.slack: "payments-team"
    notifications.argoproj.io/subscribe.on-sync-failed.slack: "payments-team"
    notifications.argoproj.io/subscribe.on-health-degraded-critical.pagerdutyV2: ""

    # Subscribe to additional triggers not in the default set
    notifications.argoproj.io/subscribe.on-sync-status-unknown.slack: "payments-team"

  labels:
    environment: production
    team: payments
    severity: critical
spec:
  project: payments
  source:
    repoURL: https://github.com/example/gitops
    targetRevision: main
    path: apps/payments-api/production
  destination:
    server: https://kubernetes.default.svc
    namespace: payments
```

### Disabling Notifications for Specific Applications

```yaml
metadata:
  annotations:
    # Completely disable all notifications for maintenance windows
    notifications.argoproj.io/disable: "true"
```

## Multi-Team Notification Routing

For organizations with many teams each owning applications, a label-based routing architecture scales well:

### Label Schema

```yaml
# Standard labels applied to all ArgoCD Applications
metadata:
  labels:
    team: "payments"              # Owning team
    environment: "production"     # Deployment target
    severity: "critical"          # Determines PagerDuty routing
    notification-channel: "payments-alerts"  # Slack channel override
```

### Team-Specific Secret Configuration

```bash
# Each team's Slack token stored in the notifications secret
kubectl create secret generic argocd-notifications-secret \
  --namespace argocd \
  --from-literal=slack-token-payments=xoxb-payments-team-token \
  --from-literal=slack-token-orders=xoxb-orders-team-token \
  --from-literal=slack-token-platform=xoxb-platform-team-token \
  --dry-run=client -o yaml | kubectl apply -f -
```

```yaml
# Multiple Slack service instances
data:
  service.slack.payments: |
    token: $slack-token-payments
    username: ArgoCD

  service.slack.orders: |
    token: $slack-token-orders
    username: ArgoCD

  service.slack.platform: |
    token: $slack-token-platform
    username: ArgoCD
```

### Dynamic Channel Selection via Template Functions

```yaml
  template.app-deployed-dynamic: |
    slack:
      attachments: |
        [{
          "title": "{{.app.metadata.name}} deployed",
          "color": "#18be52",
          "fields": [
            {"title": "Team", "value": "{{.app.metadata.labels.team}}", "short": true},
            {"title": "Env", "value": "{{.app.metadata.labels.environment}}", "short": true}
          ]
        }]
      # Channel is determined by application label, with fallback
      channel: "{{index .app.metadata.labels \"notification-channel\" | default (cat .app.metadata.labels.team \"-deployments\")}}"
```

## Testing Notifications

Before relying on notifications in production, test them:

```bash
# Test a notification manually using argocd admin commands
argocd admin notifications trigger run on-sync-failed \
  --application payments-api-production \
  --recipient slack:payments-team \
  -n argocd

# Test all templates for an application
argocd admin notifications template notify \
  app-sync-failed payments-api-production \
  --recipient slack:payments-team \
  -n argocd

# Preview a notification without sending
argocd admin notifications template notify \
  app-deployed payments-api-production \
  --recipient slack:payments-team \
  --dry-run \
  -n argocd
```

## Observability for the Notifications Controller

### Prometheus Metrics

The notifications controller exposes metrics when enabled:

```bash
# View available metrics
kubectl port-forward -n argocd svc/argocd-notifications-controller-metrics 9001:9001 &
curl -s http://localhost:9001/metrics | grep argocd_notifications
```

Key metrics:

| Metric | Description |
|--------|-------------|
| `argocd_notifications_deliveries_total` | Total notifications sent, labeled by trigger and service |
| `argocd_notifications_trigger_eval_total` | Total trigger evaluations |
| `argocd_notifications_failed_deliveries_total` | Failed notification delivery attempts |

### Alerting on Notification Failures

```yaml
groups:
- name: argocd-notifications
  rules:
  - alert: ArgoCDNotificationDeliveryFailed
    expr: |
      increase(argocd_notifications_failed_deliveries_total[30m]) > 5
    labels:
      severity: warning
    annotations:
      summary: "ArgoCD notifications are failing to deliver"
      description: "{{ $value }} notification delivery failures in the last 30 minutes for trigger={{ $labels.trigger }}, service={{ $labels.service }}"

  - alert: ArgoCDSyncFailed
    expr: |
      count(argocd_app_info{sync_status="Unknown"}) > 0
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "ArgoCD application sync status is Unknown"
```

## Notification Fatigue Reduction

High-velocity environments produce many notifications. These practices reduce fatigue:

### 1. Use `oncePer` Consistently

Always include `oncePer` in triggers for conditions that may persist:

```yaml
  trigger.on-health-degraded: |
    - oncePer: app.status.reconciledAt  # Only notify once per reconciliation cycle
      send:
      - app-health-degraded
      when: app.status.health.status == 'Degraded'
```

### 2. Scope Critical Alerts to Production

```yaml
  trigger.on-sync-failed-critical: |
    - description: Production application sync failed — pages on-call
      oncePer: app.status.operationState?.startedAt
      send:
      - app-sync-failed-pagerduty
      when: |
        app.status.operationState != nil and
        app.status.operationState.phase in ['Error', 'Failed'] and
        app.metadata.labels.environment == 'production'
```

### 3. Suppress Notifications During Maintenance Windows

```bash
# During a maintenance window, annotate all affected applications
kubectl annotate application --all -n argocd \
  notifications.argoproj.io/disable="true"

# Remove annotation after maintenance
kubectl annotate application --all -n argocd \
  notifications.argoproj.io/disable-
```

### 4. Group Notifications by Application Set

When using ApplicationSets, configure notifications at the ApplicationSet level to avoid per-instance noise:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: payments-all-envs
  namespace: argocd
  annotations:
    notifications.argoproj.io/subscribe.on-deployed.slack: "deployments"
    notifications.argoproj.io/subscribe.on-sync-failed.slack: "payments-alerts"
spec:
  generators:
  - list:
      elements:
      - env: dev
      - env: staging
      - env: production
```

## Conclusion

A well-designed ArgoCD notification configuration transforms GitOps from a passive synchronization system into an active operational platform. The key design principles:

1. **Route by environment**: Production events trigger PagerDuty; non-production events go to team Slack channels
2. **Use `oncePer` on every trigger** for persistent conditions to prevent notification storms
3. **Embed actionable context** in templates (ArgoCD URL, error message, revision) to reduce time-to-diagnosis
4. **Apply label conventions** consistently across applications to enable dynamic routing
5. **Test notifications proactively** using `argocd admin notifications` before relying on them during incidents
6. **Monitor delivery failures** with Prometheus to catch broken notification paths before they matter

The annotations-based per-application override system provides the flexibility for individual teams to customize their notification preferences while maintaining organizational defaults enforced through the global ConfigMap.
