---
title: "Kubernetes Prometheus Operator Deep Dive: Custom Metrics, Recording Rules, and Alertmanager Configuration"
date: 2031-07-08T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Prometheus", "Alertmanager", "Observability", "Monitoring", "PromQL", "Operator"]
categories: ["Kubernetes", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to the Prometheus Operator on Kubernetes, covering custom ServiceMonitors, PodMonitors, recording rules, alerting rules, and production-grade Alertmanager routing configurations."
more_link: "yes"
url: "/kubernetes-prometheus-operator-custom-metrics-recording-rules-alertmanager/"
---

The Prometheus Operator has become the de facto standard for deploying and managing Prometheus-based monitoring stacks on Kubernetes. By expressing Prometheus configuration as Kubernetes custom resources, it removes the need to manage scrape configs and alert rule files manually and brings the full GitOps workflow to your observability infrastructure. This guide covers every major capability of the operator: custom ServiceMonitors and PodMonitors, PrometheusRule manifests for recording and alerting rules, TLS-aware scrape endpoints, and a production-grade Alertmanager configuration that handles on-call routing, inhibition, and silences.

<!--more-->

# Kubernetes Prometheus Operator Deep Dive

## Section 1: Understanding the Prometheus Operator Architecture

The Prometheus Operator was created by CoreOS and is now maintained under the prometheus-operator GitHub organization. It introduces several custom resource definitions (CRDs) that allow you to declaratively manage your entire monitoring stack.

### Core CRDs

| CRD | Purpose |
|-----|---------|
| `Prometheus` | Defines a Prometheus instance: replicas, storage, retention, rule selectors |
| `Alertmanager` | Defines an Alertmanager cluster |
| `ServiceMonitor` | Defines scrape targets selected by Service labels |
| `PodMonitor` | Defines scrape targets selected directly by Pod labels |
| `PrometheusRule` | Defines recording rules and alerting rules |
| `AlertmanagerConfig` | Namespace-scoped Alertmanager routing configuration |
| `ThanosRuler` | Manages Thanos Ruler instances for long-term storage alerting |
| `ScrapeConfig` | Defines scrape targets using native Prometheus scrape configuration |

### How the Operator Reconciles Configuration

The operator watches all of these CRDs and reconciles the Prometheus and Alertmanager StatefulSets accordingly. When you create a `ServiceMonitor`, the operator:

1. Evaluates the `namespaceSelector` and `selector` to find matching Services.
2. Generates the corresponding `scrape_config` block in the Prometheus configuration.
3. Sends a SIGHUP (or calls the reload API) to trigger a live configuration reload without restarting the Prometheus process.

This reconciliation loop means you never need to edit the raw Prometheus config file directly.

### Installing the Prometheus Operator via kube-prometheus-stack

The `kube-prometheus-stack` Helm chart is the standard distribution that bundles the operator, Prometheus, Alertmanager, node-exporter, kube-state-metrics, and a curated set of Grafana dashboards.

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm upgrade --install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace \
  --version 58.x.x \
  -f values-production.yaml
```

A production `values-production.yaml` skeleton:

```yaml
prometheus:
  prometheusSpec:
    replicas: 2
    retention: 30d
    retentionSize: 80GB
    storageSpec:
      volumeClaimTemplate:
        spec:
          storageClassName: fast-ssd
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 100Gi
    resources:
      requests:
        cpu: 500m
        memory: 2Gi
      limits:
        cpu: 2000m
        memory: 8Gi
    # Allow the operator to pick up ServiceMonitors from all namespaces
    serviceMonitorNamespaceSelector: {}
    serviceMonitorSelector: {}
    podMonitorNamespaceSelector: {}
    podMonitorSelector: {}
    ruleNamespaceSelector: {}
    ruleSelector: {}
    # External labels for federation and remote_write identification
    externalLabels:
      cluster: production-us-east-1
      environment: production
    # Remote write to Thanos or VictoriaMetrics for long-term storage
    remoteWrite:
      - url: https://thanos-receive.monitoring.svc.cluster.local:19291/api/v1/receive
        tlsConfig:
          ca:
            secret:
              name: thanos-tls
              key: ca.crt
          cert:
            secret:
              name: thanos-tls
              key: tls.crt
          keySecret:
            name: thanos-tls
            key: tls.key
    walCompression: true
    enableAdminAPI: false

alertmanager:
  alertmanagerSpec:
    replicas: 3
    retention: 120h
    storage:
      volumeClaimTemplate:
        spec:
          storageClassName: fast-ssd
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 10Gi
    resources:
      requests:
        cpu: 100m
        memory: 256Mi
      limits:
        cpu: 500m
        memory: 512Mi

grafana:
  adminPassword: "<grafana-admin-password>"
  persistence:
    enabled: true
    storageClassName: fast-ssd
    size: 10Gi

nodeExporter:
  enabled: true

kubeStateMetrics:
  enabled: true
```

## Section 2: ServiceMonitor and PodMonitor Configuration

### ServiceMonitor for a Standard HTTP Service

A `ServiceMonitor` selects Services by label and defines how Prometheus should scrape the `/metrics` endpoint exposed by those Services.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: my-application
  namespace: my-app
  labels:
    # This label must match the serviceMonitorSelector in the Prometheus CR
    release: kube-prometheus-stack
spec:
  # Select Services in the same namespace
  namespaceSelector:
    matchNames:
      - my-app
      - my-app-staging
  # Label selector for Services
  selector:
    matchLabels:
      app.kubernetes.io/name: my-application
      monitoring: "true"
  endpoints:
    - port: metrics          # The named port on the Service
      path: /metrics
      interval: 30s
      scrapeTimeout: 10s
      honorLabels: false
      # Relabeling to add useful metadata
      relabelings:
        - sourceLabels: [__meta_kubernetes_pod_node_name]
          targetLabel: node
        - sourceLabels: [__meta_kubernetes_namespace]
          targetLabel: namespace
        - sourceLabels: [__meta_kubernetes_pod_name]
          targetLabel: pod
      # MetricRelabeling to drop high-cardinality or unnecessary metrics
      metricRelabelings:
        - sourceLabels: [__name__]
          regex: "go_gc_.*"
          action: drop
        - sourceLabels: [__name__]
          regex: "promhttp_metric_handler_requests_.*"
          action: drop
```

### ServiceMonitor with TLS Client Authentication

When your service exposes metrics over HTTPS (common in production environments where mTLS is enforced), the ServiceMonitor must be configured with TLS settings.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: secure-application
  namespace: my-app
  labels:
    release: kube-prometheus-stack
spec:
  namespaceSelector:
    matchNames:
      - my-app
  selector:
    matchLabels:
      app: secure-application
  endpoints:
    - port: https-metrics
      scheme: https
      interval: 30s
      tlsConfig:
        # CA certificate used to verify the server certificate
        ca:
          secret:
            name: app-tls-ca
            key: ca.crt
        # Client certificate for mTLS
        cert:
          secret:
            name: prometheus-client-tls
            key: tls.crt
        keySecret:
          name: prometheus-client-tls
          key: tls.key
        insecureSkipVerify: false
        serverName: secure-application.my-app.svc.cluster.local
      # Bearer token authentication as an alternative to mTLS
      # bearerTokenSecret:
      #   name: app-metrics-token
      #   key: token
```

### PodMonitor for Direct Pod Scraping

A `PodMonitor` bypasses the Service layer and scrapes Pods directly. This is useful for workloads like DaemonSets or Jobs where a Service abstraction is not present.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: batch-job-metrics
  namespace: data-processing
  labels:
    release: kube-prometheus-stack
spec:
  namespaceSelector:
    matchNames:
      - data-processing
  selector:
    matchLabels:
      app: batch-processor
  podMetricsEndpoints:
    - port: metrics
      path: /metrics
      interval: 60s
      scrapeTimeout: 30s
      relabelings:
        - sourceLabels: [__meta_kubernetes_pod_label_batch_job_id]
          targetLabel: job_id
        - sourceLabels: [__meta_kubernetes_pod_label_batch_job_type]
          targetLabel: job_type
```

### ScrapeConfig for External Targets

The `ScrapeConfig` CRD (introduced in operator v0.65) allows you to scrape targets outside of Kubernetes using standard Prometheus scrape_config semantics, including `static_configs`, `http_sd_configs`, and `consul_sd_configs`.

```yaml
apiVersion: monitoring.coreos.com/v1alpha1
kind: ScrapeConfig
metadata:
  name: external-legacy-services
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  staticConfigs:
    - labels:
        job: legacy-app
        environment: production
        datacenter: us-east-1
      targets:
        - "10.0.1.50:9100"
        - "10.0.1.51:9100"
        - "10.0.1.52:9100"
  relabelings:
    - sourceLabels: [__address__]
      targetLabel: instance
  metricsPath: /metrics
  scheme: http
  scrapeInterval: 60s
  scrapeTimeout: 30s
```

## Section 3: PrometheusRule for Recording Rules

Recording rules pre-compute frequently needed or computationally expensive PromQL expressions and store the results as new time series. This dramatically improves dashboard load times and reduces the computational overhead on Prometheus at query time.

### Creating a PrometheusRule Resource

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: application-recording-rules
  namespace: my-app
  labels:
    release: kube-prometheus-stack
    role: alert-rules
spec:
  groups:
    - name: application.recording_rules
      interval: 1m
      rules:
        # Request rate per service and method
        - record: job:http_requests_total:rate5m
          expr: |
            sum by (job, method, status_code) (
              rate(http_requests_total[5m])
            )

        # Error rate as a ratio
        - record: job:http_request_errors:rate5m_ratio
          expr: |
            sum by (job, method) (
              rate(http_requests_total{status_code=~"5.."}[5m])
            )
            /
            sum by (job, method) (
              rate(http_requests_total[5m])
            )

        # 95th percentile latency
        - record: job:http_request_duration_seconds:p95
          expr: |
            histogram_quantile(
              0.95,
              sum by (job, le) (
                rate(http_request_duration_seconds_bucket[5m])
              )
            )

        # 99th percentile latency
        - record: job:http_request_duration_seconds:p99
          expr: |
            histogram_quantile(
              0.99,
              sum by (job, le) (
                rate(http_request_duration_seconds_bucket[5m])
              )
            )

        # CPU saturation by namespace
        - record: namespace:container_cpu_usage_seconds_total:sum_rate
          expr: |
            sum by (namespace) (
              rate(container_cpu_usage_seconds_total{
                container!="",
                container!="POD"
              }[5m])
            )

        # Memory usage by namespace
        - record: namespace:container_memory_working_set_bytes:sum
          expr: |
            sum by (namespace) (
              container_memory_working_set_bytes{
                container!="",
                container!="POD"
              }
            )

    - name: slo.recording_rules
      interval: 1m
      rules:
        # Availability SLO: percentage of successful requests
        - record: job:slo_availability:ratio_rate5m
          expr: |
            1 - (
              sum by (job) (rate(http_requests_total{status_code=~"5.."}[5m]))
              /
              sum by (job) (rate(http_requests_total[5m]))
            )

        # Multi-window error budget burn rate (used for SLO alerting)
        - record: job:slo_error_budget_burn:rate1h
          expr: |
            sum by (job) (rate(http_requests_total{status_code=~"5.."}[1h]))
            /
            sum by (job) (rate(http_requests_total[1h]))

        - record: job:slo_error_budget_burn:rate6h
          expr: |
            sum by (job) (rate(http_requests_total{status_code=~"5.."}[6h]))
            /
            sum by (job) (rate(http_requests_total[6h]))
```

### Kubernetes Infrastructure Recording Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kubernetes-infrastructure-rules
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: kubernetes.node.recording_rules
      interval: 2m
      rules:
        # Node CPU utilization
        - record: node:node_cpu_utilization:ratio
          expr: |
            1 - avg by (node) (
              rate(node_cpu_seconds_total{mode="idle"}[5m])
            )

        # Node memory utilization
        - record: node:node_memory_utilization:ratio
          expr: |
            1 - (
              node_memory_MemAvailable_bytes
              /
              node_memory_MemTotal_bytes
            )

        # Node disk I/O utilization
        - record: node:node_disk_io_utilization:ratio
          expr: |
            max by (node, device) (
              rate(node_disk_io_time_seconds_total[5m])
            )

        # Node network receive bandwidth
        - record: node:node_network_receive_bytes:rate5m
          expr: |
            sum by (node, device) (
              rate(node_network_receive_bytes_total{device!~"lo|veth.*|docker.*|flannel.*|cali.*|cbr.*"}[5m])
            )

    - name: kubernetes.pod.recording_rules
      interval: 1m
      rules:
        # Pod CPU throttling ratio (critical for performance issues)
        - record: pod:container_cpu_throttled_seconds:ratio
          expr: |
            sum by (namespace, pod, container) (
              rate(container_cpu_cfs_throttled_seconds_total{container!=""}[5m])
            )
            /
            sum by (namespace, pod, container) (
              rate(container_cpu_cfs_periods_total{container!=""}[5m])
            )

        # Pod restart rate
        - record: pod:kube_pod_container_status_restarts:rate1h
          expr: |
            sum by (namespace, pod, container) (
              rate(kube_pod_container_status_restarts_total[1h])
            )
```

## Section 4: PrometheusRule for Alerting Rules

Alerting rules evaluate PromQL expressions and fire alerts when conditions are met. The alerts flow to Alertmanager, which handles deduplication, grouping, inhibition, and routing.

### Application-Level Alerting Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: application-alerting-rules
  namespace: my-app
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: application.alerts
      rules:
        # High error rate alert
        - alert: HighErrorRate
          expr: |
            job:http_request_errors:rate5m_ratio > 0.05
          for: 5m
          labels:
            severity: warning
            team: platform
            runbook: "https://runbooks.internal/high-error-rate"
          annotations:
            summary: "High HTTP error rate on {{ $labels.job }}"
            description: |
              The error rate for {{ $labels.job }} (method: {{ $labels.method }}) is
              {{ $value | humanizePercentage }} which exceeds the 5% threshold.
              This has been sustained for 5 minutes.
            impact: "Users may be experiencing request failures."
            remediation: "Check application logs and recent deployments."

        # Critical error rate alert
        - alert: CriticalErrorRate
          expr: |
            job:http_request_errors:rate5m_ratio > 0.20
          for: 2m
          labels:
            severity: critical
            team: platform
            runbook: "https://runbooks.internal/critical-error-rate"
            page: "true"
          annotations:
            summary: "Critical HTTP error rate on {{ $labels.job }}"
            description: |
              The error rate for {{ $labels.job }} is {{ $value | humanizePercentage }},
              exceeding the 20% critical threshold. Immediate investigation required.

        # High latency alert (p95)
        - alert: HighRequestLatency
          expr: |
            job:http_request_duration_seconds:p95 > 2.0
          for: 10m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "High p95 latency on {{ $labels.job }}"
            description: |
              The 95th percentile request latency for {{ $labels.job }} is
              {{ $value | humanizeDuration }}, exceeding the 2 second SLO threshold.

        # SLO burn rate alert (multi-window)
        - alert: SLOBurnRateFast
          expr: |
            (
              job:slo_error_budget_burn:rate1h > (14.4 * 0.001)
              and
              job:slo_error_budget_burn:rate6h > (6 * 0.001)
            )
          for: 2m
          labels:
            severity: critical
            team: platform
            page: "true"
          annotations:
            summary: "Fast SLO error budget burn for {{ $labels.job }}"
            description: |
              The error budget for {{ $labels.job }} is burning at {{ $value | humanizePercentage }}
              per hour. At this rate, the monthly error budget will be exhausted within 1 hour.

        # SLO burn rate slow alert
        - alert: SLOBurnRateSlow
          expr: |
            (
              job:slo_error_budget_burn:rate6h > (3 * 0.001)
            )
          for: 60m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "Slow SLO error budget burn for {{ $labels.job }}"
            description: |
              The error budget for {{ $labels.job }} is burning faster than expected over 6 hours.

    - name: kubernetes.workload.alerts
      rules:
        # Pod crash looping
        - alert: PodCrashLooping
          expr: |
            rate(kube_pod_container_status_restarts_total[15m]) * 60 * 15 > 0
          for: 15m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "Pod {{ $labels.namespace }}/{{ $labels.pod }} is crash looping"
            description: |
              Container {{ $labels.container }} in pod {{ $labels.pod }}
              (namespace: {{ $labels.namespace }}) has restarted
              {{ $value | humanize }} times in the last 15 minutes.

        # Pod not ready
        - alert: PodNotReady
          expr: |
            sum by (namespace, pod) (
              max by (namespace, pod) (kube_pod_status_phase{phase=~"Pending|Unknown"})
              * on(namespace, pod)
              group_left(owner_kind) topk by (namespace, pod) (
                1, max by (namespace, pod, owner_kind) (kube_pod_owner{owner_kind!="Job"})
              )
            ) > 0
          for: 15m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "Pod {{ $labels.namespace }}/{{ $labels.pod }} not ready"
            description: "Pod {{ $labels.pod }} in namespace {{ $labels.namespace }} is not ready."

        # Deployment replicas mismatch
        - alert: DeploymentReplicasMismatch
          expr: |
            (
              kube_deployment_spec_replicas
              !=
              kube_deployment_status_replicas_available
            ) and (
              changes(kube_deployment_status_replicas_updated[10m]) == 0
            )
          for: 15m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "Deployment {{ $labels.namespace }}/{{ $labels.deployment }} replicas mismatch"
            description: |
              Deployment {{ $labels.deployment }} has {{ $value }} fewer replicas available
              than desired. This has been the case for 15 minutes with no rolling update in progress.

        # HPA maxed out
        - alert: HPAMaxedOut
          expr: |
            kube_horizontalpodautoscaler_status_current_replicas
            ==
            kube_horizontalpodautoscaler_spec_max_replicas
          for: 15m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "HPA {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }} is at maximum replicas"
            description: |
              HPA {{ $labels.horizontalpodautoscaler }} has been at its maximum replica count
              ({{ $value }}) for 15 minutes, suggesting it may need a higher maximum.

        # CPU throttling
        - alert: ContainerCPUThrottling
          expr: |
            pod:container_cpu_throttled_seconds:ratio > 0.25
          for: 15m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "Container {{ $labels.container }} is being CPU throttled"
            description: |
              Container {{ $labels.container }} in pod {{ $labels.pod }}
              (namespace: {{ $labels.namespace }}) is being throttled
              {{ $value | humanizePercentage }} of the time. Consider increasing CPU limits.
```

## Section 5: Alertmanager Configuration

The Alertmanager handles alert notification routing, deduplication, grouping, and silencing. The Prometheus Operator manages Alertmanager via the `Alertmanager` CRD and a Secret containing the configuration.

### Production Alertmanager Configuration

```yaml
# Create as a Kubernetes Secret and reference it in the Alertmanager CR
apiVersion: v1
kind: Secret
metadata:
  name: alertmanager-kube-prometheus-stack-alertmanager
  namespace: monitoring
type: Opaque
stringData:
  alertmanager.yaml: |
    global:
      # How long to wait before sending a notification again if it has already
      # been sent successfully for an alert. This is the recovery notification.
      resolve_timeout: 5m
      # SMTP configuration for email notifications
      smtp_smarthost: "smtp.internal.company.com:587"
      smtp_from: "alertmanager@company.com"
      smtp_auth_username: "alertmanager@company.com"
      smtp_auth_password: "<smtp-password>"
      smtp_require_tls: true
      # Slack API URL (use a real webhook URL in production)
      slack_api_url: "<slack-webhook-url>"

    # Templates for notification formatting
    templates:
      - "/etc/alertmanager/config/*.tmpl"

    # The root route. All alerts enter here.
    route:
      receiver: "default-receiver"
      group_by: ["alertname", "cluster", "namespace"]
      group_wait: 30s        # Wait to batch initial alerts
      group_interval: 5m     # How long to wait before sending a new notification for a group
      repeat_interval: 4h    # How often to re-send ongoing alerts

      routes:
        # Critical alerts with page: true label go to PagerDuty and Slack critical channel
        - matchers:
            - severity = critical
            - page = "true"
          receiver: "pagerduty-critical"
          group_by: ["alertname", "cluster", "namespace", "pod"]
          group_wait: 10s
          repeat_interval: 1h
          continue: true  # Continue to check further routes

        # All critical alerts also go to Slack
        - matchers:
            - severity = critical
          receiver: "slack-critical"
          group_by: ["alertname", "cluster"]
          group_wait: 10s
          repeat_interval: 2h
          continue: false

        # Warning alerts go to Slack warnings channel
        - matchers:
            - severity = warning
          receiver: "slack-warning"
          group_wait: 30s
          repeat_interval: 4h

        # Platform team alerts
        - matchers:
            - team = platform
            - severity = warning
          receiver: "slack-platform-team"
          group_wait: 30s
          repeat_interval: 4h

        # Data team alerts
        - matchers:
            - team = data
          receiver: "slack-data-team"
          group_wait: 1m
          repeat_interval: 6h

        # Watchdog alert (used to test the entire alerting pipeline)
        - matchers:
            - alertname = Watchdog
          receiver: "deadman-snitch"
          repeat_interval: 1m

    # Inhibition rules prevent low-priority alerts from firing
    # when a high-priority alert is already firing
    inhibit_rules:
      # If a node is down, suppress pod-level alerts for pods on that node
      - source_matchers:
          - alertname = "NodeNotReady"
        target_matchers:
          - alertname =~ "PodCrashLooping|PodNotReady|DeploymentReplicasMismatch"
        equal: ["cluster", "node"]

      # If a namespace has a critical alert, suppress warning alerts for that namespace
      - source_matchers:
          - severity = critical
        target_matchers:
          - severity = warning
        equal: ["alertname", "cluster", "namespace"]

      # If an entire cluster is down, suppress all other alerts from it
      - source_matchers:
          - alertname = "KubeAPIDown"
        target_matchers:
          - cluster
        equal: ["cluster"]

    receivers:
      - name: "default-receiver"
        slack_configs:
          - channel: "#alerts-default"
            title: |
              [{{ .Status | toUpper }}{{ if eq .Status "firing" }}:{{ .Alerts.Firing | len }}{{ end }}]
              {{ .CommonLabels.alertname }}
            text: |
              {{ range .Alerts }}
              *Alert:* {{ .Labels.alertname }} - `{{ .Labels.severity }}`
              *Cluster:* {{ .Labels.cluster }}
              *Namespace:* {{ .Labels.namespace }}
              *Description:* {{ .Annotations.description }}
              *Runbook:* {{ .Annotations.runbook }}
              {{ end }}
            send_resolved: true

      - name: "pagerduty-critical"
        pagerduty_configs:
          - routing_key: "<pagerduty-integration-key>"
            severity: |
              {{ if eq .CommonLabels.severity "critical" }}critical{{ else }}warning{{ end }}
            description: |
              {{ .CommonLabels.alertname }}: {{ .CommonAnnotations.summary }}
            details:
              cluster: "{{ .CommonLabels.cluster }}"
              namespace: "{{ .CommonLabels.namespace }}"
              description: "{{ .CommonAnnotations.description }}"
              runbook: "{{ .CommonAnnotations.runbook }}"
            links:
              - href: "{{ .CommonAnnotations.runbook }}"
                text: "Runbook"

      - name: "slack-critical"
        slack_configs:
          - channel: "#alerts-critical"
            color: |
              {{ if eq .Status "firing" }}danger{{ else }}good{{ end }}
            title: |
              [CRITICAL] {{ .CommonLabels.alertname }}
            text: |
              {{ range .Alerts }}
              *Cluster:* {{ .Labels.cluster }}
              *Namespace:* {{ .Labels.namespace }}
              *Pod:* {{ .Labels.pod }}
              *Summary:* {{ .Annotations.summary }}
              *Description:* {{ .Annotations.description }}
              *Impact:* {{ .Annotations.impact }}
              *Remediation:* {{ .Annotations.remediation }}
              *Runbook:* <{{ .Annotations.runbook }}|Click Here>
              {{ end }}
            send_resolved: true
            icon_emoji: ":fire:"

      - name: "slack-warning"
        slack_configs:
          - channel: "#alerts-warning"
            color: |
              {{ if eq .Status "firing" }}warning{{ else }}good{{ end }}
            title: |
              [WARNING] {{ .CommonLabels.alertname }}
            text: |
              {{ range .Alerts }}
              *Cluster:* {{ .Labels.cluster }}
              *Namespace:* {{ .Labels.namespace }}
              *Summary:* {{ .Annotations.summary }}
              {{ end }}
            send_resolved: true

      - name: "slack-platform-team"
        slack_configs:
          - channel: "#platform-alerts"
            title: |
              {{ .CommonLabels.alertname }}
            text: |
              {{ .CommonAnnotations.description }}
            send_resolved: true

      - name: "slack-data-team"
        slack_configs:
          - channel: "#data-team-alerts"
            send_resolved: true

      - name: "deadman-snitch"
        webhook_configs:
          - url: "https://nosnch.in/<snitch-token>"
```

### AlertmanagerConfig for Namespace-Scoped Routing

The `AlertmanagerConfig` CRD allows application teams to define routing rules within their own namespace without having access to the global Alertmanager configuration.

```yaml
apiVersion: monitoring.coreos.com/v1alpha1
kind: AlertmanagerConfig
metadata:
  name: my-app-alerting
  namespace: my-app
  labels:
    release: kube-prometheus-stack
spec:
  route:
    receiver: my-app-slack
    matchers:
      - name: namespace
        value: my-app
    groupBy: ["alertname"]
    groupWait: 30s
    repeatInterval: 4h
  receivers:
    - name: my-app-slack
      slackConfigs:
        - apiURL:
            name: slack-webhook-secret
            key: webhook-url
          channel: "#my-app-alerts"
          sendResolved: true
```

## Section 6: Advanced Techniques

### Verifying PrometheusRule Pickup

After applying a `PrometheusRule`, verify it was picked up by the operator and loaded into Prometheus without syntax errors:

```bash
# Check if the rule was generated in Prometheus config
kubectl exec -n monitoring prometheus-kube-prometheus-stack-prometheus-0 \
  -- promtool check rules /etc/prometheus/rules/prometheus-kube-prometheus-stack-prometheus-rulefiles-0/*.yaml

# Query Prometheus API to see loaded rules
kubectl port-forward -n monitoring svc/kube-prometheus-stack-prometheus 9090:9090 &
curl http://localhost:9090/api/v1/rules | jq '.data.groups[].name'

# Check operator logs for errors
kubectl logs -n monitoring -l app.kubernetes.io/name=prometheus-operator --tail=100
```

### Debugging Alertmanager Routing

```bash
# Port-forward to Alertmanager UI
kubectl port-forward -n monitoring svc/kube-prometheus-stack-alertmanager 9093:9093 &

# Test routing using amtool
amtool config routes test \
  --config.file=/tmp/alertmanager.yaml \
  severity=critical namespace=my-app alertname=HighErrorRate

# Check current silences
amtool --alertmanager.url=http://localhost:9093 silence query

# Check active alerts
amtool --alertmanager.url=http://localhost:9093 alert query

# Create a silence for planned maintenance
amtool --alertmanager.url=http://localhost:9093 silence add \
  --duration=2h \
  --comment="Planned maintenance window" \
  namespace=my-app
```

### Recording Rule Naming Conventions

Follow the Prometheus recording rule naming convention to maintain consistency across your organization:

```
<aggregation_level>:<metric_name>:<operation>
```

Examples:
- `job:http_requests_total:rate5m` — rate over 5 minutes, aggregated by job
- `namespace:container_memory_working_set_bytes:sum` — sum, aggregated by namespace
- `pod:container_cpu_throttled_seconds:ratio` — ratio, per pod

### Custom Metrics Exposition in Go

When building services that expose Prometheus metrics, use the official client library with proper label cardinality:

```go
package main

import (
    "net/http"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
    httpRequestsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "http_requests_total",
            Help: "Total number of HTTP requests processed.",
        },
        []string{"method", "path", "status_code"},
    )

    httpRequestDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "http_request_duration_seconds",
            Help:    "HTTP request duration in seconds.",
            Buckets: []float64{0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10},
        },
        []string{"method", "path"},
    )

    // Gauge for tracking in-flight requests
    httpRequestsInFlight = promauto.NewGauge(
        prometheus.GaugeOpts{
            Name: "http_requests_in_flight",
            Help: "Current number of HTTP requests being processed.",
        },
    )
)

func instrumentedHandler(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        httpRequestsInFlight.Inc()
        defer httpRequestsInFlight.Dec()

        rw := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}
        next.ServeHTTP(rw, r)

        duration := time.Since(start).Seconds()
        statusCode := fmt.Sprintf("%d", rw.statusCode)

        httpRequestsTotal.WithLabelValues(r.Method, r.URL.Path, statusCode).Inc()
        httpRequestDuration.WithLabelValues(r.Method, r.URL.Path).Observe(duration)
    })
}

func main() {
    mux := http.NewServeMux()
    mux.HandleFunc("/api/v1/data", handleData)
    mux.Handle("/metrics", promhttp.Handler())

    server := &http.Server{
        Addr:    ":8080",
        Handler: instrumentedHandler(mux),
    }
    server.ListenAndServe()
}
```

## Section 7: Operational Best Practices

### Label Cardinality Management

High-cardinality labels are the most common source of Prometheus performance problems. Never use the following as metric labels:
- User IDs
- Session tokens
- Full request URLs
- Timestamps
- Email addresses

Use aggregation in recording rules to reduce cardinality before storing or alerting on data.

### Alert Fatigue Prevention

Structure your alerts in tiers:
1. **Page-worthy (critical)**: Requires immediate human action, revenue impact, or SLO breach imminent.
2. **Warning**: Requires attention within business hours, trend indicates future problem.
3. **Info**: Captured in logs or dashboards only, no notification sent.

Always include `for` durations on alerts to avoid alerting on transient spikes. Minimum recommended durations:
- Critical: 2-5 minutes
- Warning: 10-15 minutes

### Prometheus Resource Sizing

Use these formulas as starting points:

```
Memory = (number_of_active_time_series * 3000 bytes * 2) + (query_concurrency * 50MB)
Storage = (number_of_samples_per_second * bytes_per_sample * retention_seconds)
         = (ingestion_rate * 1-3 bytes * retention_seconds)
CPU = 0.1 cores per 100k active time series (write path)
```

For a cluster with 500k active time series and 30-day retention:
- Memory: ~3GB working set + query memory headroom = 8GB recommended
- Storage: ~200GB per month at typical compression ratios
- CPU: 0.5 cores + headroom = 2 cores recommended

### Federation and Long-Term Storage

For multi-cluster setups, configure `remote_write` to a central Thanos Receiver or VictoriaMetrics cluster:

```yaml
prometheusSpec:
  remoteWrite:
    - url: https://thanos-receive.monitoring.central.svc.cluster.local:19291/api/v1/receive
      writeRelabelConfigs:
        # Only send recording rule results and key raw metrics to reduce bandwidth
        - sourceLabels: [__name__]
          regex: "job:.*|namespace:.*|node:.*|ALERTS.*"
          action: keep
      queueConfig:
        capacity: 10000
        maxSamplesPerSend: 5000
        batchSendDeadline: 5s
        maxRetries: 3
        minBackoff: 30ms
        maxBackoff: 100ms
```

## Conclusion

The Prometheus Operator transforms monitoring configuration from a fragile, manually managed set of config files into a declarative, GitOps-friendly set of Kubernetes resources. By understanding the full lifecycle from ServiceMonitor to recording rules to Alertmanager routing, teams can build a production-grade observability stack that scales with their organization. The key principles to internalize are: keep label cardinality low, use recording rules aggressively to pre-compute expensive queries, design alert routing to minimize fatigue while ensuring nothing critical is missed, and always test alert routing changes with `amtool` before deploying to production.
