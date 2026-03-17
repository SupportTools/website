---
title: "Kubernetes Custom Metrics Adapter: Implementing external.metrics.k8s.io"
date: 2029-11-10T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Custom Metrics", "HPA", "Autoscaling", "KEDA", "Go", "Metrics API"]
categories:
- Kubernetes
- Autoscaling
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to implementing a Kubernetes custom metrics adapter: metrics API server implementation, resource.metrics.k8s.io interface, building adapters with k8s-sigs/custom-metrics-apiserver, and comparing with KEDA."
more_link: "yes"
url: "/kubernetes-custom-metrics-adapter-external-metrics-api/"
---

The Horizontal Pod Autoscaler (HPA) can scale based on CPU and memory out of the box, but real-world autoscaling requires business metrics: queue depth, request rate, active sessions, or custom Prometheus queries. This is where custom and external metrics adapters come in. This post covers the full implementation of a metrics adapter that exposes metrics to the Kubernetes HPA through the `custom.metrics.k8s.io` and `external.metrics.k8s.io` APIs.

<!--more-->

# Kubernetes Custom Metrics Adapter: Implementing external.metrics.k8s.io

## The Metrics API Architecture

Kubernetes autoscaling uses three metrics API groups:

| API Group | Metrics Type | Scope | Provided By |
|-----------|-------------|-------|-------------|
| `metrics.k8s.io` | Resource metrics (CPU, memory) | Pod/Node | metrics-server |
| `custom.metrics.k8s.io` | Custom Kubernetes object metrics | Kubernetes objects | Custom adapter |
| `external.metrics.k8s.io` | External metrics (queue depth, etc.) | Not tied to K8s objects | Custom adapter |

The HPA uses these APIs to fetch metric values and decide whether to scale. For `external.metrics.k8s.io`:

```
HPA controller
    │
    ├── GET /apis/external.metrics.k8s.io/v1beta1/namespaces/{ns}/{metric-name}
    │
    ▼
Custom Metrics Adapter
    │
    ├── Query Prometheus / CloudWatch / Datadog / etc.
    │
    ▼
Returns: ExternalMetricValueList
```

## HPA with External Metrics

Before building the adapter, let's understand what the HPA expects:

```yaml
# hpa-external.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: worker-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: worker
  minReplicas: 2
  maxReplicas: 50

  metrics:
  # External metric: SQS queue depth
  - type: External
    external:
      metric:
        name: sqs_messages_visible
        selector:
          matchLabels:
            queue: payment-processor
      target:
        type: AverageValue
        averageValue: "10"  # Scale up when >10 messages per pod

  # Custom metric: Requests per second on a Deployment
  - type: Object
    object:
      metric:
        name: http_requests_per_second
      describedObject:
        apiVersion: apps/v1
        kind: Deployment
        name: frontend
      target:
        type: AverageValue
        averageValue: "100"

  # Resource metric (built-in)
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

## Building a Custom Metrics Adapter

The `k8s-sigs/custom-metrics-apiserver` library provides the scaffolding for implementing a metrics API server. You implement the provider interface and the library handles all the Kubernetes API machinery.

### Project Structure

```
custom-metrics-adapter/
├── main.go
├── adapter/
│   └── adapter.go
├── provider/
│   ├── custom_provider.go
│   └── external_provider.go
├── prometheus/
│   └── client.go
├── go.mod
└── go.sum
```

### go.mod

```go
module github.com/myorg/custom-metrics-adapter

go 1.21

require (
    k8s.io/apimachinery v0.28.0
    k8s.io/client-go v0.28.0
    k8s.io/component-base v0.28.0
    k8s.io/metrics v0.28.0
    sigs.k8s.io/custom-metrics-apiserver v1.28.0
    github.com/prometheus/client_golang v1.17.0
    go.uber.org/zap v1.26.0
)
```

### Custom Provider Interface

The library defines two interfaces you must implement:

```go
// From sigs.k8s.io/custom-metrics-apiserver/pkg/provider

// CustomMetricsProvider provides custom metrics for Kubernetes objects
type CustomMetricsProvider interface {
    // GetMetricByName returns the value of a named metric for a specific object
    GetMetricByName(ctx context.Context, name types.NamespacedName,
        info CustomMetricInfo, metricSelector labels.Selector) (*custom_metrics.MetricValue, error)

    // GetMetricBySelector returns the values of a named metric for objects matching a selector
    GetMetricBySelector(ctx context.Context, namespace string,
        selector labels.Selector, info CustomMetricInfo,
        metricSelector labels.Selector) (*custom_metrics.MetricValueList, error)

    // ListAllMetrics lists all available custom metrics
    ListAllMetrics() []CustomMetricInfo
}

// ExternalMetricsProvider provides external metrics to the HPA
type ExternalMetricsProvider interface {
    // GetExternalMetric returns the value of an external metric
    GetExternalMetric(ctx context.Context, namespace string,
        metricSelector labels.Selector, info ExternalMetricInfo) (*external_metrics.ExternalMetricValueList, error)

    // ListAllExternalMetrics lists all available external metrics
    ListAllExternalMetrics() []ExternalMetricInfo
}
```

### Prometheus Client

```go
// prometheus/client.go
package prometheus

import (
    "context"
    "fmt"
    "time"

    "github.com/prometheus/client_golang/api"
    v1 "github.com/prometheus/client_golang/api/prometheus/v1"
    "github.com/prometheus/common/model"
    "go.uber.org/zap"
)

// Client wraps the Prometheus HTTP API client
type Client struct {
    api v1.API
    log *zap.Logger
}

func NewClient(prometheusURL string, log *zap.Logger) (*Client, error) {
    apiClient, err := api.NewClient(api.Config{
        Address: prometheusURL,
    })
    if err != nil {
        return nil, fmt.Errorf("creating prometheus client: %w", err)
    }

    return &Client{
        api: v1.NewAPI(apiClient),
        log: log,
    }, nil
}

// QueryScalar executes a Prometheus query and returns a single float64
func (c *Client) QueryScalar(ctx context.Context, query string) (float64, error) {
    ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
    defer cancel()

    result, warnings, err := c.api.Query(ctx, query, time.Now())
    if err != nil {
        return 0, fmt.Errorf("prometheus query %q: %w", query, err)
    }

    for _, w := range warnings {
        c.log.Warn("prometheus warning", zap.String("query", query), zap.String("warning", w))
    }

    vector, ok := result.(model.Vector)
    if !ok {
        return 0, fmt.Errorf("expected vector result, got %T", result)
    }

    if len(vector) == 0 {
        return 0, fmt.Errorf("query returned no results")
    }

    if len(vector) > 1 {
        c.log.Warn("query returned multiple results, using first",
            zap.String("query", query),
            zap.Int("results", len(vector)))
    }

    return float64(vector[0].Value), nil
}

// QueryVector executes a Prometheus query and returns labeled values
func (c *Client) QueryVector(ctx context.Context, query string) (map[string]float64, error) {
    ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
    defer cancel()

    result, _, err := c.api.Query(ctx, query, time.Now())
    if err != nil {
        return nil, fmt.Errorf("prometheus query %q: %w", query, err)
    }

    vector, ok := result.(model.Vector)
    if !ok {
        return nil, fmt.Errorf("expected vector result, got %T", result)
    }

    values := make(map[string]float64, len(vector))
    for _, sample := range vector {
        // Use a composite key from the metric labels
        key := fmt.Sprintf("%v", sample.Metric)
        values[key] = float64(sample.Value)
    }

    return values, nil
}
```

### External Metrics Provider

```go
// provider/external_provider.go
package provider

import (
    "context"
    "fmt"
    "sync"
    "time"

    "k8s.io/apimachinery/pkg/api/resource"
    "k8s.io/apimachinery/pkg/labels"
    external_metrics "k8s.io/metrics/pkg/apis/external_metrics/v1beta1"
    "sigs.k8s.io/custom-metrics-apiserver/pkg/provider"

    promclient "github.com/myorg/custom-metrics-adapter/prometheus"
    "go.uber.org/zap"

    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// MetricMapping maps an external metric name to a Prometheus query template
type MetricMapping struct {
    Name        string
    Query       string  // Prometheus query, can use {label} substitution
    Description string
}

// ExternalMetricsProvider implements provider.ExternalMetricsProvider
type ExternalMetricsProvider struct {
    promClient *promclient.Client
    mappings   []MetricMapping
    cache      *metricCache
    log        *zap.Logger
}

type cachedValue struct {
    value     float64
    fetchedAt time.Time
}

type metricCache struct {
    mu     sync.RWMutex
    values map[string]cachedValue
    ttl    time.Duration
}

func newMetricCache(ttl time.Duration) *metricCache {
    return &metricCache{
        values: make(map[string]cachedValue),
        ttl:    ttl,
    }
}

func (c *metricCache) get(key string) (float64, bool) {
    c.mu.RLock()
    defer c.mu.RUnlock()
    v, ok := c.values[key]
    if !ok || time.Since(v.fetchedAt) > c.ttl {
        return 0, false
    }
    return v.value, true
}

func (c *metricCache) set(key string, value float64) {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.values[key] = cachedValue{value: value, fetchedAt: time.Now()}
}

func NewExternalMetricsProvider(promClient *promclient.Client, log *zap.Logger) *ExternalMetricsProvider {
    return &ExternalMetricsProvider{
        promClient: promClient,
        cache:      newMetricCache(15 * time.Second),
        log:        log,
        mappings: []MetricMapping{
            {
                Name:        "sqs_messages_visible",
                Query:       `aws_sqs_approximate_number_of_messages_visible_sum{queue_name=~".*{{.queue}}.*"}`,
                Description: "Number of visible messages in SQS queue",
            },
            {
                Name:        "rabbitmq_queue_messages",
                Query:       `rabbitmq_queue_messages{queue="{{.queue}}"}`,
                Description: "Messages in RabbitMQ queue",
            },
            {
                Name:        "http_request_rate",
                Query:       `sum(rate(http_requests_total{job="{{.service}}"}[2m]))`,
                Description: "HTTP requests per second for a service",
            },
            {
                Name:        "active_websocket_connections",
                Query:       `sum(websocket_connections_active{namespace="{{.namespace}}"})`,
                Description: "Active WebSocket connections",
            },
        },
    }
}

// GetExternalMetric implements provider.ExternalMetricsProvider
func (p *ExternalMetricsProvider) GetExternalMetric(
    ctx context.Context,
    namespace string,
    metricSelector labels.Selector,
    info provider.ExternalMetricInfo,
) (*external_metrics.ExternalMetricValueList, error) {

    p.log.Info("GetExternalMetric called",
        zap.String("metric", info.Metric),
        zap.String("namespace", namespace),
        zap.String("selector", metricSelector.String()))

    // Find the metric mapping
    mapping, err := p.findMapping(info.Metric)
    if err != nil {
        return nil, err
    }

    // Build Prometheus query with label substitutions from metricSelector
    query, err := p.buildQuery(mapping.Query, metricSelector)
    if err != nil {
        return nil, fmt.Errorf("building query for %s: %w", info.Metric, err)
    }

    // Check cache
    cacheKey := fmt.Sprintf("%s/%s", info.Metric, metricSelector.String())
    if val, ok := p.cache.get(cacheKey); ok {
        return p.makeMetricList(info.Metric, namespace, metricSelector, val), nil
    }

    // Query Prometheus
    value, err := p.promClient.QueryScalar(ctx, query)
    if err != nil {
        p.log.Error("prometheus query failed",
            zap.String("metric", info.Metric),
            zap.String("query", query),
            zap.Error(err))
        return nil, fmt.Errorf("querying metric %s: %w", info.Metric, err)
    }

    p.cache.set(cacheKey, value)

    p.log.Info("external metric value",
        zap.String("metric", info.Metric),
        zap.Float64("value", value))

    return p.makeMetricList(info.Metric, namespace, metricSelector, value), nil
}

func (p *ExternalMetricsProvider) makeMetricList(
    metricName, namespace string,
    selector labels.Selector,
    value float64,
) *external_metrics.ExternalMetricValueList {
    return &external_metrics.ExternalMetricValueList{
        Items: []external_metrics.ExternalMetricValue{
            {
                MetricName: metricName,
                MetricLabels: selector.Requirements()[0:0], // Convert selector to labels
                Timestamp:    metav1.Now(),
                Value:        *resource.NewMilliQuantity(int64(value*1000), resource.DecimalSI),
            },
        },
    }
}

// ListAllExternalMetrics implements provider.ExternalMetricsProvider
func (p *ExternalMetricsProvider) ListAllExternalMetrics() []provider.ExternalMetricInfo {
    infos := make([]provider.ExternalMetricInfo, len(p.mappings))
    for i, m := range p.mappings {
        infos[i] = provider.ExternalMetricInfo{
            Metric: m.Name,
        }
    }
    return infos
}

func (p *ExternalMetricsProvider) findMapping(name string) (MetricMapping, error) {
    for _, m := range p.mappings {
        if m.Name == name {
            return m, nil
        }
    }
    return MetricMapping{}, fmt.Errorf("unknown metric: %s", name)
}

func (p *ExternalMetricsProvider) buildQuery(queryTemplate string, selector labels.Selector) (string, error) {
    // Extract labels from selector for query substitution
    requirements, selectable := selector.Requirements()
    if !selectable {
        return queryTemplate, nil
    }

    query := queryTemplate
    for _, req := range requirements {
        placeholder := fmt.Sprintf("{{.%s}}", req.Key())
        query = strings.ReplaceAll(query, placeholder, req.Values().List()[0])
    }

    return query, nil
}
```

### Custom Provider for Kubernetes Objects

```go
// provider/custom_provider.go
package provider

import (
    "context"
    "fmt"
    "strings"
    "time"

    "k8s.io/apimachinery/pkg/api/resource"
    "k8s.io/apimachinery/pkg/labels"
    "k8s.io/apimachinery/pkg/types"
    custom_metrics "k8s.io/metrics/pkg/apis/custom_metrics/v1beta2"
    "sigs.k8s.io/custom-metrics-apiserver/pkg/provider"
    "sigs.k8s.io/custom-metrics-apiserver/pkg/provider/helpers"

    promclient "github.com/myorg/custom-metrics-adapter/prometheus"
    "go.uber.org/zap"

    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime/schema"
)

// CustomMetricsProvider implements provider.CustomMetricsProvider
type CustomMetricsProvider struct {
    promClient *promclient.Client
    cache      *metricCache
    log        *zap.Logger
}

func NewCustomMetricsProvider(promClient *promclient.Client, log *zap.Logger) *CustomMetricsProvider {
    return &CustomMetricsProvider{
        promClient: promClient,
        cache:      newMetricCache(15 * time.Second),
        log:        log,
    }
}

// GetMetricByName implements provider.CustomMetricsProvider
func (p *CustomMetricsProvider) GetMetricByName(
    ctx context.Context,
    name types.NamespacedName,
    info provider.CustomMetricInfo,
    metricSelector labels.Selector,
) (*custom_metrics.MetricValue, error) {

    p.log.Info("GetMetricByName",
        zap.String("object", name.String()),
        zap.String("metric", info.Metric),
        zap.String("group", info.GroupResource.Group),
        zap.String("resource", info.GroupResource.Resource))

    query := p.buildQueryForObject(info.Metric, name.Namespace, name.Name, info.GroupResource)

    cacheKey := fmt.Sprintf("%s/%s/%s", info.Metric, name.Namespace, name.Name)
    if val, ok := p.cache.get(cacheKey); ok {
        return p.makeMetricValue(name, info, val), nil
    }

    value, err := p.promClient.QueryScalar(ctx, query)
    if err != nil {
        return nil, fmt.Errorf("querying metric %s for %s: %w", info.Metric, name, err)
    }

    p.cache.set(cacheKey, value)
    return p.makeMetricValue(name, info, value), nil
}

// GetMetricBySelector implements provider.CustomMetricsProvider
func (p *CustomMetricsProvider) GetMetricBySelector(
    ctx context.Context,
    namespace string,
    selector labels.Selector,
    info provider.CustomMetricInfo,
    metricSelector labels.Selector,
) (*custom_metrics.MetricValueList, error) {

    p.log.Info("GetMetricBySelector",
        zap.String("namespace", namespace),
        zap.String("metric", info.Metric),
        zap.String("selector", selector.String()))

    query := p.buildQueryForSelector(info.Metric, namespace, selector, info.GroupResource)

    values, err := p.promClient.QueryVector(ctx, query)
    if err != nil {
        return nil, fmt.Errorf("querying metric %s: %w", info.Metric, err)
    }

    items := make([]custom_metrics.MetricValue, 0, len(values))
    for labelSet, val := range values {
        // Extract object name from Prometheus label set
        objName := extractObjectName(labelSet, info.GroupResource.Resource)
        if objName == "" {
            continue
        }

        objRef := custom_metrics.ObjectReference{
            Kind:       resourceToKind(info.GroupResource.Resource),
            Namespace:  namespace,
            Name:       objName,
            APIVersion: "v1",
        }

        items = append(items, custom_metrics.MetricValue{
            DescribedObject: objRef,
            Metric: custom_metrics.MetricIdentifier{
                Name: info.Metric,
            },
            Timestamp: metav1.Now(),
            Value:     *resource.NewMilliQuantity(int64(val*1000), resource.DecimalSI),
        })
    }

    return &custom_metrics.MetricValueList{Items: items}, nil
}

// ListAllMetrics implements provider.CustomMetricsProvider
func (p *CustomMetricsProvider) ListAllMetrics() []provider.CustomMetricInfo {
    return []provider.CustomMetricInfo{
        {
            GroupResource: schema.GroupResource{Resource: "pods"},
            Namespaced:    true,
            Metric:        "http_requests_per_second",
        },
        {
            GroupResource: schema.GroupResource{Resource: "deployments", Group: "apps"},
            Namespaced:    true,
            Metric:        "http_requests_per_second",
        },
        {
            GroupResource: schema.GroupResource{Resource: "pods"},
            Namespaced:    true,
            Metric:        "websocket_connections",
        },
        {
            GroupResource: schema.GroupResource{Resource: "pods"},
            Namespaced:    true,
            Metric:        "cache_hit_rate",
        },
    }
}

func (p *CustomMetricsProvider) buildQueryForObject(metric, namespace, name string, gr schema.GroupResource) string {
    switch metric {
    case "http_requests_per_second":
        return fmt.Sprintf(
            `sum(rate(http_requests_total{namespace="%s",pod=~"%s-.*"}[2m]))`,
            namespace, name)
    case "websocket_connections":
        return fmt.Sprintf(
            `sum(websocket_connections_active{namespace="%s",pod=~"%s-.*"})`,
            namespace, name)
    default:
        return fmt.Sprintf(
            `%s{namespace="%s",pod=~"%s-.*"}`,
            metric, namespace, name)
    }
}

func (p *CustomMetricsProvider) buildQueryForSelector(metric, namespace string, selector labels.Selector, gr schema.GroupResource) string {
    labelFilter := selectorToPrometheusFilter(selector)
    switch metric {
    case "http_requests_per_second":
        return fmt.Sprintf(
            `sum by (pod) (rate(http_requests_total{namespace="%s"%s}[2m]))`,
            namespace, labelFilter)
    default:
        return fmt.Sprintf(
            `%s{namespace="%s"%s}`,
            metric, namespace, labelFilter)
    }
}

func (p *CustomMetricsProvider) makeMetricValue(name types.NamespacedName, info provider.CustomMetricInfo, value float64) *custom_metrics.MetricValue {
    return &custom_metrics.MetricValue{
        DescribedObject: custom_metrics.ObjectReference{
            Kind:       resourceToKind(info.GroupResource.Resource),
            Namespace:  name.Namespace,
            Name:       name.Name,
            APIVersion: "apps/v1",
        },
        Metric: custom_metrics.MetricIdentifier{
            Name: info.Metric,
        },
        Timestamp: metav1.Now(),
        Value:     *resource.NewMilliQuantity(int64(value*1000), resource.DecimalSI),
    }
}

func selectorToPrometheusFilter(selector labels.Selector) string {
    if selector.Empty() {
        return ""
    }
    reqs, ok := selector.Requirements()
    if !ok {
        return ""
    }
    var parts []string
    for _, req := range reqs {
        parts = append(parts, fmt.Sprintf(`%s="%s"`, req.Key(), req.Values().List()[0]))
    }
    return "," + strings.Join(parts, ",")
}

func resourceToKind(resource string) string {
    switch resource {
    case "pods":
        return "Pod"
    case "deployments":
        return "Deployment"
    case "services":
        return "Service"
    default:
        return strings.Title(strings.TrimSuffix(resource, "s"))
    }
}

func extractObjectName(labelSet string, resource string) string {
    // Parse "{pod=\"myapp-7d9f-abc12\", namespace=\"default\"}"
    for _, part := range strings.Split(labelSet, ",") {
        part = strings.TrimSpace(part)
        part = strings.Trim(part, "{}")
        if strings.HasPrefix(part, resource[:len(resource)-1]+"=") ||
            strings.HasPrefix(part, "pod=") {
            return strings.Trim(strings.Split(part, "=")[1], `"`)
        }
    }
    return ""
}
```

### Main Adapter Assembly

```go
// adapter/adapter.go
package adapter

import (
    "fmt"
    "net/http"
    "os"

    "k8s.io/apimachinery/pkg/util/wait"
    "k8s.io/client-go/rest"
    "k8s.io/component-base/logs"
    "sigs.k8s.io/custom-metrics-apiserver/pkg/apiserver"
    "sigs.k8s.io/custom-metrics-apiserver/pkg/cmd/server"

    "github.com/myorg/custom-metrics-adapter/prometheus"
    "github.com/myorg/custom-metrics-adapter/provider"
    "go.uber.org/zap"
)

// Adapter holds the adapter configuration and server
type Adapter struct {
    server.AdapterBase
    prometheusURL string
    log           *zap.Logger
}

func NewAdapter(prometheusURL string, log *zap.Logger) *Adapter {
    return &Adapter{
        prometheusURL: prometheusURL,
        log:           log,
    }
}

func (a *Adapter) makeProviderOrDie() (apiserver.CustomMetricsProvider, apiserver.ExternalMetricsProvider) {
    promClient, err := prometheus.NewClient(a.prometheusURL, a.log)
    if err != nil {
        a.log.Fatal("creating prometheus client", zap.Error(err))
    }

    customProv := provider.NewCustomMetricsProvider(promClient, a.log)
    externalProv := provider.NewExternalMetricsProvider(promClient, a.log)

    return customProv, externalProv
}

func (a *Adapter) Run(stopCh <-chan struct{}) {
    logs.InitLogs()
    defer logs.FlushLogs()

    // Wait for API server to be available
    if err := a.WaitForAPIServer(stopCh); err != nil {
        a.log.Fatal("waiting for API server", zap.Error(err))
    }

    customProv, externalProv := a.makeProviderOrDie()

    srv, err := a.Server(customProv, externalProv)
    if err != nil {
        a.log.Fatal("creating adapter server", zap.Error(err))
    }

    if err := srv.GenericAPIServer.PrepareRun().Run(stopCh); err != nil {
        a.log.Fatal("running adapter server", zap.Error(err))
    }
}
```

```go
// main.go
package main

import (
    "flag"
    "os"
    "os/signal"
    "syscall"

    "go.uber.org/zap"

    "github.com/myorg/custom-metrics-adapter/adapter"
)

func main() {
    var prometheusURL string
    flag.StringVar(&prometheusURL, "prometheus-url",
        getEnvOrDefault("PROMETHEUS_URL", "http://prometheus.monitoring:9090"),
        "URL of the Prometheus server")
    flag.Parse()

    log, _ := zap.NewProduction()
    defer log.Sync()

    log.Info("starting custom metrics adapter",
        zap.String("prometheus_url", prometheusURL))

    stopCh := make(chan struct{})
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
    go func() {
        <-sigCh
        close(stopCh)
    }()

    a := adapter.NewAdapter(prometheusURL, log)
    a.Run(stopCh)
}

func getEnvOrDefault(key, def string) string {
    if v := os.Getenv(key); v != "" {
        return v
    }
    return def
}
```

## Deploying the Adapter

```yaml
# deploy/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: custom-metrics-adapter
  namespace: custom-metrics
spec:
  replicas: 2
  selector:
    matchLabels:
      app: custom-metrics-adapter
  template:
    metadata:
      labels:
        app: custom-metrics-adapter
    spec:
      serviceAccountName: custom-metrics-adapter
      containers:
      - name: adapter
        image: myorg/custom-metrics-adapter:latest
        args:
        - --cert-dir=/var/run/serving-cert
        - --secure-port=6443
        - --tls-cert-file=/var/run/serving-cert/tls.crt
        - --tls-private-key-file=/var/run/serving-cert/tls.key
        - --prometheus-url=http://prometheus-operated.monitoring:9090
        env:
        - name: PROMETHEUS_URL
          value: "http://prometheus-operated.monitoring:9090"
        ports:
        - containerPort: 6443
          name: https
        volumeMounts:
        - name: serving-cert
          mountPath: /var/run/serving-cert
          readOnly: true
        resources:
          limits:
            cpu: "200m"
            memory: "200Mi"
          requests:
            cpu: "100m"
            memory: "100Mi"
        readinessProbe:
          httpGet:
            path: /readyz
            port: 6443
            scheme: HTTPS
      volumes:
      - name: serving-cert
        secret:
          secretName: custom-metrics-adapter-cert
---
apiVersion: v1
kind: Service
metadata:
  name: custom-metrics-adapter
  namespace: custom-metrics
spec:
  selector:
    app: custom-metrics-adapter
  ports:
  - port: 443
    targetPort: 6443
    name: https
---
# APIService registration - tells kube-aggregator to route API calls to our adapter
apiVersion: apiregistration.k8s.io/v1
kind: APIService
metadata:
  name: v1beta1.custom.metrics.k8s.io
spec:
  service:
    name: custom-metrics-adapter
    namespace: custom-metrics
    port: 443
  group: custom.metrics.k8s.io
  version: v1beta1
  insecureSkipTLSVerify: true  # Use CABundle in production
  groupPriorityMinimum: 100
  versionPriority: 100
---
apiVersion: apiregistration.k8s.io/v1
kind: APIService
metadata:
  name: v1beta1.external.metrics.k8s.io
spec:
  service:
    name: custom-metrics-adapter
    namespace: custom-metrics
    port: 443
  group: external.metrics.k8s.io
  version: v1beta1
  insecureSkipTLSVerify: true
  groupPriorityMinimum: 100
  versionPriority: 100
```

```yaml
# RBAC for the adapter
apiVersion: v1
kind: ServiceAccount
metadata:
  name: custom-metrics-adapter
  namespace: custom-metrics
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: custom-metrics-adapter
rules:
- apiGroups: [""]
  resources: ["pods", "nodes", "namespaces", "services"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["apps"]
  resources: ["deployments", "replicasets"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["custom.metrics.k8s.io"]
  resources: ["*"]
  verbs: ["get", "list"]
- apiGroups: ["external.metrics.k8s.io"]
  resources: ["*"]
  verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: custom-metrics-adapter
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: custom-metrics-adapter
subjects:
- kind: ServiceAccount
  name: custom-metrics-adapter
  namespace: custom-metrics
---
# Allow HPA to read custom metrics
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: hpa-custom-metrics
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: custom-metrics-server-resources
subjects:
- kind: ServiceAccount
  name: horizontal-pod-autoscaler
  namespace: kube-system
```

## Testing the Adapter

```bash
# Verify the APIService is available
kubectl get apiservice v1beta1.external.metrics.k8s.io
kubectl get apiservice v1beta1.custom.metrics.k8s.io

# Both should show AVAILABLE: True

# Test external metric retrieval (simulates what HPA does)
kubectl get --raw "/apis/external.metrics.k8s.io/v1beta1/namespaces/default/sqs_messages_visible?labelSelector=queue%3Dpayment-processor"

# Test custom metric
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta2/namespaces/default/pods/*/http_requests_per_second"

# List available metrics
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta2"
kubectl get --raw "/apis/external.metrics.k8s.io/v1beta1"

# Check HPA status
kubectl get hpa worker-hpa -o yaml
kubectl describe hpa worker-hpa

# Watch HPA events
kubectl get events --watch --field-selector reason=SuccessfulRescale
```

## KEDA Comparison

KEDA (Kubernetes Event-Driven Autoscaling) is a higher-level autoscaling framework that implements the same underlying metrics adapter pattern but with pre-built scalers for common event sources.

| Feature | Custom Adapter | KEDA |
|---------|---------------|------|
| Setup effort | High (custom code) | Low (YAML ScaledObject) |
| Built-in sources | None | 50+ (SQS, Kafka, Redis, etc.) |
| Flexibility | Unlimited | Limited to provided scalers |
| Scale to zero | Manual | Built-in |
| External metrics API | Yes (implements it) | Yes (implements it) |
| Custom metrics | Yes | Via Prometheus scaler |

```yaml
# KEDA equivalent of our custom adapter for SQS
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: worker-scaledobject
  namespace: production
spec:
  scaleTargetRef:
    name: worker
  minReplicaCount: 0  # Scale to zero!
  maxReplicaCount: 50
  cooldownPeriod: 30
  triggers:
  - type: aws-sqs-queue
    metadata:
      queueURL: https://sqs.us-east-1.amazonaws.com/123456789/payment-processor
      queueLength: "10"
      awsRegion: us-east-1
    authenticationRef:
      name: keda-aws-credentials
  - type: prometheus
    metadata:
      serverAddress: http://prometheus.monitoring:9090
      metricName: http_requests_per_second
      query: sum(rate(http_requests_total{namespace="production"}[2m]))
      threshold: "100"
```

KEDA is the right choice when your event sources match its built-in scalers. Build a custom adapter when you need metrics that KEDA doesn't support or need full control over query logic.

## Summary

Implementing a custom metrics adapter provides unlimited flexibility for Kubernetes autoscaling. The key components are:

- **`ExternalMetricsProvider` interface**: Implement `GetExternalMetric()` and `ListAllExternalMetrics()` to expose metrics not tied to Kubernetes objects (queue depths, external API rates)
- **`CustomMetricsProvider` interface**: Implement `GetMetricByName()` and `GetMetricBySelector()` to expose per-object metrics computed from Prometheus queries
- **APIService registration**: Register your adapter with `v1beta1.custom.metrics.k8s.io` and `v1beta1.external.metrics.k8s.io` so the API aggregation layer routes requests to it
- **Caching**: Always cache Prometheus query results (15-30 seconds) to prevent overloading Prometheus when the HPA polls every 15 seconds
- **KEDA**: For standard event sources (SQS, Kafka, Redis, RabbitMQ), KEDA's ScaledObject is significantly less work than a custom adapter

The custom adapter approach gives you the power to autoscale Kubernetes workloads based on literally any metric you can query.
