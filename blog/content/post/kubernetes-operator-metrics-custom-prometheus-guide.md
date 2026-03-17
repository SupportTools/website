---
title: "Kubernetes Operator Metrics: Exposing Custom Prometheus Metrics"
date: 2029-10-14T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Operators", "Prometheus", "Metrics", "Monitoring", "controller-runtime", "Grafana"]
categories:
- Kubernetes
- Monitoring
- Platform Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to exposing custom Prometheus metrics from Kubernetes operators using controller-runtime, including custom collectors, reconcile error rates, queue depth, work duration histograms, and Grafana dashboard design."
more_link: "yes"
url: "/kubernetes-operator-metrics-custom-prometheus-guide/"
---

A Kubernetes operator without instrumentation is a black box. It may be reconciling resources, returning errors, or stuck in a retry loop — and you have no way to know unless you added metrics. controller-runtime provides a built-in metrics framework that registers with Prometheus automatically, but the default metrics only tell you what the framework is doing. This guide covers adding business-level metrics: reconcile error rates per resource type, workqueue depth, custom resource health, and reconcile duration histograms.

<!--more-->

# Kubernetes Operator Metrics: Exposing Custom Prometheus Metrics

## Section 1: controller-runtime Metrics Foundation

### What controller-runtime Provides by Default

When you create a controller-runtime manager, it automatically registers a Prometheus metrics endpoint at `:8080/metrics` (configurable). Default metrics include:

```
# Reconcile outcomes per controller
controller_runtime_reconcile_total{controller="myresource",result="success"}
controller_runtime_reconcile_total{controller="myresource",result="error"}
controller_runtime_reconcile_total{controller="myresource",result="requeue"}
controller_runtime_reconcile_total{controller="myresource",result="requeue_after"}

# Reconcile duration
controller_runtime_reconcile_time_seconds_bucket{controller="myresource", ...}

# Workqueue metrics
workqueue_depth{name="myresource"}
workqueue_adds_total{name="myresource"}
workqueue_queue_duration_seconds_bucket{name="myresource", ...}
workqueue_work_duration_seconds_bucket{name="myresource", ...}

# Active workers
controller_runtime_active_workers{controller="myresource"}
```

These are a starting point, but they lack context about why reconciles are failing or which specific resources are problematic.

### Setting Up the Manager with Metrics

```go
// main.go
package main

import (
    "os"

    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/log/zap"
    "sigs.k8s.io/controller-runtime/pkg/metrics/server"
)

func main() {
    opts := zap.Options{Development: false}
    ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))

    mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
        Scheme: scheme,
        Metrics: server.Options{
            // Metrics endpoint
            BindAddress: ":8080",
            // Secure serving for metrics (recommended for production)
            SecureServing: false,
        },
        // Health probe endpoint
        HealthProbeBindAddress: ":8081",
        LeaderElection:         true,
        LeaderElectionID:       "my-operator.example.com",
    })
    if err != nil {
        setupLog.Error(err, "unable to start manager")
        os.Exit(1)
    }

    if err = (&controllers.MyResourceReconciler{
        Client: mgr.GetClient(),
        Scheme: mgr.GetScheme(),
    }).SetupWithManager(mgr); err != nil {
        setupLog.Error(err, "unable to create controller")
        os.Exit(1)
    }

    if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
        setupLog.Error(err, "problem running manager")
        os.Exit(1)
    }
}
```

## Section 2: Custom Metrics Registration

### Defining Custom Metrics

Define all custom metrics in a dedicated metrics package so they can be imported cleanly:

```go
// internal/metrics/metrics.go
package metrics

import (
    "github.com/prometheus/client_golang/prometheus"
    "sigs.k8s.io/controller-runtime/pkg/metrics"
)

var (
    // ReconcileErrors counts reconcile errors with resource-level labels.
    ReconcileErrors = prometheus.NewCounterVec(
        prometheus.CounterOpts{
            Name: "myoperator_reconcile_errors_total",
            Help: "Total number of reconcile errors by controller and error type.",
        },
        []string{"controller", "resource_namespace", "resource_name", "error_type"},
    )

    // ReconcileDuration is a histogram of reconcile durations.
    // Buckets are tuned for typical Kubernetes operator operations.
    ReconcileDuration = prometheus.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "myoperator_reconcile_duration_seconds",
            Help:    "Reconcile duration in seconds by controller and outcome.",
            Buckets: []float64{0.001, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60},
        },
        []string{"controller", "result"},
    )

    // ResourcePhaseGauge tracks how many custom resources are in each phase.
    ResourcePhaseGauge = prometheus.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "myoperator_resource_phase",
            Help: "Number of MyResource objects in each phase.",
        },
        []string{"namespace", "phase"},
    )

    // ExternalAPILatency tracks calls to external APIs made during reconciliation.
    ExternalAPILatency = prometheus.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "myoperator_external_api_duration_seconds",
            Help:    "Duration of external API calls made during reconciliation.",
            Buckets: prometheus.DefBuckets,
        },
        []string{"api", "operation", "status"},
    )

    // ManagedResourceCount tracks how many child resources each CR manages.
    ManagedResourceCount = prometheus.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "myoperator_managed_resource_count",
            Help: "Number of child resources managed per custom resource.",
        },
        []string{"namespace", "name", "resource_type"},
    )

    // QueueRetryDepth tracks resources stuck in retry.
    QueueRetryDepth = prometheus.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "myoperator_retry_depth",
            Help: "Number of resources currently in backoff retry.",
        },
        []string{"controller"},
    )
)

func init() {
    // Register all metrics with the controller-runtime metrics registry.
    // This automatically includes them in the /metrics endpoint.
    metrics.Registry.MustRegister(
        ReconcileErrors,
        ReconcileDuration,
        ResourcePhaseGauge,
        ExternalAPILatency,
        ManagedResourceCount,
        QueueRetryDepth,
    )
}
```

## Section 3: Custom Prometheus Collectors

For metrics that require querying Kubernetes API objects at scrape time (not just incrementing counters), implement `prometheus.Collector`:

```go
// internal/metrics/resource_collector.go
package metrics

import (
    "context"

    "github.com/prometheus/client_golang/prometheus"
    apiv1 "github.com/myorg/myoperator/api/v1"
    "sigs.k8s.io/controller-runtime/pkg/client"
)

// ResourceStateCollector scrapes the live state of MyResource objects.
type ResourceStateCollector struct {
    client client.Client

    // Descriptors for each metric this collector produces
    healthyDesc   *prometheus.Desc
    unhealthyDesc *prometheus.Desc
    ageDesc       *prometheus.Desc
}

// NewResourceStateCollector creates a collector that reads live resource state.
func NewResourceStateCollector(c client.Client) *ResourceStateCollector {
    return &ResourceStateCollector{
        client: c,
        healthyDesc: prometheus.NewDesc(
            "myoperator_resource_healthy",
            "1 if the MyResource is healthy, 0 otherwise.",
            []string{"namespace", "name", "generation"},
            nil,
        ),
        unhealthyDesc: prometheus.NewDesc(
            "myoperator_resource_unhealthy_reason",
            "Unhealthy resources labeled by reason.",
            []string{"namespace", "name", "reason"},
            nil,
        ),
        ageDesc: prometheus.NewDesc(
            "myoperator_resource_age_seconds",
            "Age of the MyResource in seconds.",
            []string{"namespace", "name"},
            nil,
        ),
    }
}

// Describe implements prometheus.Collector.
func (c *ResourceStateCollector) Describe(ch chan<- *prometheus.Desc) {
    ch <- c.healthyDesc
    ch <- c.unhealthyDesc
    ch <- c.ageDesc
}

// Collect implements prometheus.Collector.
// This is called on every Prometheus scrape.
func (c *ResourceStateCollector) Collect(ch chan<- prometheus.Metric) {
    ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()

    var resourceList apiv1.MyResourceList
    if err := c.client.List(ctx, &resourceList); err != nil {
        // Emit a metric indicating collection failed
        ch <- prometheus.NewInvalidMetric(c.healthyDesc, err)
        return
    }

    for _, resource := range resourceList.Items {
        labels := []string{resource.Namespace, resource.Name}
        generation := fmt.Sprintf("%d", resource.Generation)

        // Health metric
        healthy := 0.0
        if resource.Status.Phase == "Ready" {
            healthy = 1.0
        }
        ch <- prometheus.MustNewConstMetric(
            c.healthyDesc,
            prometheus.GaugeValue,
            healthy,
            resource.Namespace, resource.Name, generation,
        )

        // Unhealthy reason metric
        if resource.Status.Phase != "Ready" && resource.Status.Reason != "" {
            ch <- prometheus.MustNewConstMetric(
                c.unhealthyDesc,
                prometheus.GaugeValue,
                1.0,
                resource.Namespace, resource.Name, resource.Status.Reason,
            )
        }

        // Age metric
        age := time.Since(resource.CreationTimestamp.Time).Seconds()
        ch <- prometheus.MustNewConstMetric(
            c.ageDesc,
            prometheus.GaugeValue,
            age,
            labels...,
        )
    }
}
```

### Registering the Custom Collector

```go
// main.go or setup function
import (
    ctrlmetrics "sigs.k8s.io/controller-runtime/pkg/metrics"
    "github.com/myorg/myoperator/internal/metrics"
)

func setupMetrics(mgr ctrl.Manager) {
    collector := metrics.NewResourceStateCollector(mgr.GetClient())
    ctrlmetrics.Registry.MustRegister(collector)
}
```

## Section 4: Instrumenting the Reconciler

### Reconciler with Full Instrumentation

```go
// controllers/myresource_controller.go
package controllers

import (
    "context"
    "fmt"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    apierrors "k8s.io/apimachinery/pkg/api/errors"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"

    apiv1 "github.com/myorg/myoperator/api/v1"
    "github.com/myorg/myoperator/internal/metrics"
)

// MyResourceReconciler reconciles MyResource objects.
type MyResourceReconciler struct {
    client.Client
    Scheme *runtime.Scheme

    // retryTracker tracks resources currently in backoff
    retryTracker map[types.NamespacedName]struct{}
    retryMu      sync.Mutex
}

// Reconcile is the main reconcile loop.
func (r *MyResourceReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    start := time.Now()
    log := log.FromContext(ctx)

    // Defer duration recording — result is set before defer runs
    result := "success"
    defer func() {
        metrics.ReconcileDuration.
            With(prometheus.Labels{
                "controller": "myresource",
                "result":     result,
            }).
            Observe(time.Since(start).Seconds())
    }()

    // Fetch the resource
    var resource apiv1.MyResource
    if err := r.Get(ctx, req.NamespacedName, &resource); err != nil {
        if apierrors.IsNotFound(err) {
            // Resource deleted — clean up retry tracking
            r.clearRetryTracking(req.NamespacedName)
            return ctrl.Result{}, nil
        }
        result = "error"
        metrics.ReconcileErrors.
            With(prometheus.Labels{
                "controller":         "myresource",
                "resource_namespace": req.Namespace,
                "resource_name":      req.Name,
                "error_type":         "get_failed",
            }).
            Inc()
        return ctrl.Result{}, fmt.Errorf("getting resource: %w", err)
    }

    // Handle deletion
    if !resource.DeletionTimestamp.IsZero() {
        return r.reconcileDelete(ctx, &resource)
    }

    // Main reconcile logic
    if err := r.reconcileNormal(ctx, &resource); err != nil {
        result = "error"

        // Categorize error for metrics
        errorType := categorizeError(err)
        metrics.ReconcileErrors.
            With(prometheus.Labels{
                "controller":         "myresource",
                "resource_namespace": req.Namespace,
                "resource_name":      req.Name,
                "error_type":         errorType,
            }).
            Inc()

        // Track that this resource is in retry
        r.addRetryTracking(req.NamespacedName)
        return ctrl.Result{}, err
    }

    // Clear retry tracking on success
    r.clearRetryTracking(req.NamespacedName)
    result = "success"
    return ctrl.Result{}, nil
}

func (r *MyResourceReconciler) reconcileNormal(ctx context.Context, resource *apiv1.MyResource) error {
    // Track external API calls
    apiStart := time.Now()
    err := r.callExternalAPI(ctx, resource)
    status := "success"
    if err != nil {
        status = "error"
    }
    metrics.ExternalAPILatency.
        With(prometheus.Labels{
            "api":       "provision-api",
            "operation": "create",
            "status":    status,
        }).
        Observe(time.Since(apiStart).Seconds())
    if err != nil {
        return fmt.Errorf("calling provision API: %w", err)
    }

    // Update phase metric
    r.updatePhaseMetrics(ctx)

    return nil
}

// updatePhaseMetrics refreshes the phase gauge by listing all resources.
// Call this at the end of each successful reconcile to keep gauges accurate.
func (r *MyResourceReconciler) updatePhaseMetrics(ctx context.Context) {
    var resourceList apiv1.MyResourceList
    if err := r.List(ctx, &resourceList); err != nil {
        return
    }

    // Reset all phase metrics before recomputing
    metrics.ResourcePhaseGauge.Reset()

    phaseCounts := make(map[string]map[string]float64)
    for _, res := range resourceList.Items {
        ns := res.Namespace
        phase := res.Status.Phase
        if phase == "" {
            phase = "Unknown"
        }
        if phaseCounts[ns] == nil {
            phaseCounts[ns] = make(map[string]float64)
        }
        phaseCounts[ns][phase]++
    }

    for ns, phases := range phaseCounts {
        for phase, count := range phases {
            metrics.ResourcePhaseGauge.
                With(prometheus.Labels{"namespace": ns, "phase": phase}).
                Set(count)
        }
    }
}

func (r *MyResourceReconciler) addRetryTracking(nn types.NamespacedName) {
    r.retryMu.Lock()
    defer r.retryMu.Unlock()
    r.retryTracker[nn] = struct{}{}
    metrics.QueueRetryDepth.
        With(prometheus.Labels{"controller": "myresource"}).
        Set(float64(len(r.retryTracker)))
}

func (r *MyResourceReconciler) clearRetryTracking(nn types.NamespacedName) {
    r.retryMu.Lock()
    defer r.retryMu.Unlock()
    delete(r.retryTracker, nn)
    metrics.QueueRetryDepth.
        With(prometheus.Labels{"controller": "myresource"}).
        Set(float64(len(r.retryTracker)))
}

// categorizeError returns a short string categorizing the error type.
func categorizeError(err error) string {
    switch {
    case apierrors.IsNotFound(err):
        return "not_found"
    case apierrors.IsConflict(err):
        return "conflict"
    case apierrors.IsTimeout(err):
        return "timeout"
    case apierrors.IsServerTimeout(err):
        return "server_timeout"
    default:
        return "unknown"
    }
}
```

## Section 5: Work Duration Histograms

Work duration histograms help identify which reconcile operations are slow. The controller-runtime default histogram has generic buckets. Custom histograms with operation labels give more actionable detail.

```go
// internal/metrics/histogram_middleware.go
package metrics

import (
    "context"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/reconcile"
)

// TimedOperation wraps a named operation with histogram timing.
type TimedOperation struct {
    histogram *prometheus.HistogramVec
    labels    prometheus.Labels
}

func NewTimedOperation(h *prometheus.HistogramVec, labels prometheus.Labels) *TimedOperation {
    return &TimedOperation{histogram: h, labels: labels}
}

func (t *TimedOperation) Execute(fn func() error) error {
    start := time.Now()
    err := fn()
    status := "success"
    if err != nil {
        status = "error"
    }
    l := make(prometheus.Labels)
    for k, v := range t.labels {
        l[k] = v
    }
    l["status"] = status
    t.histogram.With(l).Observe(time.Since(start).Seconds())
    return err
}

// Example: per-operation histogram
var OperationDuration = prometheus.NewHistogramVec(
    prometheus.HistogramOpts{
        Name:    "myoperator_operation_duration_seconds",
        Help:    "Duration of specific reconcile operations.",
        Buckets: []float64{0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5},
    },
    []string{"controller", "operation", "status"},
)
```

### Using Timed Operations in Reconciler

```go
func (r *MyResourceReconciler) reconcileNormal(ctx context.Context, resource *apiv1.MyResource) error {
    op := metrics.NewTimedOperation(metrics.OperationDuration, prometheus.Labels{
        "controller": "myresource",
        "operation":  "provision",
    })

    return op.Execute(func() error {
        return r.provision(ctx, resource)
    })
}
```

## Section 6: Queue Depth Monitoring

```go
// internal/metrics/queue_monitor.go
package metrics

import (
    "context"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "k8s.io/client-go/util/workqueue"
    ctrlmetrics "sigs.k8s.io/controller-runtime/pkg/metrics"
)

var (
    // QueueLength measures the current length of each workqueue.
    QueueLength = prometheus.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "myoperator_queue_length",
            Help: "Current number of items in the reconcile queue.",
        },
        []string{"controller"},
    )

    // MaxQueueLength tracks the peak queue length since startup.
    MaxQueueLength = prometheus.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "myoperator_queue_length_max",
            Help: "Maximum queue length seen since operator start.",
        },
        []string{"controller"},
    )
)

// QueueMetricsProvider implements workqueue.MetricsProvider.
type QueueMetricsProvider struct{}

func (p QueueMetricsProvider) NewDepthMetric(name string) workqueue.GaugeMetric {
    return QueueLength.WithLabelValues(name)
}

func (p QueueMetricsProvider) NewAddsMetric(name string) workqueue.CounterMetric {
    return prometheus.NewCounter(prometheus.CounterOpts{
        Name:        "myoperator_queue_adds_total",
        Help:        "Total number of items added to the queue.",
        ConstLabels: prometheus.Labels{"controller": name},
    })
}

func (p QueueMetricsProvider) NewLatencyMetric(name string) workqueue.HistogramMetric {
    return ReconcileDuration.WithLabelValues(name, "queued")
}

func (p QueueMetricsProvider) NewWorkDurationMetric(name string) workqueue.HistogramMetric {
    return ReconcileDuration.WithLabelValues(name, "processing")
}

func (p QueueMetricsProvider) NewUnfinishedWorkSecondsMetric(name string) workqueue.SettableGaugeMetric {
    return prometheus.NewGauge(prometheus.GaugeOpts{
        Name: "myoperator_unfinished_work_seconds",
        ConstLabels: prometheus.Labels{"controller": name},
    })
}

func (p QueueMetricsProvider) NewLongestRunningProcessorSecondsMetric(name string) workqueue.SettableGaugeMetric {
    return prometheus.NewGauge(prometheus.GaugeOpts{
        Name: "myoperator_longest_running_seconds",
        ConstLabels: prometheus.Labels{"controller": name},
    })
}

func (p QueueMetricsProvider) NewRetriesMetric(name string) workqueue.CounterMetric {
    return prometheus.NewCounter(prometheus.CounterOpts{
        Name: "myoperator_queue_retries_total",
        ConstLabels: prometheus.Labels{"controller": name},
    })
}
```

## Section 7: Grafana Dashboard

### Key Panels

```json
{
  "panels": [
    {
      "title": "Reconcile Rate",
      "type": "stat",
      "targets": [{
        "expr": "sum(rate(myoperator_reconcile_duration_seconds_count{result=\"success\"}[5m])) by (controller)",
        "legendFormat": "{{controller}}"
      }]
    },
    {
      "title": "Reconcile Error Rate",
      "type": "timeseries",
      "targets": [{
        "expr": "sum(rate(myoperator_reconcile_errors_total[5m])) by (controller, error_type)",
        "legendFormat": "{{controller}}/{{error_type}}"
      }]
    },
    {
      "title": "Reconcile Duration P99",
      "type": "timeseries",
      "targets": [{
        "expr": "histogram_quantile(0.99, sum(rate(myoperator_reconcile_duration_seconds_bucket[5m])) by (le, controller, result))",
        "legendFormat": "{{controller}} {{result}} p99"
      }]
    },
    {
      "title": "Queue Depth by Controller",
      "type": "timeseries",
      "targets": [{
        "expr": "myoperator_queue_length",
        "legendFormat": "{{controller}}"
      }]
    },
    {
      "title": "Resources in Retry",
      "type": "stat",
      "targets": [{
        "expr": "myoperator_retry_depth",
        "legendFormat": "{{controller}}"
      }]
    },
    {
      "title": "Resource Phase Distribution",
      "type": "piechart",
      "targets": [{
        "expr": "sum(myoperator_resource_phase) by (phase)",
        "legendFormat": "{{phase}}"
      }]
    },
    {
      "title": "External API Latency P95",
      "type": "timeseries",
      "targets": [{
        "expr": "histogram_quantile(0.95, sum(rate(myoperator_external_api_duration_seconds_bucket[5m])) by (le, api, operation))",
        "legendFormat": "{{api}}/{{operation}}"
      }]
    }
  ]
}
```

### ServiceMonitor for Prometheus Operator

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: myoperator
  namespace: myoperator-system
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      control-plane: controller-manager
  namespaceSelector:
    matchNames:
      - myoperator-system
  endpoints:
    - port: metrics
      interval: 30s
      scheme: http
      path: /metrics
      # For secure metrics endpoint:
      # scheme: https
      # tlsConfig:
      #   caFile: /etc/prometheus/secrets/metrics-tls/ca.crt
```

### PrometheusRule for Alerting

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: myoperator-alerts
  namespace: myoperator-system
spec:
  groups:
    - name: myoperator.rules
      interval: 30s
      rules:
        - alert: OperatorHighReconcileErrorRate
          expr: |
            rate(myoperator_reconcile_errors_total[5m]) > 0.1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Operator reconcile error rate is high"
            description: "Controller {{ $labels.controller }} has error rate {{ $value | humanize }}/s"

        - alert: OperatorQueueDepthHigh
          expr: |
            myoperator_queue_length > 100
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Operator workqueue depth is high"
            description: "Controller {{ $labels.controller }} has {{ $value }} items queued"

        - alert: OperatorReconcileP99High
          expr: |
            histogram_quantile(0.99,
              rate(myoperator_reconcile_duration_seconds_bucket[5m])
            ) > 30
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Operator P99 reconcile duration is high"
            description: "Controller {{ $labels.controller }} P99 reconcile duration is {{ $value }}s"

        - alert: OperatorResourceUnhealthy
          expr: |
            (sum(myoperator_resource_phase{phase!="Ready"}) by (namespace))
              /
            (sum(myoperator_resource_phase) by (namespace)) > 0.2
          for: 15m
          labels:
            severity: critical
          annotations:
            summary: "More than 20% of resources are not Ready"
            description: "Namespace {{ $labels.namespace }}: {{ $value | humanizePercentage }} unhealthy"
```

## Section 8: Testing Metrics

```go
// controllers/myresource_controller_test.go
package controllers_test

import (
    "testing"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/testutil"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestReconcileErrorMetricIncrement(t *testing.T) {
    // Create a fresh registry for test isolation
    registry := prometheus.NewRegistry()
    reconcileErrors := prometheus.NewCounterVec(
        prometheus.CounterOpts{
            Name: "test_reconcile_errors_total",
        },
        []string{"controller", "resource_namespace", "resource_name", "error_type"},
    )
    registry.MustRegister(reconcileErrors)

    // Simulate error recording
    reconcileErrors.With(prometheus.Labels{
        "controller":         "myresource",
        "resource_namespace": "default",
        "resource_name":      "test-resource",
        "error_type":         "not_found",
    }).Inc()

    // Verify counter was incremented
    count := testutil.ToFloat64(reconcileErrors.With(prometheus.Labels{
        "controller":         "myresource",
        "resource_namespace": "default",
        "resource_name":      "test-resource",
        "error_type":         "not_found",
    }))
    assert.Equal(t, float64(1), count)
}

func TestReconcileDurationHistogram(t *testing.T) {
    histogram := prometheus.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "test_duration_seconds",
            Buckets: []float64{0.1, 0.5, 1.0},
        },
        []string{"result"},
    )

    histogram.With(prometheus.Labels{"result": "success"}).Observe(0.05)
    histogram.With(prometheus.Labels{"result": "success"}).Observe(0.3)

    // Use testutil.CollectAndCompare for full metric comparison
    expected := `
# HELP test_duration_seconds
# TYPE test_duration_seconds histogram
test_duration_seconds_bucket{result="success",le="0.1"} 1
test_duration_seconds_bucket{result="success",le="0.5"} 2
test_duration_seconds_bucket{result="success",le="1"} 2
test_duration_seconds_bucket{result="success",le="+Inf"} 2
test_duration_seconds_sum{result="success"} 0.35
test_duration_seconds_count{result="success"} 2
`
    err := testutil.CollectAndCompare(histogram, strings.NewReader(expected), "test_duration_seconds")
    require.NoError(t, err)
}
```

## Conclusion

Operator observability is not an afterthought — it is what makes the difference between an operator you can trust in production and one you have to watch with your eyes. The combination of controller-runtime's default metrics (reconcile counts, duration, queue depth), custom counters with business-level labels (error types, resource phases), custom collectors for live state snapshots, and Grafana dashboards with alerting rules gives complete visibility into what an operator is doing and why. The patterns here scale from simple single-controller operators to complex multi-controller operators managing thousands of custom resources.
