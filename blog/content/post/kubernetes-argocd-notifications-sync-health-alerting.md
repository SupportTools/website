---
title: "Kubernetes ArgoCD Notifications: Alerting on Sync Status and Health"
date: 2029-10-28T00:00:00-05:00
draft: false
tags: ["Kubernetes", "ArgoCD", "GitOps", "Notifications", "Slack", "PagerDuty", "Alerting"]
categories: ["Kubernetes", "GitOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to ArgoCD Notifications Engine: configuring triggers and templates, integrating Slack, PagerDuty, and GitHub, using annotation-based subscriptions, and building custom webhook templates for enterprise GitOps alerting."
more_link: "yes"
url: "/kubernetes-argocd-notifications-sync-health-alerting/"
---

ArgoCD Notifications fills a critical gap in GitOps workflows: knowing immediately when a deployment succeeds, fails, or enters a degraded state. Without notifications, teams must actively monitor the ArgoCD UI or rely on end-user reports to discover issues. The Notifications Engine—now integrated directly into ArgoCD—provides a flexible trigger-and-template system that routes alerts to Slack, PagerDuty, GitHub, Microsoft Teams, and any webhook endpoint. This guide covers the complete setup from catalog defaults through custom enterprise integrations.

<!--more-->

# Kubernetes ArgoCD Notifications: Alerting on Sync Status and Health

## Section 1: ArgoCD Notifications Architecture

The notifications system consists of four components:

- **Triggers**: Conditions that, when true, send a notification. Examples: `on-sync-failed`, `on-health-degraded`, `on-deployed`.
- **Templates**: The message format for each notification. Can be different for each destination.
- **Services**: The delivery mechanism — Slack webhook, PagerDuty API, SMTP, etc.
- **Subscriptions**: Which applications send which notifications to which services. Managed via annotations on ArgoCD Application resources.

```
Application Resource
    │
    ├── annotation: notifications.argoproj.io/subscribe.on-sync-failed.slack: ops-alerts
    │
    └── ArgoCD Notifications Controller
            │
            ├── Evaluates triggers on every reconciliation
            ├── Renders templates with application context
            └── Delivers via configured services
```

### Installation

ArgoCD Notifications is bundled with ArgoCD v2.3+. For standalone installation:

```bash
kubectl apply -n argocd -f \
  https://raw.githubusercontent.com/argoproj/argo-cd/stable/notifications_catalog/install.yaml
```

The notifications controller runs as a separate deployment:

```bash
kubectl get deployment argocd-notifications-controller -n argocd
```

## Section 2: Service Configuration

Services are configured in the `argocd-notifications-cm` ConfigMap and credentials in `argocd-notifications-secret`.

### Slack Integration

```yaml
# argocd-notifications-cm.yaml
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
    signingSecret: $slack-signing-secret
```

```yaml
# argocd-notifications-secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: argocd-notifications-secret
  namespace: argocd
type: Opaque
stringData:
  slack-token: "xoxb-your-slack-bot-token"
  slack-signing-secret: "your-signing-secret"
```

For webhook-based Slack (simpler, no bot token needed):

```yaml
data:
  service.webhook.slack-webhook: |
    url: https://hooks.slack.com/services/<WORKSPACE_ID>/<CHANNEL_ID>/<WEBHOOK_TOKEN>
    headers:
      - name: Content-Type
        value: application/json
```

### PagerDuty Integration

```yaml
data:
  service.pagerduty: |
    token: $pagerduty-token
    # Alternative: use the Events API v2

  # PagerDuty via webhook (Events API v2)
  service.webhook.pagerduty-events: |
    url: https://events.pagerduty.com/v2/enqueue
    headers:
      - name: Content-Type
        value: application/json
```

```yaml
# In secret
stringData:
  pagerduty-token: "your-pagerduty-api-token"
```

### GitHub Deployment Status Integration

```yaml
data:
  service.github: |
    appID: $github-app-id
    installationID: $github-installation-id
    privateKey: $github-private-key
```

This integration creates GitHub deployment status events directly on commits, linking ArgoCD sync status to the GitHub UI.

### Microsoft Teams

```yaml
data:
  service.teams: |
    recipientUrls:
      ops-channel: https://outlook.office.com/webhook/<WEBHOOK_URL>
      critical-channel: https://outlook.office.com/webhook/<WEBHOOK_URL_2>
```

### Email (SMTP)

```yaml
data:
  service.email: |
    host: smtp.example.com
    port: 587
    from: argocd@example.com
    username: $smtp-username
    password: $smtp-password
    html: true
```

## Section 3: Triggers

Triggers define when notifications fire. Each trigger has a `when` condition (Go template evaluating to true/false) and a list of `send` templates.

### Built-in Catalog Triggers

ArgoCD ships with a catalog of common triggers:

```yaml
# These are pre-built — reference them directly in subscriptions
# on-created: Application was created
# on-deleted: Application was deleted
# on-deployed: Successfully deployed a new revision
# on-health-degraded: Application health changed to Degraded
# on-sync-failed: Sync operation failed
# on-sync-running: Sync operation started
# on-sync-status-unknown: Sync status changed to Unknown
# on-sync-succeeded: Sync completed successfully
```

### Custom Trigger Definitions

```yaml
# In argocd-notifications-cm
data:
  trigger.on-sync-failed: |
    - when: app.status.sync.status == 'Unknown'
      send: [app-sync-status-unknown]
    - when: app.status.sync.status == 'OutOfSync'
      send: [app-out-of-sync]

  # Trigger only for production apps (using label selector)
  trigger.on-production-sync-failed: |
    - when: >-
        app.status.sync.status == 'OutOfSync' and
        app.metadata.labels['env'] == 'production'
      send: [production-sync-failed]
      oncePer: app.status.operationState.syncResult.revision

  # Trigger on image update (detect new image deployment)
  trigger.on-image-updated: |
    - when: >-
        app.status.operationState.phase in ['Succeeded'] and
        app.status.sync.status == 'Synced'
      oncePer: app.status.operationState.syncResult.revision
      send: [image-updated]

  # Trigger on resource degradation (specific resource type)
  trigger.on-deployment-degraded: |
    - when: >-
        app.status.health.status == 'Degraded' and
        any(app.status.resources, {
          .kind == 'Deployment' and
          .health != nil and
          .health.status == 'Degraded'
        })
      send: [deployment-degraded-alert]

  # Trigger with cooldown (don't re-notify for 1 hour)
  trigger.on-repeated-sync-failure: |
    - when: >-
        app.status.operationState != nil and
        app.status.operationState.phase == 'Failed'
      oncePer: app.status.operationState.startedAt
      send: [sync-failed-with-details]
```

### Trigger Context Variables

Triggers have access to the full ArgoCD Application object:

```
app.metadata.name                          -- Application name
app.metadata.namespace                     -- ArgoCD namespace
app.metadata.labels                        -- Labels map
app.metadata.annotations                   -- Annotations map
app.spec.source.repoURL                    -- Git repository URL
app.spec.source.targetRevision             -- Target branch/tag/commit
app.spec.source.path                       -- Path in repository
app.spec.destination.server               -- Target cluster
app.spec.destination.namespace            -- Target namespace
app.status.sync.status                     -- Synced/OutOfSync/Unknown
app.status.sync.revision                   -- Current revision
app.status.health.status                   -- Healthy/Degraded/Progressing/Suspended/Missing/Unknown
app.status.operationState.phase           -- Succeeded/Failed/Running/Terminating
app.status.operationState.message         -- Operation message
app.status.operationState.syncResult.revision  -- Deployed revision
app.status.conditions                      -- Conditions array
```

## Section 4: Notification Templates

Templates define the message content. They support Go templating with Sprig functions.

### Slack Block Kit Templates

```yaml
data:
  template.app-sync-failed: |
    message: |
      :x: Application *{{.app.metadata.name}}* sync failed.
    slack:
      attachments: |
        [{
          "title": "{{.app.metadata.name}} Sync Failed",
          "title_link": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}",
          "color": "#E53E3E",
          "fields": [
            {
              "title": "Repository",
              "value": "{{.app.spec.source.repoURL}}",
              "short": true
            },
            {
              "title": "Revision",
              "value": "{{.app.status.sync.revision | substr 0 7}}",
              "short": true
            },
            {
              "title": "Error",
              "value": "{{.app.status.operationState.message}}",
              "short": false
            },
            {
              "title": "Environment",
              "value": "{{index .app.metadata.labels \"env\" | default \"unknown\"}}",
              "short": true
            },
            {
              "title": "Target Cluster",
              "value": "{{.app.spec.destination.server}}",
              "short": true
            }
          ],
          "actions": [
            {
              "type": "button",
              "text": "View in ArgoCD",
              "url": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}"
            }
          ],
          "footer": "ArgoCD",
          "ts": {{call .time.Unix}}
        }]

  template.app-deployed: |
    message: |
      :white_check_mark: Application *{{.app.metadata.name}}* deployed successfully!
    slack:
      blocks: |
        [{
          "type": "header",
          "text": {
            "type": "plain_text",
            "text": ":white_check_mark: Deployment Successful"
          }
        },
        {
          "type": "section",
          "fields": [
            {
              "type": "mrkdwn",
              "text": "*Application:*\n{{.app.metadata.name}}"
            },
            {
              "type": "mrkdwn",
              "text": "*Environment:*\n{{index .app.metadata.labels \"env\" | default \"unknown\"}}"
            },
            {
              "type": "mrkdwn",
              "text": "*Revision:*\n`{{.app.status.operationState.syncResult.revision | substr 0 7}}`"
            },
            {
              "type": "mrkdwn",
              "text": "*Namespace:*\n{{.app.spec.destination.namespace}}"
            }
          ]
        },
        {
          "type": "actions",
          "elements": [
            {
              "type": "button",
              "text": {"type": "plain_text", "text": "View Application"},
              "url": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}"
            }
          ]
        }]

  template.app-health-degraded: |
    message: |
      :warning: Application *{{.app.metadata.name}}* health is {{.app.status.health.status}}
    slack:
      attachments: |
        [{
          "title": "Health Degraded: {{.app.metadata.name}}",
          "title_link": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}",
          "color": "#DD6B20",
          "fields": [
            {
              "title": "Health Status",
              "value": "{{.app.status.health.status}}",
              "short": true
            },
            {
              "title": "Health Message",
              "value": "{{.app.status.health.message | default \"No message\"}}",
              "short": false
            },
            {{range .app.status.resources}}
            {{if and .health (ne .health.status "Healthy")}}
            {
              "title": "{{.kind}}/{{.name}}",
              "value": "Status: {{.health.status}}\n{{.health.message | default \"\"}}",
              "short": false
            },
            {{end}}
            {{end}}
          ]
        }]
```

### PagerDuty Events API Template

```yaml
data:
  template.pagerduty-critical: |
    webhook:
      method: POST
      path: /v2/enqueue
      body: |
        {
          "routing_key": "{{.context.pagerdutyRoutingKey}}",
          "event_action": "trigger",
          "dedup_key": "argocd-{{.app.metadata.name}}-{{.app.status.operationState.startedAt}}",
          "payload": {
            "summary": "ArgoCD: {{.app.metadata.name}} sync failed",
            "severity": "critical",
            "source": "argocd",
            "component": "{{.app.metadata.name}}",
            "group": "{{index .app.metadata.labels \"team\" | default \"platform\"}}",
            "class": "deployment",
            "custom_details": {
              "application": "{{.app.metadata.name}}",
              "environment": "{{index .app.metadata.labels \"env\" | default \"unknown\"}}",
              "repository": "{{.app.spec.source.repoURL}}",
              "revision": "{{.app.status.sync.revision}}",
              "error": "{{.app.status.operationState.message}}",
              "argocd_url": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}"
            }
          },
          "links": [{
            "href": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}",
            "text": "View in ArgoCD"
          }]
        }

  # Auto-resolve PagerDuty when sync succeeds
  template.pagerduty-resolve: |
    webhook:
      method: POST
      path: /v2/enqueue
      body: |
        {
          "routing_key": "{{.context.pagerdutyRoutingKey}}",
          "event_action": "resolve",
          "dedup_key": "argocd-{{.app.metadata.name}}-{{.app.status.operationState.startedAt}}"
        }
```

### GitHub Deployment Status Template

```yaml
data:
  template.github-deployment-status: |
    github:
      repoURLTemplate: "{{.app.spec.source.repoURL}}"
      revisionTemplate: "{{.app.status.operationState.syncResult.revision}}"
      status:
        state: "{{if eq .app.status.health.status \"Healthy\"}}success{{else if eq .app.status.health.status \"Degraded\"}}failure{{else}}pending{{end}}"
        label: "argocd/{{index .app.metadata.labels \"env\" | default \"deploy\"}}"
        targetURL: "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}"
```

## Section 5: Annotation-Based Subscriptions

Subscriptions tell ArgoCD which applications send which notifications to which services. The annotation format is:

```
notifications.argoproj.io/subscribe.<trigger>.<service>: <destination>
```

### Application Annotations

```yaml
# Individual Application
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: my-service-production
  namespace: argocd
  annotations:
    # Send to Slack #ops-alerts on sync failure
    notifications.argoproj.io/subscribe.on-sync-failed.slack: ops-alerts

    # Send to Slack #deployments on successful deploy
    notifications.argoproj.io/subscribe.on-deployed.slack: deployments

    # Send to PagerDuty on health degraded (critical)
    notifications.argoproj.io/subscribe.on-health-degraded.pagerduty: P123ABC

    # Send to GitHub for deployment status
    notifications.argoproj.io/subscribe.on-deployed.github: ""

    # Send to multiple Slack channels
    notifications.argoproj.io/subscribe.on-sync-failed.slack: "ops-alerts;incidents"

    # Multiple services for the same trigger
    notifications.argoproj.io/subscribe.on-health-degraded.slack: ops-alerts
    notifications.argoproj.io/subscribe.on-health-degraded.pagerduty: P123ABC

    # Custom context values (passed to templates)
    notifications.argoproj.io/subscribe.on-sync-failed.teams: ops-channel
```

### AppProject-Level Default Subscriptions

Configure subscriptions at the AppProject level to apply to all applications in a project without modifying each Application individually:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: production
  namespace: argocd
  annotations:
    # All apps in this project send sync failures to ops-alerts
    notifications.argoproj.io/subscribe.on-sync-failed.slack: ops-alerts

    # All apps send health degraded to PagerDuty
    notifications.argoproj.io/subscribe.on-health-degraded.pagerduty: production-service

    # All apps update GitHub deployment status
    notifications.argoproj.io/subscribe.on-deployed.github: ""
    notifications.argoproj.io/subscribe.on-sync-failed.github: ""
spec:
  description: Production applications
  sourceRepos:
    - "https://github.com/example/*"
  destinations:
    - namespace: "*"
      server: https://kubernetes.default.svc
```

### Notification Context Variables

Add shared context values used in templates:

```yaml
# In argocd-notifications-cm
data:
  context: |
    argocdUrl: https://argocd.example.com
    pagerdutyRoutingKey: $pagerduty-routing-key
    environmentEmoji: |
      {{if eq (index .app.metadata.labels "env") "production"}}:fire:{{else}}:wrench:{{end}}
```

## Section 6: Custom Webhook Templates

For destinations not natively supported, generic webhooks provide maximum flexibility.

### Generic Webhook Service Configuration

```yaml
data:
  # Opsgenie
  service.webhook.opsgenie: |
    url: https://api.opsgenie.com/v2/alerts
    headers:
      - name: Content-Type
        value: application/json
      - name: Authorization
        value: GenieKey $opsgenie-api-key

  # Custom internal webhook
  service.webhook.internal-alerting: |
    url: https://alerting.internal.example.com/argocd-events
    headers:
      - name: Content-Type
        value: application/json
      - name: X-API-Key
        value: $internal-webhook-token
      - name: X-Source
        value: argocd

  # Jira (create issues on failure)
  service.webhook.jira: |
    url: https://example.atlassian.net/rest/api/3/issue
    headers:
      - name: Content-Type
        value: application/json
      - name: Authorization
        value: Basic $jira-auth-token
```

### Opsgenie Template

```yaml
data:
  template.opsgenie-alert: |
    webhook:
      method: POST
      body: |
        {
          "message": "ArgoCD: {{.app.metadata.name}} sync failed",
          "alias": "argocd-{{.app.metadata.name}}",
          "description": "Application {{.app.metadata.name}} failed to sync.\n\nError: {{.app.status.operationState.message}}\n\nRepository: {{.app.spec.source.repoURL}}\nRevision: {{.app.status.sync.revision}}",
          "priority": "{{if eq (index .app.metadata.labels \"env\") \"production\"}}P1{{else}}P2{{end}}",
          "tags": ["argocd", "{{index .app.metadata.labels \"team\" | default \"platform\"}}", "{{index .app.metadata.labels \"env\" | default \"unknown\"}}"],
          "details": {
            "application": "{{.app.metadata.name}}",
            "environment": "{{index .app.metadata.labels \"env\" | default \"unknown\"}}",
            "repository": "{{.app.spec.source.repoURL}}",
            "revision": "{{.app.status.sync.revision | substr 0 7}}"
          },
          "source": "ArgoCD",
          "note": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}"
        }
```

### Jira Issue Creation Template

```yaml
data:
  template.jira-incident: |
    webhook:
      method: POST
      body: |
        {
          "fields": {
            "project": {"key": "OPS"},
            "summary": "[ArgoCD] {{.app.metadata.name}} deployment failed",
            "description": {
              "type": "doc",
              "version": 1,
              "content": [{
                "type": "paragraph",
                "content": [{
                  "type": "text",
                  "text": "Application {{.app.metadata.name}} failed to sync to {{index .app.metadata.labels \"env\" | default \"unknown\"}}.\n\nError: {{.app.status.operationState.message}}\n\nArgoCD URL: {{.context.argocdUrl}}/applications/{{.app.metadata.name}}"
                }]
              }]
            },
            "issuetype": {"name": "Incident"},
            "priority": {"name": "{{if eq (index .app.metadata.labels \"env\") \"production\"}}High{{else}}Medium{{end}}"},
            "labels": ["argocd", "deployment-failure", "{{index .app.metadata.labels \"env\" | default \"unknown\"}}"]
          }
        }
```

## Section 7: Testing and Debugging

### Testing Notifications Without Applications

Use the `argocd admin notifications` command to test:

```bash
# List configured services
argocd admin notifications service list

# Test a specific service (dry run)
argocd admin notifications trigger run on-sync-failed my-application \
  --recipient slack:ops-alerts \
  --dry-run

# Send a real test notification
argocd admin notifications template notify app-deployed my-application \
  --recipient slack:ops-alerts

# List all subscriptions for an application
argocd admin notifications subscription list \
  --application my-application

# Add a subscription from the CLI
argocd admin notifications subscription add \
  --application my-application \
  --trigger on-sync-failed \
  --service slack \
  --recipient ops-alerts
```

### Debugging Template Rendering

```bash
# View rendered notification without sending
argocd admin notifications template render app-sync-failed \
  --application my-application

# Check controller logs
kubectl logs -n argocd -l app.kubernetes.io/name=argocd-notifications-controller \
  --tail=100 -f

# Enable debug logging
kubectl set env deployment/argocd-notifications-controller \
  -n argocd \
  LOG_LEVEL=debug
```

### Common Template Errors

**Nil pointer in template:**
```yaml
# BAD: app.status.operationState may be nil
value: "{{.app.status.operationState.message}}"

# GOOD: Use conditional
value: "{{if .app.status.operationState}}{{.app.status.operationState.message}}{{else}}N/A{{end}}"
```

**Missing label:**
```yaml
# BAD: Panics if label doesn't exist
value: "{{.app.metadata.labels.env}}"

# GOOD: Use index with default
value: "{{index .app.metadata.labels \"env\" | default \"unknown\"}}"
```

**Revision too long:**
```yaml
# BAD: Full SHA is ugly in Slack
value: "{{.app.status.sync.revision}}"

# GOOD: Truncate to 7 characters
value: "{{.app.status.sync.revision | substr 0 7}}"
```

## Section 8: Complete Production Configuration

A complete ConfigMap for a production environment:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-notifications-cm
  namespace: argocd
data:
  # Services
  service.slack: |
    token: $slack-token
    username: ArgoCD
    icon: ":argo:"

  service.webhook.pagerduty-events: |
    url: https://events.pagerduty.com/v2/enqueue
    headers:
      - name: Content-Type
        value: application/json

  service.github: |
    appID: $github-app-id
    installationID: $github-installation-id
    privateKey: $github-private-key

  # Context
  context: |
    argocdUrl: https://argocd.example.com
    pagerdutyRoutingKeyProduction: $pd-routing-key-prod
    pagerdutyRoutingKeyNonProduction: $pd-routing-key-nonprod

  # Triggers
  trigger.on-sync-failed: |
    - when: app.status.operationState.phase in ['Error', 'Failed']
      send: [sync-failed-slack, sync-failed-pagerduty]

  trigger.on-health-degraded: |
    - when: app.status.health.status == 'Degraded'
      send: [health-degraded-slack, health-degraded-pagerduty]
      oncePer: app.status.health.status

  trigger.on-deployed: |
    - when: >-
        app.status.operationState != nil and
        app.status.operationState.phase == 'Succeeded' and
        app.status.health.status == 'Healthy'
      oncePer: app.status.operationState.syncResult.revision
      send: [deployed-slack, github-deployment-success]

  trigger.on-sync-running: |
    - when: app.status.operationState.phase in ['Running']
      send: [sync-running-slack]

  # Templates
  template.sync-failed-slack: |
    slack:
      attachments: |
        [{
          "color": "#E53E3E",
          "title": ":x: Sync Failed: {{.app.metadata.name}}",
          "title_link": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}",
          "fields": [
            {"title": "Env", "value": "{{index .app.metadata.labels \"env\" | default \"??\"}}", "short": true},
            {"title": "Revision", "value": "`{{.app.status.sync.revision | substr 0 7}}`", "short": true},
            {"title": "Error", "value": "{{if .app.status.operationState}}{{.app.status.operationState.message}}{{end}}", "short": false}
          ]
        }]

  template.sync-failed-pagerduty: |
    webhook:
      method: POST
      body: |
        {
          "routing_key": "{{if eq (index .app.metadata.labels \"env\") \"production\"}}{{.context.pagerdutyRoutingKeyProduction}}{{else}}{{.context.pagerdutyRoutingKeyNonProduction}}{{end}}",
          "event_action": "trigger",
          "dedup_key": "argocd-sync-{{.app.metadata.name}}",
          "payload": {
            "summary": "ArgoCD sync failed: {{.app.metadata.name}}",
            "severity": "{{if eq (index .app.metadata.labels \"env\") \"production\"}}critical{{else}}warning{{end}}",
            "source": "argocd",
            "component": "{{.app.metadata.name}}",
            "custom_details": {
              "application": "{{.app.metadata.name}}",
              "environment": "{{index .app.metadata.labels \"env\" | default \"unknown\"}}",
              "error": "{{if .app.status.operationState}}{{.app.status.operationState.message}}{{end}}",
              "url": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}"
            }
          }
        }

  template.health-degraded-slack: |
    slack:
      attachments: |
        [{
          "color": "#DD6B20",
          "title": ":warning: Health Degraded: {{.app.metadata.name}}",
          "title_link": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}",
          "fields": [
            {"title": "Health", "value": "{{.app.status.health.status}}", "short": true},
            {"title": "Env", "value": "{{index .app.metadata.labels \"env\" | default \"??\"}}", "short": true}
          ]
        }]

  template.health-degraded-pagerduty: |
    webhook:
      method: POST
      body: |
        {
          "routing_key": "{{if eq (index .app.metadata.labels \"env\") \"production\"}}{{.context.pagerdutyRoutingKeyProduction}}{{else}}{{.context.pagerdutyRoutingKeyNonProduction}}{{end}}",
          "event_action": "trigger",
          "dedup_key": "argocd-health-{{.app.metadata.name}}",
          "payload": {
            "summary": "ArgoCD health degraded: {{.app.metadata.name}}",
            "severity": "{{if eq (index .app.metadata.labels \"env\") \"production\"}}critical{{else}}error{{end}}",
            "source": "argocd",
            "component": "{{.app.metadata.name}}"
          }
        }

  template.deployed-slack: |
    slack:
      attachments: |
        [{
          "color": "#38A169",
          "title": ":white_check_mark: Deployed: {{.app.metadata.name}}",
          "title_link": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}",
          "fields": [
            {"title": "Env", "value": "{{index .app.metadata.labels \"env\" | default \"??\"}}", "short": true},
            {"title": "Revision", "value": "`{{.app.status.operationState.syncResult.revision | substr 0 7}}`", "short": true},
            {"title": "Namespace", "value": "{{.app.spec.destination.namespace}}", "short": true}
          ]
        }]

  template.github-deployment-success: |
    github:
      repoURLTemplate: "{{.app.spec.source.repoURL}}"
      revisionTemplate: "{{.app.status.operationState.syncResult.revision}}"
      status:
        state: "success"
        label: "argocd/{{index .app.metadata.labels \"env\" | default \"deploy\"}}"
        targetURL: "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}"

  template.sync-running-slack: |
    slack:
      attachments: |
        [{
          "color": "#3182CE",
          "title": ":arrows_counterclockwise: Sync Running: {{.app.metadata.name}}",
          "title_link": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}",
          "fields": [
            {"title": "Revision", "value": "`{{.app.status.sync.revision | substr 0 7}}`", "short": true},
            {"title": "Env", "value": "{{index .app.metadata.labels \"env\" | default \"??\"}}", "short": true}
          ]
        }]
```

## Section 9: ApplicationSet Integration

When using ApplicationSets, configure notifications on the generated Applications by adding annotations to the ApplicationSet template:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: microservices
  namespace: argocd
spec:
  generators:
    - list:
        elements:
          - service: api-gateway
            env: production
            pagerduty_service: P_PROD_ABC
          - service: user-service
            env: production
            pagerduty_service: P_PROD_DEF
          - service: api-gateway
            env: staging
            pagerduty_service: P_STAGING_ABC
  template:
    metadata:
      name: "{{service}}-{{env}}"
      annotations:
        # Dynamic routing based on generator variables
        notifications.argoproj.io/subscribe.on-sync-failed.slack: "{{env}}-alerts"
        notifications.argoproj.io/subscribe.on-deployed.slack: "deployments"
        notifications.argoproj.io/subscribe.on-health-degraded.pagerduty: "{{pagerduty_service}}"
      labels:
        env: "{{env}}"
        team: platform
    spec:
      project: "{{env}}"
      source:
        repoURL: https://github.com/example/microservices
        targetRevision: main
        path: "services/{{service}}"
      destination:
        server: https://kubernetes.default.svc
        namespace: "{{env}}"
```

## Conclusion

ArgoCD Notifications transforms GitOps from a passive deployment tool into an active feedback loop. Teams know immediately when deployments succeed or fail, when applications degrade, and can track deployment status directly in GitHub. The trigger-and-template architecture is flexible enough to support any alerting destination while the annotation-based subscription model keeps notification configuration close to the application definition.

Key takeaways:
- Use AppProject-level annotations for organization-wide notification policies
- The `oncePer` field prevents notification storms on repeated failures
- PagerDuty dedup keys enable automatic incident resolution when deployments succeed
- Test templates with `argocd admin notifications template render` before deploying
- Custom webhooks cover any destination not supported natively
