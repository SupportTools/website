---
title: "Prometheus Recording Rules and Alert Grouping for Large-Scale Environments"
date: 2028-12-25T00:00:00-05:00
draft: false
tags: ["Prometheus", "Monitoring", "Alerting", "Recording Rules", "Alertmanager", "Observability"]
categories:
- Monitoring
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Prometheus recording rules for query optimization, cardinality management, and hierarchical alert grouping strategies for environments with thousands of targets and millions of active time series."
more_link: "yes"
url: "/prometheus-recording-rules-alert-grouping-large-scale-environments/"
---

At scale, raw Prometheus queries become a bottleneck. A dashboard loading twenty panels each executing expensive multi-dimensional aggregations across millions of time series can take minutes to render. Alerting rules that re-evaluate the same heavy expressions every 15 seconds create constant CPU pressure on Prometheus servers. Recording rules are the solution: they pre-compute expensive queries and store the results as new time series, making dashboards instantaneous and alerting CPU-cheap. Combined with precise alert grouping in Alertmanager, recording rules form the foundation of observable, scalable monitoring infrastructure.

<!--more-->

## Why Recording Rules Matter at Scale

Consider a simple question: what is the per-cluster CPU utilization across 50 clusters? The naive query:

```promql
# This aggregates across all node_cpu_seconds_total time series
# In a 50-cluster environment: ~50 clusters × ~100 nodes × 4 CPUs × 5 modes = 100,000 series
sum by (cluster) (
  rate(node_cpu_seconds_total{mode!="idle"}[5m])
) /
sum by (cluster) (
  rate(node_cpu_seconds_total[5m])
)
```

At 15-second scrape intervals with 50 clusters, this query touches 100,000+ time series on every execution. With recording rules, this aggregation runs once every 30 seconds and stores a 50-element result set. Dashboards then query a single 50-series metric rather than 100,000.

## Recording Rule Naming Conventions

The Prometheus documentation recommends the format `level:metric:operations`. Following this consistently makes the origin and transformation of a recorded metric self-documenting:

```yaml
# rules/cpu_recording.yml
groups:
- name: cpu_aggregations
  interval: 30s  # Override global evaluation interval for this group
  rules:
  # Level: cluster, Metric: cpu_usage, Operations: ratio
  - record: cluster:cpu_usage:ratio
    expr: |
      sum by (cluster, environment) (
        rate(node_cpu_seconds_total{mode!="idle"}[5m])
      )
      /
      sum by (cluster, environment) (
        rate(node_cpu_seconds_total[5m])
      )

  # Level: cluster, Metric: cpu_requests_fraction, Operations: ratio
  - record: cluster:cpu_requests_fraction:ratio
    expr: |
      sum by (cluster, environment) (
        kube_pod_container_resource_requests{resource="cpu"}
      )
      /
      sum by (cluster, environment) (
        kube_node_status_allocatable{resource="cpu"}
      )

  # Level: namespace, Metric: cpu_usage_cores, Operations: sum_rate
  - record: namespace:cpu_usage_cores:sum_rate5m
    expr: |
      sum by (cluster, namespace, environment) (
        rate(container_cpu_usage_seconds_total{
          container!="",
          container!="POD"
        }[5m])
      )

  # Level: pod, Metric: cpu_throttle_ratio, Operations: ratio_rate
  - record: pod:cpu_throttle_ratio:rate5m
    expr: |
      sum by (cluster, namespace, pod, container) (
        rate(container_cpu_cfs_throttled_seconds_total[5m])
      )
      /
      sum by (cluster, namespace, pod, container) (
        rate(container_cpu_cfs_periods_total[5m])
      )
```

## Memory Recording Rules

```yaml
# rules/memory_recording.yml
groups:
- name: memory_aggregations
  interval: 30s
  rules:
  - record: cluster:memory_usage_bytes:sum
    expr: |
      sum by (cluster, environment) (
        container_memory_working_set_bytes{
          container!="",
          container!="POD"
        }
      )

  - record: cluster:memory_requests_fraction:ratio
    expr: |
      sum by (cluster, environment) (
        kube_pod_container_resource_requests{resource="memory"}
      )
      /
      sum by (cluster, environment) (
        kube_node_status_allocatable{resource="memory"}
      )

  - record: namespace:memory_usage_bytes:sum
    expr: |
      sum by (cluster, namespace, environment) (
        container_memory_working_set_bytes{
          container!="",
          container!="POD"
        }
      )

  # OOM kill rate per cluster
  - record: cluster:oom_kills:rate5m
    expr: |
      sum by (cluster, environment) (
        rate(kube_pod_container_status_restarts_total{
          reason="OOMKilled"
        }[5m])
      )

  # Memory working set vs limit ratio per container
  - record: container:memory_usage_limit_ratio:ratio
    expr: |
      container_memory_working_set_bytes{
        container!="",
        container!="POD"
      }
      /
      container_spec_memory_limit_bytes{
        container!="",
        container!="POD"
      } > 0
```

## SLI Recording Rules

Pre-computing SLI metrics enables fast burn-rate alerting and efficient SLO dashboards:

```yaml
# rules/sli_recording.yml
groups:
- name: http_sli
  interval: 30s
  rules:
  # Request rate per service
  - record: service:http_request_rate:rate5m
    expr: |
      sum by (cluster, namespace, service, method, status_class) (
        label_replace(
          rate(http_requests_total[5m]),
          "status_class",
          "${1}xx",
          "status",
          "([0-9]).*"
        )
      )

  # Error ratio per service (5xx errors / total requests)
  - record: service:http_error_ratio:rate5m
    expr: |
      sum by (cluster, namespace, service) (
        rate(http_requests_total{status=~"5.."}[5m])
      )
      /
      sum by (cluster, namespace, service) (
        rate(http_requests_total[5m])
      )

  # Latency histogram quantiles per service
  - record: service:http_request_duration_p50:rate5m
    expr: |
      histogram_quantile(0.50,
        sum by (cluster, namespace, service, le) (
          rate(http_request_duration_seconds_bucket[5m])
        )
      )

  - record: service:http_request_duration_p99:rate5m
    expr: |
      histogram_quantile(0.99,
        sum by (cluster, namespace, service, le) (
          rate(http_request_duration_seconds_bucket[5m])
        )
      )

  - record: service:http_request_duration_p999:rate5m
    expr: |
      histogram_quantile(0.999,
        sum by (cluster, namespace, service, le) (
          rate(http_request_duration_seconds_bucket[5m])
        )
      )

  # Availability (inverse of error ratio) for SLO tracking
  - record: service:http_availability:rate5m
    expr: |
      1 - (
        sum by (cluster, namespace, service) (
          rate(http_requests_total{status=~"5.."}[5m])
        )
        /
        sum by (cluster, namespace, service) (
          rate(http_requests_total[5m])
        )
      )
```

## Multi-Window Burn Rate Recording Rules

Multi-window burn rate alerting requires multiple recording rules at different time windows. These pre-compute the burn rates used in SLO alerting:

```yaml
# rules/slo_burnrate.yml
groups:
- name: slo_burnrates
  interval: 60s  # Less frequent — these windows are already smooth
  rules:
  # 5-minute error ratio
  - record: service:slo_error_ratio:rate5m
    expr: |
      sum by (cluster, namespace, service) (
        rate(http_requests_total{status=~"5.."}[5m])
      )
      /
      sum by (cluster, namespace, service) (
        rate(http_requests_total[5m])
      )

  # 30-minute error ratio
  - record: service:slo_error_ratio:rate30m
    expr: |
      sum by (cluster, namespace, service) (
        rate(http_requests_total{status=~"5.."}[30m])
      )
      /
      sum by (cluster, namespace, service) (
        rate(http_requests_total[30m])
      )

  # 1-hour error ratio
  - record: service:slo_error_ratio:rate1h
    expr: |
      sum by (cluster, namespace, service) (
        rate(http_requests_total{status=~"5.."}[1h])
      )
      /
      sum by (cluster, namespace, service) (
        rate(http_requests_total[1h])
      )

  # 6-hour error ratio
  - record: service:slo_error_ratio:rate6h
    expr: |
      sum by (cluster, namespace, service) (
        rate(http_requests_total{status=~"5.."}[6h])
      )
      /
      sum by (cluster, namespace, service) (
        rate(http_requests_total[6h])
      )
```

## Alert Rules Using Recording Rules

With recording rules in place, alert expressions become lightweight lookups:

```yaml
# rules/alerts.yml
groups:
- name: slo_alerts
  rules:
  # Fast burn: >14.4x burn rate over 1h AND 5m
  # Consumes 2%+ of monthly error budget in 1 hour
  - alert: SLOFastBurn
    expr: |
      (
        service:slo_error_ratio:rate5m > (14.4 * 0.001)
        and
        service:slo_error_ratio:rate1h > (14.4 * 0.001)
      )
    for: 2m
    labels:
      severity: critical
      slo: "true"
      alert_type: fast_burn
    annotations:
      summary: "Fast SLO burn for {{ $labels.service }}"
      description: |
        Service {{ $labels.namespace }}/{{ $labels.service }} is burning its error budget
        at {{ $value | humanizePercentage }} error rate (14.4x normal burn rate).
        Will exhaust monthly budget in ~1 hour if sustained.
      runbook: "https://runbooks.support.tools/slo-fast-burn"
      dashboard: "https://grafana.support.tools/d/slo/{{ $labels.service }}"

  # Slow burn: >6x burn rate over 6h AND 30m
  # Consumes 5%+ of monthly error budget in 1 day
  - alert: SLOSlowBurn
    expr: |
      (
        service:slo_error_ratio:rate30m > (6 * 0.001)
        and
        service:slo_error_ratio:rate6h > (6 * 0.001)
      )
    for: 15m
    labels:
      severity: warning
      slo: "true"
      alert_type: slow_burn
    annotations:
      summary: "Slow SLO burn for {{ $labels.service }}"
      description: |
        Service {{ $labels.namespace }}/{{ $labels.service }} has sustained 6x normal
        error burn rate. Monthly budget exhaustion projected in ~5 days.
      runbook: "https://runbooks.support.tools/slo-slow-burn"

- name: resource_alerts
  rules:
  - alert: ClusterCPUOvercommitted
    expr: cluster:cpu_requests_fraction:ratio > 0.90
    for: 10m
    labels:
      severity: warning
      team: platform
    annotations:
      summary: "Cluster {{ $labels.cluster }} CPU overcommitted at {{ $value | humanizePercentage }}"
      description: "Pod CPU requests exceed 90% of allocatable CPU. Scheduling pressure imminent."

  - alert: NamespaceMemoryHigh
    expr: |
      namespace:memory_usage_bytes:sum
      /
      sum by (cluster, namespace, environment) (
        kube_namespace_status_phase{phase="Active"} * 0
        or
        kube_resourcequota{resource="limits.memory", type="hard"}
      ) > 0.85
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "Namespace {{ $labels.namespace }} memory usage at {{ $value | humanizePercentage }} of quota"

  - alert: ContainerMemoryNearLimit
    expr: container:memory_usage_limit_ratio:ratio > 0.90
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Container {{ $labels.pod }}/{{ $labels.container }} near memory limit"
      description: "Memory usage is {{ $value | humanizePercentage }} of limit. OOM risk."
```

## Alertmanager Configuration for Large Scale

Alertmanager's grouping, inhibition, and routing logic determines how alert floods are handled. At scale, poor grouping sends hundreds of individual alerts for a single node failure:

```yaml
# alertmanager.yml
global:
  smtp_from: 'alerts@support.tools'
  smtp_smarthost: 'smtp.support.tools:587'
  smtp_auth_username: 'alerts@support.tools'
  smtp_auth_password_file: /etc/alertmanager/smtp-password
  slack_api_url_file: /etc/alertmanager/slack-webhook
  resolve_timeout: 5m

templates:
- /etc/alertmanager/templates/*.tmpl

route:
  receiver: default
  group_by: ['alertname', 'cluster', 'environment']
  group_wait: 30s        # Wait 30s for more alerts before sending first notification
  group_interval: 5m     # Wait 5m before sending updates for a grouped alert
  repeat_interval: 4h    # Repeat unresolved alerts every 4h

  routes:
  # SLO alerts go to PagerDuty with tight grouping
  - matchers:
    - slo="true"
    receiver: pagerduty-slo
    group_by: ['alertname', 'cluster', 'namespace', 'service']
    group_wait: 0s        # Page immediately for SLO burns
    group_interval: 5m
    repeat_interval: 1h

  # Critical alerts → PagerDuty
  - matchers:
    - severity="critical"
    receiver: pagerduty-critical
    group_by: ['alertname', 'cluster', 'namespace']
    group_wait: 10s
    group_interval: 5m
    repeat_interval: 30m

  # Warning alerts → Slack (don't page)
  - matchers:
    - severity="warning"
    receiver: slack-warnings
    group_by: ['alertname', 'cluster', 'namespace']
    group_wait: 1m
    group_interval: 10m
    repeat_interval: 6h

  # Platform alerts go to platform team
  - matchers:
    - team="platform"
    receiver: slack-platform
    group_by: ['alertname', 'cluster']
    group_wait: 2m
    group_interval: 10m

inhibit_rules:
# Suppress node-level alerts when the entire cluster is down
- source_matchers:
  - alertname="ClusterDown"
  target_matchers:
  - alertname=~"Node.*"
  equal: ['cluster']

# Suppress container alerts when the node is not ready
- source_matchers:
  - alertname="NodeNotReady"
  target_matchers:
  - alertname=~"Container.*|Pod.*"
  equal: ['cluster', 'node']

# Suppress slow burn when fast burn is firing (same service)
- source_matchers:
  - alert_type="fast_burn"
  target_matchers:
  - alert_type="slow_burn"
  equal: ['cluster', 'namespace', 'service']

receivers:
- name: default
  slack_configs:
  - channel: '#alerts-default'
    send_resolved: true
    title: '{{ template "slack.title" . }}'
    text: '{{ template "slack.text" . }}'

- name: pagerduty-critical
  pagerduty_configs:
  - service_key_file: /etc/alertmanager/pagerduty-critical-key
    send_resolved: true
    description: '{{ template "pagerduty.description" . }}'
    client: 'Prometheus Alertmanager'
    client_url: 'https://prometheus.support.tools'
    severity: '{{ if eq .GroupLabels.severity "critical" }}critical{{ else }}warning{{ end }}'
    details:
      cluster: '{{ .GroupLabels.cluster }}'
      namespace: '{{ .GroupLabels.namespace }}'
      num_alerts: '{{ len .Alerts }}'

- name: pagerduty-slo
  pagerduty_configs:
  - service_key_file: /etc/alertmanager/pagerduty-slo-key
    send_resolved: true
    description: 'SLO Burn: {{ .GroupLabels.service }} in {{ .GroupLabels.namespace }}'
    severity: '{{ if eq .GroupLabels.severity "critical" }}critical{{ else }}warning{{ end }}'

- name: slack-warnings
  slack_configs:
  - channel: '#alerts-warning'
    send_resolved: true
    title: '[{{ .Status | toUpper }}] {{ .GroupLabels.alertname }} ({{ .Alerts | len }} alerts)'
    color: '{{ if eq .Status "firing" }}warning{{ else }}good{{ end }}'

- name: slack-platform
  slack_configs:
  - channel: '#platform-alerts'
    send_resolved: true
```

## Alert Templates

```go
// templates/slack.tmpl
{{ define "slack.title" -}}
[{{ .Status | toUpper }}{{ if eq .Status "firing" }}:{{ .Alerts.Firing | len }}{{ end }}]
{{ .GroupLabels.SortedPairs.Values | join " | " }}
{{- end }}

{{ define "slack.text" -}}
{{ range .Alerts -}}
*Alert:* {{ .Annotations.summary }}
*Cluster:* {{ .Labels.cluster }}
*Severity:* {{ .Labels.severity }}
*Description:* {{ .Annotations.description }}
{{ if .Annotations.runbook }}*Runbook:* <{{ .Annotations.runbook }}|View Runbook>{{ end }}
{{ if .Annotations.dashboard }}*Dashboard:* <{{ .Annotations.dashboard }}|View Dashboard>{{ end }}
*Started:* {{ .StartsAt | since }}
---
{{ end }}
{{- end }}
```

## Cardinality Management for Recording Rules

Recording rules can inadvertently create high-cardinality metrics if label combinations are unbounded:

```bash
# Identify high-cardinality recording rule outputs
# Query Prometheus meta-metrics
curl -s 'http://prometheus:9090/api/v1/query' \
  --data-urlencode 'query=topk(20, count by (__name__) ({__name__=~".*:.*:.*"}))' | \
  jq '.data.result[] | {metric: .metric.__name__, count: .value[1]}'

# Typical safe cardinalities for recording rules:
# cluster-level: O(10) — 10 clusters
# namespace-level: O(100) — 100 namespaces per cluster
# service-level: O(1000) — acceptable
# pod-level: O(10000) — borderline, watch carefully
# container-level: O(50000) — high, consider aggregating higher
```

### Avoiding Cardinality Explosions

```yaml
# WRONG: preserves high-cardinality labels in recording rule output
- record: container:cpu_usage:rate5m
  expr: |
    rate(container_cpu_usage_seconds_total[5m])
    # This preserves pod, container, image, id — potentially millions of series

# CORRECT: aggregate to needed dimensions only
- record: namespace:cpu_usage_cores:rate5m
  expr: |
    sum by (cluster, namespace, environment) (
      rate(container_cpu_usage_seconds_total{
        container!="",
        container!="POD"
      }[5m])
    )
    # Output: O(cluster_count × namespace_count) — manageable
```

## Prometheus Rule File Organization

```bash
# Recommended directory structure for rule files
/etc/prometheus/rules/
├── recording/
│   ├── 01-cpu.yml           # CPU aggregations
│   ├── 02-memory.yml        # Memory aggregations
│   ├── 03-network.yml       # Network aggregations
│   ├── 04-storage.yml       # Storage/I/O aggregations
│   ├── 05-sli-http.yml      # HTTP SLI recording rules
│   ├── 06-sli-grpc.yml      # gRPC SLI recording rules
│   └── 07-slo-burnrates.yml # SLO burn rate windows
└── alerts/
    ├── 01-slo.yml           # SLO burn rate alerts
    ├── 02-kubernetes.yml    # Kubernetes component alerts
    ├── 03-node.yml          # Node resource alerts
    ├── 04-container.yml     # Container resource alerts
    └── 05-database.yml      # Database health alerts

# Validate rule files before applying
promtool check rules /etc/prometheus/rules/**/*.yml

# Check for common issues
promtool check rules /etc/prometheus/rules/recording/01-cpu.yml
# Checking /etc/prometheus/rules/recording/01-cpu.yml
#   SUCCESS: 8 rules found
```

Recording rules and thoughtful alert grouping transform Prometheus from a reactive query engine into a proactive observability platform. The investment in pre-computation pays dividends across dashboard load times, alert firing latency, and Prometheus server CPU — all critical at the scale of hundreds of clusters and thousands of services.
