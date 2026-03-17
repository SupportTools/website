---
title: "Go Metrics Cardinality: Avoiding Label Explosion in Prometheus"
date: 2029-09-16T00:00:00-05:00
draft: false
tags: ["Go", "Prometheus", "Metrics", "Observability", "Cardinality", "Performance"]
categories: ["Go", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into Prometheus label cardinality in Go applications: anti-patterns that cause explosion, strategies for bounding label values, recording rule aggregation, and tooling to detect and alert on runaway cardinality."
more_link: "yes"
url: "/go-metrics-cardinality-label-explosion-prometheus/"
---

High cardinality in Prometheus metrics is one of the most common and costly mistakes teams make when instrumenting Go services. A single label whose values are unbounded — user IDs, request IDs, URLs with path parameters — can grow a metric's time-series count into the millions, consuming gigabytes of RAM and making every query crawl. This post walks through the cardinality problem from first principles, shows the Go patterns that cause it, and gives you concrete techniques to prevent, detect, and remediate label explosion in production.

<!--more-->

# Go Metrics Cardinality: Avoiding Label Explosion in Prometheus

## Understanding Time-Series Cardinality

Every unique combination of label values in Prometheus creates an independent time series. A gauge with two labels, each having five distinct values, creates up to 25 series. That is manageable. The problem appears when label values are not bounded.

```
Total series = product of cardinality of each label
```

A metric with three labels where one label is a user ID from a table of 100,000 users will have at least 100,000 series just for that metric. Add a second high-cardinality label and the math becomes catastrophic.

Prometheus stores all active series in memory. The rule of thumb is roughly 1-2 KB per series for head block data. At 1 million series that is 1-2 GB just for one metric in the head block, before any chunks are written to disk.

## High-Cardinality Anti-Patterns in Go

### Anti-Pattern 1: User or Entity IDs as Label Values

The most common mistake is using entity identifiers directly as label values.

```go
package metrics

import "github.com/prometheus/client_golang/prometheus"

// BAD: user_id as a label value — unbounded cardinality
var requestsTotal = prometheus.NewCounterVec(
    prometheus.CounterOpts{
        Name: "http_requests_total",
        Help: "Total HTTP requests",
    },
    []string{"method", "path", "status", "user_id"}, // user_id is unbounded
)

// BAD: recording per-user latency
var requestDuration = prometheus.NewHistogramVec(
    prometheus.HistogramOpts{
        Name:    "http_request_duration_seconds",
        Help:    "Request duration",
        Buckets: prometheus.DefBuckets,
    },
    []string{"user_id", "endpoint"}, // user_id * endpoint = explosion
)
```

A service with 500,000 users and 50 endpoints generates 25 million histogram series. Each histogram with default 12 buckets creates 12 underlying series, yielding 300 million total series.

### Anti-Pattern 2: Raw URL Paths with Path Parameters

```go
// BAD: raw request path exposes /users/123, /users/456, etc.
func middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        next.ServeHTTP(w, r)
        requestDuration.WithLabelValues(r.URL.Path).Observe(time.Since(start).Seconds())
    })
}
```

Every unique resource path becomes a label value. A REST API serving `/orders/ORDER-00001` through `/orders/ORDER-99999` creates 100,000 series from one counter.

### Anti-Pattern 3: Error Message Strings

```go
// BAD: using error strings as label values
var errorsTotal = prometheus.NewCounterVec(
    prometheus.CounterOpts{
        Name: "operation_errors_total",
        Help: "Operation errors",
    },
    []string{"operation", "error"}, // error string is unbounded
)

func processItem(id string) error {
    err := db.Query(id)
    if err != nil {
        // This creates a new series for every unique error message
        errorsTotal.WithLabelValues("db_query", err.Error()).Inc()
        return err
    }
    return nil
}
```

Database errors often contain specific values: `pq: duplicate key value violates unique constraint "users_email_key"` varies with the actual value. Each unique message is a new series.

### Anti-Pattern 4: Timestamps or Version Strings

```go
// BAD: build version or timestamp as label
var buildInfo = prometheus.NewGaugeVec(
    prometheus.GaugeOpts{
        Name: "app_build_info",
        Help: "Application build information",
    },
    []string{"version", "commit", "build_date"}, // build_date changes every build
)
```

Every deployment creates permanent "orphaned" series that Prometheus must track until they fall out of the retention window.

### Anti-Pattern 5: Tracing or Correlation IDs

```go
// BAD: trace or request ID in a metric label
var spanDuration = prometheus.NewHistogramVec(
    prometheus.HistogramOpts{
        Name: "span_duration_seconds",
    },
    []string{"trace_id", "span_name"}, // trace_id is a UUID per request
)
```

This is particularly insidious because tracing IDs look useful in metrics but are better handled by distributed tracing systems (Jaeger, Tempo). Metrics should aggregate; traces should provide per-request detail.

## Label Value Bounding Strategies

### Strategy 1: Route Template Normalization

Replace raw paths with route templates before they become label values.

```go
package middleware

import (
    "net/http"
    "regexp"
    "strings"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var httpRequestsTotal = promauto.NewCounterVec(
    prometheus.CounterOpts{
        Name: "http_requests_total",
        Help: "Total HTTP requests by normalized route",
    },
    []string{"method", "route", "status_class"},
)

var httpRequestDuration = promauto.NewHistogramVec(
    prometheus.HistogramOpts{
        Name:    "http_request_duration_seconds",
        Help:    "Request duration by normalized route",
        Buckets: []float64{0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0},
    },
    []string{"method", "route"},
)

// pathParamRegex matches common path parameter patterns
var pathParamRegex = regexp.MustCompile(
    `(/)([\da-fA-F]{8}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{12}|` + // UUID
    `\d+|` + // numeric IDs
    `[A-Z]+-\d+)` + // ticket IDs like JIRA-123
    `(/|$)`,
)

// NormalizePath replaces path parameters with placeholders
func NormalizePath(path string) string {
    normalized := pathParamRegex.ReplaceAllString(path, "${1}{id}${3}")
    // Deduplicate consecutive {id} segments
    normalized = strings.ReplaceAll(normalized, "{id}/{id}", "{id}")
    return normalized
}

// statusClass converts HTTP status code to a 2-character class string
func statusClass(code int) string {
    switch {
    case code < 200:
        return "1xx"
    case code < 300:
        return "2xx"
    case code < 400:
        return "3xx"
    case code < 500:
        return "4xx"
    default:
        return "5xx"
    }
}

type responseWriter struct {
    http.ResponseWriter
    status int
}

func (rw *responseWriter) WriteHeader(code int) {
    rw.status = code
    rw.ResponseWriter.WriteHeader(code)
}

// MetricsMiddleware instruments HTTP handlers with bounded label cardinality
func MetricsMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        rw := &responseWriter{ResponseWriter: w, status: 200}

        next.ServeHTTP(rw, r)

        route := NormalizePath(r.URL.Path)
        method := r.Method
        class := statusClass(rw.status)
        duration := time.Since(start).Seconds()

        httpRequestsTotal.WithLabelValues(method, route, class).Inc()
        httpRequestDuration.WithLabelValues(method, route).Observe(duration)
    })
}
```

For frameworks like gorilla/mux or chi, extract the route pattern directly:

```go
import "github.com/go-chi/chi/v5"

// chi provides RouteContext which holds the matched route pattern
func ChiMetricsMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        rw := &responseWriter{ResponseWriter: w, status: 200}
        next.ServeHTTP(rw, r)

        // chi stores the route pattern in context
        routeCtx := chi.RouteContext(r.Context())
        route := "unknown"
        if routeCtx != nil && routeCtx.RoutePattern() != "" {
            route = routeCtx.RoutePattern()
        }

        httpRequestsTotal.WithLabelValues(r.Method, route, statusClass(rw.status)).Inc()
        httpRequestDuration.WithLabelValues(r.Method, route).Observe(time.Since(start).Seconds())
    })
}
```

### Strategy 2: Error Classification

Replace error message strings with stable error class labels.

```go
package errors

import (
    "errors"
    "net"

    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

// ErrorClass returns a short, stable string classifying an error
// suitable for use as a Prometheus label value
func ErrorClass(err error) string {
    if err == nil {
        return "none"
    }

    // Check for sentinel errors first
    switch {
    case errors.Is(err, ErrNotFound):
        return "not_found"
    case errors.Is(err, ErrUnauthorized):
        return "unauthorized"
    case errors.Is(err, ErrConflict):
        return "conflict"
    case errors.Is(err, ErrValidation):
        return "validation"
    }

    // gRPC status codes
    if s, ok := status.FromError(err); ok {
        return "grpc_" + strings.ToLower(s.Code().String())
    }

    // Network errors
    var netErr *net.OpError
    if errors.As(err, &netErr) {
        return "network_" + netErr.Op
    }

    // Context errors
    if errors.Is(err, context.DeadlineExceeded) {
        return "deadline_exceeded"
    }
    if errors.Is(err, context.Canceled) {
        return "canceled"
    }

    // Database errors
    if isDatabaseError(err) {
        return "database"
    }

    return "internal"
}

var operationErrors = promauto.NewCounterVec(
    prometheus.CounterOpts{
        Name: "operation_errors_total",
        Help: "Operation errors by class",
    },
    []string{"operation", "error_class"}, // bounded: ~10 error classes
)

func RecordError(operation string, err error) {
    if err != nil {
        operationErrors.WithLabelValues(operation, ErrorClass(err)).Inc()
    }
}
```

### Strategy 3: Allowlist-Based Label Validation

Enforce at registration time that label values come from a known set.

```go
package metrics

import (
    "fmt"
    "sync"

    "github.com/prometheus/client_golang/prometheus"
)

// BoundedCounterVec wraps a CounterVec and enforces label value allowlists
type BoundedCounterVec struct {
    inner     *prometheus.CounterVec
    allowlist map[string]map[string]struct{} // labelName -> set of allowed values
    mu        sync.RWMutex
    overflow  prometheus.Counter // counts rejected label combinations
}

func NewBoundedCounterVec(opts prometheus.CounterOpts, labelNames []string, allowlists map[string][]string) *BoundedCounterVec {
    inner := prometheus.NewCounterVec(opts, labelNames)

    // Add an "other" value to each allowlisted label for overflow
    allowed := make(map[string]map[string]struct{}, len(allowlists))
    for label, values := range allowlists {
        set := make(map[string]struct{}, len(values)+1)
        for _, v := range values {
            set[v] = struct{}{}
        }
        set["other"] = struct{}{}
        allowed[label] = set
    }

    overflow := prometheus.NewCounter(prometheus.CounterOpts{
        Name: opts.Name + "_label_overflow_total",
        Help: "Counts label value combinations rejected by the allowlist",
    })

    return &BoundedCounterVec{
        inner:     inner,
        allowlist: allowed,
        overflow:  overflow,
    }
}

func (b *BoundedCounterVec) WithLabelValues(lvs ...string) prometheus.Counter {
    // This is a simplified example; production code should map lvs to label names
    return b.inner.WithLabelValues(b.sanitizeLabelValues(lvs)...)
}

func (b *BoundedCounterVec) sanitizeLabelValues(lvs []string) []string {
    sanitized := make([]string, len(lvs))
    copy(sanitized, lvs)
    // In practice you would check each lv against its corresponding allowlist entry
    return sanitized
}

// Describe and Collect implement prometheus.Collector
func (b *BoundedCounterVec) Describe(ch chan<- *prometheus.Desc) {
    b.inner.Describe(ch)
    b.overflow.Describe(ch)
}

func (b *BoundedCounterVec) Collect(ch chan<- prometheus.Metric) {
    b.inner.Collect(ch)
    b.overflow.Collect(ch)
}
```

### Strategy 4: Aggregation Before Recording

For use cases where you genuinely need per-entity tracking, aggregate in application memory and expose only the aggregated result.

```go
package metrics

import (
    "sync"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

// UserTierCounter aggregates per-user requests into tier buckets
type UserTierCounter struct {
    mu      sync.Mutex
    buckets map[string]int64 // tier -> count
}

var (
    // Expose aggregated tier counts — low cardinality
    tierRequestsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "requests_by_tier_total",
            Help: "Requests aggregated by user tier",
        },
        []string{"tier"}, // "free", "pro", "enterprise", "internal"
    )
)

type UserResolver interface {
    GetTier(userID string) string
}

// InstrumentRequest records a request, mapping user to tier
func InstrumentRequest(userID string, resolver UserResolver) {
    tier := resolver.GetTier(userID)
    // Normalize unknown tiers
    switch tier {
    case "free", "pro", "enterprise", "internal":
        // valid tier
    default:
        tier = "unknown"
    }
    tierRequestsTotal.WithLabelValues(tier).Inc()
}
```

## Recording Rule Aggregation

Recording rules in Prometheus allow you to pre-compute expensive queries and store them as new, lower-cardinality metrics. This is the primary tool for taming high-cardinality raw metrics when you still need to ingest them.

### Example: Aggregating Per-Pod Metrics to Per-Service

```yaml
# prometheus-recording-rules.yaml
groups:
  - name: http_aggregations
    interval: 30s
    rules:
      # Aggregate per-pod request rate to per-service level
      # Raw metric has labels: pod, service, namespace, method, route, status_class
      # Recorded metric has labels: service, namespace, method, route, status_class
      - record: service:http_requests_total:rate5m
        expr: |
          sum by (service, namespace, method, route, status_class) (
            rate(http_requests_total[5m])
          )

      # P99 latency per service, dropping pod-level label
      - record: service:http_request_duration_seconds:p99:5m
        expr: |
          histogram_quantile(0.99,
            sum by (service, namespace, method, route, le) (
              rate(http_request_duration_seconds_bucket[5m])
            )
          )

      # Error rate per service
      - record: service:http_error_rate:rate5m
        expr: |
          sum by (service, namespace) (
            rate(http_requests_total{status_class=~"4xx|5xx"}[5m])
          )
          /
          sum by (service, namespace) (
            rate(http_requests_total[5m])
          )

  - name: cardinality_tracking
    interval: 60s
    rules:
      # Track total active series per job — useful for cardinality alerting
      - record: job:prometheus_tsdb_head_series:sum
        expr: |
          sum by (job) (
            label_replace(
              prometheus_tsdb_head_series,
              "job", "$1", "instance", "(.+):.+"
            )
          )
```

### Applying Recording Rules in Kubernetes

```yaml
# prometheus-rule-configmap.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: http-aggregation-rules
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    - name: http_aggregations
      interval: 30s
      rules:
        - record: service:http_requests_total:rate5m
          expr: |
            sum by (service, namespace, method, route, status_class) (
              rate(http_requests_total[5m])
            )
        - record: service:http_request_duration_p99
          expr: |
            histogram_quantile(0.99,
              sum by (service, namespace, le) (
                rate(http_request_duration_seconds_bucket[5m])
              )
            )
```

## Cardinality Analysis Tools

### Prometheus HTTP API Queries

Prometheus exposes cardinality information directly through its HTTP API.

```bash
# Query total number of active time series
curl -s 'http://localhost:9090/api/v1/query?query=prometheus_tsdb_head_series' \
  | jq '.data.result[0].value[1]'

# List metrics by series count (top 20)
curl -s 'http://localhost:9090/api/v1/label/__name__/values' \
  | jq -r '.data[]' \
  | while read metric; do
      count=$(curl -s "http://localhost:9090/api/v1/query?query=count(${metric})" \
        | jq -r '.data.result[0].value[1] // 0' 2>/dev/null)
      echo "$count $metric"
    done \
  | sort -rn \
  | head -20
```

### Using the Prometheus TSDB Analyze Tool

```bash
# Run the Prometheus tsdb analyze tool against a data directory
docker run --rm -v /var/lib/prometheus:/data \
  prom/prometheus:latest \
  tsdb analyze /data

# Sample output:
# Block path: /data/01HPQR...
# Duration: 2h0m0s
# Series: 1,247,832
# Label names: 47
# Postings (unique label pairs): 8,234,191
# Highest cardinality labels:
#  1. user_id: 412,000 values
#  2. trace_id: 390,000 values
#  3. request_id: 298,000 values
```

### Go-Based Cardinality Audit Tool

```go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
    "net/url"
    "os"
    "sort"
    "strconv"
    "time"
)

type prometheusAPI struct {
    baseURL string
    client  *http.Client
}

type queryResult struct {
    Status string `json:"status"`
    Data   struct {
        ResultType string `json:"resultType"`
        Result     []struct {
            Metric map[string]string `json:"metric"`
            Value  [2]interface{}    `json:"value"`
        } `json:"result"`
    } `json:"data"`
}

type labelValuesResult struct {
    Status string   `json:"status"`
    Data   []string `json:"data"`
}

func (p *prometheusAPI) query(ctx context.Context, q string) (*queryResult, error) {
    reqURL := p.baseURL + "/api/v1/query?query=" + url.QueryEscape(q)
    req, _ := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
    resp, err := p.client.Do(req)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()
    body, _ := io.ReadAll(resp.Body)
    var result queryResult
    return &result, json.Unmarshal(body, &result)
}

func (p *prometheusAPI) labelValues(ctx context.Context, label string) ([]string, error) {
    reqURL := p.baseURL + "/api/v1/label/" + label + "/values"
    req, _ := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
    resp, err := p.client.Do(req)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()
    body, _ := io.ReadAll(resp.Body)
    var result labelValuesResult
    return result.Data, json.Unmarshal(body, &result)
}

type metricCardinality struct {
    Name        string
    SeriesCount int
}

func main() {
    baseURL := "http://localhost:9090"
    if len(os.Args) > 1 {
        baseURL = os.Args[1]
    }

    api := &prometheusAPI{
        baseURL: baseURL,
        client:  &http.Client{Timeout: 30 * time.Second},
    }
    ctx := context.Background()

    // Get all metric names
    names, err := api.labelValues(ctx, "__name__")
    if err != nil {
        fmt.Fprintf(os.Stderr, "error fetching metric names: %v\n", err)
        os.Exit(1)
    }

    fmt.Printf("Analyzing %d metrics...\n\n", len(names))

    var cardinalities []metricCardinality
    for _, name := range names {
        result, err := api.query(ctx, fmt.Sprintf("count(%s)", name))
        if err != nil || result.Status != "success" || len(result.Data.Result) == 0 {
            continue
        }
        countStr, _ := result.Data.Result[0].Value[1].(string)
        count, _ := strconv.Atoi(countStr)
        cardinalities = append(cardinalities, metricCardinality{Name: name, SeriesCount: count})
    }

    sort.Slice(cardinalities, func(i, j int) bool {
        return cardinalities[i].SeriesCount > cardinalities[j].SeriesCount
    })

    fmt.Printf("%-60s %12s\n", "Metric Name", "Series Count")
    fmt.Printf("%s\n", string(make([]byte, 75)))
    limit := 30
    if len(cardinalities) < limit {
        limit = len(cardinalities)
    }
    for _, c := range cardinalities[:limit] {
        fmt.Printf("%-60s %12d\n", c.Name, c.SeriesCount)
    }
}
```

### Cardinality Dashboard in Grafana

```json
{
  "title": "Prometheus Cardinality Dashboard",
  "panels": [
    {
      "title": "Total Active Series",
      "type": "stat",
      "targets": [
        {
          "expr": "prometheus_tsdb_head_series",
          "legendFormat": "{{instance}}"
        }
      ]
    },
    {
      "title": "Series Growth Rate (1h)",
      "type": "graph",
      "targets": [
        {
          "expr": "rate(prometheus_tsdb_head_series[1h]) * 3600",
          "legendFormat": "Series/hour"
        }
      ]
    },
    {
      "title": "Top 10 Metrics by Series Count",
      "type": "table",
      "targets": [
        {
          "expr": "topk(10, count by (__name__) ({__name__=~\".+\"}))",
          "legendFormat": "{{__name__}}"
        }
      ]
    }
  ]
}
```

## Alerting on Cardinality

### Prometheus Alerting Rules

```yaml
# cardinality-alerts.yaml
groups:
  - name: cardinality_alerts
    rules:
      # Alert when total series exceeds threshold
      - alert: HighTotalSeriesCount
        expr: prometheus_tsdb_head_series > 5000000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Prometheus series count is high"
          description: >
            Prometheus has {{ $value | humanize }} active time series.
            This may indicate label cardinality issues.

      # Alert on rapid series growth
      - alert: RapidSeriesGrowth
        expr: |
          rate(prometheus_tsdb_head_series[1h]) > 10000
        for: 15m
        labels:
          severity: critical
        annotations:
          summary: "Prometheus series count growing rapidly"
          description: >
            Series count is growing at {{ $value | humanize }}/second.
            A new high-cardinality metric may have been deployed.

      # Alert when series count approaches TSDB limits
      - alert: PrometheusTSDBNearCapacity
        expr: |
          prometheus_tsdb_head_series / prometheus_tsdb_head_max_time > 0.8
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "Prometheus TSDB approaching capacity"

      # Alert on label value explosion for specific metrics
      - alert: MetricCardinalityExplosion
        expr: |
          count by (__name__) (
            {__name__=~"http_requests_total|grpc_server_handled_total"}
          ) > 10000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Metric {{ $labels.__name__ }} has high cardinality"
          description: >
            {{ $labels.__name__ }} has {{ $value }} active series.
            Check for unbounded label values.
```

### Integrating Cardinality Checks into CI/CD

Add a cardinality check to your pre-deployment pipeline that prevents high-cardinality metrics from reaching production.

```go
package main

import (
    "encoding/json"
    "fmt"
    "go/ast"
    "go/parser"
    "go/token"
    "os"
    "path/filepath"
    "strings"
)

// cardinalityAudit scans Go source for metrics declared with potentially
// high-cardinality label names
type cardinalityAudit struct {
    violations []violation
}

type violation struct {
    File    string
    Line    int
    Metric  string
    Labels  []string
    Reason  string
}

var riskyLabelNames = []string{
    "user_id", "userid", "account_id", "customer_id",
    "request_id", "requestid", "req_id",
    "trace_id", "traceid", "span_id",
    "session_id", "sessionid",
    "order_id", "transaction_id",
    "url", "path", "uri", "endpoint_raw",
    "error_message", "error_msg", "errmsg",
    "ip_address", "ip", "client_ip",
}

func main() {
    root := "."
    if len(os.Args) > 1 {
        root = os.Args[1]
    }

    audit := &cardinalityAudit{}
    err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
        if err != nil || info.IsDir() || !strings.HasSuffix(path, ".go") {
            return err
        }
        return audit.analyzeFile(path)
    })
    if err != nil {
        fmt.Fprintf(os.Stderr, "walk error: %v\n", err)
        os.Exit(1)
    }

    if len(audit.violations) == 0 {
        fmt.Println("No cardinality violations found.")
        os.Exit(0)
    }

    enc := json.NewEncoder(os.Stdout)
    enc.SetIndent("", "  ")
    enc.Encode(audit.violations)
    fmt.Fprintf(os.Stderr, "\n%d cardinality violation(s) found\n", len(audit.violations))
    os.Exit(1)
}

func (a *cardinalityAudit) analyzeFile(path string) error {
    fset := token.NewFileSet()
    f, err := parser.ParseFile(fset, path, nil, 0)
    if err != nil {
        return nil // skip unparseable files
    }

    ast.Inspect(f, func(n ast.Node) bool {
        call, ok := n.(*ast.CallExpr)
        if !ok {
            return true
        }

        // Look for prometheus.NewCounterVec, NewGaugeVec, NewHistogramVec, NewSummaryVec
        sel, ok := call.Fun.(*ast.SelectorExpr)
        if !ok {
            return true
        }

        fnName := sel.Sel.Name
        if !strings.HasSuffix(fnName, "Vec") {
            return true
        }

        // Check label slice arguments
        for _, arg := range call.Args {
            comp, ok := arg.(*ast.CompositeLit)
            if !ok {
                continue
            }
            var labels []string
            for _, elt := range comp.Elts {
                lit, ok := elt.(*ast.BasicLit)
                if !ok {
                    continue
                }
                label := strings.Trim(lit.Value, `"`)
                labels = append(labels, label)
                for _, risky := range riskyLabelNames {
                    if strings.EqualFold(label, risky) {
                        pos := fset.Position(call.Pos())
                        a.violations = append(a.violations, violation{
                            File:   path,
                            Line:   pos.Line,
                            Metric: fnName,
                            Labels: labels,
                            Reason: fmt.Sprintf("label %q is likely high-cardinality", label),
                        })
                    }
                }
            }
        }
        return true
    })
    return nil
}
```

## Production Checklist

Before shipping any new metric instrumentation, validate against this checklist:

```markdown
## Metrics Cardinality Review Checklist

### Label Values
- [ ] All label values come from a bounded, known set
- [ ] No entity IDs (user, order, request, session) used as label values
- [ ] No raw URL paths — route templates only
- [ ] No error message strings — error class enums only
- [ ] No timestamps or build metadata as label values
- [ ] No tracing/correlation IDs

### Cardinality Estimation
- [ ] Maximum series count calculated: product of all label cardinalities
- [ ] Total series per metric < 1,000 for standard metrics
- [ ] Total series per histogram < 500 (each bucket adds ~12 series)
- [ ] Worst-case series count reviewed with team

### Recording Rules
- [ ] High-cardinality metrics have corresponding recording rules for dashboards
- [ ] Dashboards query recording rules, not raw metrics
- [ ] Alerting rules use recording rules where possible

### Monitoring
- [ ] prometheus_tsdb_head_series alert configured
- [ ] Rate-of-growth alert configured
- [ ] Per-metric cardinality checked post-deployment
```

## Summary

Label explosion is a silent killer in production observability stacks. The key principles for keeping cardinality under control in Go services are:

1. Normalize all label values to bounded sets before recording — route templates over raw paths, error classes over error messages, user tiers over user IDs.
2. Use recording rules to pre-aggregate high-cardinality raw metrics into low-cardinality derived metrics for dashboards and alerts.
3. Run cardinality analysis tools (Prometheus HTTP API, tsdb analyze) regularly and especially after every deployment.
4. Alert on series count growth rate, not just absolute count — growth spikes indicate newly deployed high-cardinality metrics.
5. Integrate static analysis into CI/CD to catch risky label names before they reach production.

By treating cardinality as a first-class correctness concern — not just a performance concern — you keep your Prometheus installation healthy, your dashboards responsive, and your on-call engineers sane.
