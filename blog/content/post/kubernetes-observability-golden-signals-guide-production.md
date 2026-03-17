---
title: "Kubernetes Observability: The Four Golden Signals and USE/RED Methods"
date: 2028-02-21T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Observability", "Prometheus", "Grafana", "Monitoring", "SRE", "Alerting"]
categories:
- Kubernetes
- Monitoring
- SRE
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to implementing the Four Golden Signals, USE method, and RED method for Kubernetes observability. Covers PromQL patterns, Grafana dashboard construction, exemplar integration, and production alerting strategies."
more_link: "yes"
url: "/kubernetes-observability-golden-signals-guide/"
---

Google's Site Reliability Engineering discipline introduced the Four Golden Signals—Latency, Traffic, Errors, and Saturation—as the minimum set of metrics needed to understand a service's health. The USE method (Utilization, Saturation, Errors) from Brendan Gregg provides a complementary framework for infrastructure resources, and the RED method (Rate, Errors, Duration) applies naturally to request-driven microservices.

Together, these three methodologies provide a complete observability framework for Kubernetes deployments: USE monitors the nodes and cluster resources that workloads run on, RED monitors individual service endpoints, and the Four Golden Signals provide service-level health signals that map directly to user experience. This guide implements all three using Prometheus, Grafana, and OpenTelemetry exemplars.

<!--more-->

# Kubernetes Observability: The Four Golden Signals and USE/RED Methods

## Observability Framework Overview

The three methodologies complement each other at different levels of the stack:

```
┌─────────────────────────────────────────────────────────────┐
│                Four Golden Signals (Service Level)           │
│   Latency | Traffic | Errors | Saturation                   │
│   Focus: User experience and business impact                 │
├─────────────────────────────────────────────────────────────┤
│                RED Method (Request Level)                    │
│   Rate | Errors | Duration                                   │
│   Focus: Individual service health                           │
├─────────────────────────────────────────────────────────────┤
│                USE Method (Resource Level)                   │
│   Utilization | Saturation | Errors                         │
│   Focus: Infrastructure capacity                             │
└─────────────────────────────────────────────────────────────┘
```

## Instrumenting Go Services

### Standard Prometheus Metrics for RED

```go
// metrics/metrics.go
// Standard metrics package implementing RED method signals.
// Import this package in any service to get consistent observability.
package metrics

import (
    "net/http"
    "strconv"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

// RED metrics: Rate, Errors, Duration
// These implement the RED method for request-driven services.
var (
    // Rate: requests per second
    // Computed as rate(http_requests_total[5m]) in Prometheus
    HTTPRequestsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "http_requests_total",
            Help: "Total number of HTTP requests, partitioned by status code and method",
        },
        []string{"method", "path", "status_code"},
    )

    // Duration: request latency
    // Use histograms (not summaries) for aggregable quantile computation
    HTTPRequestDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name: "http_request_duration_seconds",
            Help: "HTTP request duration in seconds",
            // Buckets optimized for web services
            // Align buckets to SLO boundaries (e.g., 100ms, 500ms, 1s)
            Buckets: []float64{
                0.005, 0.010, 0.025, 0.050, 0.100,  // < 100ms (fast)
                0.250, 0.500, 1.000,                  // 100ms-1s (acceptable)
                2.500, 5.000, 10.000,                  // > 1s (slow)
            },
            // NativeHistogram enables high-resolution quantile computation
            // without pre-specifying buckets (Prometheus 2.40+)
            NativeHistogramBucketFactor:     1.1,
            NativeHistogramMaxBucketNumber:  100,
            NativeHistogramMinResetDuration: 1 * time.Hour,
        },
        []string{"method", "path"},
    )

    // Errors: partition by error type for actionable alerts
    HTTPErrors = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "http_errors_total",
            Help: "Total number of HTTP errors, partitioned by type",
        },
        []string{"method", "path", "error_type"},
    )

    // In-flight requests: a saturation signal
    // High values relative to capacity indicate the service is saturated
    HTTPRequestsInFlight = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "http_requests_in_flight",
            Help: "Current number of HTTP requests being served",
        },
        []string{"method", "path"},
    )
)

// Middleware wraps an http.Handler with RED metrics instrumentation.
// Apply to all routes in the service.
func Middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        path := normalizePathForLabel(r.URL.Path)
        method := r.Method

        // Track in-flight requests (saturation signal)
        HTTPRequestsInFlight.WithLabelValues(method, path).Inc()
        defer HTTPRequestsInFlight.WithLabelValues(method, path).Dec()

        // Capture response status code via wrapped ResponseWriter
        rw := newStatusCapture(w)
        start := time.Now()

        next.ServeHTTP(rw, r)

        duration := time.Since(start).Seconds()
        statusCode := strconv.Itoa(rw.statusCode)

        // Record request count (Rate)
        HTTPRequestsTotal.WithLabelValues(method, path, statusCode).Inc()

        // Record duration (Duration)
        HTTPRequestDuration.WithLabelValues(method, path).Observe(duration)

        // Record errors separately for cleaner error rate calculation
        if rw.statusCode >= 500 {
            HTTPErrors.WithLabelValues(method, path, "server_error").Inc()
        } else if rw.statusCode >= 400 {
            HTTPErrors.WithLabelValues(method, path, "client_error").Inc()
        }
    })
}

// normalizePathForLabel prevents high-cardinality labels from
// variable path segments (e.g., /users/12345 -> /users/:id)
func normalizePathForLabel(path string) string {
    // In production, use a router that provides the pattern
    // e.g., chi: chi.RouteContext(r.Context()).RoutePattern()
    // This simple version is a placeholder
    return path
}

// statusCapture wraps http.ResponseWriter to capture the status code.
type statusCapture struct {
    http.ResponseWriter
    statusCode int
}

func newStatusCapture(w http.ResponseWriter) *statusCapture {
    return &statusCapture{w, http.StatusOK}
}

func (sc *statusCapture) WriteHeader(statusCode int) {
    sc.statusCode = statusCode
    sc.ResponseWriter.WriteHeader(statusCode)
}
```

### Business Metrics for Golden Signals

```go
// metrics/business.go
// Business-level metrics that form the Traffic golden signal.
// These measure actual business outcomes, not just HTTP counts.
package metrics

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    // Traffic signal: business events per second
    OrdersProcessed = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "orders_processed_total",
            Help: "Total number of orders processed",
        },
        []string{"payment_method", "status"},
    )

    OrderValue = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "order_value_dollars",
            Help:    "Distribution of order values in dollars",
            Buckets: prometheus.ExponentialBuckets(1, 2, 15), // $1 to ~$32K
        },
        []string{"payment_method"},
    )

    // Saturation signal: queue depth as a saturation indicator
    // When queue depth grows, the service is saturated
    ProcessingQueueDepth = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "processing_queue_depth",
        Help: "Current number of items waiting to be processed",
    })

    // Latency signal: business operation latency (not just HTTP)
    // This is more meaningful than HTTP latency for async operations
    OrderProcessingDuration = promauto.NewHistogram(prometheus.HistogramOpts{
        Name:    "order_processing_duration_seconds",
        Help:    "End-to-end order processing time from receipt to confirmation",
        Buckets: prometheus.ExponentialBuckets(0.1, 2, 12),
    })
)
```

## USE Method: Infrastructure Resource Metrics

### Node Utilization, Saturation, and Errors

```promql
# --- UTILIZATION ---

# CPU utilization per node (1 = 100% utilized)
# Use 1m avg to smooth short spikes; use 5m for alerting
1 - avg by (node) (
  rate(node_cpu_seconds_total{mode="idle"}[5m])
)

# Memory utilization: used / available
# Excludes cache/buffers which are reclaimable
1 - (
  node_memory_MemAvailable_bytes
  / node_memory_MemTotal_bytes
)

# Disk utilization: filesystem usage
(
  node_filesystem_size_bytes{mountpoint="/"}
  - node_filesystem_free_bytes{mountpoint="/"}
) / node_filesystem_size_bytes{mountpoint="/"}

# Network bandwidth utilization (% of interface capacity)
# Requires knowing the interface capacity; often use absolute values
rate(node_network_transmit_bytes_total{device!="lo"}[5m]) * 8  # Convert to bits

# --- SATURATION ---

# CPU saturation: run queue (load average) relative to CPU count
# > 1.0 means processes waiting for CPU
node_load1 / count by (node) (
  node_cpu_seconds_total{mode="idle"}
)

# Memory saturation: pages being swapped (memory is saturated when swapping)
rate(node_vmstat_pgpgin[5m])   # Pages swapped in (reads from swap)

# Disk saturation: I/O utilization (time disk was busy)
# > 0.9 indicates disk is saturated
rate(node_disk_io_time_seconds_total{device="sda"}[5m])

# CPU throttling in containers (cgroups)
# Pods being throttled = Kubernetes CPU saturation
sum by (namespace, pod, container) (
  rate(container_cpu_cfs_throttled_periods_total[5m])
) / sum by (namespace, pod, container) (
  rate(container_cpu_cfs_periods_total[5m])
)

# --- ERRORS ---

# Hardware error events
# node_edac_* metrics for memory ECC errors
rate(node_edac_correctable_errors_total[5m])    # Correctable (warning)
rate(node_edac_uncorrectable_errors_total[5m])  # Uncorrectable (critical)

# Disk errors
rate(node_disk_read_errors_total[5m])
rate(node_disk_write_errors_total[5m])

# Network errors
rate(node_network_receive_errs_total[5m])
rate(node_network_transmit_errs_total[5m])
```

### USE Method Dashboard Panels

```json
// grafana-use-panel.json
// Grafana panel configuration for CPU USE (as JSON model fragment)
{
  "title": "CPU USE Method",
  "type": "row",
  "panels": [
    {
      "title": "CPU Utilization",
      "type": "timeseries",
      "targets": [
        {
          "expr": "1 - avg by (node) (rate(node_cpu_seconds_total{mode='idle'}[5m]))",
          "legendFormat": "{{ node }}"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "percentunit",
          "max": 1,
          "thresholds": {
            "steps": [
              {"color": "green", "value": 0},
              {"color": "yellow", "value": 0.7},
              {"color": "red", "value": 0.9}
            ]
          }
        }
      }
    }
  ]
}
```

## RED Method: Service Request Metrics

### Rate, Errors, Duration PromQL

```promql
# --- RATE ---

# Requests per second for all HTTP methods and paths
sum(rate(http_requests_total[5m]))

# Requests per second by service and status code
sum by (service, status_code) (
  rate(http_requests_total[5m])
)

# Per-path request rate to identify high-traffic endpoints
topk(10,
  sum by (path) (
    rate(http_requests_total[5m])
  )
)

# --- ERRORS ---

# HTTP 5xx error rate (server-side errors)
sum(rate(http_requests_total{status_code=~"5.."}[5m]))
/ sum(rate(http_requests_total[5m]))

# Error rate by path (for endpoint-level triage)
sum by (path) (rate(http_requests_total{status_code=~"5.."}[5m]))
/ sum by (path) (rate(http_requests_total[5m]))

# Separate client errors (4xx) from server errors (5xx)
# Client errors are often not actionable but affect user experience
sum(rate(http_requests_total{status_code=~"4.."}[5m]))

# --- DURATION ---

# P50 request latency
histogram_quantile(0.50,
  sum by (le) (
    rate(http_request_duration_seconds_bucket[5m])
  )
)

# P99 request latency (SLO boundary)
histogram_quantile(0.99,
  sum by (le) (
    rate(http_request_duration_seconds_bucket[5m])
  )
)

# P99 latency per path (to identify slow endpoints)
histogram_quantile(0.99,
  sum by (le, path) (
    rate(http_request_duration_seconds_bucket[5m])
  )
)

# Latency heatmap data (for Grafana heatmap panel)
sum by (le) (
  rate(http_request_duration_seconds_bucket[5m])
)
```

## Four Golden Signals Implementation

### Signal 1: Latency

```promql
# Latency is measured as the time to service a request.
# Separate successful requests from failed requests:
# failed requests have meaningless latency (they fail fast).

# P99 latency for successful requests only
histogram_quantile(0.99,
  sum by (le, path) (
    rate(http_request_duration_seconds_bucket{
      status_code!~"5.."    # Exclude server errors
    }[5m])
  )
)

# Compare slow requests to SLO target
# Count requests exceeding 500ms SLO target
sum(
  rate(http_request_duration_seconds_bucket{le="0.5"}[5m])
) / sum(
  rate(http_request_duration_seconds_count[5m])
)
# This computes the fraction of requests meeting the 500ms SLO

# Latency by percentile (for Grafana stat panel showing p50/p95/p99)
# P50
histogram_quantile(0.50,
  sum by (le) (rate(http_request_duration_seconds_bucket[5m]))
)
```

### Signal 2: Traffic

```promql
# Traffic measures the demand on the system.
# Use business-meaningful metrics where possible.

# HTTP requests per second
sum(rate(http_requests_total[5m]))

# Business transactions per second (more meaningful)
sum(rate(orders_processed_total{status="success"}[5m]))

# Traffic by component for capacity planning
sum by (service) (
  rate(http_requests_total[5m])
)

# Traffic trends: 7-day comparison for capacity planning
sum(rate(http_requests_total[5m]))
/
sum(rate(http_requests_total[5m] offset 7d))
```

### Signal 3: Errors

```promql
# Errors measure the rate of failing requests.
# Define "error" clearly: include both explicit (5xx) and implicit
# (wrong content, slow responses, canceled requests).

# HTTP 5xx error rate
sum(rate(http_requests_total{status_code=~"5.."}[5m]))
/ sum(rate(http_requests_total[5m]))

# Service-level error rate (including application-level errors)
# Some errors are returned as 200 OK with error in the body
# Track application errors separately via custom metrics
sum(rate(application_errors_total[5m]))

# Error budget burn rate (for SLO-based alerting)
# SLO: 99.9% availability = 0.1% error budget
# Burn rate > 1 means consuming budget faster than allowed
sum(rate(http_requests_total{status_code=~"5.."}[1h]))
/ sum(rate(http_requests_total[1h]))
/ 0.001   # Divide by error budget (1 - 0.999)
```

### Signal 4: Saturation

```promql
# Saturation measures how "full" a service is.
# The most relevant saturation metric depends on the service's
# constraint: CPU, memory, connections, queue depth, etc.

# CPU saturation (container-level)
sum by (pod, namespace) (
  rate(container_cpu_usage_seconds_total[5m])
) / sum by (pod, namespace) (
  kube_pod_container_resource_limits{resource="cpu"}
)

# Memory saturation
sum by (pod, namespace) (container_memory_working_set_bytes)
/ sum by (pod, namespace) (
  kube_pod_container_resource_limits{resource="memory"}
)

# Connection pool saturation (for database-heavy services)
# Requires custom metric instrumentation
sum(db_connection_pool_in_use)
/ sum(db_connection_pool_max_size)

# Request queue saturation (in-flight vs. configured limit)
sum(http_requests_in_flight)
/ scalar(http_max_concurrent_requests)   # Configured concurrency limit

# Thread pool saturation (Java/thread-per-request services)
sum(jvm_threads_live_threads)
/ sum(jvm_threads_peak_threads)
```

## Exemplars: Connecting Metrics to Traces

Exemplars attach a trace ID to metric observations, enabling direct navigation from a slow query in a dashboard to the distributed trace for that specific request:

```go
// exemplars.go
// Attaches trace exemplars to Prometheus histogram observations.
// Enables clicking a slow data point in Grafana and jumping to Jaeger/Tempo.
package metrics

import (
    "context"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "go.opentelemetry.io/otel/trace"
)

// ObserveWithExemplar records a histogram observation with a trace exemplar.
// The trace span from the current context is attached to the observation.
func ObserveWithExemplar(
    ctx context.Context,
    histogram *prometheus.HistogramVec,
    value float64,
    labels prometheus.Labels,
    labelValues ...string,
) {
    span := trace.SpanFromContext(ctx)
    if !span.SpanContext().IsValid() {
        // No active trace; record without exemplar
        histogram.WithLabelValues(labelValues...).Observe(value)
        return
    }

    // Extract trace and span IDs for the exemplar
    traceID := span.SpanContext().TraceID().String()
    spanID := span.SpanContext().SpanID().String()

    // ObserverVec with exemplar requires the prometheus.ExemplarObserver interface
    if obsEx, ok := histogram.WithLabelValues(labelValues...).(prometheus.ExemplarObserver); ok {
        obsEx.ObserveWithExemplar(value, prometheus.Labels{
            "traceID": traceID,
            "spanID":  spanID,
        })
    } else {
        histogram.WithLabelValues(labelValues...).Observe(value)
    }
}

// ExemplarMiddleware wraps the standard middleware with exemplar support.
func ExemplarMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        path := normalizePathForLabel(r.URL.Path)
        method := r.Method

        rw := newStatusCapture(w)
        start := time.Now()

        next.ServeHTTP(rw, r)

        duration := time.Since(start).Seconds()

        // Record with exemplar (attaches current trace context)
        ObserveWithExemplar(
            r.Context(),
            HTTPRequestDuration,
            duration,
            nil,
            method, path,
        )

        HTTPRequestsTotal.WithLabelValues(
            method, path, strconv.Itoa(rw.statusCode),
        ).Inc()
    })
}
```

```yaml
# grafana-exemplar-config.yaml
# Configure Grafana to show exemplar dots on histogram panels.
# Clicking an exemplar navigates to the trace in Tempo/Jaeger.
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-datasources
  namespace: monitoring
data:
  datasources.yaml: |
    apiVersion: 1
    datasources:
    - name: Prometheus
      type: prometheus
      url: http://prometheus.monitoring.svc:9090
      isDefault: true
      jsonData:
        # Enable exemplars display on metrics panels
        exemplarTraceIdDestinations:
        - name: traceID
          datasourceUid: tempo    # Link to Tempo data source
          urlDisplayLabel: "View Trace in Tempo"

    - name: Tempo
      type: tempo
      uid: tempo
      url: http://tempo.monitoring.svc:3100
      jsonData:
        tracesToMetrics:
          datasourceUid: prometheus   # Link back to metrics from traces
          tags:
          - key: service.name
            value: service
```

## Alerting on Golden Signals

### Multi-Window, Multi-Burn-Rate SLO Alerts

```yaml
# prometheus-slo-alerts.yaml
# Production alerting using multi-window burn-rate approach
# from Google's SRE Workbook. Provides fast detection of severe
# outages while avoiding alert fatigue for minor degradations.
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: golden-signals-slo-alerts
  namespace: monitoring
spec:
  groups:
  # --- Latency Alerts ---
  - name: latency.slo
    rules:
    # Fast burn: latency SLO is at risk within ~1 hour
    # P99 > 1s for 2 minutes is likely user-impacting
    - alert: LatencySLOFastBurn
      expr: >
        histogram_quantile(0.99,
          sum by (le, service) (
            rate(http_request_duration_seconds_bucket[5m])
          )
        ) > 1.0
        and
        histogram_quantile(0.99,
          sum by (le, service) (
            rate(http_request_duration_seconds_bucket[1h])
          )
        ) > 1.0
      for: 2m
      labels:
        severity: critical
        team: platform
      annotations:
        summary: "Latency SLO fast burn: P99 > 1s for service {{ $labels.service }}"
        description: >
          Service {{ $labels.service }} P99 latency is {{ $value | humanizeDuration }},
          exceeding the 1s SLO threshold. Burn rate indicates SLO exhaustion within hours.
        runbook_url: "https://runbooks.example.com/latency-slo"

    # Slow burn: latency SLO degraded over a longer window
    - alert: LatencySLOSlowBurn
      expr: >
        histogram_quantile(0.99,
          sum by (le, service) (
            rate(http_request_duration_seconds_bucket[6h])
          )
        ) > 0.5
      for: 15m
      labels:
        severity: warning
        team: platform
      annotations:
        summary: "Latency SLO slow burn: P99 elevated for {{ $labels.service }}"

  # --- Error Rate Alerts ---
  - name: errors.slo
    rules:
    # Page-worthy: error rate is high enough to exhaust error budget quickly
    # Burn rate 14.4x consumes 1-hour budget in 5 minutes
    - alert: ErrorRateFastBurn
      expr: >
        (
          sum by (service) (rate(http_requests_total{status_code=~"5.."}[5m]))
          / sum by (service) (rate(http_requests_total[5m]))
        ) > 14.4 * 0.001     # 14.4x burn rate, 0.1% error budget
        and
        (
          sum by (service) (rate(http_requests_total{status_code=~"5.."}[1h]))
          / sum by (service) (rate(http_requests_total[1h]))
        ) > 14.4 * 0.001
      for: 2m
      labels:
        severity: critical
        team: platform
      annotations:
        summary: "Error rate fast burn for {{ $labels.service }}"
        description: >
          Service {{ $labels.service }} error rate is {{ $value | humanizePercentage }},
          representing a 14.4x burn rate against the 0.1% error budget.

    # Ticket-worthy: elevated error rate that will consume monthly budget
    # Burn rate 1x over 6 hours means notable degradation
    - alert: ErrorRateSlowBurn
      expr: >
        (
          sum by (service) (rate(http_requests_total{status_code=~"5.."}[6h]))
          / sum by (service) (rate(http_requests_total[6h]))
        ) > 0.001     # Exceeding error budget (not burning fast)
      for: 30m
      labels:
        severity: warning
        team: platform
      annotations:
        summary: "Error rate slow burn for {{ $labels.service }}"

  # --- Saturation Alerts ---
  - name: saturation
    rules:
    # Container CPU throttling alert
    - alert: ContainerCPUThrottlingHigh
      expr: >
        sum by (namespace, pod, container) (
          rate(container_cpu_cfs_throttled_periods_total[5m])
        )
        /
        sum by (namespace, pod, container) (
          rate(container_cpu_cfs_periods_total[5m])
        ) > 0.25     # > 25% of CPU periods throttled
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Container {{ $labels.container }} in pod {{ $labels.pod }} is CPU throttled"
        description: >
          Container {{ $labels.namespace }}/{{ $labels.pod }}/{{ $labels.container }}
          is throttled {{ $value | humanizePercentage }} of the time.
          Consider increasing CPU limits.

    # Memory saturation
    - alert: ContainerMemorySaturationHigh
      expr: >
        sum by (namespace, pod, container) (container_memory_working_set_bytes)
        /
        sum by (namespace, pod, container) (
          kube_pod_container_resource_limits{resource="memory"}
        ) > 0.85
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Container {{ $labels.container }} memory near limit"
        description: >
          Container {{ $labels.namespace }}/{{ $labels.pod }}/{{ $labels.container }}
          is using {{ $value | humanizePercentage }} of its memory limit.
          OOM kill risk at high saturation.
```

## Grafana Dashboard Construction

### Four Golden Signals Dashboard (as Code)

```yaml
# grafana-golden-signals-dashboard.yaml
# Grafana dashboard as ConfigMap for GitOps deployment.
# The JSON content defines the complete dashboard structure.
apiVersion: v1
kind: ConfigMap
metadata:
  name: four-golden-signals-dashboard
  namespace: monitoring
  labels:
    grafana_dashboard: "1"   # Grafana sidecar discovers this label
data:
  golden-signals.json: |
    {
      "title": "Four Golden Signals",
      "uid": "four-golden-signals",
      "refresh": "30s",
      "time": {"from": "now-1h", "to": "now"},
      "variables": [
        {
          "name": "service",
          "type": "query",
          "datasource": "Prometheus",
          "query": "label_values(http_requests_total, service)",
          "multi": true,
          "includeAll": true
        },
        {
          "name": "namespace",
          "type": "query",
          "datasource": "Prometheus",
          "query": "label_values(kube_pod_info, namespace)",
          "multi": false
        }
      ],
      "panels": [
        {
          "title": "Request Rate (Traffic)",
          "type": "timeseries",
          "gridPos": {"h": 8, "w": 12, "x": 0, "y": 0},
          "targets": [
            {
              "expr": "sum by (service) (rate(http_requests_total{service=~\"$service\"}[5m]))",
              "legendFormat": "{{ service }}"
            }
          ],
          "fieldConfig": {
            "defaults": {
              "unit": "reqps",
              "custom": {"lineWidth": 2}
            }
          }
        },
        {
          "title": "Error Rate (Errors)",
          "type": "timeseries",
          "gridPos": {"h": 8, "w": 12, "x": 12, "y": 0},
          "targets": [
            {
              "expr": "sum by (service) (rate(http_requests_total{service=~\"$service\",status_code=~\"5..\"}[5m])) / sum by (service) (rate(http_requests_total{service=~\"$service\"}[5m]))",
              "legendFormat": "{{ service }}"
            }
          ],
          "fieldConfig": {
            "defaults": {
              "unit": "percentunit",
              "thresholds": {
                "steps": [
                  {"color": "green", "value": 0},
                  {"color": "yellow", "value": 0.001},
                  {"color": "red", "value": 0.01}
                ]
              }
            }
          }
        },
        {
          "title": "P99 Latency (Latency)",
          "type": "timeseries",
          "gridPos": {"h": 8, "w": 12, "x": 0, "y": 8},
          "targets": [
            {
              "expr": "histogram_quantile(0.99, sum by (le, service) (rate(http_request_duration_seconds_bucket{service=~\"$service\"}[5m])))",
              "legendFormat": "p99 {{ service }}",
              "exemplar": true
            },
            {
              "expr": "histogram_quantile(0.50, sum by (le, service) (rate(http_request_duration_seconds_bucket{service=~\"$service\"}[5m])))",
              "legendFormat": "p50 {{ service }}"
            }
          ],
          "fieldConfig": {
            "defaults": {
              "unit": "s",
              "custom": {
                "showPoints": "never"
              }
            },
            "overrides": [
              {
                "matcher": {"id": "byName", "options": "p99 .*"},
                "properties": [
                  {"id": "custom.lineWidth", "value": 2}
                ]
              }
            ]
          }
        },
        {
          "title": "CPU Saturation",
          "type": "timeseries",
          "gridPos": {"h": 8, "w": 12, "x": 12, "y": 8},
          "targets": [
            {
              "expr": "sum by (pod) (rate(container_cpu_cfs_throttled_periods_total{namespace=\"$namespace\"}[5m])) / sum by (pod) (rate(container_cpu_cfs_periods_total{namespace=\"$namespace\"}[5m]))",
              "legendFormat": "{{ pod }}"
            }
          ],
          "fieldConfig": {
            "defaults": {
              "unit": "percentunit",
              "max": 1,
              "thresholds": {
                "steps": [
                  {"color": "green", "value": 0},
                  {"color": "yellow", "value": 0.1},
                  {"color": "red", "value": 0.25}
                ]
              }
            }
          }
        }
      ]
    }
```

## SLO Recording Rules

Recording rules pre-compute expensive queries, improving dashboard responsiveness and enabling efficient alert evaluation:

```yaml
# slo-recording-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: slo-recording-rules
  namespace: monitoring
spec:
  groups:
  - name: slo.recording
    interval: 60s
    rules:
    # Pre-compute error rates for common time windows
    # These avoid repeated computation in dashboards and alerts
    - record: job:http_requests_total:rate5m
      expr: sum by (job, status_code) (rate(http_requests_total[5m]))

    - record: job:http_errors:rate5m
      expr: sum by (job) (rate(http_requests_total{status_code=~"5.."}[5m]))

    - record: job:http_error_ratio:rate5m
      expr: >
        sum by (job) (rate(http_requests_total{status_code=~"5.."}[5m]))
        /
        sum by (job) (rate(http_requests_total[5m]))

    # Pre-compute P99 latency for common windows
    - record: job:http_request_duration_seconds:p99_5m
      expr: >
        histogram_quantile(0.99,
          sum by (job, le) (
            rate(http_request_duration_seconds_bucket[5m])
          )
        )

    - record: job:http_request_duration_seconds:p50_5m
      expr: >
        histogram_quantile(0.50,
          sum by (job, le) (
            rate(http_request_duration_seconds_bucket[5m])
          )
        )

    # Error budget consumption rate
    # slo_target should be set as a constant metric or via recording rule
    - record: job:slo_error_budget_burn_rate:5m
      expr: >
        job:http_error_ratio:rate5m
        / (1 - 0.999)   # Hardcoded 99.9% SLO; use label-based config in practice
```

## Summary

The Four Golden Signals, USE method, and RED method provide a layered observability framework that addresses different aspects of Kubernetes service health. USE monitors infrastructure capacity constraints that create the floor for all service performance. RED focuses on individual service request handling, surfacing endpoint-level latency and error rates. The Four Golden Signals tie these together into a coherent service-level health picture that maps to user experience.

Implementing exemplars connects the metric timeseries to distributed traces for individual requests, enabling engineers to navigate from a latency spike on a dashboard to the specific trace that caused it. Multi-window burn-rate alerting on SLOs reduces alert fatigue by distinguishing between fast burns (page now) and slow burns (create a ticket), ensuring the on-call engineer is notified at the right time with actionable severity context.

Recording rules ensure that the complex PromQL required for these calculations remains performant at scale, while GitOps-managed Grafana dashboards ensure that observability infrastructure is treated with the same rigor as the services it monitors.
