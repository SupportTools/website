---
title: "Prometheus Recording Rules: Query Optimization and Dashboard Performance"
date: 2028-03-12T00:00:00-05:00
draft: false
tags: ["Prometheus", "Monitoring", "Recording Rules", "Thanos", "PromQL", "Observability", "Performance"]
categories: ["Monitoring", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Prometheus recording rules covering naming conventions, pre-computing expensive queries, cardinality management, promtool testing, Thanos Ruler for HA evaluation, and migrating dashboards to recording rules."
more_link: "yes"
url: "/prometheus-recording-rules-optimization-guide-advanced/"
---

Prometheus dashboards that query raw metrics with complex aggregations directly against the TSDB experience two compounding problems: query latency increases as data volume grows, and repeated evaluation of identical expressions by multiple users multiplies the computational load. Recording rules solve both problems by pre-computing expensive expressions on a schedule and storing the results as new time series. This guide covers every aspect of production recording rule design, from naming conventions through HA evaluation with Thanos Ruler.

<!--more-->

## Why Recording Rules Matter at Scale

A Prometheus instance scraping 1 million series with 15-second intervals stores roughly 800 MB of uncompressed data per hour. Dashboard queries that span 30-day ranges with multi-level aggregations can take 10–30 seconds against raw data. Recording rules pre-materialize these results:

- **Reduced query latency**: A 30-day trend query on a recording rule completes in milliseconds instead of seconds
- **Reduced memory pressure**: Complex range queries load only the recording rule series instead of all source series
- **Consistent semantics**: Everyone using a dashboard reads from the same materialized series rather than slightly different query formulations
- **Federation-friendly**: Recording rules produce lower-cardinality series suitable for federation to central Prometheus instances

## Recording Rule Anatomy and Naming Convention

### File Structure

Recording rules are defined in YAML files loaded by Prometheus via `rule_files`:

```yaml
# prometheus.yml
rule_files:
  - /etc/prometheus/rules/*.yml
  - /etc/prometheus/rules/recording/*.yml
```

### Rule Group Structure

```yaml
groups:
  - name: node_exporter_recording_rules
    interval: 1m           # Evaluation interval (default: global.evaluation_interval)
    limit: 0               # Max series this group can produce (0 = unlimited)
    rules:
      - record: instance:node_cpu_utilisation:rate5m
        expr: |
          1 - avg without (cpu, mode) (
            rate(node_cpu_seconds_total{mode="idle"}[5m])
          )
        labels:
          source: node_exporter

      - record: instance:node_memory_utilisation:ratio
        expr: |
          1 - (
            node_memory_MemAvailable_bytes /
            node_memory_MemTotal_bytes
          )
```

### Naming Convention: `:rule:aggregation`

The Prometheus community convention for recording rule names uses colon-delimited components:

```
<aggregation_level>:<metric_name>:<operations>
```

Examples:

```
# Level: job (aggregated by job)
# Metric: http_requests_total
# Operation: rate5m
job:http_requests_total:rate5m

# Level: instance
# Metric: node_cpu_utilisation
# Operation: rate5m
instance:node_cpu_utilisation:rate5m

# Level: cluster (aggregated across entire cluster)
# Metric: http_inbound_requests
# Operation: rate1h_sum
cluster:http_inbound_requests:rate1h_sum

# Federation level (aggregated at the remote/federation level)
# Metric: up
# Operation: sum
:up:sum
```

The colons serve as visual separators and also enable partial matching in dashboards:

```promql
# Match all recording rules for http_requests_total
{__name__=~".*:http_requests_total:.*"}
```

## Pre-Computing Expensive Queries

### HTTP Request Rate by Service

Without recording rules, every dashboard panel evaluates:

```promql
sum by (namespace, service, status_code_class) (
  rate(http_requests_total[5m])
)
```

With a recording rule evaluated every minute, dashboards query the pre-materialized result:

```yaml
groups:
  - name: http_recording_rules
    interval: 1m
    rules:
      - record: namespace_service_statusclass:http_requests_total:rate5m
        expr: |
          sum by (namespace, service, status_code_class) (
            label_replace(
              rate(http_requests_total[5m]),
              "status_code_class",
              "${1}xx",
              "status_code",
              "([0-9]).*"
            )
          )

      - record: namespace_service:http_requests_total:rate5m_sum
        expr: |
          sum by (namespace, service) (
            rate(http_requests_total[5m])
          )

      - record: namespace_service:http_request_duration_seconds:p99_5m
        expr: |
          histogram_quantile(
            0.99,
            sum by (namespace, service, le) (
              rate(http_request_duration_seconds_bucket[5m])
            )
          )

      - record: namespace_service:http_request_duration_seconds:p95_5m
        expr: |
          histogram_quantile(
            0.95,
            sum by (namespace, service, le) (
              rate(http_request_duration_seconds_bucket[5m])
            )
          )
```

### Kubernetes Resource Recording Rules

```yaml
groups:
  - name: kubernetes_resource_recording_rules
    interval: 1m
    rules:
      # CPU utilization per container vs request
      - record: namespace_container:container_cpu_usage_seconds_total:rate5m
        expr: |
          sum by (namespace, container, pod) (
            rate(container_cpu_usage_seconds_total{container!="POD", container!=""}[5m])
          )

      - record: namespace_container:cpu_request_utilization:ratio
        expr: |
          namespace_container:container_cpu_usage_seconds_total:rate5m
          /
          on(namespace, pod, container) group_left()
          kube_pod_container_resource_requests{resource="cpu"}

      # Memory utilization per container vs request
      - record: namespace_container:container_memory_working_set_bytes:avg
        expr: |
          avg by (namespace, container, pod) (
            container_memory_working_set_bytes{container!="POD", container!=""}
          )

      - record: namespace_container:memory_request_utilization:ratio
        expr: |
          namespace_container:container_memory_working_set_bytes:avg
          /
          on(namespace, pod, container) group_left()
          kube_pod_container_resource_requests{resource="memory"}

      # Node pressure indicators
      - record: node:node_cpu_saturation:rate5m
        expr: |
          sum by (node) (
            rate(node_cpu_seconds_total{mode="idle"}[5m])
          )

      # Namespace cost aggregation (for FinOps dashboards)
      - record: namespace:pod_cpu_requests:sum
        expr: |
          sum by (namespace) (
            kube_pod_container_resource_requests{resource="cpu", container!=""}
          )

      - record: namespace:pod_memory_requests:sum
        expr: |
          sum by (namespace) (
            kube_pod_container_resource_requests{resource="memory", container!=""}
          )
```

### Expensive Histogram Quantile Rules

Histogram quantile computation is O(n) in the number of `le` buckets. Pre-compute at rule evaluation time:

```yaml
groups:
  - name: slo_recording_rules
    interval: 30s    # More frequent for SLO dashboards
    rules:
      # Request latency quantiles
      - record: job_route:http_request_duration_seconds:p50_5m
        expr: |
          histogram_quantile(0.50,
            sum by (job, route, le) (
              rate(http_request_duration_seconds_bucket[5m])
            )
          )

      - record: job_route:http_request_duration_seconds:p99_5m
        expr: |
          histogram_quantile(0.99,
            sum by (job, route, le) (
              rate(http_request_duration_seconds_bucket[5m])
            )
          )

      # Error budget consumption rate (for SLO alerting)
      - record: job:http_error_rate:rate5m
        expr: |
          sum by (job) (
            rate(http_requests_total{status_code=~"5.."}[5m])
          )
          /
          sum by (job) (
            rate(http_requests_total[5m])
          )

      # 1-hour error budget window (for SLO burn rate alerts)
      - record: job:http_error_rate:rate1h
        expr: |
          sum by (job) (
            rate(http_requests_total{status_code=~"5.."}[1h])
          )
          /
          sum by (job) (
            rate(http_requests_total[1h])
          )
```

## Federation Recording Rules

When federating metrics to a central Prometheus, recording rules reduce cardinality before the data crosses the federation boundary:

### Source Prometheus (per-cluster)

```yaml
# On the per-cluster Prometheus
groups:
  - name: federation_recording_rules
    interval: 1m
    rules:
      # Aggregate per-pod CPU to namespace level for federation
      - record: cluster_namespace:cpu_usage:rate5m_sum
        expr: |
          sum by (cluster, namespace) (
            rate(container_cpu_usage_seconds_total{container!="POD"}[5m])
          )

      - record: cluster_namespace:memory_usage:avg
        expr: |
          sum by (cluster, namespace) (
            container_memory_working_set_bytes{container!="POD"}
          )

      - record: cluster_namespace:pod_count:sum
        expr: |
          count by (cluster, namespace) (
            kube_pod_info
          )
```

### Federation Scrape Configuration

```yaml
# On the central Prometheus
scrape_configs:
  - job_name: federate
    scrape_interval: 1m
    honor_labels: true
    metrics_path: /federate
    params:
      match[]:
        - '{__name__=~"cluster_namespace:.*"}'
        - '{__name__=~"cluster:.*"}'
        - 'up{job="kube-apiserver"}'
    static_configs:
      - targets:
          - cluster-a-prometheus:9090
          - cluster-b-prometheus:9090
```

## Rule Evaluation Intervals

### Choosing the Right Interval

```yaml
groups:
  # Fast-changing metrics for real-time dashboards
  - name: realtime_metrics
    interval: 15s
    rules:
      - record: instance:up:gauge
        expr: up

  # Standard operational metrics
  - name: operational_metrics
    interval: 1m
    rules:
      - record: job:http_requests_total:rate5m
        expr: sum by (job) (rate(http_requests_total[5m]))

  # Trend analysis — updated every 5 minutes is sufficient
  - name: trend_metrics
    interval: 5m
    rules:
      - record: job:http_requests_total:rate1h_avg
        expr: avg_over_time(job:http_requests_total:rate5m[1h])

  # Daily aggregations for cost/capacity planning
  - name: daily_aggregations
    interval: 1h
    rules:
      - record: namespace:pod_cpu_hours:sum_1d
        expr: |
          sum by (namespace) (
            increase(
              container_cpu_usage_seconds_total{container!="POD"}[1d]
            )
          ) / 3600
```

**Rule of thumb**: The recording rule interval should not be shorter than the range selector in the query (`rate()[5m]` → minimum 1m interval). Setting an interval shorter than the scrape interval produces duplicate data points.

## Testing Rules with promtool

### Writing Rule Tests

```yaml
# tests/recording_rules_test.yml
rule_files:
  - rules/http_recording_rules.yml
  - rules/kubernetes_recording_rules.yml

evaluation_interval: 1m

tests:
  - interval: 1m
    input_series:
      # Simulate http_requests_total from two services
      - series: 'http_requests_total{job="frontend", service="web", namespace="production", status_code="200"}'
        values: "0 100 200 300 400"
      - series: 'http_requests_total{job="frontend", service="web", namespace="production", status_code="500"}'
        values: "0 1 2 3 4"
      - series: 'http_requests_total{job="backend", service="api", namespace="production", status_code="200"}'
        values: "0 50 100 150 200"

    promql_expr_test:
      - expr: job:http_requests_total:rate5m
        eval_time: 4m
        exp_samples:
          - labels: '{job="frontend"}'
            value: 1.683e+00  # (404-0)/(4*60) ≈ 1.683
          - labels: '{job="backend"}'
            value: 8.333e-01  # (200-0)/(4*60) ≈ 0.833

      - expr: job:http_error_rate:rate5m
        eval_time: 4m
        exp_samples:
          - labels: '{job="frontend"}'
            value: 9.64e-03   # error_rate ≈ 1/104 ≈ 0.0096

    alert_rule_test:
      - alertname: HighErrorRate
        eval_time: 5m
        exp_alerts:
          - exp_labels:
              severity: warning
              job: frontend
            exp_annotations:
              summary: "High error rate for frontend"
```

Run tests:

```bash
# Test all rule files in a directory
promtool test rules tests/*.yml

# Validate rule syntax without running tests
promtool check rules rules/*.yml

# Lint rule files
promtool lint rules rules/*.yml
```

### Testing Recording Rules with Real Prometheus

```bash
# Query the recording rule series to verify it has data
curl -sG http://prometheus:9090/api/v1/query \
  --data-urlencode 'query=job:http_requests_total:rate5m' | \
  jq '.data.result | length'

# Check rule evaluation status
curl -sG http://prometheus:9090/api/v1/rules | \
  jq '.data.groups[].rules[] |
      select(.type == "recording") |
      {name: .name, health: .health, lastEvaluation: .lastEvaluation}'

# Check for rule evaluation errors
curl -sG http://prometheus:9090/api/v1/rules | \
  jq '.data.groups[].rules[] |
      select(.health != "ok") |
      {name: .name, health: .health, lastError: .lastError}'
```

## Cardinality Management via Relabeling

High-cardinality labels in recording rules multiply the number of resulting series. Use `without` and `by` clauses carefully:

### Problematic High-Cardinality Rule

```yaml
# AVOID: preserves high-cardinality labels (pod, instance)
- record: namespace_pod_container:cpu_usage:rate5m
  expr: |
    rate(container_cpu_usage_seconds_total[5m])  # Preserves ALL labels
```

### Cardinality-Controlled Rules

```yaml
# Better: aggregate to meaningful dimensions
- record: namespace_service:cpu_usage:rate5m_sum
  expr: |
    sum by (namespace, service, container) (
      rate(container_cpu_usage_seconds_total{container!="POD"}[5m])
    )

# Drop high-cardinality labels before recording
- record: job:http_requests_total:rate5m
  expr: |
    sum without (pod, instance, node, kubernetes_pod_name) (
      rate(http_requests_total[5m])
    )
```

### Measuring Recording Rule Cardinality

```promql
# Count time series produced by recording rules
count by (__name__) (
  {__name__=~"namespace.*:.*|job.*:.*|instance.*:.*|cluster.*:.*"}
)

# Find recording rules with high cardinality
topk(20,
  count by (__name__) (
    {__name__=~".*:.*:.*"}
  )
)
```

## Thanos Ruler for HA Rule Evaluation

In a multi-Prometheus setup, recording rules evaluated on multiple Prometheus instances produce duplicate series. Thanos Ruler centralizes rule evaluation while reading from Thanos Query (which deduplicates data from multiple Prometheus instances).

### Thanos Ruler Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: thanos-ruler
  namespace: monitoring
spec:
  replicas: 2  # HA — two rulers evaluate the same rules
  template:
    spec:
      containers:
        - name: thanos-ruler
          image: quay.io/thanos/thanos:v0.35.1
          args:
            - rule
            - --log.level=info
            - --data-dir=/data
            - --eval-interval=1m
            - --rule-file=/etc/thanos/rules/*.yml
            - --query=http://thanos-query:9090
            - --query=http://thanos-query-secondary:9090
            - --objstore.config-file=/etc/thanos/objstore.yml
            - --label=ruler_cluster="prod"
            - --label=replica="$(POD_NAME)"
            - --alert.label-drop=replica
            - --alertmanager.url=http://alertmanager:9093
            - "--web.route-prefix=/"
            - "--web.external-prefix=thanos-ruler"
          env:
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
          ports:
            - name: http
              containerPort: 10902
            - name: grpc
              containerPort: 10901
          volumeMounts:
            - name: rules
              mountPath: /etc/thanos/rules
            - name: objstore
              mountPath: /etc/thanos/objstore.yml
              subPath: objstore.yml
            - name: data
              mountPath: /data
      volumes:
        - name: rules
          configMap:
            name: thanos-ruler-rules
        - name: objstore
          secret:
            secretName: thanos-objstore-config
        - name: data
          emptyDir: {}
```

### Thanos Ruler Rule File for Cross-Cluster Aggregation

```yaml
# /etc/thanos/rules/cross-cluster-aggregation.yml
groups:
  - name: cross_cluster_aggregation
    interval: 5m
    partial_response_strategy: warn  # Thanos-specific: warn instead of fail on partial responses
    rules:
      # Aggregate CPU across all clusters
      - record: global:cluster_cpu_usage:rate5m_sum
        expr: |
          sum by (cluster) (
            cluster_namespace:cpu_usage:rate5m_sum
          )

      # Global error rate across all services
      - record: global:http_error_rate:rate5m
        expr: |
          sum(job:http_error_rate:rate5m)
          /
          sum(job:http_requests_total:rate5m)

      # Cross-cluster availability
      - record: global:service_availability:avg
        expr: |
          avg by (job, service) (
            job:up:avg
          )
```

### Configuring Thanos Query to Read Ruler Results

```yaml
# thanos-query deployment arguments
args:
  - query
  - --store=thanos-store-gateway:10901
  - --store=thanos-ruler:10901  # Include ruler as a data source
  - --query.replica-label=replica
  - --query.auto-downsampling
```

## Migrating Dashboards to Recording Rules

### Audit Existing Dashboard Queries

Export all Grafana dashboards and extract PromQL expressions:

```bash
#!/bin/bash
# extract-dashboard-queries.sh
GRAFANA_URL=${GRAFANA_URL:-http://grafana:3000}
GRAFANA_TOKEN=${GRAFANA_TOKEN}

# Get all dashboard UIDs
DASHBOARDS=$(curl -sH "Authorization: Bearer ${GRAFANA_TOKEN}" \
  "${GRAFANA_URL}/api/search?type=dash-db" | \
  jq -r '.[].uid')

for uid in ${DASHBOARDS}; do
  curl -sH "Authorization: Bearer ${GRAFANA_TOKEN}" \
    "${GRAFANA_URL}/api/dashboards/uid/${uid}" | \
    jq -r '
      .dashboard.title as $title |
      .dashboard.panels[]? |
      .title as $panel |
      .targets[]?.expr? |
      select(. != null and . != "") |
      "\($title) | \($panel) | \(.)"
    '
done | sort -u > dashboard-queries.txt

echo "Extracted $(wc -l < dashboard-queries.txt) unique expressions"
```

### Identifying Candidates for Recording Rules

```python
#!/usr/bin/env python3
# identify-recording-candidates.py
# Finds queries that appear 3+ times across dashboards (good recording rule candidates)

from collections import Counter
import re

with open('dashboard-queries.txt') as f:
    lines = f.readlines()

# Extract just the PromQL expressions
expressions = [line.split(' | ')[-1].strip() for line in lines]

# Count frequency
freq = Counter(expressions)

print("High-frequency queries (candidates for recording rules):")
for expr, count in freq.most_common(20):
    if count >= 3:
        print(f"\n  Count: {count}")
        print(f"  Query: {expr[:100]}...")
```

### Converting Dashboard Queries to Recording Rules

```bash
# Before: Grafana panel uses raw query
# sum by (namespace, job) (rate(http_requests_total{status_code!~"5.."}[5m]))
# / sum by (namespace, job) (rate(http_requests_total[5m]))

# After: Create recording rule
cat >> /etc/prometheus/rules/dashboard_recording.yml <<'EOF'
groups:
  - name: dashboard_precomputed
    interval: 1m
    rules:
      - record: namespace_job:http_success_rate:rate5m
        expr: |
          sum by (namespace, job) (
            rate(http_requests_total{status_code!~"5.."}[5m])
          )
          /
          sum by (namespace, job) (
            rate(http_requests_total[5m])
          )
EOF

# Update Grafana panel query to use the recording rule
# FROM: sum by (namespace, job) (rate(http_requests_total{status_code!~"5.."}[5m])) / sum by (namespace, job) (rate(http_requests_total[5m]))
# TO:   namespace_job:http_success_rate:rate5m
```

### Dashboard Template Variable Compatibility

Recording rules must preserve the labels used as Grafana template variables:

```yaml
# If dashboards filter by $namespace and $job template variables,
# the recording rule MUST include namespace and job in the 'by' clause
- record: namespace_job:http_requests_total:rate5m
  expr: |
    sum by (namespace, job, status_code_class) (  # namespace and job preserved
      label_replace(
        rate(http_requests_total[5m]),
        "status_code_class", "${1}xx", "status_code", "([0-9]).*"
      )
    )
```

## Recording Rule Operational Checklist

```bash
# 1. Validate all rule files
find /etc/prometheus/rules -name "*.yml" -exec promtool check rules {} \;

# 2. Check for rule evaluation lag
curl -s http://prometheus:9090/api/v1/rules | \
  jq '
    [.data.groups[].rules[] |
     select(.type == "recording") |
     {
       name: .name,
       lastEvalDuration: .evaluationTime,
       lastEvalTime: .lastEvaluation
     }] |
    sort_by(.lastEvalDuration) |
    reverse |
    .[0:10]
  '

# 3. Verify recording rule staleness
# (if rule evaluation time > interval, rules are behind)
curl -s http://prometheus:9090/api/v1/query \
  --data-urlencode 'query=prometheus_rule_evaluation_duration_seconds{quantile="0.99"}' | \
  jq '.data.result[].value[1]'

# 4. Monitor rule group evaluation failures
curl -s http://prometheus:9090/api/v1/query \
  --data-urlencode 'query=prometheus_rule_group_last_evaluation_samples{rule_group=~".*"}' | \
  jq '.data.result[] | select(.value[1] == "0")'
```

## SLO Recording Rules with Sloth

Sloth generates Prometheus SLO recording rules from a higher-level SLO definition, eliminating manual rule authoring for error-budget tracking:

```yaml
# sloth-slo.yaml
version: "prometheus/v1"
service: checkout-service
labels:
  team: commerce
  env: production
slos:
  - name: requests-availability
    objective: 99.9
    description: "Checkout service availability SLO"
    sli:
      events:
        error_query: |
          sum(rate(http_requests_total{job="checkout-service",code=~"5.."}[{{.window}}]))
        total_query: |
          sum(rate(http_requests_total{job="checkout-service"}[{{.window}}]))
    alerting:
      name: CheckoutServiceHighErrorRate
      labels:
        category: availability
      annotations:
        runbook: https://runbooks.example.com/checkout-service-errors
      page_alert:
        labels:
          severity: critical
      ticket_alert:
        labels:
          severity: warning
```

Generate recording rules from the SLO definition:

```bash
# Install Sloth
curl -LO https://github.com/slok/sloth/releases/latest/download/sloth-linux-amd64
chmod +x sloth-linux-amd64
sudo mv sloth-linux-amd64 /usr/local/bin/sloth

# Generate Prometheus recording and alerting rules
sloth generate -i sloth-slo.yaml -o slo-rules.yaml

# The generated file contains:
# - Short-window (5m, 30m) recording rules for burn rate calculation
# - Long-window (1h, 6h) recording rules for slow burn detection
# - Error budget consumption recording rules
# - Multi-window, multi-burn-rate alert rules
```

The generated recording rules follow the Sloth naming convention:

```yaml
# Generated excerpt
- record: "slo:sli_error:ratio_rate5m"
  expr: |
    sum(rate(http_requests_total{job="checkout-service",code=~"5.."}[5m]))
    /
    sum(rate(http_requests_total{job="checkout-service"}[5m]))

- record: "slo:error_budget:ratio"
  expr: |
    1 - slo:objective:ratio

- record: "slo:current_burn_rate:ratio"
  expr: |
    slo:sli_error:ratio_rate1h / slo:error_budget:ratio
```

## Recording Rules for Capacity Planning

Long-range capacity recording rules support monthly or quarterly infrastructure reviews:

```yaml
groups:
  - name: capacity_planning_rules
    interval: 1h
    rules:
      # Weekly average CPU request vs capacity per node
      - record: node:cpu_request_utilization:avg_over_time_7d
        expr: |
          avg_over_time(
            (
              sum by (node) (
                kube_pod_container_resource_requests{resource="cpu"}
              )
              /
              sum by (node) (
                kube_node_status_allocatable{resource="cpu"}
              )
            )[7d:1h]
          )

      # 90th percentile memory utilization over the past 30 days
      - record: node:memory_utilization:p90_30d
        expr: |
          quantile_over_time(
            0.9,
            (
              sum by (node) (
                node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes
              )
              /
              sum by (node) (
                node_memory_MemTotal_bytes
              )
            )[30d:1h]
          )

      # Pod count growth rate (new pods per day, 7-day average)
      - record: cluster:pod_count:avg_rate7d
        expr: |
          deriv(
            sum(kube_pod_info)[7d:1h]
          )

      # Storage capacity utilization trend
      - record: pvc:storage_utilization:avg_7d
        expr: |
          avg_over_time(
            (
              kubelet_volume_stats_used_bytes
              /
              kubelet_volume_stats_capacity_bytes
            )[7d:1h]
          )
```

## Alerting Rules That Reference Recording Rules

Recording rules are most valuable when alerting rules consume them, reducing alert evaluation cost:

```yaml
groups:
  - name: slo_alerts
    rules:
      # Reference recording rule instead of raw metric for fast evaluation
      - alert: CheckoutHighErrorRate
        expr: |
          job:http_error_rate:rate5m{job="checkout-service"} > 0.01
        for: 2m
        labels:
          severity: warning
          team: commerce
        annotations:
          summary: "Checkout service error rate above 1%"
          description: |
            Current error rate: {{ printf "%.2f" (mul $value 100) }}%
            Threshold: 1%

      - alert: CheckoutLatencyDegraded
        expr: |
          job_route:http_request_duration_seconds:p99_5m{job="checkout-service"} > 0.5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Checkout P99 latency above 500ms"

      # Multi-window burn rate alert using recording rules
      - alert: CheckoutErrorBudgetBurnHigh
        expr: |
          (
            job:http_error_rate:rate1h{job="checkout-service"} > (14.4 * 0.001)
            and
            job:http_error_rate:rate5m{job="checkout-service"} > (14.4 * 0.001)
          )
          or
          (
            job:http_error_rate:rate6h{job="checkout-service"} > (6 * 0.001)
            and
            job:http_error_rate:rate30m{job="checkout-service"} > (6 * 0.001)
          )
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "High error budget burn rate for checkout-service"
```

## Summary

Recording rules are the primary performance lever for large Prometheus deployments. The naming convention (`level:metric:operation`) provides a self-documenting namespace that makes recording rules discoverable and prevents collisions across teams. Pre-computing histogram quantiles, error rates, and resource utilization at the namespace/service level reduces dashboard query time from seconds to milliseconds while dramatically lowering Prometheus memory pressure. SLO-focused tools like Sloth generate the multi-window burn rate recording rules needed for reliable error budget alerting without manual PromQL authoring. The `promtool test rules` workflow provides deterministic CI testing for rule correctness, capacity planning rules turn historical metrics into infrastructure sizing data, and Thanos Ruler extends recording rule semantics to multi-cluster environments with deduplication and long-term storage.
