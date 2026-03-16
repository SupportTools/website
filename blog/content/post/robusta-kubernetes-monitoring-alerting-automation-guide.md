---
title: "Robusta: Kubernetes Monitoring Enrichment and Alert Automation"
date: 2027-02-24T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Robusta", "Monitoring", "Alerting", "Automation"]
categories: ["Kubernetes", "Observability", "Automation"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to deploying Robusta for Kubernetes alert enrichment and remediation automation, covering PlaybookAction triggers, Slack and PagerDuty sinks, custom Python playbooks, self-healing automations, and HolmesGPT AI investigation."
more_link: "yes"
url: "/robusta-kubernetes-monitoring-alerting-automation-guide/"
---

Robusta is an open-source Kubernetes monitoring platform that enriches Prometheus alerts with actionable context — pod logs, events, CPU/memory graphs, resource descriptions — and delivers that context directly to Slack, PagerDuty, or any configured notification channel. Beyond enrichment, Robusta supports **remediation playbooks** that can automatically restart failing pods, scale deployments, drain nodes, or execute any custom Python action in response to alert triggers.

This guide covers architecture, installation, built-in trigger types, alert enrichment configuration, sink setup for Slack and PagerDuty, custom Python playbooks, self-healing patterns, the Robusta UI for alert correlation, and integration with HolmesGPT for AI-powered root cause investigation.

<!--more-->

## Why Robusta

Standard Prometheus + Alertmanager deployments deliver alerts as raw metric thresholds with minimal context. On-call engineers receiving a `KubePodCrashLooping` alert must manually:

1. Find the affected pod
2. Retrieve recent logs from multiple containers
3. Check Kubernetes events for node pressure or scheduling failures
4. Review resource utilization graphs
5. Correlate with recent deployments

Robusta performs all these steps automatically and delivers the aggregated context in the alert notification. The same trigger that fires a Slack message can simultaneously trigger automated remediation — restarting the pod, scaling the deployment, or opening a PagerDuty incident with a full diagnostic bundle attached.

## Architecture

Robusta consists of three components:

**Robusta Runner** — A Kubernetes deployment that connects to the Alertmanager webhook receiver, watches the Kubernetes API for events, and executes configured playbooks. Written in Python and fully extensible.

**Robusta UI** — An optional managed SaaS dashboard (or self-hosted) that aggregates alert history, correlates related alerts, and stores the enrichment bundles for post-incident review.

**Sink Integrations** — Pluggable output channels including Slack, PagerDuty, OpsGenie, Microsoft Teams, Telegram, Jira, and generic webhooks.

### Playbook Execution Model

Every playbook is a mapping between a **trigger** (an event that something happened) and one or more **actions** (what to do in response). Actions receive a `RobustaEvent` object containing the Kubernetes resource context and can:

- Gather additional data (logs, events, metrics)
- Send notifications to sinks
- Mutate Kubernetes resources (restart pods, patch deployments)
- Execute arbitrary shell commands in a container
- Call external APIs

## Installation

### Helm Deployment

```bash
# Generate a Robusta configuration file
pip install robusta-cli
robusta gen-config

# This produces a generated_values.yaml with your sink credentials
# Review and edit before applying
```

Alternatively, construct the values manually:

```yaml
# robusta-values.yaml
globalConfig:
  clusterName: production-us-east-1
  prometheusUrl: "http://kube-prometheus-stack-prometheus.monitoring.svc.cluster.local:9090"

sinksConfig:
  - slack_sink:
      name: main-slack
      api_key: SLACK_BOT_TOKEN_REPLACE_ME
      slack_channel: "#kubernetes-alerts"
      default: true
  - pagerduty_sink:
      name: pagerduty-critical
      api_key: PAGERDUTY_ROUTING_KEY_REPLACE_ME
      default: false

playbookRepos:
  - url: https://github.com/robusta-dev/robusta
    branch: master

activePlaybooks:
  # Enrich Prometheus alerts with pod context
  - triggers:
      - on_prometheus_alert:
          alert_name: KubePodCrashLooping
    actions:
      - logs_enricher: {}
      - pod_events_enricher: {}
      - pod_graph_enricher:
          resource_type: CPU
          past_hours: 1
      - pod_graph_enricher:
          resource_type: Memory
          past_hours: 1

  # Enrich all firing prometheus alerts with resource info
  - triggers:
      - on_prometheus_alert: {}
    actions:
      - prometheus_enricher: {}
      - resource_events_enricher: {}

  # Auto-restart pods stuck in OOMKilled
  - triggers:
      - on_prometheus_alert:
          alert_name: KubeContainerOOMKilled
          status: firing
    actions:
      - pod_events_enricher: {}
      - logs_enricher:
          previous: true
      - restart_loop_reporter: {}

  # Node pressure enrichment
  - triggers:
      - on_prometheus_alert:
          alert_name: KubeNodeNotReady
    actions:
      - node_events_enricher: {}
      - node_running_pods_enricher: {}
      - node_allocatable_resources_enricher: {}

runner:
  resources:
    requests:
      cpu: 250m
      memory: 512Mi
    limits:
      cpu: 1000m
      memory: 2Gi
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    readOnlyRootFilesystem: false   # Robusta writes temp files

# Enable Robusta UI integration
enablePlatform: false   # Set true for managed UI
```

Install via Helm:

```bash
helm repo add robusta https://robusta-charts.storage.googleapis.com
helm repo update

helm install robusta robusta/robusta \
  --namespace robusta \
  --create-namespace \
  --version 0.12.0 \
  -f robusta-values.yaml

kubectl -n robusta get pods -w
```

### Alertmanager Integration

Robusta registers itself as an Alertmanager webhook receiver. When using kube-prometheus-stack, add the Robusta receiver to Alertmanager configuration:

```yaml
# Added to kube-prometheus-stack values
alertmanager:
  config:
    global:
      resolve_timeout: 5m
    route:
      group_by:
        - namespace
        - alertname
      group_wait: 30s
      group_interval: 5m
      repeat_interval: 12h
      receiver: slack-default
      routes:
        - match:
            severity: critical
          receiver: pagerduty-critical
          continue: true
        - receiver: robusta-webhook
          continue: true   # Robusta receives ALL alerts
    receivers:
      - name: robusta-webhook
        webhook_configs:
          - url: "http://robusta-runner.robusta.svc.cluster.local:9090/api/alerts"
            send_resolved: true
      - name: slack-default
        slack_configs:
          - api_url: "https://hooks.slack.com/services/SLACK_WEBHOOK_REPLACE_ME"
            channel: "#kubernetes-alerts"
      - name: pagerduty-critical
        pagerduty_configs:
          - routing_key: "PAGERDUTY_KEY_REPLACE_ME"
```

## Triggers

### Prometheus Alert Trigger

The most common trigger fires when Alertmanager forwards an alert to Robusta:

```yaml
triggers:
  - on_prometheus_alert:
      alert_name: KubePodCrashLooping   # Match specific alert
      namespace: production              # Optional namespace filter
      labels:
        severity: critical               # Match on any label
      status: firing                     # firing | resolved
```

Omitting `alert_name` matches all firing alerts, making it easy to apply universal enrichment:

```yaml
- triggers:
    - on_prometheus_alert: {}            # Matches every alert
  actions:
    - resource_events_enricher: {}
    - prometheus_enricher: {}
```

### Kubernetes Event Trigger

Triggers on Kubernetes events (Warning events, image pull failures, etc.):

```yaml
- triggers:
    - on_kubernetes_warning_event:
        include:
          - "BackOff"
          - "Failed"
          - "Unhealthy"
        namespace_prefix: "production"
  actions:
    - event_report: {}
    - logs_enricher: {}
```

### Scheduled Trigger

Run periodic playbooks for health checks or capacity reports:

```yaml
- triggers:
    - on_schedule:
        repeat: 3600   # Every hour in seconds
  actions:
    - cluster_status_report: {}
    - node_running_pods_enricher: {}
```

### Manual Trigger via CLI

```bash
# Trigger a playbook manually against a specific resource
robusta playbooks trigger pod_graph_enricher \
  --namespace production \
  --pod payment-api-7d9f8b9c4-xk2p9 \
  --resource_type CPU

# Trigger a custom restart action
robusta playbooks trigger restart_pod \
  --namespace production \
  --deployment order-service
```

## Built-in Alert Enrichment Actions

### Pod-Level Enrichment

```yaml
- triggers:
    - on_prometheus_alert:
        alert_name: KubePodCrashLooping
  actions:
    # Fetch last 100 lines from all containers in the pod
    - logs_enricher:
        tail_lines: 100
        container_name: ""    # Empty = all containers
        previous: true        # Include logs from previous (crashed) container

    # Recent Kubernetes events for the pod
    - pod_events_enricher: {}

    # CPU and memory graphs from Prometheus
    - pod_graph_enricher:
        resource_type: CPU
        past_hours: 2
    - pod_graph_enricher:
        resource_type: Memory
        past_hours: 2

    # Human-readable describe output
    - pod_info_enricher: {}

    # OOM analysis
    - oom_killer_enricher: {}
```

### Node-Level Enrichment

```yaml
- triggers:
    - on_prometheus_alert:
        alert_name: NodeHighCPU
  actions:
    # All events on the node
    - node_events_enricher: {}

    # Pods currently running on the node
    - node_running_pods_enricher: {}

    # Node capacity and allocatable resources
    - node_allocatable_resources_enricher: {}

    # Top CPU/memory consuming pods
    - node_top_pods_enricher: {}
```

### Deployment-Level Enrichment

```yaml
- triggers:
    - on_prometheus_alert:
        alert_name: KubeDeploymentReplicasMismatch
  actions:
    - resource_events_enricher: {}
    - deployment_events_enricher: {}
    # Show recent rollout history
    - rollout_status_enricher: {}
    # Show pod status across all replicas
    - pod_status_enricher: {}
```

## Slack Sink Configuration

```yaml
sinksConfig:
  - slack_sink:
      name: team-platform-alerts
      api_key: SLACK_BOT_TOKEN_REPLACE_ME
      slack_channel: "#platform-alerts"
      default: true
      # Send critical alerts to a dedicated channel
      channel_override: "labels.team"   # Use pod label to route to team channel

  - slack_sink:
      name: team-data-alerts
      api_key: SLACK_BOT_TOKEN_REPLACE_ME
      slack_channel: "#data-team-alerts"
      scope:
        include:
          - namespace: data-platform

  # Thread alerts to reduce noise
  - slack_sink:
      name: main-slack-threaded
      api_key: SLACK_BOT_TOKEN_REPLACE_ME
      slack_channel: "#kubernetes-all-alerts"
      send_svg: true
      max_log_file_limit_kb: 1000
```

### Per-Alert Routing

Route specific alerts to specific channels using scope filters:

```yaml
activePlaybooks:
  - triggers:
      - on_prometheus_alert:
          alert_name: KubePodCrashLooping
          labels:
            team: payments
    actions:
      - logs_enricher: {}
    sinks:
      - team-payments-slack
      - pagerduty-critical
```

## PagerDuty Sink Configuration

```yaml
sinksConfig:
  - pagerduty_sink:
      name: pagerduty-critical
      api_key: PAGERDUTY_INTEGRATION_KEY_REPLACE_ME
      default: false
      # Only route critical severity
      scope:
        include:
          - labels:
              severity: critical
```

```yaml
# Route critical alerts to both Slack and PagerDuty
activePlaybooks:
  - triggers:
      - on_prometheus_alert:
          labels:
            severity: critical
    actions:
      - logs_enricher: {}
      - pod_events_enricher: {}
      - pod_graph_enricher:
          resource_type: CPU
          past_hours: 1
    sinks:
      - main-slack
      - pagerduty-critical
```

## Custom Python Playbooks

Robusta playbook actions are Python functions decorated with `@action`. Create custom actions for organization-specific remediation logic:

```python
# custom_playbooks.py
from robusta.api import (
    action,
    DeploymentEvent,
    PodEvent,
    RobustaDeployment,
    RobustaPod,
    ExecutionBaseEvent,
    Finding,
    FindingSource,
    FindingType,
    SlackAnnotations,
)
import logging


@action
def restart_crashlooping_pod(event: PodEvent):
    """
    Automatically restarts a pod that has been crash-looping
    for more than 5 restart cycles.
    """
    pod = event.get_pod()
    if pod is None:
        logging.warning("restart_crashlooping_pod: pod not found in event")
        return

    # Only restart if restart count is high
    restart_count = sum(
        s.restartCount
        for s in (pod.status.containerStatuses or [])
    )

    if restart_count < 5:
        logging.info(f"Restart count {restart_count} below threshold, skipping restart")
        return

    logging.info(f"Restarting pod {pod.metadata.name} (restart count: {restart_count})")
    pod.delete()

    event.add_enrichment(
        [
            f"*Action Taken*: Pod `{pod.metadata.name}` was automatically deleted "
            f"after {restart_count} crash restarts. Kubernetes will create a replacement."
        ]
    )


@action
def scale_deployment_on_high_memory(event: DeploymentEvent):
    """
    Scales a deployment up by 1 replica when memory usage exceeds 90%.
    Caps at maxReplicas to avoid runaway scaling.
    """
    deployment = event.get_deployment()
    if deployment is None:
        return

    max_replicas = int(
        deployment.metadata.annotations.get("robusta.dev/max-replicas", "5")
    )
    current_replicas = deployment.spec.replicas or 1

    if current_replicas >= max_replicas:
        event.add_enrichment(
            [f"*Scale Skipped*: Deployment `{deployment.metadata.name}` already at "
             f"max replicas ({max_replicas})."]
        )
        return

    new_replicas = current_replicas + 1
    deployment.spec.replicas = new_replicas
    deployment.patch()

    event.add_enrichment(
        [f"*Auto-Scaled*: Deployment `{deployment.metadata.name}` scaled from "
         f"{current_replicas} to {new_replicas} replicas due to high memory pressure."]
    )


@action
def notify_on_oom_with_heap_dump_hint(event: PodEvent):
    """
    Enriches OOMKill alerts with actionable JVM heap dump instructions
    when the killed container runs a JVM workload.
    """
    pod = event.get_pod()
    if pod is None:
        return

    container_names = [c.name for c in (pod.spec.containers or [])]
    jvm_containers = [
        name for name in container_names
        if any(kw in name for kw in ["java", "spring", "kafka", "elasticsearch"])
    ]

    if not jvm_containers:
        return

    event.add_enrichment(
        [
            "*JVM OOM Detected*",
            f"Affected containers: `{', '.join(jvm_containers)}`",
            "To capture a heap dump before the next restart, run:",
            f"```kubectl exec -n {pod.metadata.namespace} {pod.metadata.name} "
            f"-- jmap -dump:format=b,file=/tmp/heap.hprof 1```",
            "Then copy the dump: `kubectl cp <pod>:/tmp/heap.hprof ./heap.hprof`",
        ]
    )
```

Mount the custom playbook into Robusta:

```yaml
# robusta-values.yaml addition
playbookRepos:
  - url: "git+https://github.com/myorg/robusta-playbooks.git"
    branch: main

activePlaybooks:
  - triggers:
      - on_prometheus_alert:
          alert_name: KubeContainerOOMKilled
    actions:
      - notify_on_oom_with_heap_dump_hint: {}
      - logs_enricher:
          previous: true

  - triggers:
      - on_prometheus_alert:
          alert_name: KubePodCrashLooping
    actions:
      - restart_crashlooping_pod: {}
      - logs_enricher: {}
      - pod_events_enricher: {}
```

## Self-Healing Automation Patterns

### Pattern 1: Automatic Pod Restart on Extended CrashLoop

```yaml
activePlaybooks:
  - triggers:
      - on_prometheus_alert:
          alert_name: KubePodCrashLooping
          status: firing
          namespace: production
    actions:
      - logs_enricher:
          tail_lines: 50
          previous: true
      - pod_events_enricher: {}
      - restart_loop_reporter: {}
```

### Pattern 2: Node Drain on Disk Pressure

```yaml
activePlaybooks:
  - triggers:
      - on_prometheus_alert:
          alert_name: NodeDiskPressure
          labels:
            severity: critical
    actions:
      - node_events_enricher: {}
      - node_running_pods_enricher: {}
      # Custom action to initiate controlled node drain
      - drain_node_graceful:
          timeout_seconds: 300
          ignore_daemonsets: true
          delete_emptydir_data: false
    sinks:
      - main-slack
      - pagerduty-critical
```

### Pattern 3: Scale-Up on Pending Pods

```yaml
activePlaybooks:
  - triggers:
      - on_kubernetes_warning_event:
          include:
            - "FailedScheduling"
    actions:
      - event_report: {}
      - pod_info_enricher: {}
      # Report unschedulable pods with resource requirements
      - pending_pods_enricher: {}
```

### Pattern 4: Automatic ImagePullBackOff Notification with Registry Status

```yaml
activePlaybooks:
  - triggers:
      - on_kubernetes_warning_event:
          include:
            - "Failed"
          reason: "Failed"
    actions:
      - event_report: {}
      - logs_enricher: {}
      - image_pull_backoff_reporter: {}
```

## Robusta UI for Alert Correlation

The Robusta UI (cloud.robusta.dev or self-hosted) provides:

- **Alert timeline**: All firing and resolved alerts in a searchable timeline
- **Enrichment bundles**: Stored logs, graphs, and events attached to each alert
- **Correlation view**: Alerts from the same namespace or pod grouped automatically
- **Silence management**: Suppress specific alerts from the UI without modifying Alertmanager config
- **Playbook execution history**: View what actions ran and their output

Enable the managed UI:

```yaml
# robusta-values.yaml
enablePlatform: true
globalConfig:
  signing_key: ROBUSTA_SIGNING_KEY_REPLACE_ME
  account_id: ROBUSTA_ACCOUNT_ID_REPLACE_ME
```

Or self-host:

```bash
helm install robusta-platform robusta/robusta-platform \
  --namespace robusta \
  --set persistence.enabled=true \
  --set persistence.size=20Gi
```

## HolmesGPT AI Investigation

HolmesGPT integrates with Robusta to provide AI-powered root cause analysis. When an alert fires, HolmesGPT queries the Kubernetes API, pod logs, events, and metrics to generate a natural-language hypothesis about the root cause:

```yaml
# robusta-values.yaml — enable HolmesGPT
holmes:
  enabled: true
  openaiApiKey: OPENAI_API_KEY_REPLACE_ME   # Or use Azure OpenAI
  model: gpt-4o-mini
  # Alternative: use self-hosted LLM
  # ollamaUrl: "http://ollama.ai-platform.svc.cluster.local:11434"
  # model: "llama3.1"

activePlaybooks:
  - triggers:
      - on_prometheus_alert:
          labels:
            severity: critical
    actions:
      - logs_enricher: {}
      - pod_events_enricher: {}
      # Run HolmesGPT investigation and include in Slack message
      - ask_holmes: {}
```

Example HolmesGPT output attached to a Slack alert:

```
[HolmesGPT Analysis]
Root cause: The payment-api pod is OOMKilled due to a memory leak in the
connection pool. Logs show 'WARN: Connection pool exhausted' repeating every
30 seconds for the past 2 hours before the OOM event. The heap dump from the
previous crash shows 847 unclosed database connections accumulating.

Recommended action:
1. Restart the pod (already done automatically)
2. Check application.properties for connection pool max-size setting
3. Review DB_POOL_MAX_SIZE environment variable (currently set to 0 = unlimited)
4. Consider setting memory limits to 1Gi to prevent node pressure
```

## Monitoring Robusta Itself

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: robusta-runner
  namespace: robusta
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: robusta-runner
  endpoints:
    - port: http
      path: /metrics
      interval: 30s
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: robusta-health-alerts
  namespace: robusta
spec:
  groups:
    - name: robusta
      rules:
        - alert: RobustaRunnerDown
          expr: up{job="robusta-runner"} == 0
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Robusta runner is unreachable"
            description: "Alert enrichment and remediation playbooks are not executing."

        - alert: RobustaPlaybookErrors
          expr: rate(robusta_playbook_errors_total[5m]) > 0.1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Robusta playbook error rate elevated"
            description: "Playbook execution errors: {{ $value }}/s"

        - alert: RobustaAlertProcessingLag
          expr: robusta_alert_processing_lag_seconds > 30
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Robusta is slow to process alerts"
            description: "Alert processing lag is {{ $value }}s — runner may be overloaded."
```

## Troubleshooting

### Alerts Not Reaching Robusta

```bash
# Verify Alertmanager is sending to Robusta
kubectl -n monitoring port-forward svc/alertmanager-operated 9093:9093
# Open http://localhost:9093/#/status
# Check "Receiver: robusta-webhook" is listed

# Verify Robusta can receive webhooks
kubectl -n robusta logs -l app.kubernetes.io/name=robusta-runner \
  --tail=100 | grep -E "(received|webhook|alert)"

# Test manually
curl -X POST http://localhost:9090/api/alerts \
  -H "Content-Type: application/json" \
  -d '[{"labels":{"alertname":"TestAlert","severity":"warning"},"status":"firing"}]' \
  --resolve "robusta-runner.robusta.svc.cluster.local:9090:127.0.0.1"
```

### Playbook Actions Not Executing

```bash
# Check runner logs for playbook errors
kubectl -n robusta logs -l app.kubernetes.io/name=robusta-runner \
  --tail=200 | grep -E "(ERROR|playbook|action)"

# Verify the trigger syntax in generated_values.yaml
robusta playbooks list

# Validate the YAML configuration
robusta validate-config ./robusta-values.yaml
```

### Slack Messages Not Arriving

```bash
# Test the Slack token
curl -H "Authorization: Bearer SLACK_BOT_TOKEN_REPLACE_ME" \
  https://slack.com/api/auth.test

# Check Robusta sink connection
kubectl -n robusta logs -l app.kubernetes.io/name=robusta-runner \
  | grep -E "(slack|sink|connection)"
```

## Best Practices

### Alert Noise Reduction

Use `inhibit_rules` in Alertmanager to suppress child alerts when a parent alert is already firing. Configure Robusta to send resolved notifications to automatically close Slack threads, keeping alert channels clean.

### Playbook Idempotency

Remediation playbooks must be **idempotent** — running them twice must not cause additional harm. Before deleting a pod or scaling a deployment, check the current state and bail out if the action is unnecessary.

### Rate Limiting Self-Healing

Add annotations to controlled resources that track when an automated action last ran:

```yaml
annotations:
  robusta.dev/last-auto-restart: "2027-02-24T10:30:00Z"
  robusta.dev/auto-restart-count: "3"
```

Playbook logic checks this annotation and stops auto-restarting after a configurable threshold, escalating to PagerDuty instead for human intervention.

### Separate Enrichment from Remediation

Enrichment playbooks (log collection, graph attachment) are safe to run broadly against all alerts. Remediation playbooks (pod restarts, scaling) should be scoped narrowly to specific alert names and namespaces, and should require a minimum time-threshold before acting (e.g., alert must be firing for 15 minutes before auto-restart).

## Conclusion

Robusta transforms Kubernetes observability from reactive page-and-investigate to proactive enriched alerting with optional automated remediation. The Python playbook system is flexible enough to encode any organization-specific runbook as code, and the sink architecture delivers enriched context to whatever notification channels on-call teams already use. Combined with HolmesGPT's AI-powered root cause analysis, Robusta significantly reduces mean time to resolution for common Kubernetes failure patterns while keeping on-call engineers informed with the full diagnostic context they need when automated remediation is not sufficient.
