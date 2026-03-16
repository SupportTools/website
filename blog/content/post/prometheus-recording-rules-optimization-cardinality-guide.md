---
title: "Prometheus Recording Rules: Optimization, Cardinality Control, and Performance Tuning"
date: 2027-01-15T00:00:00-05:00
draft: false
tags: ["Prometheus", "Monitoring", "Observability", "Performance"]
categories: ["Monitoring", "Observability", "Infrastructure"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Prometheus recording rules covering naming conventions, cardinality explosion prevention, federation patterns, rule group parallelism, migrating dashboard queries, and operational runbooks for production monitoring environments."
more_link: "yes"
url: "/prometheus-recording-rules-optimization-cardinality-guide/"
---

Prometheus is capable of evaluating complex PromQL expressions on the fly, but relying on raw queries in dashboards and alert rules at scale creates compounding performance problems: high-cardinality expressions execute repeatedly across multiple dashboards, rule evaluations back up when evaluation time exceeds the interval, and federation queries time out because they must aggregate across millions of series per request. **Recording rules** solve all three problems by pre-computing expensive expressions and materialising them as new time series that dashboards and alerts can query cheaply. This guide covers when and how to use recording rules effectively, naming conventions, cardinality control, multi-tenant patterns, and day-2 operational practices.

<!--more-->

## When to Use Recording Rules vs Raw Queries

Recording rules are not always the right tool. The decision depends on query frequency, cardinality, and the cost of the expression.

### Use Recording Rules When

- A PromQL expression is used in more than two dashboards or alert rules
- Evaluation time for a query exceeds 200ms (check `prometheus_rule_evaluation_duration_seconds`)
- A dashboard query aggregates over more than 50,000 series
- Federation or remote-read clients query the same high-cardinality expression repeatedly
- Alert rules need sub-minute resolution but the underlying expression is expensive
- The query performs multi-level aggregation (e.g., per-pod → per-namespace → per-cluster)

### Avoid Recording Rules When

- The query is used in a single ad-hoc dashboard that changes frequently
- The expression returns fewer than 100 series and evaluates in under 10ms
- The metric is already a counter or gauge with naturally low cardinality
- Debugging one-off incidents (recording rules add persistence overhead)

## Naming Conventions: level:metric:operations

The Prometheus community has established a naming convention that encodes context directly in the metric name. The format is:

```
<aggregation_level>:<base_metric>:<list_of_operations>
```

Where:
- **aggregation_level** describes the labels remaining after aggregation (e.g., `job`, `instance`, `namespace`, `cluster`)
- **base_metric** is the source metric name (without type suffixes like `_total` or `_seconds`)
- **list_of_operations** describes transformations applied, in order (e.g., `rate5m`, `sum`, `avg`)

### Naming Examples

| Expression | Recording Rule Name |
|---|---|
| `rate(http_requests_total[5m])` | `job:http_requests:rate5m` |
| `sum by (job) (rate(http_requests_total[5m]))` | `job:http_requests:rate5m` |
| `sum by (namespace) (rate(container_cpu_usage_seconds_total[5m]))` | `namespace:container_cpu_usage:rate5m` |
| `histogram_quantile(0.99, sum by (le,job) (rate(http_request_duration_seconds_bucket[5m])))` | `job:http_request_duration_seconds:histogram_quantile99_rate5m` |
| `sum by (cluster, namespace) (kube_pod_container_resource_requests{resource="cpu"})` | `cluster_namespace:container_cpu_requested:sum` |

This convention makes it immediately clear what the metric represents, what labels it carries, and how it was derived—essential for operators who didn't write the rule.

## Recording Rule Structure

### Basic Rule File

```yaml
# /etc/prometheus/rules/http-request-rates.yaml
groups:
  - name: http_request_rates
    # Evaluation interval for this group (default: global.evaluation_interval)
    interval: 1m
    rules:
      - record: job:http_requests:rate5m
        expr: |
          sum by (job) (
            rate(http_requests_total[5m])
          )

      - record: job:http_request_errors:rate5m
        expr: |
          sum by (job) (
            rate(http_requests_total{status=~"5.."}[5m])
          )

      - record: job:http_request_error_ratio:rate5m
        expr: |
          job:http_request_errors:rate5m
            /
          job:http_requests:rate5m

      - record: job:http_request_duration_seconds:histogram_quantile99_rate5m
        expr: |
          histogram_quantile(0.99,
            sum by (job, le) (
              rate(http_request_duration_seconds_bucket[5m])
            )
          )

      - record: job:http_request_duration_seconds:histogram_quantile50_rate5m
        expr: |
          histogram_quantile(0.50,
            sum by (job, le) (
              rate(http_request_duration_seconds_bucket[5m])
            )
          )
```

### Multi-Level Aggregation Chain

For large environments, build aggregation chains that feed each level from the level below:

```yaml
groups:
  - name: cpu_usage_pod
    interval: 30s
    rules:
      # Level 1: Per-pod, per-container (high cardinality, short retention)
      - record: pod_container:container_cpu_usage:rate5m
        expr: |
          sum by (namespace, pod, container) (
            rate(container_cpu_usage_seconds_total{container!=""}[5m])
          )

  - name: cpu_usage_namespace
    interval: 1m
    rules:
      # Level 2: Per-namespace (medium cardinality)
      - record: namespace:container_cpu_usage:rate5m
        expr: |
          sum by (namespace) (
            pod_container:container_cpu_usage:rate5m
          )

  - name: cpu_usage_cluster
    interval: 5m
    rules:
      # Level 3: Cluster-wide totals (low cardinality)
      - record: cluster:container_cpu_usage:rate5m
        expr: |
          sum(namespace:container_cpu_usage:rate5m)
```

This chain has three benefits:
1. Each level queries a pre-computed, low-cardinality series rather than raw metrics.
2. Evaluation intervals can be tuned per level—high-frequency for operational use, low-frequency for trend analysis.
3. The intermediate levels are independently queryable for debugging.

## Cardinality Explosion Patterns and Prevention

**Cardinality explosion** occurs when a recording rule retains labels that have unbounded or very high cardinality. The result is a recording rule that produces more series than the underlying metric, defeating the purpose of the rule.

### Common Explosion Patterns

**Pattern 1: Retaining pod name in a long-term recording rule**

```yaml
# BAD: pod label has high cardinality; pods come and go
- record: pod:container_memory_usage:sum
  expr: sum by (namespace, pod) (container_memory_usage_bytes{container!=""})
```

This produces one series per pod. In a cluster with 500 pods, that is 500 series. When pods are replaced (rolling updates, node failures), stale series accumulate.

**Pattern 2: Retaining request path**

```yaml
# BAD: path can be unbounded (e.g., user IDs in path)
- record: path:http_requests:rate5m
  expr: sum by (job, path) (rate(http_requests_total[5m]))
```

If the `path` label contains values like `/users/12345/profile`, cardinality grows linearly with user count.

**Pattern 3: Retaining ephemeral labels**

```yaml
# BAD: le (histogram bucket boundary) must be retained for quantile calculation
# but retaining instance + le creates O(instances × buckets) series
- record: instance_le:http_request_duration_seconds:rate5m
  expr: sum by (instance, le) (rate(http_request_duration_seconds_bucket[5m]))
```

### Prevention Strategies

**Strategy 1: Aggregate away high-cardinality labels**

```yaml
# GOOD: drop pod, keep namespace and container
- record: namespace_container:container_memory_usage:sum
  expr: |
    sum by (namespace, container) (
      container_memory_usage_bytes{container!=""}
    )
```

**Strategy 2: Use `topk` for bounded high-cardinality summaries**

```yaml
# Top 20 pods by CPU—bounded cardinality
- record: namespace:container_cpu_top20pods:rate5m
  expr: |
    topk by (namespace) (20,
      sum by (namespace, pod) (
        rate(container_cpu_usage_seconds_total{container!=""}[5m])
      )
    )
```

**Strategy 3: Pre-aggregate path into route groups**

Instrument applications to emit a `route` label that maps paths to route patterns (e.g., `/users/{id}/profile` → `/users/:id/profile`). Recording rules on `route` are bounded by the number of routes, not users.

**Strategy 4: Exclude labels with `without`**

```yaml
# Remove all labels except job before recording
- record: job:process_cpu:rate5m
  expr: |
    sum without (instance, cpu) (
      rate(process_cpu_seconds_total[5m])
    )
```

### Cardinality Monitoring

Track the cardinality of recording rules to detect regressions:

```yaml
groups:
  - name: cardinality_monitoring
    interval: 5m
    rules:
      - record: recording_rule:series_count:by_name
        expr: |
          count by (__name__) ({__name__=~"job:.*|namespace:.*|cluster:.*"})
```

Alert when a recording rule produces an unexpected number of series:

```yaml
- alert: RecordingRuleCardinalityExplosion
  expr: |
    recording_rule:series_count:by_name > 10000
  for: 10m
  labels:
    severity: warning
  annotations:
    summary: "Recording rule {{ $labels.__name__ }} has high cardinality"
    description: "{{ $value }} series detected. Investigate label retention."
```

## Federation Recording Rules

In federated Prometheus deployments, leaf Prometheus servers pre-aggregate data before the central federation Prometheus scrapes it. Without recording rules, the federation Prometheus must scrape all raw metrics, causing high cardinality and bandwidth.

### Leaf Configuration

```yaml
# rules/federation-exports.yaml on leaf Prometheus
groups:
  - name: federation_exports
    interval: 1m
    rules:
      # Export namespace-level CPU aggregates for federation
      - record: namespace:container_cpu_usage:rate5m
        expr: |
          sum by (namespace) (
            rate(container_cpu_usage_seconds_total{container!=""}[5m])
          )
        labels:
          cluster: "cluster-east-1"

      # Export per-job request rates
      - record: job:http_requests:rate5m
        expr: |
          sum by (job, status_code) (
            rate(http_requests_total[5m])
          )
        labels:
          cluster: "cluster-east-1"
```

### Federation Prometheus Configuration

```yaml
# prometheus-federation.yaml
scrape_configs:
  - job_name: federate
    scrape_interval: 1m
    honor_labels: true
    metrics_path: /federate
    params:
      match[]:
        # Only scrape pre-computed recording rule series
        - '{__name__=~"namespace:.*"}'
        - '{__name__=~"job:.*"}'
        - '{__name__=~"cluster:.*"}'
    static_configs:
      - targets:
          - prometheus-leaf-east1:9090
          - prometheus-leaf-west1:9090
          - prometheus-leaf-eu1:9090
```

This pattern reduces federation scrape cardinality by 99%+ in typical Kubernetes environments.

## Multi-Tenant Recording Rules

In shared Prometheus deployments serving multiple teams or tenants, recording rules must be scoped to avoid cross-tenant data bleed and to give each tenant usable aggregates.

### Namespace-Scoped Rules with External Labels

```yaml
# Multi-tenant recording rules with tenant isolation via namespace
groups:
  - name: tenant_billing_metrics
    interval: 5m
    rules:
      # Per-tenant CPU consumption
      - record: tenant_namespace:container_cpu:rate5m
        expr: |
          sum by (namespace) (
            rate(container_cpu_usage_seconds_total{container!=""}[5m])
          )

      # Per-tenant memory consumption
      - record: tenant_namespace:container_memory:sum
        expr: |
          sum by (namespace) (
            container_memory_working_set_bytes{container!=""}
          )

      # Per-tenant network I/O
      - record: tenant_namespace:container_network_receive:rate5m
        expr: |
          sum by (namespace) (
            rate(container_network_receive_bytes_total[5m])
          )

      - record: tenant_namespace:container_network_transmit:rate5m
        expr: |
          sum by (namespace) (
            rate(container_network_transmit_bytes_total[5m])
          )
```

### Per-Team Alert Rules Using Recording Rules

Teams can define alert rules that reference shared recording rules without needing access to the underlying raw metrics:

```yaml
groups:
  - name: team_payments_alerts
    rules:
      - alert: PaymentsHighErrorRate
        expr: |
          job:http_request_error_ratio:rate5m{job="payments-api"} > 0.05
        for: 5m
        labels:
          team: payments
          severity: critical
        annotations:
          summary: "Payments API error rate above 5%"
```

## Measuring Recording Rule Evaluation Time

Prometheus exposes metrics about its own rule evaluation. Use these to identify slow rules before they cause problems.

### Key Metrics

- `prometheus_rule_evaluation_duration_seconds`: Histogram of individual rule evaluation duration
- `prometheus_rule_group_duration_seconds`: Histogram of full group evaluation duration
- `prometheus_rule_group_interval_seconds`: Configured evaluation interval per group
- `prometheus_evaluator_iterations_missed_total`: Number of times evaluation was skipped because the previous iteration hadn't finished

### Evaluation Time Dashboard Queries

```promql
# Top 10 slowest rule groups
topk(10,
  rate(prometheus_rule_group_duration_seconds_sum[5m])
    /
  rate(prometheus_rule_group_duration_seconds_count[5m])
)

# Groups where evaluation takes more than 50% of the interval
(
  rate(prometheus_rule_group_duration_seconds_sum[5m])
    /
  rate(prometheus_rule_group_duration_seconds_count[5m])
)
  /
prometheus_rule_group_interval_seconds
> 0.5

# Missed evaluations
rate(prometheus_evaluator_iterations_missed_total[5m]) > 0
```

### Alert on Slow Evaluation

```yaml
groups:
  - name: prometheus_self_monitoring
    rules:
      - alert: PrometheusRuleGroupSlow
        expr: |
          (
            rate(prometheus_rule_group_duration_seconds_sum[5m])
              /
            rate(prometheus_rule_group_duration_seconds_count[5m])
          )
            /
          prometheus_rule_group_interval_seconds
          > 0.8
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Rule group {{ $labels.rule_group }} evaluation is slow"
          description: "Evaluation takes {{ $value | humanizePercentage }} of the interval."

      - alert: PrometheusRuleEvaluationsMissed
        expr: rate(prometheus_evaluator_iterations_missed_total[5m]) > 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Prometheus rule evaluations are being skipped"
          description: "{{ $value }} evaluations per second are missed for job {{ $labels.job }}."
```

## Rule Grouping for Parallelism

Prometheus evaluates rules within a group serially, but different groups in the same rule file can be evaluated in parallel. Use `--rules.alert.max-rule-groups-per-tenant` and group structure to control parallelism.

### Parallel Group Design

```yaml
# SUBOPTIMAL: all rules in one group — serial evaluation
groups:
  - name: all_metrics
    interval: 1m
    rules:
      - record: job:http_requests:rate5m
        expr: sum by (job) (rate(http_requests_total[5m]))
      - record: namespace:container_cpu_usage:rate5m
        expr: sum by (namespace) (rate(container_cpu_usage_seconds_total[5m]))
      - record: job:db_query_duration:p99_rate5m
        expr: histogram_quantile(0.99, sum by (job,le) (rate(db_query_duration_seconds_bucket[5m])))
      # ... 30 more rules
```

```yaml
# BETTER: independent groups evaluated in parallel
groups:
  - name: http_metrics
    interval: 1m
    rules:
      - record: job:http_requests:rate5m
        expr: sum by (job) (rate(http_requests_total[5m]))

  - name: cpu_metrics
    interval: 1m
    rules:
      - record: namespace:container_cpu_usage:rate5m
        expr: sum by (namespace) (rate(container_cpu_usage_seconds_total[5m]))

  - name: database_metrics
    interval: 1m
    rules:
      - record: job:db_query_duration:p99_rate5m
        expr: |
          histogram_quantile(0.99,
            sum by (job, le) (
              rate(db_query_duration_seconds_bucket[5m])
            )
          )
```

Rules within a group that depend on each other (output of one rule feeds the next) must remain in the same group and in the correct order. Prometheus evaluates rules within a group in sequence, so each rule sees the output of the preceding rule in the same evaluation cycle.

### Dependency Ordering

```yaml
groups:
  # This group must complete before cluster-level rules reference namespace:*
  - name: namespace_aggregates
    interval: 1m
    rules:
      - record: namespace:container_cpu_usage:rate5m
        expr: sum by (namespace) (rate(container_cpu_usage_seconds_total[5m]))
      - record: namespace:container_memory_usage:sum
        expr: sum by (namespace) (container_memory_working_set_bytes{container!=""})

  # This group references namespace:* rules from the group above.
  # Prometheus evaluates groups concurrently on the same tick,
  # so use stagger via different intervals or accept one-tick staleness.
  - name: cluster_aggregates
    interval: 5m
    rules:
      - record: cluster:container_cpu_usage:rate5m
        expr: sum(namespace:container_cpu_usage:rate5m)
      - record: cluster:container_memory_usage:sum
        expr: sum(namespace:container_memory_usage:sum)
```

## Migrating Expensive Dashboard Queries to Recording Rules

Dashboard query migration follows a repeatable pattern:

### Step 1: Identify Slow Queries

Use Prometheus's query stats endpoint or Grafana's query inspector to find queries taking over 200ms. Look for patterns like:
- `histogram_quantile` over raw buckets
- `rate()` over very long windows on high-cardinality metrics
- Multi-level `sum by` chains

### Step 2: Create the Recording Rule

```yaml
# Original Grafana query (slow):
# histogram_quantile(0.99, sum by (le, job) (rate(grpc_server_handling_seconds_bucket{job="api"}[5m])))

# Equivalent recording rule:
groups:
  - name: grpc_latency
    interval: 1m
    rules:
      - record: job:grpc_server_handling_seconds:histogram_quantile99_rate5m
        expr: |
          histogram_quantile(0.99,
            sum by (le, job) (
              rate(grpc_server_handling_seconds_bucket[5m])
            )
          )
      - record: job:grpc_server_handling_seconds:histogram_quantile50_rate5m
        expr: |
          histogram_quantile(0.50,
            sum by (le, job) (
              rate(grpc_server_handling_seconds_bucket[5m])
            )
          )
```

### Step 3: Update Dashboard Queries

Replace the complex Grafana query:

```promql
# Before:
histogram_quantile(0.99, sum by (le, job) (rate(grpc_server_handling_seconds_bucket{job="api"}[5m])))

# After:
job:grpc_server_handling_seconds:histogram_quantile99_rate5m{job="api"}
```

The `After` query executes in microseconds because it reads a pre-computed time series.

### Step 4: Validate Equivalence

Before removing the old query, compare the two in a Grafana panel using dual axes. Values should be nearly identical (within one evaluation interval of drift).

## Stale Markers and Rule Lifecycle

When a recording rule's expression returns no data (all source series have gone stale), Prometheus generates a **stale marker** for the recording rule series. This prevents dashboards from showing the last-known value indefinitely.

### Stale Marker Behaviour

- If the expression returns no data for two consecutive evaluation intervals, Prometheus writes a stale marker.
- Grafana and other PromQL consumers treat stale markers as gaps in the time series.
- Alert rules referencing stale recording rule series will trigger `absent()` conditions.

### Testing for Staleness

```promql
# Check if a recording rule series has recent data
(
  time() - timestamp(job:http_requests:rate5m)
) > 120
```

This expression returns the age of the most recent sample. Alert if it exceeds two evaluation intervals:

```yaml
- alert: RecordingRuleStale
  expr: |
    (time() - timestamp(job:http_requests:rate5m)) > 120
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Recording rule job:http_requests:rate5m has stale data"
```

## Remote Write Filtering with Recording Rules

When using remote write to a long-term storage backend (Thanos Receive, Cortex, Mimir, VictoriaMetrics), pre-filtering with recording rules reduces write volume dramatically.

### remote_write with match filters

```yaml
# prometheus.yaml
remote_write:
  - url: https://thanos-receive.monitoring.svc.cluster.local/api/v1/receive
    queue_config:
      max_samples_per_send: 10000
      batch_send_deadline: 5s
    write_relabel_configs:
      # Only remote-write recording rule series and critical raw metrics
      - source_labels: [__name__]
        regex: "^(job:|namespace:|cluster:|recording_rule:).*"
        action: keep
      # Also keep certain raw metrics needed for ad-hoc queries
      - source_labels: [__name__]
        regex: "^(kube_node_status_condition|kube_pod_status_phase|up)$"
        action: keep
```

This pattern means the remote storage receives only low-cardinality, pre-aggregated series while the local Prometheus retains the full raw data for short-term debugging.

## Production Operational Runbook

### Validating Rule Files Before Reload

```bash
#!/bin/bash
# Validate Prometheus rule files before applying
set -euo pipefail

RULES_DIR="/etc/prometheus/rules"
PROMETHEUS_URL="http://localhost:9090"

echo "=== Validating rule files ==="
promtool check rules "${RULES_DIR}"/*.yaml
echo "Syntax validation passed."

echo ""
echo "=== Testing rules against live data ==="
for rule_file in "${RULES_DIR}"/*.yaml; do
  echo "Testing: ${rule_file}"
  promtool test rules "${rule_file%.yaml}.test.yaml" 2>/dev/null || \
    echo "  No test file found for ${rule_file}"
done

echo ""
echo "=== Triggering hot reload ==="
curl -s -X POST "${PROMETHEUS_URL}/-/reload"
echo "Prometheus reloaded."

echo ""
echo "=== Checking for evaluation errors ==="
sleep 10
curl -s "${PROMETHEUS_URL}/api/v1/rules" | \
  jq '.data.groups[].rules[] | select(.health != "ok") | {name: .name, health: .health, lastError: .lastError}'
```

### Writing Rule Unit Tests

```yaml
# rules/http-request-rates.test.yaml
rule_files:
  - http-request-rates.yaml

evaluation_interval: 1m

tests:
  - interval: 1m
    input_series:
      - series: 'http_requests_total{job="api", status="200"}'
        values: "0 60 120 180 240"
      - series: 'http_requests_total{job="api", status="500"}'
        values: "0 3 6 9 12"

    promql_expr_test:
      - expr: 'job:http_requests:rate5m{job="api"}'
        eval_time: 5m
        exp_samples:
          - labels: '{job="api"}'
            value: 1

      - expr: 'job:http_request_error_ratio:rate5m{job="api"}'
        eval_time: 5m
        exp_samples:
          - labels: '{job="api"}'
            value: 0.05
```

Run tests with:

```bash
promtool test rules rules/http-request-rates.test.yaml
```

### Bulk Migration Script

When migrating a Grafana instance from raw queries to recording rules across many dashboards:

```python
#!/usr/bin/env python3
# migrate_dashboard_queries.py
# Scans Grafana dashboards and replaces known slow queries with recording rules

import json
import os
import sys

# Map from slow query patterns to recording rule names
QUERY_MIGRATIONS = {
    'sum by (job) (rate(http_requests_total[5m]))':
        'job:http_requests:rate5m',
    'histogram_quantile(0.99, sum by (le, job) (rate(http_request_duration_seconds_bucket[5m])))':
        'job:http_request_duration_seconds:histogram_quantile99_rate5m',
    'sum by (namespace) (rate(container_cpu_usage_seconds_total{container!=""}[5m]))':
        'namespace:container_cpu_usage:rate5m',
}

def migrate_dashboard(dashboard_path):
    with open(dashboard_path) as f:
        dashboard = json.load(f)

    changed = False
    for panel in dashboard.get('panels', []):
        for target in panel.get('targets', []):
            expr = target.get('expr', '')
            for old_query, new_metric in QUERY_MIGRATIONS.items():
                if old_query in expr:
                    print(f"  Migrating: {old_query[:60]}... -> {new_metric}")
                    target['expr'] = expr.replace(old_query, new_metric)
                    changed = True

    if changed:
        backup_path = dashboard_path + '.bak'
        os.rename(dashboard_path, backup_path)
        with open(dashboard_path, 'w') as f:
            json.dump(dashboard, f, indent=2)
        print(f"  Saved (backup: {backup_path})")
    else:
        print(f"  No changes needed.")

    return changed

if __name__ == '__main__':
    dashboards_dir = sys.argv[1] if len(sys.argv) > 1 else './dashboards'
    total = 0
    migrated = 0
    for fname in os.listdir(dashboards_dir):
        if fname.endswith('.json'):
            total += 1
            path = os.path.join(dashboards_dir, fname)
            print(f"Processing: {fname}")
            if migrate_dashboard(path):
                migrated += 1
    print(f"\nMigrated {migrated}/{total} dashboards.")
```

## Summary

Recording rules are the primary performance lever available to Prometheus operators. The `level:metric:operations` naming convention makes pre-computed series self-documenting. Cardinality discipline—aggregating away pod, path, and other high-cardinality labels—prevents recording rules from worsening the problems they exist to solve. Multi-level aggregation chains, parallel rule groups, and evaluation time monitoring keep large deployments healthy. The remote write filtering pattern means long-term storage backends receive only the curated series that actually matter for trend analysis and capacity planning, while the local Prometheus retains the full raw data for short-term incident investigation. With unit-tested rule files, validated migrations, and automated dashboard query replacement, recording rules become a managed, reviewable part of the monitoring codebase rather than an ad-hoc performance fix.
