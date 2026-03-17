---
title: "Kubernetes Service Level Objectives: Implementing RED Method Dashboards"
date: 2029-08-25T00:00:00-05:00
draft: false
tags: ["Kubernetes", "SLO", "SRE", "Prometheus", "Grafana", "RED Method", "Observability", "Monitoring"]
categories: ["Kubernetes", "Observability", "SRE"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to implementing Kubernetes SLOs using the RED Method (Rate/Errors/Duration) with Prometheus recording rules, Grafana dashboard templates, and SLO burn rate alerting for error budget management."
more_link: "yes"
url: "/kubernetes-service-level-objectives-red-method-dashboards/"
---

The RED Method — Rate, Errors, Duration — gives every service three signals that collectively answer the question "is this service healthy for its users?" When combined with Service Level Objectives and error budget burn rate alerting, these signals form a complete SLO framework that eliminates alert fatigue while ensuring reliability issues are detected before users are significantly impacted. This post covers the complete implementation: Prometheus recording rules, Grafana dashboards, and the mathematics behind multi-window burn rate alerts.

<!--more-->

# Kubernetes Service Level Objectives: Implementing RED Method Dashboards

## The RED Method

Tom Wilkie's RED Method defines three key metrics for any request-driven service:

- **Rate**: requests per second (throughput)
- **Errors**: percentage of requests that result in errors
- **Duration**: distribution of response times (latency histograms)

These three signals, together, tell you:
- **Rate**: is traffic normal? Unexpected drops indicate upstream failures or outages
- **Errors**: are users experiencing failures?
- **Duration**: are users waiting longer than expected?

## Service Level Objectives and Error Budgets

An SLO defines the target reliability for a service. For example:
- 99.9% of HTTP requests succeed (error rate SLO)
- 99% of requests complete in under 300ms (latency SLO)

The **error budget** is the inverse: how many failures are allowed per period.
- 99.9% SLO = 0.1% error budget = 43.8 minutes of downtime per month
- 99.99% SLO = 0.01% error budget = 4.38 minutes of downtime per month

**Burn rate** is how fast you're consuming the error budget relative to the period:
- Burn rate 1 = consuming budget at exactly the sustainable rate
- Burn rate 14.4 = consuming budget 14.4x faster than sustainable

Multi-window burn rate alerting (from the Google SRE Workbook) fires alerts based on how fast you're burning at different time windows, catching both fast (critical) and slow (warning) budget depletion.

## Prometheus Recording Rules for RED Metrics

### Basic RED Recording Rules

```yaml
# prometheus-red-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: red-method-recording-rules
  namespace: monitoring
  labels:
    prometheus: k8s
    role: alert-rules
spec:
  groups:
    # ============================================================
    # Rate (Request Rate)
    # ============================================================
    - name: red.rate
      interval: 30s
      rules:
        # Requests per second per service (5m window)
        - record: job:http_requests:rate5m
          expr: |
            sum by (job, namespace, service) (
              rate(http_requests_total[5m])
            )

        # Requests per second per service (1m window — for dashboards)
        - record: job:http_requests:rate1m
          expr: |
            sum by (job, namespace, service) (
              rate(http_requests_total[1m])
            )

        # Requests per second per status code class
        - record: job:http_requests_by_status:rate5m
          expr: |
            sum by (job, namespace, service, status_class) (
              label_replace(
                rate(http_requests_total[5m]),
                "status_class", "${1}xx",
                "status_code", "([0-9]).*"
              )
            )

    # ============================================================
    # Errors (Error Rate)
    # ============================================================
    - name: red.errors
      interval: 30s
      rules:
        # Error rate: fraction of requests that are errors (5m window)
        - record: job:http_request_errors:rate5m
          expr: |
            sum by (job, namespace, service) (
              rate(http_requests_total{status_code=~"5.."}[5m])
            )

        # Error ratio: 0.0 to 1.0 (5m window)
        - record: job:http_request_error_ratio:rate5m
          expr: |
            sum by (job, namespace, service) (
              rate(http_requests_total{status_code=~"5.."}[5m])
            )
            /
            sum by (job, namespace, service) (
              rate(http_requests_total[5m])
            )

        # Success ratio (complement of error ratio)
        - record: job:http_request_success_ratio:rate5m
          expr: |
            1 - job:http_request_error_ratio:rate5m

        # Error ratio over longer windows for SLO calculation
        - record: job:http_request_error_ratio:rate1h
          expr: |
            sum by (job, namespace, service) (
              rate(http_requests_total{status_code=~"5.."}[1h])
            )
            /
            sum by (job, namespace, service) (
              rate(http_requests_total[1h])
            )

        - record: job:http_request_error_ratio:rate6h
          expr: |
            sum by (job, namespace, service) (
              rate(http_requests_total{status_code=~"5.."}[6h])
            )
            /
            sum by (job, namespace, service) (
              rate(http_requests_total[6h])
            )

        - record: job:http_request_error_ratio:rate24h
          expr: |
            sum by (job, namespace, service) (
              rate(http_requests_total{status_code=~"5.."}[24h])
            )
            /
            sum by (job, namespace, service) (
              rate(http_requests_total[24h])
            )

        - record: job:http_request_error_ratio:rate30d
          expr: |
            sum by (job, namespace, service) (
              rate(http_requests_total{status_code=~"5.."}[30d])
            )
            /
            sum by (job, namespace, service) (
              rate(http_requests_total[30d])
            )

    # ============================================================
    # Duration (Latency)
    # ============================================================
    - name: red.duration
      interval: 30s
      rules:
        # p50 latency (5m window)
        - record: job:http_request_duration_p50:rate5m
          expr: |
            histogram_quantile(0.50,
              sum by (job, namespace, service, le) (
                rate(http_request_duration_seconds_bucket[5m])
              )
            )

        # p95 latency (5m window)
        - record: job:http_request_duration_p95:rate5m
          expr: |
            histogram_quantile(0.95,
              sum by (job, namespace, service, le) (
                rate(http_request_duration_seconds_bucket[5m])
              )
            )

        # p99 latency (5m window)
        - record: job:http_request_duration_p99:rate5m
          expr: |
            histogram_quantile(0.99,
              sum by (job, namespace, service, le) (
                rate(http_request_duration_seconds_bucket[5m])
              )
            )

        # Fraction of requests below SLO threshold (e.g., 300ms)
        # This is used for latency SLO compliance
        - record: job:http_request_duration_under_slo:rate5m
          expr: |
            sum by (job, namespace, service) (
              rate(http_request_duration_seconds_bucket{le="0.3"}[5m])
            )
            /
            sum by (job, namespace, service) (
              rate(http_request_duration_seconds_count[5m])
            )

        - record: job:http_request_duration_under_slo:rate30d
          expr: |
            sum by (job, namespace, service) (
              rate(http_request_duration_seconds_bucket{le="0.3"}[30d])
            )
            /
            sum by (job, namespace, service) (
              rate(http_request_duration_seconds_count[30d])
            )
```

### SLO Burn Rate Recording Rules

```yaml
# prometheus-slo-burnrate-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: slo-burn-rate-rules
  namespace: monitoring
spec:
  groups:
    - name: slo.burnrate
      interval: 30s
      rules:
        # Error budget remaining (99.9% SLO = 0.001 error budget)
        # Formula: 1 - (error_ratio_30d / (1 - SLO_target))
        - record: job:slo_error_budget_remaining:ratio
          expr: |
            1 - (
              job:http_request_error_ratio:rate30d
              / (1 - 0.999)
            )

        # Burn rate: current error rate / SLO error budget rate
        # burn_rate = error_rate_current / ((1 - SLO) / period)
        # For 99.9% SLO: (1 - 0.999) = 0.001 is the allowed error fraction
        # burn_rate = error_ratio_current / 0.001
        - record: job:slo_burn_rate:1h
          expr: |
            job:http_request_error_ratio:rate1h
            / (1 - 0.999)

        - record: job:slo_burn_rate:6h
          expr: |
            job:http_request_error_ratio:rate6h
            / (1 - 0.999)

        - record: job:slo_burn_rate:24h
          expr: |
            job:http_request_error_ratio:rate24h
            / (1 - 0.999)

        # Latency SLO burn rate: fraction of requests exceeding threshold
        # 99% of requests must be under 300ms
        - record: job:slo_latency_burn_rate:1h
          expr: |
            (1 - job:http_request_duration_under_slo:rate5m)
            / (1 - 0.99)
```

## SLO Alerting: Multi-Window Burn Rate

The Google SRE Workbook recommends multi-window burn rate alerts for SLOs. The principle: alert when you're burning your error budget fast enough that you'd exhaust it before the end of the period, using two windows to reduce false positives.

```yaml
# slo-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: slo-burn-rate-alerts
  namespace: monitoring
spec:
  groups:
    - name: slo.alerts
      rules:
        # CRITICAL: Burning budget at 14.4x rate over 1h AND 5m windows
        # At 14.4x, you exhaust a monthly budget in 2 days
        # Two-window approach: short window for recency, long window for confidence
        - alert: SLOHighErrorBudgetBurnRate
          expr: |
            (
              job:slo_burn_rate:1h{job="myapp"} > 14.4
              and
              job:slo_burn_rate:5m{job="myapp"} > 14.4
            )
          for: 2m
          labels:
            severity: critical
            slo: "99.9"
          annotations:
            summary: "{{ $labels.job }} burning SLO budget at critical rate"
            description: |
              Service {{ $labels.job }} is consuming its error budget at {{ $value | humanize }}x
              the sustainable rate. At this rate, the monthly budget will be exhausted in
              {{ div 720 $value | humanize }} hours.
            runbook_url: "https://runbooks.mycompany.com/slo-critical"

        # CRITICAL: Burning at 6x rate over 6h AND 30m windows
        # At 6x, you exhaust a monthly budget in 5 days
        - alert: SLOMediumHighErrorBudgetBurnRate
          expr: |
            (
              job:slo_burn_rate:6h{job="myapp"} > 6
              and
              job:slo_burn_rate:30m{job="myapp"} > 6
            )
          for: 15m
          labels:
            severity: critical
            slo: "99.9"
          annotations:
            summary: "{{ $labels.job }} burning SLO budget at elevated rate"
            description: |
              Service {{ $labels.job }} is consuming its error budget at {{ $value | humanize }}x
              the sustainable rate.

        # WARNING: Burning at 3x rate over 24h AND 6h windows
        # At 3x, you exhaust a monthly budget in 10 days
        - alert: SLOSlowBurnRate
          expr: |
            (
              job:slo_burn_rate:24h{job="myapp"} > 3
              and
              job:slo_burn_rate:6h{job="myapp"} > 3
            )
          for: 60m
          labels:
            severity: warning
            slo: "99.9"
          annotations:
            summary: "{{ $labels.job }} slow error budget burn"
            description: |
              Service {{ $labels.job }} is consuming its error budget at {{ $value | humanize }}x
              the sustainable rate over the past 24 hours.

        # Add the missing 5m and 30m burn rate recording rules
        - record: job:slo_burn_rate:5m
          expr: |
            job:http_request_error_ratio:rate5m
            / (1 - 0.999)

        - record: job:slo_burn_rate:30m
          expr: |
            sum by (job, namespace, service) (
              rate(http_requests_total{status_code=~"5.."}[30m])
            )
            /
            sum by (job, namespace, service) (
              rate(http_requests_total[30m])
            )
            / (1 - 0.999)

        # Latency SLO burn rate alerts
        - alert: SLOLatencyBudgetBurn
          expr: |
            job:slo_latency_burn_rate:1h{job="myapp"} > 14.4
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "{{ $labels.job }} latency SLO burn rate critical"
            description: "99th percentile latency exceeding SLO threshold at {{ $value | humanize }}x rate"
```

## Grafana Dashboard Templates

### RED Method Dashboard: Grafana JSON

```json
{
  "title": "RED Method - Service Overview",
  "uid": "red-method-service",
  "tags": ["red", "slo", "kubernetes"],
  "templating": {
    "list": [
      {
        "name": "namespace",
        "type": "query",
        "datasource": "Prometheus",
        "query": "label_values(http_requests_total, namespace)",
        "label": "Namespace"
      },
      {
        "name": "service",
        "type": "query",
        "datasource": "Prometheus",
        "query": "label_values(http_requests_total{namespace=~\"$namespace\"}, service)",
        "label": "Service"
      }
    ]
  },
  "panels": [
    {
      "title": "Request Rate (RPS)",
      "type": "timeseries",
      "gridPos": {"x": 0, "y": 0, "w": 8, "h": 8},
      "targets": [
        {
          "expr": "sum(rate(http_requests_total{namespace=~\"$namespace\", service=~\"$service\"}[5m]))",
          "legendFormat": "Total RPS"
        },
        {
          "expr": "sum by (status_class) (label_replace(rate(http_requests_total{namespace=~\"$namespace\", service=~\"$service\"}[5m]), \"status_class\", \"${1}xx\", \"status_code\", \"([0-9]).*\"))",
          "legendFormat": "{{status_class}}"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "reqps",
          "color": {"mode": "palette-classic"}
        }
      }
    },
    {
      "title": "Error Rate (%)",
      "type": "timeseries",
      "gridPos": {"x": 8, "y": 0, "w": 8, "h": 8},
      "targets": [
        {
          "expr": "100 * sum(rate(http_requests_total{namespace=~\"$namespace\", service=~\"$service\", status_code=~\"5..\"}[5m])) / sum(rate(http_requests_total{namespace=~\"$namespace\", service=~\"$service\"}[5m]))",
          "legendFormat": "Error Rate %"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "percent",
          "thresholds": {
            "steps": [
              {"color": "green", "value": null},
              {"color": "yellow", "value": 0.1},
              {"color": "red", "value": 1.0}
            ]
          }
        }
      }
    },
    {
      "title": "Request Duration Percentiles",
      "type": "timeseries",
      "gridPos": {"x": 16, "y": 0, "w": 8, "h": 8},
      "targets": [
        {
          "expr": "histogram_quantile(0.50, sum by (le) (rate(http_request_duration_seconds_bucket{namespace=~\"$namespace\", service=~\"$service\"}[5m])))",
          "legendFormat": "p50"
        },
        {
          "expr": "histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{namespace=~\"$namespace\", service=~\"$service\"}[5m])))",
          "legendFormat": "p95"
        },
        {
          "expr": "histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{namespace=~\"$namespace\", service=~\"$service\"}[5m])))",
          "legendFormat": "p99"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "s"
        }
      }
    }
  ]
}
```

### SLO Dashboard: Error Budget Panels

```yaml
# grafana-configmap.yaml — Dashboard as ConfigMap for GitOps
apiVersion: v1
kind: ConfigMap
metadata:
  name: slo-dashboard
  namespace: monitoring
  labels:
    grafana_dashboard: "1"
data:
  slo-dashboard.json: |
    {
      "title": "SLO Error Budget",
      "uid": "slo-error-budget",
      "panels": [
        {
          "title": "Error Budget Remaining (30d)",
          "type": "gauge",
          "targets": [{
            "expr": "100 * (1 - (sum(rate(http_requests_total{status_code=~\"5..\",job=\"$service\"}[30d])) / sum(rate(http_requests_total{job=\"$service\"}[30d])) / 0.001))",
            "legendFormat": "Budget %"
          }],
          "fieldConfig": {
            "defaults": {
              "unit": "percent",
              "min": 0,
              "max": 100,
              "thresholds": {
                "steps": [
                  {"color": "red", "value": null},
                  {"color": "yellow", "value": 25},
                  {"color": "green", "value": 50}
                ]
              }
            }
          }
        },
        {
          "title": "Burn Rate (1h)",
          "type": "stat",
          "targets": [{
            "expr": "sum(rate(http_requests_total{status_code=~\"5..\",job=\"$service\"}[1h])) / sum(rate(http_requests_total{job=\"$service\"}[1h])) / 0.001",
            "legendFormat": "Burn Rate"
          }],
          "fieldConfig": {
            "defaults": {
              "thresholds": {
                "steps": [
                  {"color": "green", "value": null},
                  {"color": "yellow", "value": 3},
                  {"color": "orange", "value": 6},
                  {"color": "red", "value": 14.4}
                ]
              }
            }
          }
        }
      ]
    }
```

### Grafana Dashboard as Code with Grafonnet

```go
// grafana/slo_dashboard.go — Generate Grafana dashboard JSON programmatically
package grafana

import (
    "encoding/json"
    "fmt"
)

type Dashboard struct {
    Title       string        `json:"title"`
    UID         string        `json:"uid"`
    Tags        []string      `json:"tags"`
    Templating  Templating    `json:"templating"`
    Panels      []Panel       `json:"panels"`
    Refresh     string        `json:"refresh"`
    Time        TimeRange     `json:"time"`
}

type Panel struct {
    Title       string        `json:"title"`
    Type        string        `json:"type"`
    GridPos     GridPos       `json:"gridPos"`
    Targets     []Target      `json:"targets"`
    FieldConfig FieldConfig   `json:"fieldConfig"`
    Options     interface{}   `json:"options,omitempty"`
}

type Target struct {
    Expr         string `json:"expr"`
    LegendFormat string `json:"legendFormat"`
    RefID        string `json:"refId"`
}

// GenerateREDDashboard generates a complete RED method dashboard
func GenerateREDDashboard(serviceName, namespace string) *Dashboard {
    sloTarget := 0.999  // 99.9% SLO
    errorBudget := 1 - sloTarget

    return &Dashboard{
        Title:   fmt.Sprintf("RED Dashboard - %s", serviceName),
        UID:     fmt.Sprintf("red-%s", serviceName),
        Tags:    []string{"red", "slo", "service=" + serviceName},
        Refresh: "30s",
        Time:    TimeRange{From: "now-3h", To: "now"},

        Panels: []Panel{
            // Rate panel
            {
                Title: "Request Rate",
                Type:  "timeseries",
                GridPos: GridPos{X: 0, Y: 0, W: 8, H: 8},
                Targets: []Target{
                    {
                        Expr:         fmt.Sprintf(`sum(rate(http_requests_total{namespace="%s",service="%s"}[5m]))`, namespace, serviceName),
                        LegendFormat: "RPS",
                        RefID:        "A",
                    },
                },
                FieldConfig: FieldConfig{
                    Defaults: FieldDefaults{Unit: "reqps"},
                },
            },
            // Error rate panel
            {
                Title: fmt.Sprintf("Error Rate vs SLO (%.1f%%)", (1-sloTarget)*100),
                Type:  "timeseries",
                GridPos: GridPos{X: 8, Y: 0, W: 8, H: 8},
                Targets: []Target{
                    {
                        Expr: fmt.Sprintf(`100 * sum(rate(http_requests_total{namespace="%s",service="%s",status_code=~"5.."}[5m])) / sum(rate(http_requests_total{namespace="%s",service="%s"}[5m]))`,
                            namespace, serviceName, namespace, serviceName),
                        LegendFormat: "Error %",
                        RefID:        "A",
                    },
                    {
                        Expr:         fmt.Sprintf("%.3f", errorBudget*100),
                        LegendFormat: "SLO Threshold",
                        RefID:        "B",
                    },
                },
                FieldConfig: FieldConfig{
                    Defaults: FieldDefaults{Unit: "percent"},
                },
            },
        },
    }
}

func (d *Dashboard) ToJSON() ([]byte, error) {
    return json.MarshalIndent(d, "", "  ")
}
```

## SLO Compliance Reporting

### Monthly SLO Report Query

```promql
# SLO compliance for the past 30 days
# Returns: fraction of requests that succeeded (should be >= SLO target)
sum(
  rate(http_requests_total{status_code!~"5..", job="myapp"}[30d])
)
/
sum(
  rate(http_requests_total{job="myapp"}[30d])
)

# Error budget consumed in the past 30 days
(
  sum(rate(http_requests_total{status_code=~"5..", job="myapp"}[30d]))
  /
  sum(rate(http_requests_total{job="myapp"}[30d]))
)
/ (1 - 0.999)

# Expected output:
# 0.0234 = 2.34% of budget consumed (well within 100% limit)
# 1.23   = 123% of budget consumed (budget exceeded)
```

### SLO Status Endpoint in Go

```go
// pkg/slo/reporter.go
package slo

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "time"

    "github.com/prometheus/client_golang/api"
    v1 "github.com/prometheus/client_golang/api/prometheus/v1"
    "github.com/prometheus/common/model"
)

type SLOStatus struct {
    ServiceName      string    `json:"service_name"`
    SLOTarget        float64   `json:"slo_target"`
    ErrorBudget      float64   `json:"error_budget"`
    Period           string    `json:"period"`
    CurrentErrorRate float64   `json:"current_error_rate"`
    BudgetRemaining  float64   `json:"budget_remaining_pct"`
    BurnRate1h       float64   `json:"burn_rate_1h"`
    BurnRate6h       float64   `json:"burn_rate_6h"`
    BurnRate24h      float64   `json:"burn_rate_24h"`
    Status           string    `json:"status"` // "healthy", "warning", "critical"
    ReportTime       time.Time `json:"report_time"`
}

type SLOReporter struct {
    promAPI     v1.API
    serviceName string
    sloTarget   float64
}

func NewSLOReporter(prometheusURL, serviceName string, sloTarget float64) (*SLOReporter, error) {
    client, err := api.NewClient(api.Config{
        Address: prometheusURL,
    })
    if err != nil {
        return nil, fmt.Errorf("creating prometheus client: %w", err)
    }

    return &SLOReporter{
        promAPI:     v1.NewAPI(client),
        serviceName: serviceName,
        sloTarget:   sloTarget,
    }, nil
}

func (r *SLOReporter) GetCurrentStatus(ctx context.Context) (*SLOStatus, error) {
    errorBudget := 1 - r.sloTarget

    // Query current error rate (30d window for SLO compliance)
    errorRate30d, err := r.queryScalar(ctx,
        fmt.Sprintf(`sum(rate(http_requests_total{status_code=~"5..",job="%s"}[30d])) / sum(rate(http_requests_total{job="%s"}[30d]))`,
            r.serviceName, r.serviceName))
    if err != nil {
        return nil, fmt.Errorf("querying 30d error rate: %w", err)
    }

    // Query burn rates
    burnRate1h, _ := r.queryScalar(ctx,
        fmt.Sprintf(`sum(rate(http_requests_total{status_code=~"5..",job="%s"}[1h])) / sum(rate(http_requests_total{job="%s"}[1h])) / %f`,
            r.serviceName, r.serviceName, errorBudget))

    burnRate6h, _ := r.queryScalar(ctx,
        fmt.Sprintf(`sum(rate(http_requests_total{status_code=~"5..",job="%s"}[6h])) / sum(rate(http_requests_total{job="%s"}[6h])) / %f`,
            r.serviceName, r.serviceName, errorBudget))

    burnRate24h, _ := r.queryScalar(ctx,
        fmt.Sprintf(`sum(rate(http_requests_total{status_code=~"5..",job="%s"}[24h])) / sum(rate(http_requests_total{job="%s"}[24h])) / %f`,
            r.serviceName, r.serviceName, errorBudget))

    budgetConsumed := errorRate30d / errorBudget
    budgetRemaining := (1 - budgetConsumed) * 100

    status := "healthy"
    if burnRate1h > 14.4 || burnRate6h > 6 {
        status = "critical"
    } else if burnRate24h > 3 {
        status = "warning"
    }

    return &SLOStatus{
        ServiceName:      r.serviceName,
        SLOTarget:        r.sloTarget * 100,
        ErrorBudget:      errorBudget * 100,
        Period:           "30d",
        CurrentErrorRate: errorRate30d * 100,
        BudgetRemaining:  budgetRemaining,
        BurnRate1h:       burnRate1h,
        BurnRate6h:       burnRate6h,
        BurnRate24h:      burnRate24h,
        Status:           status,
        ReportTime:       time.Now(),
    }, nil
}

func (r *SLOReporter) queryScalar(ctx context.Context, query string) (float64, error) {
    result, warnings, err := r.promAPI.Query(ctx, query, time.Now())
    if err != nil {
        return 0, err
    }
    _ = warnings

    if vector, ok := result.(model.Vector); ok && len(vector) > 0 {
        return float64(vector[0].Value), nil
    }
    return 0, nil
}

// HTTP handler for SLO status endpoint
func (r *SLOReporter) Handler() http.HandlerFunc {
    return func(w http.ResponseWriter, req *http.Request) {
        status, err := r.GetCurrentStatus(req.Context())
        if err != nil {
            http.Error(w, err.Error(), http.StatusInternalServerError)
            return
        }

        w.Header().Set("Content-Type", "application/json")
        if status.Status == "critical" {
            w.WriteHeader(http.StatusServiceUnavailable)
        }

        json.NewEncoder(w).Encode(status)
    }
}
```

## Kubernetes Service Monitor for RED Metrics

```yaml
# servicemonitor.yaml — Scrape configuration for applications
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: myapp-metrics
  namespace: production
  labels:
    app: myapp
spec:
  selector:
    matchLabels:
      app: myapp
  endpoints:
    - port: metrics
      interval: 15s
      path: /metrics
      # Relabel rules to add standard labels used in RED rules
      relabelings:
        - sourceLabels: [__meta_kubernetes_service_name]
          targetLabel: service
        - sourceLabels: [__meta_kubernetes_namespace]
          targetLabel: namespace
```

### Required Application Metrics

For the RED recording rules to work, applications must expose these metrics:

```go
// Required Prometheus metrics for RED method
package metrics

import (
    "net/http"
    "strconv"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    httpRequestsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "http_requests_total",
            Help: "Total number of HTTP requests",
        },
        []string{"method", "path", "status_code"},
    )

    httpRequestDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "http_request_duration_seconds",
            Help:    "HTTP request duration in seconds",
            Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10},
        },
        []string{"method", "path", "status_code"},
    )
)

// Middleware wraps HTTP handlers with RED metrics
func REDMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        rw := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}

        next.ServeHTTP(rw, r)

        duration := time.Since(start).Seconds()
        status := strconv.Itoa(rw.statusCode)

        // Normalize path to avoid cardinality explosion
        path := normalizePath(r.URL.Path)

        httpRequestsTotal.WithLabelValues(r.Method, path, status).Inc()
        httpRequestDuration.WithLabelValues(r.Method, path, status).Observe(duration)
    })
}

type responseWriter struct {
    http.ResponseWriter
    statusCode int
}

func (rw *responseWriter) WriteHeader(code int) {
    rw.statusCode = code
    rw.ResponseWriter.WriteHeader(code)
}

func normalizePath(path string) string {
    // Replace UUIDs and numeric IDs with placeholders
    // /users/12345 -> /users/:id
    // This prevents unbounded cardinality
    // Use your router's path pattern matching if available
    return path
}
```

The RED Method with SLO burn rate alerting provides a complete observability framework: three signals that answer "is the service healthy?", SLOs that answer "how reliable should it be?", and burn rate alerts that answer "when should we act?" The multi-window alerting approach minimizes false positives while ensuring you're paged fast enough to protect the error budget.
