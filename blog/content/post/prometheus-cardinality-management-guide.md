---
title: "Prometheus Cardinality Management: Preventing High-Cardinality Explosions"
date: 2027-12-25T00:00:00-05:00
draft: false
tags: ["Prometheus", "Cardinality", "Monitoring", "Thanos", "Recording Rules", "Metrics", "Observability", "Performance"]
categories:
- Monitoring
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Prometheus cardinality management covering analysis tools, recording rules optimization, label drop aggregation, metric relabeling, Thanos deduplication, federation patterns, series churn, and remote_write tuning to prevent high-cardinality explosions."
more_link: "yes"
url: "/prometheus-cardinality-management-guide/"
---

High cardinality is the leading cause of Prometheus performance degradation in production clusters. A single metric with an unbounded label (user IDs, request IDs, full URLs) can generate millions of time series, exhausting memory and making queries unusable. This guide covers systematic cardinality analysis, label architecture decisions, recording rules that pre-aggregate high-cardinality metrics, relabeling pipelines that drop series before they reach the TSDB, and remote_write tuning for large-scale federation through Thanos.

<!--more-->

# Prometheus Cardinality Management: Preventing High-Cardinality Explosions

## Understanding Cardinality

A Prometheus time series is uniquely identified by its metric name plus its label set. The cardinality of a metric is the number of unique combinations of label values:

```
http_requests_total{method="GET", status="200", path="/api/v1/users"} 1234
http_requests_total{method="POST", status="201", path="/api/v1/users"} 56
http_requests_total{method="GET", status="404", path="/api/v1/users/12345"} 3
```

If `path` includes user IDs (`/api/v1/users/12345`), and there are 1 million users, this single metric generates:
- 2 methods × 10 status codes × 1,000,000 paths = **20,000,000 time series**

At ~2KB per time series in TSDB memory, that is 40GB for a single metric. Prometheus becomes unresponsive.

Common cardinality offenders:
- HTTP path labels with dynamic segments (user IDs, object IDs)
- Kubernetes labels that include pod names or replica set names (which change with each deployment)
- Request ID or correlation ID labels
- Client IP addresses
- Full URL query strings

## Cardinality Analysis Tools

### Prometheus Built-In TSDB Analysis

```bash
# Top 20 metrics by series count
curl -sG http://prometheus.monitoring.svc.cluster.local:9090/api/v1/query \
  --data-urlencode 'query=topk(20, count by (__name__)({__name__!=""}))' | \
  jq -r '.data.result[] | "\(.value[1])\t\(.metric.__name__)"' | \
  sort -rn | head -20
```

```bash
# TSDB status endpoint (detailed cardinality analysis)
curl -s http://prometheus.monitoring.svc.cluster.local:9090/api/v1/status/tsdb | \
  jq '{
    headStats: .data.headStats,
    topSeriesCountMetrics: .data.seriesCountByMetricName[:10],
    topSeriesCountLabels: .data.seriesCountByLabelName[:10],
    topSeriesCountLabelPairs: .data.seriesCountByLabelValuePair[:10],
    memoryChunks: .data.headStats.numChunks
  }'
```

### mimirtool for Cardinality Analysis

mimirtool works against both Prometheus and Grafana Mimir:

```bash
# Install mimirtool
curl -fSL -o mimirtool \
  "https://github.com/grafana/mimir/releases/download/mimir-2.13.0/mimirtool-linux-amd64"
chmod +x mimirtool
sudo mv mimirtool /usr/local/bin/

# Analyze cardinality of active series
mimirtool analyze prometheus \
  --address=http://prometheus.monitoring.svc.cluster.local:9090 \
  --output-file=cardinality-report.json

# Find metrics not used in any dashboards or alerts
mimirtool analyze grafana \
  --grafana-url=https://grafana.internal.example.com \
  --grafana-api-key="${GRAFANA_API_KEY}" \
  --output-file=grafana-metrics.json

# Compare to find unused metrics
mimirtool analyze analyze \
  --rules-file=alerts.yaml \
  --grafana-metrics-file=grafana-metrics.json \
  --prometheus-file=cardinality-report.json
```

### Cardinality Explorer Dashboard Queries

```promql
# Top 10 label names by total series contribution
topk(10,
  count by (label_name) (
    count by (label_name, label_value) ({__name__!=""})
  )
)

# Series count trend (detect sudden cardinality spikes)
deriv(prometheus_tsdb_head_series[1h])

# Memory usage per series (cardinality × size indicator)
prometheus_tsdb_head_chunks_storage_size_bytes
  / prometheus_tsdb_head_series

# Churn rate: series created and deleted per minute
rate(prometheus_tsdb_head_series_created_total[5m])

# Series that only existed for < 5 minutes (high churn indicator)
rate(prometheus_tsdb_head_series_removed_total[5m])
```

## Label Architecture Decisions

Before writing recording rules or relabeling, design labels correctly:

### Bad: High-Cardinality Labels

```
# BAD: request_id has unbounded cardinality
http_requests_total{method="GET", status="200", request_id="req-abc123"}

# BAD: path contains dynamic ID segments
http_requests_total{path="/api/v1/orders/ORD-789456"}

# BAD: pod name changes with every deployment
app_requests_total{pod="payment-service-7d4b8c-xk9pv"}
```

### Good: Low-Cardinality Labels

```
# GOOD: normalize path with a template
http_requests_total{method="GET", status="200", path_template="/api/v1/orders/:id"}

# GOOD: workload-level labels only
app_requests_total{deployment="payment-service", namespace="payments"}
```

### Label Normalization in Application Code

```go
// Go: normalize HTTP paths to templates before recording metrics
import (
    "regexp"
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    // Pre-compiled path normalizers
    uuidPattern   = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)
    objectIDPattern = regexp.MustCompile(`/[0-9a-zA-Z-]{10,}`)

    httpRequests = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "http_requests_total",
        Help: "Total HTTP requests",
    }, []string{"method", "status", "path_template"})
)

func normalizePathTemplate(path string) string {
    // Replace UUIDs
    path = uuidPattern.ReplaceAllString(path, ":uuid")
    // Replace numeric IDs in path segments
    path = regexp.MustCompile(`/\d+`).ReplaceAllString(path, "/:id")
    return path
}

func InstrumentedHandler(method, path string, statusCode int) {
    httpRequests.With(prometheus.Labels{
        "method":        method,
        "status":        strconv.Itoa(statusCode),
        "path_template": normalizePathTemplate(path),
    }).Inc()
}
```

## Metric Relabeling Pipelines

Relabeling drops series before they enter the TSDB, which is more efficient than recording rules (relabeling prevents storage; recording rules reduce query load but still store the raw data).

### Drop High-Cardinality Labels at Scrape Time

```yaml
# prometheus-configmap.yaml (scrape_config section)
scrape_configs:
  - job_name: payment-service
    kubernetes_sd_configs:
      - role: pod
        namespaces:
          names: [payments]
    relabel_configs:
      # Keep only pods with the correct annotation
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
        action: keep
        regex: "true"

      # Drop all pod-level labels that cause churn
      - regex: "__meta_kubernetes_pod_label_pod_template_hash"
        action: labeldrop

    metric_relabel_configs:
      # Drop the high-cardinality request_id label from all metrics
      - source_labels: [__name__]
        regex: "http_.*"
        action: keep    # Only process http_ metrics in this rule

      - regex: "request_id|trace_id|user_id|session_id"
        action: labeldrop

      # Drop metrics with too many series (emergency cardinality protection)
      - source_labels: [__name__]
        regex: "go_memstats_.*|go_gc_.*"
        action: drop

      # Normalize status codes to buckets to reduce cardinality
      - source_labels: [status_code]
        target_label: status_class
        regex: "([245])[0-9]{2}"
        replacement: "${1}xx"

      # Drop the original high-cardinality status_code after normalizing
      - regex: "status_code"
        action: labeldrop
```

### Global Metric Relabeling in Prometheus Configuration

```yaml
# prometheus.yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s
  external_labels:
    cluster: production-us-east-1
    region: us-east-1

  # Global metric relabeling applied to ALL scraped metrics
  metric_relabel_configs:
    # Drop internal Go runtime metrics from all jobs
    - source_labels: [__name__]
      regex: "go_goroutines|go_threads|go_gc_duration_.*|process_cpu_.*"
      action: drop

    # Drop metrics with pod-level granularity that cause churn
    - source_labels: [__name__, pod]
      regex: "kube_pod_container_.*;.*-[a-z0-9]{5}-[a-z0-9]{5}"
      action: drop
```

## Recording Rules for Aggregation

Recording rules pre-compute expensive queries and store the result as new time series. Use them to reduce cardinality of high-cardinality metrics by aggregating away the offending labels:

```yaml
# prometheus-recording-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: platform-recording-rules
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    - name: http_aggregations
      interval: 30s
      rules:
        # Aggregate HTTP requests by service/namespace/method/status_class
        # Drops pod-level and path-level labels
        - record: job:http_requests_total:rate5m
          expr: |
            sum by (job, namespace, method, status_class) (
              rate(http_requests_total[5m])
            )

        # P50/P90/P99 latency pre-computed at service level
        - record: job:http_request_duration_seconds:p50
          expr: |
            histogram_quantile(0.50,
              sum by (job, namespace, le) (
                rate(http_request_duration_seconds_bucket[5m])
              )
            )

        - record: job:http_request_duration_seconds:p99
          expr: |
            histogram_quantile(0.99,
              sum by (job, namespace, le) (
                rate(http_request_duration_seconds_bucket[5m])
              )
            )

        # Error rate pre-computed
        - record: job:http_error_rate:rate5m
          expr: |
            sum by (job, namespace) (
              rate(http_requests_total{status_class="5xx"}[5m])
            )
            /
            sum by (job, namespace) (
              rate(http_requests_total[5m])
            )

    - name: kubernetes_aggregations
      interval: 60s
      rules:
        # Aggregate pod CPU at deployment level (drops pod name)
        - record: namespace_deployment:container_cpu_usage_seconds_total:rate5m
          expr: |
            sum by (namespace, deployment) (
              label_replace(
                rate(container_cpu_usage_seconds_total{
                  container!="",
                  container!="POD"
                }[5m]),
                "deployment",
                "$1",
                "pod",
                "^(.*)-[a-z0-9]+-[a-z0-9]+$"
              )
            )

        # Memory at deployment level
        - record: namespace_deployment:container_memory_working_set_bytes:avg
          expr: |
            avg by (namespace, deployment) (
              label_replace(
                container_memory_working_set_bytes{
                  container!="",
                  container!="POD"
                },
                "deployment",
                "$1",
                "pod",
                "^(.*)-[a-z0-9]+-[a-z0-9]+$"
              )
            )

    - name: database_aggregations
      interval: 30s
      rules:
        # PostgreSQL query latency at database level (drops query_text)
        - record: job:pg_stat_statements_mean_exec_time:avg5m
          expr: |
            avg by (job, namespace, datname) (
              pg_stat_statements_mean_exec_time_seconds
            )

        # Top N slow queries per database (retain only top 10)
        - record: job:pg_stat_statements_top_slow:5m
          expr: |
            topk(10,
              avg by (job, namespace, datname, queryid) (
                pg_stat_statements_mean_exec_time_seconds
              )
            )
```

## Series Churn Management

Series churn occurs when time series are constantly created and deleted, such as when pod names appear in labels. High churn degrades TSDB compaction efficiency.

### Identify Churn Sources

```bash
# Metrics with highest churn (created+removed series per minute)
curl -sG http://prometheus.monitoring.svc.cluster.local:9090/api/v1/query \
  --data-urlencode 'query=topk(10, rate(prometheus_tsdb_head_series_created_total[5m]) + rate(prometheus_tsdb_head_series_removed_total[5m]))' | \
  jq -r '.data.result[] | "\(.value[1]) churn/min\t\(.metric.job // "unknown")"' | \
  sort -rn
```

### Reduce Churn from Kubernetes Labels

Kubernetes pod labels like `pod-template-hash` change with every deployment, generating new series for each rollout:

```yaml
# In scrape config: drop churn-inducing kubernetes labels
relabel_configs:
  # Drop pod-template-hash (changes with each rollout)
  - regex: "__meta_kubernetes_pod_label_pod_template_hash"
    action: labeldrop

  # Replace pod name with deployment name to prevent per-pod series
  - source_labels: [__meta_kubernetes_pod_controller_name]
    target_label: controller_name
    regex: "(.*)-[a-z0-9]+-[a-z0-9]+"
    replacement: "$1"

  # Remove the original pod label (high cardinality)
  - regex: "pod"
    action: labeldrop

  # Add normalized deployment label
  - source_labels: [__meta_kubernetes_pod_controller_name]
    target_label: deployment
```

### Limit Time Series with Sample Limit

Protect Prometheus from scraping endpoints that produce unexpected cardinality:

```yaml
scrape_configs:
  - job_name: payment-service
    sample_limit: 50000     # Fail entire scrape if >50k samples
    label_limit: 30         # Reject samples with >30 labels
    label_name_length_limit: 128
    label_value_length_limit: 256
```

## Thanos Ruler Deduplication

In multi-cluster Thanos setups, recording rules may run on each cluster's Prometheus, producing duplicate results. Thanos Ruler evaluates global recording rules once across all clusters:

```yaml
# thanos-ruler-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: thanos-ruler-rules
  namespace: thanos
data:
  global-recording-rules.yaml: |
    groups:
      - name: global_aggregations
        interval: 60s
        rules:
          # Global error rate across all clusters
          - record: global:http_error_rate:rate5m
            expr: |
              sum by (region, service) (
                rate(http_requests_total{status_class="5xx"}[5m])
              )
              /
              sum by (region, service) (
                rate(http_requests_total[5m])
              )

          # Global P99 latency
          - record: global:http_p99_latency:5m
            expr: |
              histogram_quantile(0.99,
                sum by (region, service, le) (
                  rate(http_request_duration_seconds_bucket[5m])
                )
              )
```

```yaml
# thanos-ruler-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: thanos-ruler
  namespace: thanos
spec:
  replicas: 2
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
          image: quay.io/thanos/thanos:v0.36.1
          args:
            - rule
            - --grpc-address=0.0.0.0:10901
            - --http-address=0.0.0.0:10902
            - --eval-interval=60s
            - --rule-file=/etc/thanos/rules/*.yaml
            - --alertmanagers.url=http://alertmanager.monitoring.svc.cluster.local:9093
            - --query=thanos-query.thanos.svc.cluster.local:9090
            - --label=ruler_cluster="production-global"
            - --label=rule_replica="$(POD_NAME)"
            - --alert.query-url=https://thanos.internal.example.com
          env:
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
          volumeMounts:
            - name: rules
              mountPath: /etc/thanos/rules
            - name: data
              mountPath: /data
      volumes:
        - name: rules
          configMap:
            name: thanos-ruler-rules
        - name: data
          emptyDir: {}
```

## remote_write Tuning

For large Prometheus deployments sending to Thanos Receiver, Cortex, or Mimir, remote_write configuration directly impacts cardinality at the storage layer:

```yaml
# prometheus.yaml remote_write section
remote_write:
  - url: http://thanos-receive.thanos.svc.cluster.local:19291/api/v1/receive
    name: thanos-receive

    # Queue configuration for high-throughput environments
    queue_config:
      capacity: 100000          # In-memory queue capacity (samples)
      max_shards: 50             # Parallel HTTP connections to remote
      min_shards: 5
      max_samples_per_send: 5000  # Samples per HTTP request
      batch_send_deadline: 5s
      min_backoff: 30ms
      max_backoff: 5s

    # Filter what is sent to remote storage
    write_relabel_configs:
      # Only send recording rule results (pre-aggregated) to long-term storage
      # This dramatically reduces cardinality at the Thanos/Mimir layer
      - source_labels: [__name__]
        regex: "job:.*|namespace_deployment:.*|global:.*|:.*"
        action: keep

      # Drop debug metrics from remote storage
      - source_labels: [__name__]
        regex: "go_.*|process_.*|promhttp_.*"
        action: drop

      # Drop high-cardinality kubernetes state metrics
      - source_labels: [__name__]
        regex: "kube_pod_container_.*"
        action: drop

    # Metadata sending configuration
    metadata_config:
      send: true
      send_interval: 1m
      max_samples_per_send: 500
```

## Federation Patterns for Cardinality Control

Hierarchical federation reduces what a global Prometheus stores by scraping only pre-aggregated recording rules from cluster-level instances:

```yaml
# global-prometheus scrape_config
scrape_configs:
  - job_name: cluster-federation
    honor_labels: true
    metrics_path: /federate
    params:
      match[]:
        # Only federate recording rule results (pre-aggregated)
        - '{__name__=~"job:.*"}'
        - '{__name__=~"namespace_deployment:.*"}'
        - '{__name__=~"cluster:.*"}'
        # No raw metrics - only aggregates
    static_configs:
      - targets:
          - prometheus.cluster-us-east-1.internal:9090
          - prometheus.cluster-eu-west-1.internal:9090
          - prometheus.cluster-ap-southeast-1.internal:9090
    relabel_configs:
      - source_labels: [__address__]
        target_label: cluster
        regex: "prometheus\\.([^.]+)\\..*"
        replacement: "$1"
```

## Alerts for Cardinality Protection

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: prometheus-cardinality-alerts
  namespace: monitoring
spec:
  groups:
    - name: prometheus.cardinality
      rules:
        - alert: PrometheusHighCardinalityMetric
          expr: |
            topk(5,
              count by (__name__) ({__name__!=""})
            ) > 100000
          for: 15m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "Prometheus metric {{ $labels.__name__ }} has >100k series"
            description: |
              Metric {{ $labels.__name__ }} has {{ $value }} active series.
              Review label dimensions and apply relabeling to drop high-cardinality labels.

        - alert: PrometheusHighSeriesChurn
          expr: |
            rate(prometheus_tsdb_head_series_created_total[10m]) > 1000
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Prometheus creating >1000 new series/minute"
            description: "High series churn detected. Check for dynamic labels in scraped metrics."

        - alert: PrometheusSeriesLimitApproaching
          expr: |
            prometheus_tsdb_head_series > 8000000
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Prometheus approaching 10M series limit"
            description: "{{ $value }} active series. Memory exhaustion and query timeouts imminent."

        - alert: PrometheusRemoteWriteQueueFull
          expr: |
            prometheus_remote_storage_queue_highest_sent_timestamp_seconds
              < time() - 300
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Prometheus remote_write queue behind by >5 minutes"

        - alert: PrometheusRemoteWriteDropped
          expr: |
            rate(prometheus_remote_storage_samples_dropped_total[5m]) > 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Prometheus dropping samples in remote_write queue"
            description: "{{ $value }} samples/second being dropped. Increase queue_config.capacity."
```

## Cardinality Remediation Runbook

### Step 1: Identify the Offending Metric

```bash
# Find metric with most series
curl -sG http://prometheus:9090/api/v1/query \
  --data-urlencode 'query=topk(5, count by (__name__)({__name__!=""}))' | \
  jq -r '.data.result[] | "\(.value[1]) series: \(.metric.__name__)"'
```

### Step 2: Identify the Offending Label

```bash
METRIC="http_requests_total"
# Count series per label combination for this metric
curl -sG http://prometheus:9090/api/v1/query \
  --data-urlencode "query=count by (${METRIC}) ({__name__=\"${METRIC}\"})" | \
  jq -r '.data.result | sort_by(.value[1] | tonumber) | reverse | .[0:5][]'
```

### Step 3: Apply Drop Rule

```yaml
# Add to scrape_config metric_relabel_configs
metric_relabel_configs:
  - source_labels: [__name__, problematic_label]
    regex: "http_requests_total;.*"
    target_label: problematic_label
    replacement: ""   # Drop the label value
```

### Step 4: Verify Reduction

```bash
# Monitor series count over next 2 hours
watch -n 60 "curl -sG http://prometheus:9090/api/v1/query \
  --data-urlencode 'query=count({__name__=\"http_requests_total\"})' | \
  jq '.data.result[0].value[1]'"
```

## Sizing Guidelines

| Series Count | RAM Required | Storage (30d) | Notes |
|-------------|-------------|--------------|-------|
| < 500k | 4GB | 15GB | Single Prometheus, no federation needed |
| 500k - 2M | 8-16GB | 60GB | Consider remote_write to Thanos |
| 2M - 10M | 32-64GB | 300GB | Mandatory remote_write; local retention 24h only |
| > 10M | Multiple shards | Thanos/Mimir required | Prometheus alone cannot handle this |

## Summary

Cardinality management is a continuous operational discipline, not a one-time fix. The systematic approach:

1. Baseline with TSDB status endpoint and mimirtool to identify top contributors
2. Normalize high-cardinality labels in application code before they enter Prometheus
3. Drop remaining offending labels with `metric_relabel_configs` at scrape time
4. Pre-aggregate high-cardinality metrics with recording rules for dashboard queries
5. Configure `sample_limit` and `label_limit` on all scrape jobs as a circuit breaker
6. Send only recording rule results to Thanos/Mimir via `remote_write` write_relabel_configs
7. Alert on series growth rate, churn rate, and series count thresholds
8. Review and prune unused metrics quarterly using mimirtool's grafana analysis
