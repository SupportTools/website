---
title: "Prometheus Recording Rules and Query Optimization: Production Performance Patterns"
date: 2027-06-05T00:00:00-05:00
draft: false
tags: ["Prometheus", "PromQL", "Recording Rules", "Performance", "Monitoring", "Observability"]
categories: ["Monitoring", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep-dive production guide to Prometheus recording rules, PromQL optimization, cardinality management, and query performance patterns for large-scale enterprise monitoring deployments."
more_link: "yes"
url: "/prometheus-recording-rules-optimization-guide/"
---

Prometheus is a powerful metrics platform, but a poorly optimized deployment becomes a performance bottleneck that defeats its purpose. As the number of scraped targets grows and dashboards proliferate, query performance degrades, memory consumption increases, and the Prometheus process becomes a source of operational anxiety rather than operational confidence. Recording rules and query optimization are the primary tools for keeping Prometheus performant at scale.

This guide covers the full spectrum of Prometheus query optimization: recording rule design, naming conventions, PromQL anti-patterns, cardinality management, and the techniques used to keep large-scale production Prometheus deployments fast and efficient.

<!--more-->

## Understanding Prometheus Query Performance

Before optimizing, it is important to understand what makes a PromQL query expensive.

### Query Execution Model

When Prometheus evaluates a PromQL expression, it:

1. Resolves all time series matching the selectors
2. Loads the relevant data points from memory (or disk via mmap)
3. Applies aggregations, functions, and arithmetic
4. Returns the result set

The cost of a query scales with:

- **Number of matching time series** - the primary cost driver
- **Time range** - wider ranges require loading more data points
- **Aggregation complexity** - multi-level aggregations compound cost
- **Query frequency** - expensive queries evaluated by dashboards every 30 seconds are expensive 30 times per minute

### Identifying Expensive Queries

Prometheus exposes query timing data through its HTTP API and internal metrics.

```bash
# Time a query execution directly
curl -s "http://prometheus:9090/api/v1/query?query=sum(rate(http_requests_total[5m]))&timeout=30s" | \
  jq '{status: .status, datapoints: (.data.result | length), duration: .data.stats}'

# The response includes execution statistics
# {
#   "status": "success",
#   "data": {
#     "stats": {
#       "timings": {
#         "evalTotalTime": 2.450,
#         "resultSortTime": 0.002,
#         "queryPreparationTime": 0.045,
#         "innerEvalTime": 2.400,
#         "execQueueTime": 0.003,
#         "execTotalTime": 2.453
#       },
#       "samples": {
#         "totalQueryableSamples": 4850000,
#         "peakSamples": 150000
#       }
#     }
#   }
# }
```

Key metrics from Prometheus itself:

```promql
# Total query execution time by query handler
rate(prometheus_engine_query_duration_seconds_sum[5m])
/ rate(prometheus_engine_query_duration_seconds_count[5m])

# Queries exceeding time limit
rate(prometheus_engine_query_duration_seconds_bucket{le="30"}[5m])

# Number of active queries
prometheus_engine_queries

# Time series count (primary cardinality metric)
prometheus_tsdb_head_series

# Chunks per series
prometheus_tsdb_head_chunks / prometheus_tsdb_head_series
```

## Recording Rules: Fundamentals

Recording rules pre-compute expensive PromQL expressions and store the results as new time series. A Grafana dashboard that queries `sum(rate(http_requests_total[5m])) by (service)` across 10,000 time series can be replaced with a query against a single pre-computed series - the difference is often two orders of magnitude in query time.

### Naming Convention

The Prometheus community standard naming convention for recording rules is:

```
level:metric:operation
```

- **level**: The aggregation scope (e.g., `job`, `instance`, `cluster`, `namespace`, `service`)
- **metric**: The base metric name being aggregated
- **operation**: The aggregation operation applied (e.g., `rate5m`, `sum`, `avg`, `p99`)

Examples:

```
job:http_requests_total:rate5m
namespace:container_cpu_usage_seconds_total:rate5m_sum
cluster:node_memory_MemAvailable_bytes:ratio
service:http_request_duration_seconds:p99_rate5m
```

### Basic Recording Rule Structure

```yaml
# prometheus-recording-rules.yaml
groups:
  - name: http_requests
    interval: 1m  # How often to evaluate these rules
    rules:
      # Sum of request rate per job
      - record: job:http_requests_total:rate5m
        expr: sum(rate(http_requests_total[5m])) by (job)

      # Per-job error rate
      - record: job:http_request_errors:rate5m
        expr: |
          sum(rate(http_requests_total{status=~"5.."}[5m])) by (job)

      # Error ratio derived from above recording rules
      # Using recording rules in other recording rules is efficient
      - record: job:http_error_ratio:rate5m
        expr: |
          job:http_request_errors:rate5m
          /
          job:http_requests_total:rate5m

  - name: kubernetes_resources
    interval: 1m
    rules:
      # CPU usage ratio per namespace
      - record: namespace:container_cpu_usage_seconds_total:sum_rate5m
        expr: |
          sum by (namespace) (
            rate(container_cpu_usage_seconds_total{container!=""}[5m])
          )

      # Memory usage per namespace
      - record: namespace:container_memory_working_set_bytes:sum
        expr: |
          sum by (namespace) (
            container_memory_working_set_bytes{container!=""}
          )
```

### Multi-Level Recording Rules

Building recording rules from other recording rules avoids redundant computation. Each level uses the pre-computed data from the level below:

```yaml
groups:
  - name: instance_level
    interval: 30s
    rules:
      # Level 1: per-instance rate
      - record: instance:node_cpu_seconds_total:rate5m
        expr: |
          rate(node_cpu_seconds_total{mode!="idle"}[5m])

  - name: job_level
    interval: 1m
    rules:
      # Level 2: aggregate instances to job
      - record: job:node_cpu_seconds_total:rate5m_sum
        expr: |
          sum by (job, mode) (instance:node_cpu_seconds_total:rate5m)

  - name: cluster_level
    interval: 5m
    rules:
      # Level 3: aggregate jobs to cluster
      - record: cluster:node_cpu_seconds_total:rate5m_avg
        expr: |
          avg by (cluster) (job:node_cpu_seconds_total:rate5m_sum)
```

Each level's evaluation interval can be adjusted independently. Instance-level rules need frequent updates (30s), while cluster-level aggregations can update less frequently (5m).

## When to Create Recording Rules

Not every PromQL expression needs a recording rule. Creating unnecessary recording rules increases TSDB storage and memory usage. Apply these criteria:

### Create Recording Rules When:

**1. The expression is evaluated by multiple dashboards or alerts**

```yaml
# This expensive expression appears in 12 different Grafana panels
# Create a recording rule so it is computed once, not 12 times
- record: service:http_request_duration_p99:rate5m
  expr: |
    histogram_quantile(0.99,
      sum by (service, le) (
        rate(http_request_duration_seconds_bucket[5m])
      )
    )
```

**2. The expression uses long range windows**

```yaml
# Long range windows are expensive - pre-compute them
- record: job:http_requests_total:rate1h
  expr: sum by (job) (rate(http_requests_total[1h]))

- record: job:http_requests_total:rate6h
  expr: sum by (job) (rate(http_requests_total[6h]))
```

**3. The expression is used in an alerting rule**

All alert expressions should be backed by recording rules in high-volume environments:

```yaml
groups:
  - name: recording_for_alerts
    rules:
      # Pre-compute the alert expression
      - record: job:http_error_ratio:rate5m
        expr: |
          sum(rate(http_requests_total{status=~"5.."}[5m])) by (job)
          /
          sum(rate(http_requests_total[5m])) by (job)

  - name: alerts
    rules:
      # Alert uses pre-computed series - fast evaluation
      - alert: HighErrorRate
        expr: job:http_error_ratio:rate5m > 0.05
        for: 5m
```

**4. Dashboard queries take more than 200ms**

Any Grafana panel that regularly takes more than 200ms to load should be backed by recording rules.

### Do NOT Create Recording Rules For:

- One-off ad-hoc queries
- Debugging queries used temporarily
- Metrics queried only during incidents
- Low-cardinality expressions that are already fast

## PromQL Anti-Patterns and How to Avoid Them

### Anti-Pattern 1: Unbounded Label Selectors on High-Cardinality Metrics

```promql
# BAD: matches all time series for this metric - potentially millions
rate(container_cpu_usage_seconds_total[5m])

# GOOD: filter to remove empty containers and pause containers
rate(container_cpu_usage_seconds_total{container!="", container!="POD"}[5m])
```

Always filter high-cardinality metrics to the minimum required set.

### Anti-Pattern 2: Using `.*` Regex on Cardinality-Generating Labels

```promql
# BAD: regex that matches everything is pointless and scans all series
sum by (pod) (rate(container_cpu_usage_seconds_total{pod=~".*"}[5m]))

# GOOD: no filter needed if you want all pods
sum by (pod) (rate(container_cpu_usage_seconds_total[5m]))

# GOOD: filter with a meaningful prefix
sum by (pod) (rate(container_cpu_usage_seconds_total{pod=~"frontend-.*"}[5m]))
```

### Anti-Pattern 3: `rate()` on a Counter That Gets Reset Frequently

```promql
# BAD: if pod restarts frequently, rate() produces incorrect results
# because it includes the counter reset as a negative spike, then compensates
rate(process_cpu_seconds_total[5m])

# GOOD: when pods restart frequently, use irate() for instantaneous rate
# or increase() if you need total over the window
irate(process_cpu_seconds_total[5m])
```

### Anti-Pattern 4: `irate()` for Long-Range Dashboards

```promql
# BAD: irate() uses only the last two data points, making it volatile
# for dashboard panels with time ranges longer than 1h
irate(http_requests_total[1h])

# GOOD: rate() with an appropriate window for the dashboard time range
rate(http_requests_total[5m])
```

The rule: use `rate()` for dashboards and SLO calculations. Use `irate()` only when you need instantaneous rate for near-real-time spike detection.

### Anti-Pattern 5: Large Group-By in Alerting Rules

```promql
# BAD: creates one alert per unique (pod, container, namespace, node, image, ...) combination
# potentially thousands of individual alerts
sum by (pod, container, namespace, node, image, uid) (
  container_cpu_usage_seconds_total
) > 0.8

# GOOD: aggregate to actionable level
sum by (namespace, pod) (
  rate(container_cpu_usage_seconds_total{container!=""}[5m])
) > 0.8
```

### Anti-Pattern 6: Using `count()` on High-Cardinality Sets

```promql
# BAD: counts all time series including labels - loads all time series metadata
count(container_cpu_usage_seconds_total)

# GOOD: use count_values or restrict with meaningful filters
count by (namespace) (
  count by (namespace, pod) (
    container_cpu_usage_seconds_total{container!=""}
  )
)
```

### Anti-Pattern 7: Nested Aggregations Without Recording Rules

```promql
# BAD: this triple-level aggregation is evaluated from raw metrics every time
sum by (cluster) (
  sum by (cluster, namespace) (
    sum by (cluster, namespace, pod) (
      rate(container_cpu_usage_seconds_total[5m])
    )
  )
)

# GOOD: use the multi-level recording rule pattern
# Rule 1: namespace:container_cpu:rate5m_sum
# Rule 2: cluster:container_cpu:rate5m_sum using rule 1
cluster:container_cpu_usage_seconds_total:rate5m_sum
```

## histogram_quantile Optimization

`histogram_quantile()` is one of the most useful but also most expensive PromQL functions. Each call must sum bucket rates across all time series, then interpolate percentiles.

### Standard Pattern vs Optimized Pattern

```promql
# Standard (expensive) - evaluated fresh each time
histogram_quantile(0.99,
  rate(http_request_duration_seconds_bucket[5m])
)

# Optimized - pre-aggregate buckets in a recording rule, then apply quantile
# Recording rule (evaluated once per interval):
# record: service:http_request_duration_seconds_bucket:rate5m
# expr: sum by (service, le) (rate(http_request_duration_seconds_bucket[5m]))

# Dashboard query (fast - small series count):
histogram_quantile(0.99, service:http_request_duration_seconds_bucket:rate5m)
```

The optimization works because `histogram_quantile()` is applied after the aggregation, so the expensive `rate()` over all raw bucket series is pre-computed.

### Multiple Quantile Recording Rules

```yaml
groups:
  - name: latency_recording_rules
    interval: 1m
    rules:
      # Pre-aggregate buckets
      - record: service:http_request_duration_seconds_bucket:rate5m
        expr: |
          sum by (service, le) (
            rate(http_request_duration_seconds_bucket[5m])
          )

      # Also need total count for ratio calculations
      - record: service:http_request_duration_seconds_count:rate5m
        expr: |
          sum by (service) (
            rate(http_request_duration_seconds_count[5m])
          )

      # Pre-compute common quantiles
      - record: service:http_request_duration_p50:rate5m
        expr: |
          histogram_quantile(0.50,
            service:http_request_duration_seconds_bucket:rate5m
          )

      - record: service:http_request_duration_p95:rate5m
        expr: |
          histogram_quantile(0.95,
            service:http_request_duration_seconds_bucket:rate5m
          )

      - record: service:http_request_duration_p99:rate5m
        expr: |
          histogram_quantile(0.99,
            service:http_request_duration_seconds_bucket:rate5m
          )
```

### Native Histograms (Prometheus 2.40+)

Prometheus 2.40 introduced native histograms, which eliminate the `le` label explosion and dramatically reduce cardinality:

```promql
# Native histogram - no bucket labels, far fewer series
histogram_quantile(0.99, rate(http_request_duration_seconds[5m]))
```

Native histograms are instrumented differently and require client library support. When migrating, keep classic histograms as fallback during the transition.

## rate() vs irate() vs increase(): Choosing the Right Function

### rate()

`rate()` calculates the per-second average rate over the range window, extrapolating for partial samples at the window edges.

```promql
# Average requests per second over the last 5 minutes
rate(http_requests_total[5m])
```

**Best for:**
- Dashboard panels showing sustained rates
- SLO calculations
- Alert expressions requiring stability

**Considerations:**
- Window should be at least 4x the scrape interval (1m scrape = 4m minimum window)
- Smooths over short spikes

### irate()

`irate()` calculates the instantaneous rate using only the last two data points in the range window. The range window is used only to find the data points.

```promql
# Instantaneous request rate (last 2 data points)
irate(http_requests_total[5m])
```

**Best for:**
- Real-time spike detection dashboards
- Short-range views (last 5-15 minutes)
- When you need to see brief spikes that `rate()` would smooth

**Considerations:**
- Volatile - single data point anomalies cause spikes in the graph
- Unreliable for dashboard time ranges > 1h because any gap in data causes zeros

### increase()

`increase()` calculates the total increase in a counter over the range window. It is equivalent to `rate() * range_seconds`.

```promql
# Total request count over the last hour
increase(http_requests_total[1h])

# Equivalent to:
rate(http_requests_total[1h]) * 3600
```

**Best for:**
- Showing totals over a specific window (requests per hour, errors per day)
- Non-rate views of counter data
- SLA reporting (total errors in 24h)

**Considerations:**
- Produces extrapolated values, not exact integer counts
- Use `resets()` function if counter resets are frequent

## Cardinality Management and Metric Relabeling

High cardinality - too many unique time series - is the primary cause of Prometheus performance degradation. Each time series consumes memory and CPU during evaluation.

### Identifying High-Cardinality Metrics

```bash
# Top 10 metrics by time series count via TSDB status API
curl -s "http://prometheus:9090/api/v1/status/tsdb?limit=10" | \
  jq '.data.headStats, .data.seriesCountByMetricName[:10]'

# Check cardinality of specific metric
curl -s 'http://prometheus:9090/api/v1/query?query=count+by+(__name__)+({__name__=~"http.*"})' | \
  jq '.data.result | sort_by(-.value[1] | tonumber) | .[:10]'
```

### Drop Unnecessary Labels with Metric Relabeling

```yaml
# prometheus.yaml scrape config
scrape_configs:
  - job_name: 'kubernetes-pods'
    kubernetes_sd_configs:
      - role: pod
    relabel_configs:
      # ... service discovery relabeling
    metric_relabel_configs:
      # Drop high-cardinality labels that are not useful
      - source_labels: [request_id]
        action: labeldrop

      # Drop trace ID labels (extremely high cardinality)
      - source_labels: [trace_id, span_id]
        action: labeldrop

      # Drop metrics you do not use (reduces storage significantly)
      - source_labels: [__name__]
        regex: 'go_gc_.*|process_virtual_memory.*|go_memstats_mspan.*'
        action: drop

      # Normalize path labels to reduce cardinality
      # /api/users/12345 -> /api/users/:id
      - source_labels: [path]
        regex: '/api/users/\d+'
        replacement: '/api/users/:id'
        target_label: path
        action: replace
```

### Drop Unused Metrics Globally

```yaml
# prometheus.yaml - global metric relabeling
scrape_configs:
  - job_name: 'node-exporter'
    metric_relabel_configs:
      # Keep only the metrics your dashboards and alerts actually use
      - source_labels: [__name__]
        regex: >-
          node_cpu_seconds_total|
          node_memory_MemAvailable_bytes|
          node_memory_MemTotal_bytes|
          node_filesystem_avail_bytes|
          node_filesystem_size_bytes|
          node_network_receive_bytes_total|
          node_network_transmit_bytes_total|
          node_load1|node_load5|node_load15|
          node_uname_info
        action: keep
```

This "allowlist" approach keeps only the metrics you actually use and can dramatically reduce cardinality (50-80% reduction is common when first auditing node-exporter metrics).

### Cardinality Limits

Prometheus supports per-scrape and global cardinality limits to prevent runaway cardinality from breaking the deployment:

```yaml
# prometheus.yaml
global:
  # Fail the scrape if more than 10000 new series would be created
  sample_limit: 10000

scrape_configs:
  - job_name: 'application'
    # Per-job limit (takes precedence over global)
    sample_limit: 5000
    target_limit: 200
    label_limit: 30
    label_name_length_limit: 64
    label_value_length_limit: 256
```

When a scrape exceeds `sample_limit`, Prometheus drops the entire scrape and records `up{job="..."} = 0`, preventing cardinality explosion from a misconfigured application.

## Remote Write Optimization

When Prometheus writes data to long-term storage (Thanos, Cortex, Mimir, VictoriaMetrics), remote_write performance is critical for keeping the WAL queue from growing unbounded.

### Tuning remote_write

```yaml
# prometheus.yaml
remote_write:
  - url: "https://thanos-receive.monitoring.svc.cluster.local:10908/api/v1/receive"
    remote_timeout: 30s
    tls_config:
      ca_file: /etc/prometheus/secrets/ca.crt
    queue_config:
      # Number of parallel remote_write shards per remote endpoint
      max_shards: 200
      # Minimum number of shards (avoid idle periods)
      min_shards: 20
      # Max samples per send
      max_samples_per_send: 500
      # Wait time to batch samples before sending
      batch_send_deadline: 5s
      # Number of samples to buffer before dropping (WAL catchup capacity)
      capacity: 100000
      # Max retries before dropping
      max_retries: 3
      # Initial backoff on failure
      min_backoff: 30ms
      max_backoff: 5s

    # Only write specific metrics to remote storage (save bandwidth/cost)
    write_relabel_configs:
      # Only forward recording rule results and selected raw metrics
      - source_labels: [__name__]
        regex: >-
          (job|namespace|cluster):[a-z_]+:[a-z0-9_]+|
          node_cpu_seconds_total|
          kube_pod_status_phase|
          up
        action: keep
```

### Monitoring remote_write Performance

```promql
# Remote write queue length (high = Prometheus is falling behind)
prometheus_remote_storage_samples_pending

# Remote write failure rate
rate(prometheus_remote_storage_samples_failed_total[5m])

# Remote write latency
rate(prometheus_remote_storage_send_batch_duration_seconds_sum[5m])
/ rate(prometheus_remote_storage_send_batch_duration_seconds_count[5m])

# WAL replay time (indicates disk I/O issues)
prometheus_tsdb_wal_replay_duration_seconds
```

Alert on queue backlog:

```yaml
- alert: PrometheusRemoteWriteBehind
  expr: |
    (prometheus_remote_storage_highest_timestamp_in_seconds
    - prometheus_remote_storage_queue_highest_sent_timestamp_seconds) > 120
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "Prometheus remote write is {{ $value }}s behind"
```

## Thanos Ruler for Long-Term Recording Rules

For recording rules that need to operate over long time ranges (days, weeks), Prometheus's local retention may be too short. Thanos Ruler evaluates recording rules against Thanos Query (which can access data from all stores) and writes results back to long-term storage.

### Thanos Ruler Deployment

```yaml
# thanos-ruler.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: thanos-ruler
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: thanos-ruler
  template:
    metadata:
      labels:
        app: thanos-ruler
    spec:
      containers:
        - name: thanos-ruler
          image: quay.io/thanos/thanos:v0.35.0
          args:
            - rule
            - --log.level=info
            - --data-dir=/data
            - --eval-interval=1m
            - --rule-file=/etc/thanos/rules/*.yaml
            # Query endpoint for evaluating expressions
            - --query=dnssrv+_http._tcp.thanos-query.monitoring.svc.cluster.local
            # Write results to object storage
            - --objstore.config-file=/etc/thanos/objstore.yaml
            # Label all recording rule results with source
            - --label=ruler_cluster="production"
            - --alert.label-drop=replica
          volumeMounts:
            - name: rules
              mountPath: /etc/thanos/rules
            - name: objstore-config
              mountPath: /etc/thanos/objstore.yaml
              subPath: objstore.yaml
```

### Long-Term Recording Rules

```yaml
# long-term-recording-rules.yaml
groups:
  - name: slo_calculations
    interval: 5m
    rules:
      # 30-day error budget consumption (requires 30d of data)
      - record: service:error_budget_consumed:30d
        expr: |
          (
            1 - (
              sum_over_time(service:http_success_ratio:rate5m[30d:5m])
              / count_over_time(service:http_success_ratio:rate5m[30d:5m])
            )
          ) / (1 - 0.999)

      # 7-day availability (for SLA reporting)
      - record: service:http_availability:7d
        expr: |
          avg_over_time(service:http_success_ratio:rate5m[7d:5m])

      # Daily request totals (for billing/reporting)
      - record: service:http_requests_total:daily
        expr: |
          increase(http_requests_total[1d])
```

## SLO Recording Rules

SLO-based alerting requires specific recording rules that capture error rate and request volume at multiple time windows.

### Complete SLO Recording Rule Set

```yaml
groups:
  - name: slo_base_rules
    interval: 30s
    rules:
      # Success rate per service (base metric)
      - record: service:http_requests_total:rate5m
        expr: |
          sum by (service) (rate(http_requests_total[5m]))

      - record: service:http_requests_successful:rate5m
        expr: |
          sum by (service) (rate(http_requests_total{status!~"5.."}[5m]))

      - record: service:http_success_ratio:rate5m
        expr: |
          service:http_requests_successful:rate5m
          /
          service:http_requests_total:rate5m

  - name: slo_burn_rate_rules
    interval: 1m
    rules:
      # Error ratio at different windows for multi-window burn rate alerting
      - record: service:http_error_ratio:rate1h
        expr: |
          1 - (
            sum by (service) (rate(http_requests_total{status!~"5.."}[1h]))
            / sum by (service) (rate(http_requests_total[1h]))
          )

      - record: service:http_error_ratio:rate6h
        expr: |
          1 - (
            sum by (service) (rate(http_requests_total{status!~"5.."}[6h]))
            / sum by (service) (rate(http_requests_total[6h]))
          )

      - record: service:http_error_ratio:rate1d
        expr: |
          1 - (
            sum by (service) (rate(http_requests_total{status!~"5.."}[1d]))
            / sum by (service) (rate(http_requests_total[1d]))
          )

  - name: slo_burn_rate_alerts
    rules:
      # Fast burn: 14.4x error budget burn rate (page immediately)
      # This fires if 1h error ratio > 14.4 * error_budget
      - alert: SLOErrorBudgetBurnRateCritical
        expr: |
          service:http_error_ratio:rate1h > (14.4 * (1 - 0.999))
          and
          service:http_error_ratio:rate6h > (6 * (1 - 0.999))
        for: 2m
        labels:
          severity: critical
          alert_type: slo_burn_rate
        annotations:
          summary: "Service {{ $labels.service }} consuming error budget critically fast"

      # Slow burn: 3x error budget burn rate (ticket, no immediate page)
      - alert: SLOErrorBudgetBurnRateWarning
        expr: |
          service:http_error_ratio:rate1d > (3 * (1 - 0.999))
          and
          service:http_error_ratio:rate1d > (1 * (1 - 0.999))
        for: 15m
        labels:
          severity: warning
          alert_type: slo_burn_rate
```

## Query Optimization Patterns for Kubernetes Metrics

Kubernetes metrics from kube-state-metrics and kubelet are high cardinality. These recording rules are essential for Kubernetes deployments.

```yaml
groups:
  - name: kubernetes_recording_rules
    interval: 1m
    rules:
      # Pod CPU usage by namespace (very common dashboard query)
      - record: namespace:container_cpu_usage_seconds_total:sum_rate5m
        expr: |
          sum by (namespace) (
            rate(container_cpu_usage_seconds_total{
              container!="",
              container!="POD",
              image!=""
            }[5m])
          )

      # Pod memory usage by namespace
      - record: namespace:container_memory_working_set_bytes:sum
        expr: |
          sum by (namespace) (
            container_memory_working_set_bytes{
              container!="",
              container!="POD",
              image!=""
            }
          )

      # Node CPU utilization ratio
      - record: node:node_cpu_utilization:ratio
        expr: |
          1 - avg by (node) (
            rate(node_cpu_seconds_total{mode="idle"}[5m])
          )

      # Node memory utilization ratio
      - record: node:node_memory_utilization:ratio
        expr: |
          1 - (
            node_memory_MemAvailable_bytes
            / node_memory_MemTotal_bytes
          )

      # Deployment availability ratio
      - record: deployment:kube_deployment_status_replicas:availability_ratio
        expr: |
          kube_deployment_status_replicas_available
          / kube_deployment_spec_replicas

      # PVC usage ratio (very expensive when calculated raw)
      - record: persistentvolumeclaim:kubelet_volume_stats_used_bytes:ratio
        expr: |
          kubelet_volume_stats_used_bytes
          / kubelet_volume_stats_capacity_bytes
```

## Rule Group Interval and Evaluation Order

Recording rule groups evaluate in order within a rule file but groups from different files may evaluate in parallel. The evaluation interval controls how frequently rules are evaluated.

### Choosing Evaluation Intervals

```yaml
groups:
  # Fast-changing metrics - evaluate frequently
  - name: request_rates
    interval: 15s
    rules:
      - record: job:http_requests_total:rate1m
        expr: sum by (job) (rate(http_requests_total[1m]))

  # Slower-changing aggregations - less frequent evaluation saves compute
  - name: cluster_aggregations
    interval: 5m
    rules:
      - record: cluster:container_cpu_usage:sum
        expr: sum (namespace:container_cpu_usage_seconds_total:sum_rate5m)

  # Long-term SLO calculations - run every hour
  - name: slo_long_term
    interval: 1h
    rules:
      - record: service:http_availability:30d
        expr: avg_over_time(service:http_success_ratio:rate5m[30d:5m])
```

**Warning:** Setting `interval` too low for expensive rules causes Prometheus to spend more time evaluating rules than scraping targets. Monitor `prometheus_rule_evaluation_duration_seconds` to detect this:

```promql
# Alert if rule evaluation takes more than 80% of the interval
prometheus_rule_evaluation_duration_seconds{rule_group!=""}
> 0.8 * prometheus_rule_group_interval_seconds
```

## Stale Marker Handling

When a target disappears or a series stops being scraped, Prometheus sends a stale marker. Recording rules referencing those series stop producing results. This is correct behavior but can confuse dashboards.

Handle stale series in recording rules with `or`:

```yaml
- record: service:http_requests_total:rate5m
  expr: |
    sum by (service) (rate(http_requests_total[5m]))
    or
    # If no data for this service, emit 0 (prevents "No data" in dashboard)
    0 * group by (service) (http_requests_total)
```

## Complete Production Recording Rules Configuration

```yaml
# prometheus-recording-rules.yaml
groups:
  - name: http_sli_rules
    interval: 30s
    rules:
      - record: service:http_requests_total:rate5m
        expr: sum by (service, namespace, cluster) (rate(http_requests_total[5m]))

      - record: service:http_requests_errors:rate5m
        expr: sum by (service, namespace, cluster) (rate(http_requests_total{status=~"5.."}[5m]))

      - record: service:http_error_ratio:rate5m
        expr: |
          service:http_requests_errors:rate5m
          / service:http_requests_total:rate5m

      - record: service:http_request_duration_bucket:rate5m
        expr: |
          sum by (service, namespace, cluster, le) (
            rate(http_request_duration_seconds_bucket[5m])
          )

      - record: service:http_request_duration_p99:rate5m
        expr: |
          histogram_quantile(0.99, service:http_request_duration_bucket:rate5m)

      - record: service:http_request_duration_p95:rate5m
        expr: |
          histogram_quantile(0.95, service:http_request_duration_bucket:rate5m)

      - record: service:http_request_duration_p50:rate5m
        expr: |
          histogram_quantile(0.50, service:http_request_duration_bucket:rate5m)

  - name: kubernetes_resource_rules
    interval: 1m
    rules:
      - record: namespace:container_cpu_usage:rate5m
        expr: |
          sum by (namespace, cluster) (
            rate(container_cpu_usage_seconds_total{container!="", container!="POD"}[5m])
          )

      - record: namespace:container_memory_rss:sum
        expr: |
          sum by (namespace, cluster) (
            container_memory_rss{container!="", container!="POD"}
          )

      - record: node:node_cpu_utilization:avg1m
        expr: |
          1 - avg by (node, cluster) (
            rate(node_cpu_seconds_total{mode="idle"}[1m])
          )

      - record: node:node_memory_utilization:ratio
        expr: |
          1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)

  - name: cluster_capacity_rules
    interval: 5m
    rules:
      - record: cluster:node_cpu_capacity:sum
        expr: sum by (cluster) (kube_node_status_capacity{resource="cpu"})

      - record: cluster:node_memory_capacity:sum
        expr: sum by (cluster) (kube_node_status_capacity{resource="memory"})

      - record: cluster:container_cpu_requests:sum
        expr: |
          sum by (cluster) (
            kube_pod_container_resource_requests{resource="cpu", pod!=""}
          )

      - record: cluster:container_memory_requests:sum
        expr: |
          sum by (cluster) (
            kube_pod_container_resource_requests{resource="memory", pod!=""}
          )

      - record: cluster:cpu_overcommit_ratio
        expr: |
          cluster:container_cpu_requests:sum / cluster:node_cpu_capacity:sum

      - record: cluster:memory_overcommit_ratio
        expr: |
          cluster:container_memory_requests:sum / cluster:node_memory_capacity:sum
```

## Summary

Prometheus recording rules and query optimization are not optional refinements for large deployments - they are operational requirements. The key principles:

- Apply the `level:metric:operation` naming convention consistently for discoverability
- Build recording rules from other recording rules (multi-level aggregation)
- Pre-aggregate histogram buckets before applying `histogram_quantile()`
- Avoid unbounded label selectors on high-cardinality metrics
- Use `rate()` for dashboards and SLOs, `irate()` only for instantaneous spike detection
- Implement metric relabeling to drop unused metrics and high-cardinality labels
- Monitor recording rule evaluation duration to detect over-evaluation
- Use Thanos Ruler for recording rules requiring long-range data that exceeds local TSDB retention
- Tune `remote_write` queue parameters to prevent WAL backlog under load

The investment in recording rule design pays continuous dividends throughout the lifetime of the deployment. Every query backed by a recording rule responds in milliseconds instead of seconds, reducing dashboard latency, improving alert evaluation reliability, and keeping Prometheus memory consumption predictable.
